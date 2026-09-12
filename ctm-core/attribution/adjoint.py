"""attribution/adjoint.py — backward Lagrangian dispersion tracer.

See CLAUDE.md, "Adjoint inverse layer", item 1. `AdjointTracer.trace()` is
a stochastic backward particle ensemble through STORED wind + diffusion
history (HYSPLIT/FLEXPART family). It answers "which upstream cells
influenced this receptor" -- a footprint / sensitivity distribution.

This is explicitly NOT source inversion. It does not estimate emission
strengths from observations; that is `attribution/inverse.py`
(`SourceInversion`), a later phase. It is also not forward tagged-tracer
attribution (`attribution/tagged_tracers.py`), which requires a KNOWN
inventory; this module needs no inventory at all, only stored transport
history.

Correctness details called out in CLAUDE.md, each with its own test:
- Backward-decay weighting is `weight *= exp(-k_dep * dt)` at EVERY
  backward step (an emission further in the past is MORE depleted before
  reaching the receptor). The wrong sign, `exp(+k_dep*dt)`, was shipped
  once and overweighted old sources ~32x for a 24h-old source.
- Open boundaries: particles that exit the domain are TERMINATED and
  their remaining weight is booked to an explicit `boundary_inflow_fraction`
  category -- never clipped (which pins weight on the edge cell) and never
  reflected (unphysical for an open urban domain).
- K_h used in the random walk comes from the SAME per-step history the
  forward model actually used (see ctm/simulator.py's k_h_history), never
  a hardcoded constant.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class AdjointResult:
    interior_probability: np.ndarray  # (nx, ny); + boundary_inflow_fraction == 1.0
    boundary_inflow_fraction: float
    n_particles: int
    n_steps_traced: int
    seed: object
    # Exiting-particle weight binned by compass sector (bearing FROM the
    # receptor TO the particle's position at the moment it exits the
    # domain), length `n_sectors`, summing to exactly `boundary_inflow_fraction`.
    # Sector k is centered on `k * (360/n_sectors)` degrees (sector 0 = due
    # north). When interior_probability is near-zero (the dominant real
    # failure mode at this project's domain size -- see
    # PROMPT_FLOW_INTEGRATION.md's 744-hour saturation finding), this is
    # the ONLY real directional signal left: which way the mass actually
    # left the domain, not nothing.
    boundary_exit_by_sector: np.ndarray


class AdjointTracer:
    def __init__(self, nx: int, ny: int, dx: float, dy: float):
        self.nx = nx
        self.ny = ny
        self.dx = dx
        self.dy = dy

    def trace(
        self,
        receptor_i: int,
        receptor_j: int,
        wind_history,
        k_h_history,
        k_dep: float,
        dt: float,
        n_particles: int = 2000,
        seed=0,
        n_sectors: int = 8,
    ) -> AdjointResult:
        """Backward-trace an ensemble of particles from receptor (i, j)
        through `wind_history`/`k_h_history` (both ordered OLDEST-first,
        exactly as ctm.simulator.Simulator accumulates them -- iterated
        here newest-first, i.e. backward in time from "now").
        """
        if not (0 <= receptor_i < self.nx and 0 <= receptor_j < self.ny):
            raise ValueError(
                f"receptor ({receptor_i}, {receptor_j}) is outside the grid "
                f"(0<=i<{self.nx}, 0<=j<{self.ny}) -- every other consumer of "
                f"CTMGrid.latlon_to_cell() in this codebase bounds-checks the "
                f"result before use (see ctm/assimilation.py, "
                f"attribution/inverse.py); an "
                f"out-of-domain receptor would otherwise silently report "
                f"~100% boundary_inflow_fraction, which looks like a valid "
                f"result rather than a caller bug."
            )
        wind_history = list(wind_history)
        k_h_history = list(k_h_history)
        if len(wind_history) != len(k_h_history):
            raise ValueError("wind_history and k_h_history must be aligned (same length)")

        rng = np.random.default_rng(seed)

        receptor_x = (receptor_i + 0.5) * self.dx
        receptor_y = (receptor_j + 0.5) * self.dy

        x = np.full(n_particles, receptor_x, dtype=np.float64)
        y = np.full(n_particles, receptor_y, dtype=np.float64)
        weight = np.full(n_particles, 1.0 / n_particles, dtype=np.float64)
        active = np.ones(n_particles, dtype=bool)

        interior_probability = np.zeros((self.nx, self.ny), dtype=np.float64)
        boundary_inflow_fraction = 0.0
        boundary_exit_by_sector = np.zeros(n_sectors, dtype=np.float64)
        sector_width_deg = 360.0 / n_sectors
        domain_x_max = self.nx * self.dx
        domain_y_max = self.ny * self.dy

        steps = list(zip(wind_history, k_h_history))
        for entry, k_h in reversed(steps):
            if not np.any(active):
                break

            # Backward-decay weighting: an emission further in the past is
            # MORE depleted before reaching the receptor -- correct sign.
            weight[active] *= np.exp(-k_dep * dt)

            u_field = np.asarray(entry["u"])
            v_field = np.asarray(entry["v"])
            active_idx = np.where(active)[0]
            idx_i = np.clip((x[active_idx] / self.dx).astype(int), 0, self.nx - 1)
            idx_j = np.clip((y[active_idx] / self.dy).astype(int), 0, self.ny - 1)
            u_local = u_field[idx_i, idx_j] if u_field.ndim == 2 else np.full(idx_i.shape, float(u_field))
            v_local = v_field[idx_i, idx_j] if v_field.ndim == 2 else np.full(idx_i.shape, float(v_field))

            # Backward advection: exact reverse of the forward displacement.
            dx_move = -u_local * dt
            dy_move = -v_local * dt

            # Random walk (turbulent diffusion), using THIS step's K_h --
            # never a hardcoded constant (see module docstring).
            sigma = np.sqrt(2.0 * k_h * dt)
            dx_diff = rng.normal(0.0, sigma, size=idx_i.shape) if sigma > 0 else 0.0
            dy_diff = rng.normal(0.0, sigma, size=idx_i.shape) if sigma > 0 else 0.0

            x[active_idx] += dx_move + dx_diff
            y[active_idx] += dy_move + dy_diff

            out_of_domain = (
                (x[active_idx] < 0)
                | (x[active_idx] >= domain_x_max)
                | (y[active_idx] < 0)
                | (y[active_idx] >= domain_y_max)
            )
            exited = active_idx[out_of_domain]
            if exited.size:
                boundary_inflow_fraction += float(weight[exited].sum())
                # Bearing FROM the receptor TO each exiting particle's
                # position at the moment it exits -- plain compass bearing
                # (0=N/90=E), the SAME convention
                # scripts/source_direction_worker.py's interior-centroid
                # bearing uses, NOT the meteorological wind FROM-direction
                # convention (that's wind_dir_from_uv, deliberately
                # different -- see met/weather_station.py).
                dx_east = x[exited] - receptor_x
                dy_north = y[exited] - receptor_y
                bearing_deg = np.degrees(np.arctan2(dx_east, dy_north)) % 360.0
                sector_idx = np.round(bearing_deg / sector_width_deg).astype(int) % n_sectors
                np.add.at(boundary_exit_by_sector, sector_idx, weight[exited])
                active[exited] = False

        remaining = np.where(active)[0]
        if remaining.size:
            fi = np.clip((x[remaining] / self.dx).astype(int), 0, self.nx - 1)
            fj = np.clip((y[remaining] / self.dy).astype(int), 0, self.ny - 1)
            np.add.at(interior_probability, (fi, fj), weight[remaining])

        return AdjointResult(
            interior_probability=interior_probability,
            boundary_inflow_fraction=boundary_inflow_fraction,
            n_particles=n_particles,
            n_steps_traced=len(steps),
            seed=seed,
            boundary_exit_by_sector=boundary_exit_by_sector,
        )

    def trace_ensemble(
        self,
        receptor_i: int,
        receptor_j: int,
        wind_history,
        k_h_history,
        k_dep: float,
        dt: float,
        n_particles: int = 2000,
        n_members: int = 10,
        seed=0,
    ) -> dict:
        """Runs `n_members` independent traces (via `SeedSequence.spawn`,
        never a fixed/repeated seed) and reports the ensemble spread
        directly -- a fixed-seed "ensemble" would have zero spread by
        construction and is not an uncertainty estimate."""
        child_seeds = np.random.SeedSequence(seed).spawn(n_members)
        members = [
            self.trace(
                receptor_i, receptor_j, wind_history, k_h_history, k_dep, dt,
                n_particles=n_particles, seed=child_seeds[m],
            )
            for m in range(n_members)
        ]
        boundary_fracs = np.array([m.boundary_inflow_fraction for m in members])
        stacked = np.stack([m.interior_probability for m in members], axis=0)
        return {
            "members": members,
            "boundary_inflow_fraction_mean": float(boundary_fracs.mean()),
            "boundary_inflow_fraction_std": float(boundary_fracs.std()),
            "interior_probability_mean": stacked.mean(axis=0),
            "interior_probability_std": stacked.std(axis=0),
        }
