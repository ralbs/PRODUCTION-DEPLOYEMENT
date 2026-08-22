"""ctm/assimilation.py — Optimal Interpolation (OI) analysis.

See CLAUDE.md, "Assimilation": solve ALL observations for one species
SIMULTANEOUSLY, never with a sequential per-observation loop (each
innovation computed against the ORIGINAL background but applied
cumulatively double-corrects when sensors are spatially clustered -- two
co-located identical readings can push the analysis PAST the observed
value). The correct joint form:

    x_a = x_b + B H^T (H B H^T + R)^-1 (y - H x_b)

Sensor identity, location, and per-species observation error all come
from CityConfig's sensor network -- never hardcoded here. Non-finite
observations are rejected at QC, before any range/domain check.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from cities.loader import CityConfig
from ctm.grid import CTMGrid


@dataclass
class Observation:
    sensor_id: str
    value: float


def _resolve_observations(city: CityConfig, grid: CTMGrid, species: str, observations: list[Observation]):
    """QC each Observation against the city's sensor network and the grid
    domain. Returns (resolved, counts) where `resolved` is a list of
    (i, j, x_m, y_m, value, sigma) tuples for observations that passed
    every check, and `counts` is a dict of rejection reasons."""
    sensors_by_id = {s.id: s for s in city.sensors}
    resolved = []
    counts = {
        "n_obs_rejected_nonfinite": 0,
        "n_obs_rejected_unknown_sensor": 0,
        "n_obs_rejected_out_of_domain": 0,
    }

    for obs in observations:
        # Reject non-finite BEFORE any other check -- see CLAUDE.md's NaN
        # rule: np.isfinite() first, never a bare range comparison (NaN
        # silently fails every such comparison).
        if not np.isfinite(obs.value):
            counts["n_obs_rejected_nonfinite"] += 1
            continue

        sensor = sensors_by_id.get(obs.sensor_id)
        sigma = None if sensor is None else sensor.species_error_sigma.get(species)
        if sensor is None or sigma is None or not np.isfinite(sigma) or sigma <= 0:
            counts["n_obs_rejected_unknown_sensor"] += 1
            continue

        x_m, y_m = grid.latlon_to_xy_m(sensor.lat, sensor.lon)
        i, j = grid.latlon_to_cell(sensor.lat, sensor.lon)
        if not (0 <= i < grid.nx and 0 <= j < grid.ny):
            counts["n_obs_rejected_out_of_domain"] += 1
            continue

        resolved.append((i, j, x_m, y_m, obs.value, sigma))

    return resolved, counts


def assimilate(city: CityConfig, grid: CTMGrid, species: str, observations: list[Observation]) -> dict:
    """Run one simultaneous OI analysis step for `species`, updating
    `grid`'s field for that species in place. Returns a diagnostics dict
    (never crashes/returns None, even if every observation is rejected).
    """
    field = grid.get_field(species).astype(np.float64)

    resolved, counts = _resolve_observations(city, grid, species, observations)
    diagnostics = {
        "n_obs_total": len(observations),
        "n_obs_used": len(resolved),
        **counts,
        "analysis_applied": False,
    }
    if not resolved:
        return diagnostics

    assim_cfg = city.assimilation
    bg_error_fraction = assim_cfg.bg_error_fraction
    L_corr = assim_cfg.correlation_length_m
    L_loc = assim_cfg.localisation_radius_m
    background_conc = city.species[species].background_conc
    floor = max(background_conc, 1e-6)

    obs_i = np.array([r[0] for r in resolved])
    obs_j = np.array([r[1] for r in resolved])
    obs_x = np.array([r[2] for r in resolved])
    obs_y = np.array([r[3] for r in resolved])
    obs_values = np.array([r[4] for r in resolved])
    obs_sigma = np.array([r[5] for r in resolved])

    ii, jj = np.meshgrid(np.arange(grid.nx), np.arange(grid.ny), indexing="ij")
    grid_x = ((ii + 0.5) * grid.dx).ravel()
    grid_y = ((jj + 0.5) * grid.dy).ravel()

    sigma_b_grid = bg_error_fraction * np.maximum(field.ravel(), floor)
    sigma_b_obs = bg_error_fraction * np.maximum(field[obs_i, obs_j], floor)
    Hxb = field[obs_i, obs_j]
    innovation = obs_values - Hxb

    def gaussian_correlation(d):
        c = np.exp(-(d**2) / (2.0 * L_corr**2))
        return np.where(d <= L_loc, c, 0.0)  # hard localisation cutoff

    d_obs_obs = np.sqrt((obs_x[:, None] - obs_x[None, :]) ** 2 + (obs_y[:, None] - obs_y[None, :]) ** 2)
    HBHt = sigma_b_obs[:, None] * sigma_b_obs[None, :] * gaussian_correlation(d_obs_obs)
    R = np.diag(obs_sigma**2)
    innovation_cov = HBHt + R

    # Solve the JOINT n_obs x n_obs system ONCE -- this is the whole point:
    # never loop per-observation against the original background.
    weighted_innovation = np.linalg.solve(innovation_cov, innovation)

    d_grid_obs = np.sqrt((grid_x[:, None] - obs_x[None, :]) ** 2 + (grid_y[:, None] - obs_y[None, :]) ** 2)
    BHt = sigma_b_grid[:, None] * sigma_b_obs[None, :] * gaussian_correlation(d_grid_obs)

    increment = (BHt @ weighted_innovation).reshape(grid.nx, grid.ny)
    analysis = field + increment
    grid.set_field(species, analysis)

    diagnostics["analysis_applied"] = True
    diagnostics["increment_at_obs"] = increment[obs_i, obs_j].tolist()
    diagnostics["analysis_at_obs"] = analysis[obs_i, obs_j].tolist()
    return diagnostics
