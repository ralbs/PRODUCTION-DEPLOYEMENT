"""attribution/inverse.py — true inverse source estimation.

See CLAUDE.md, "Adjoint inverse layer", item 3. `SourceInversion` solves
observations -> emission STRENGTHS per zone/category. This is the part
that doesn't exist unless it's built here: a backward trajectory
(`attribution/adjoint.py`) answers "which upstream cells influenced this
receptor," and forward tagged-tracer accounting (`attribution/
tagged_tracers.py`) partitions a field given a KNOWN inventory -- neither
estimates anything from observations.

Design, per CLAUDE.md:
- Unknowns are aggregated into a small number of Zones (a dozen or so
  against many stacked observations is well-posed; per-grid-cell
  inversion against a dozen sensors is hopeless and not attempted).
- H is assembled from FORWARD unit-response simulations using the
  IDENTICAL advect/diffuse/deposit function instances as the live model
  (ctm.advection.advect, ctm.diffusion.diffuse, ctm.deposition.deposit)
  and the exact same EmissionEngine.inject() code path -- never a
  reimplementation of the transport or injection math. Each zone is run
  in isolation at unit emission intensity with ZERO ambient background
  (inflow=0), so C = H @ E is exact to float32, not an approximation.
  Never reinterprets the backward tracer's dwell-time weights into a
  physical sensitivity coefficient -- that introduces unverifiable
  assumptions the forward-unit-response approach avoids entirely.
- Solved as a Bayesian linear / Tikhonov estimator:
    Sigma_post = (H^T Sy^-1 H + Sx^-1)^-1
    x_hat = x_prior + Sigma_post @ H^T @ Sy^-1 @ (y - H @ x_prior)
  Sy = diag(sigma_obs^2), reusing the same per-observation sigma
  convention as ctm.assimilation.Observation (resolved via the city's
  sensor network). Sx defaults to a weak/uninformative prior so the
  estimate is data-dominated unless a real prior is supplied.
- Observations are ENHANCEMENT above a caller-estimated baseline
  (background + regional contribution) -- this module never guesses a
  baseline itself.
- `species_advisory()` reuses the SAME deposition_rate() the forward
  model uses (one source of truth), not a duplicated half-life formula.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

import numpy as np

from cities.loader import CityConfig, EmissionSource
from ctm.advection import advect
from ctm.deposition import deposit, deposition_rate
from ctm.diffusion import diffuse
from ctm.emissions import EmissionEngine
from ctm.grid import CTMGrid

_UNIT_PROFILE_NAME = "__unit_response__"


@dataclass
class Zone:
    """A zone/category whose unit-emission forward response becomes one
    column of H. Deliberately pure geometry (same kind/point/box
    convention as EmissionSource) -- x_hat, once solved, is the zone's
    effective constant emission rate in the species' declared
    conc-unit/m^2/s convention."""

    name: str
    kind: str  # "point" or "area"
    lat: float | None = None
    lon: float | None = None
    lat_sw: float | None = None
    lon_sw: float | None = None
    lat_ne: float | None = None
    lon_ne: float | None = None


@dataclass
class InversionObservation:
    sensor_id: str
    time_index: int  # step index (0-based) within the supplied history
    enhancement: float  # observed value ABOVE a caller-estimated baseline


@dataclass
class InversionResult:
    zone_names: list[str]
    x_hat: np.ndarray
    posterior_cov: np.ndarray
    marginal_std: np.ndarray
    fit_residuals: np.ndarray
    chi2_per_obs: float
    H: np.ndarray


@dataclass
class SpeciesAdvisory:
    species: str
    half_life_s: float
    transit_time_s: float
    quasi_conservative: bool
    message: str


class SourceInversion:
    def __init__(self, city: CityConfig, species: str, zones: list[Zone]):
        self.city = city
        self.species = species
        self.zones = zones

        internal_profiles = dict(city.diurnal_profiles)
        internal_profiles[_UNIT_PROFILE_NAME] = [1.0] * 24
        self._internal_city = dataclasses.replace(city, diurnal_profiles=internal_profiles)
        self._grid = CTMGrid(self._internal_city)  # geometry only: nx/ny/dx/dy/latlon_to_cell

    @property
    def nx(self) -> int:
        return self._grid.nx

    @property
    def ny(self) -> int:
        return self._grid.ny

    def _make_source(self, zone: Zone) -> EmissionSource:
        return EmissionSource(
            name=zone.name, kind=zone.kind, profile=_UNIT_PROFILE_NAME, rates={self.species: 1.0},
            lat=zone.lat, lon=zone.lon, lat_sw=zone.lat_sw, lon_sw=zone.lon_sw,
            lat_ne=zone.lat_ne, lon_ne=zone.lon_ne,
        )

    def _run_unit_response(self, zone, wind_history, k_h_history, mixing_height_history, needed_time_indices):
        dt = self.city.dt_seconds
        v_dep = self.city.species[self.species].v_dep_m_s

        grid = CTMGrid(self._internal_city)
        grid.set_field(self.species, np.zeros((grid.nx, grid.ny), dtype=np.float32))  # zero ambient background
        engine = EmissionEngine(grid, sources=[self._make_source(zone)])

        recorded = {}
        for t, (wind, k_h, h_mix) in enumerate(zip(wind_history, k_h_history, mixing_height_history)):
            engine.inject(hour_local=0.0, dt=dt, mixing_height_m=h_mix)  # flat unit profile: hour is irrelevant
            f = grid.get_field(self.species)
            f = advect(f, wind["u"], wind["v"], grid.dx, grid.dy, dt, 0.0)  # inflow=0: isolates this zone
            f = diffuse(f, k_h, grid.dx, grid.dy, dt)
            f = deposit(f, v_dep, h_mix, dt)
            grid.set_field(self.species, f)

            if t in needed_time_indices:
                recorded[t] = grid.get_field(self.species).astype(np.float64).copy()

        return recorded

    def assemble_H(self, wind_history, k_h_history, mixing_height_history, observations: list[InversionObservation]) -> np.ndarray:
        n_steps = len(wind_history)
        if not (n_steps == len(k_h_history) == len(mixing_height_history)):
            raise ValueError("wind_history, k_h_history, and mixing_height_history must be aligned (same length)")

        sensors_by_id = {s.id: s for s in self.city.sensors}
        obs_cells = []
        for obs in observations:
            if not (0 <= obs.time_index < n_steps):
                raise ValueError(f"observation time_index {obs.time_index} out of range for a {n_steps}-step history")
            sensor = sensors_by_id.get(obs.sensor_id)
            if sensor is None:
                raise ValueError(f"unknown sensor_id {obs.sensor_id!r}")
            obs_cells.append(self._grid.latlon_to_cell(sensor.lat, sensor.lon))

        needed_time_indices = {obs.time_index for obs in observations}

        H = np.zeros((len(observations), len(self.zones)), dtype=np.float64)
        for z_idx, zone in enumerate(self.zones):
            recorded = self._run_unit_response(zone, wind_history, k_h_history, mixing_height_history, needed_time_indices)
            for o_idx, obs in enumerate(observations):
                i, j = obs_cells[o_idx]
                H[o_idx, z_idx] = recorded[obs.time_index][i, j]

        return H

    def solve(
        self,
        H: np.ndarray,
        observations: list[InversionObservation],
        x_prior: np.ndarray | None = None,
        Sx: np.ndarray | None = None,
    ) -> InversionResult:
        n_zones = len(self.zones)
        y = np.array([obs.enhancement for obs in observations], dtype=np.float64)

        sensors_by_id = {s.id: s for s in self.city.sensors}
        sigma = np.array(
            [sensors_by_id[obs.sensor_id].species_error_sigma[self.species] for obs in observations],
            dtype=np.float64,
        )
        Sy_inv = np.diag(1.0 / sigma**2)

        if x_prior is None:
            x_prior = np.zeros(n_zones)
        if Sx is None:
            # weak/uninformative default: variance far larger than any
            # plausible signal, so the estimate is data-dominated.
            typical_scale = max(float(np.max(np.abs(y))), 1.0) if len(y) else 1.0
            Sx = np.eye(n_zones) * (1.0e6 * typical_scale) ** 2
        Sx_inv = np.linalg.inv(Sx)

        posterior_precision = H.T @ Sy_inv @ H + Sx_inv
        posterior_cov = np.linalg.inv(posterior_precision)
        x_hat = x_prior + posterior_cov @ H.T @ Sy_inv @ (y - H @ x_prior)

        marginal_std = np.sqrt(np.diag(posterior_cov))
        fit_residuals = y - H @ x_hat
        chi2_per_obs = float((fit_residuals**2 / sigma**2).sum() / len(y)) if len(y) else float("nan")

        return InversionResult(
            zone_names=[z.name for z in self.zones],
            x_hat=x_hat,
            posterior_cov=posterior_cov,
            marginal_std=marginal_std,
            fit_residuals=fit_residuals,
            chi2_per_obs=chi2_per_obs,
            H=H,
        )

    def species_advisory(self, transit_time_s: float, mixing_height_m: float) -> SpeciesAdvisory:
        """Uses ctm.deposition.deposition_rate -- the SAME function (and
        therefore the same v_dep/H_mix numbers) the forward model uses --
        never a duplicated half-life formula."""
        v_dep = self.city.species[self.species].v_dep_m_s
        k = deposition_rate(v_dep, mixing_height_m)
        half_life_s = float(np.log(2) / k) if k > 0 else float("inf")
        quasi_conservative = bool(transit_time_s < 0.1 * half_life_s)

        if quasi_conservative:
            message = (
                f"{self.species}: transit time {transit_time_s:.0f}s is short relative to its "
                f"deposition half-life {half_life_s:.0f}s -- transport-only loss is a reasonable "
                f"approximation, so interpreting x_hat as a primary-emission rate is defensible."
            )
        else:
            message = (
                f"{self.species}: transit time {transit_time_s:.0f}s is NOT short relative to its "
                f"deposition half-life {half_life_s:.0f}s. Species with fast non-transport chemistry "
                f"this model doesn't represent (e.g. NO<->NO2 photostationary cycling, SO2 oxidation) "
                f"will have x_hat entangled with processes outside this model's scope -- treat any "
                f"recovered rate as a screening-grade estimate only, not a validated primary-emission "
                f"inventory number."
            )

        return SpeciesAdvisory(
            species=self.species, half_life_s=half_life_s, transit_time_s=transit_time_s,
            quasi_conservative=quasi_conservative, message=message,
        )

    def screen_zones_by_backward_footprint(
        self,
        receptors: list[tuple[int, int]],
        wind_history,
        k_h_history,
        k_dep: float,
        dt: float,
        threshold: float = 1e-4,
        n_particles: int = 2000,
        seed=0,
    ) -> list[Zone]:
        """Cheap pre-filter: drop zones with negligible backward
        sensitivity to ANY of `receptors` BEFORE paying for the expensive
        per-zone forward unit-response runs in assemble_H. Pure compute
        optimisation -- does not change the physics of zones that remain.
        """
        from attribution.adjoint import AdjointTracer

        tracer = AdjointTracer(self.nx, self.ny, self._grid.dx, self._grid.dy)
        footprints = [
            tracer.trace(ri, rj, wind_history, k_h_history, k_dep, dt, n_particles=n_particles, seed=seed).interior_probability
            for (ri, rj) in receptors
        ]
        combined_footprint = np.maximum.reduce(footprints) if footprints else np.zeros((self.nx, self.ny))

        engine = EmissionEngine(self._grid, sources=[])
        kept = []
        for zone in self.zones:
            weights, total_area = engine.source_footprint_m2(self._make_source(zone))
            overlap = weights > 0
            sensitivity = float(combined_footprint[overlap].sum()) if np.any(overlap) else 0.0
            if sensitivity >= threshold:
                kept.append(zone)
        return kept
