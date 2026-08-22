"""ctm/emissions.py — point/area emission sources with diurnal profiles,
all as CITY CONFIG DATA (never hardcoded arrays), injected so that the
mass added over one step equals `E_rate * source_area * dt` EXACTLY --
mixing height cancels algebraically (see `inject()` below and CLAUDE.md,
"Emissions").

See CLAUDE.md: diurnal profiles are authored in LOCAL time. `inject()`
takes an explicit `hour_local` -- never `hour_utc`. A previous version
computed `hour_local` correctly but then called `inject(hour_utc=hour_utc)`,
firing every profile ~5.5h off wall-clock. Use `local_hour_from_utc()` with
the city's fractional `utc_offset_hours`, never a hardcoded `+5`
approximation.
"""
from __future__ import annotations

import copy

import numpy as np

from cities.loader import EmissionSource
from ctm.grid import CTMGrid


def local_hour_from_utc(utc_hour: float, utc_offset_hours: float) -> float:
    """Convert a UTC hour-of-day (0-23, may be fractional) to local
    hour-of-day (0-23, fractional) using the city's declared, fractional
    UTC offset (e.g. +5.5 for IST) -- never a hardcoded integer offset."""
    return (utc_hour + utc_offset_hours) % 24.0


class EmissionEngine:
    def __init__(self, grid: CTMGrid, sources: list[EmissionSource] | None = None):
        self.grid = grid
        if sources is None:
            sources = grid.city.emission_sources
        # Deep-copy: never share a mutable source list -- or the mutable
        # `rates` dict inside each source -- across engine instances.
        self.sources: list[EmissionSource] = copy.deepcopy(sources)

    def source_footprint_m2(self, source: EmissionSource) -> tuple[np.ndarray, float]:
        """(weights, total_area_m2): `weights` is an (nx, ny) array of this
        source's overlap area (m^2) with each grid cell, summing to exactly
        `total_area_m2` for a source fully inside the domain -- this exact
        partition is what makes injected mass algebraically equal
        `E_rate * source_area * dt` regardless of grid resolution."""
        grid = self.grid
        nx, ny = grid.nx, grid.ny
        weights = np.zeros((nx, ny), dtype=np.float64)

        if source.kind == "point":
            cell_area = grid.dx * grid.dy
            i, j = grid.latlon_to_cell(source.lat, source.lon)
            if 0 <= i < nx and 0 <= j < ny:
                weights[i, j] = cell_area
            return weights, cell_area

        if source.kind == "area":
            x0, y0 = grid.latlon_to_xy_m(source.lat_sw, source.lon_sw)
            x1, y1 = grid.latlon_to_xy_m(source.lat_ne, source.lon_ne)
            x0, x1 = sorted((x0, x1))
            y0, y1 = sorted((y0, y1))
            total_area = (x1 - x0) * (y1 - y0)

            i_lo = max(0, int(np.floor(x0 / grid.dx)))
            i_hi = min(nx, int(np.ceil(x1 / grid.dx)))
            j_lo = max(0, int(np.floor(y0 / grid.dy)))
            j_hi = min(ny, int(np.ceil(y1 / grid.dy)))

            for i in range(i_lo, i_hi):
                cell_x0, cell_x1 = i * grid.dx, (i + 1) * grid.dx
                overlap_x = min(x1, cell_x1) - max(x0, cell_x0)
                if overlap_x <= 0:
                    continue
                for j in range(j_lo, j_hi):
                    cell_y0, cell_y1 = j * grid.dy, (j + 1) * grid.dy
                    overlap_y = min(y1, cell_y1) - max(y0, cell_y0)
                    if overlap_y <= 0:
                        continue
                    weights[i, j] = overlap_x * overlap_y

            return weights, total_area

        raise ValueError(f"Unknown source kind: {source.kind!r}")

    def inject(self, hour_local: float, dt: float, mixing_height_m: float) -> dict[str, float]:
        """Inject all configured sources for one step, indexed by LOCAL
        hour (see module docstring -- never UTC). Returns injected mass per
        species (the analytic `E_rate * source_area * dt` total, useful for
        acceptance/regression testing)."""
        if mixing_height_m <= 0:
            raise ValueError(f"mixing_height_m must be > 0, got {mixing_height_m}")

        hour_index = int(hour_local) % 24
        cell_area = self.grid.dx * self.grid.dy

        injected_mass: dict[str, float] = {sp: 0.0 for sp in self.grid.species}
        deltas: dict[str, np.ndarray] = {
            sp: np.zeros((self.grid.nx, self.grid.ny), dtype=np.float64) for sp in self.grid.species
        }

        for source in self.sources:
            profile = self.grid.city.diurnal_profiles.get(source.profile)
            if profile is None:
                raise KeyError(
                    f"Emission source {source.name!r} references unknown diurnal profile {source.profile!r}"
                )
            scale = profile[hour_index]
            weights, total_area = self.source_footprint_m2(source)
            if total_area <= 0:
                continue

            for species, rate in source.rates.items():
                if species not in deltas:
                    continue  # species not tracked by this grid/city config
                effective_rate = rate * scale
                d_conc = effective_rate * dt * (weights / cell_area) / mixing_height_m
                deltas[species] += d_conc
                injected_mass[species] += effective_rate * total_area * dt

        for species, delta in deltas.items():
            if not np.any(delta):
                continue
            field = self.grid.get_field(species).astype(np.float64)
            self.grid.set_field(species, field + delta)

        return injected_mass
