"""ctm/grid.py — the CTM's spatial grid and per-species concentration
fields, entirely parameterised by a CityConfig (see cities/loader.py).

See CLAUDE.md, "Multi-city from day one": no domain bound, species list,
or background concentration may be a Python constant here -- it all comes
from the city config passed into CTMGrid.
"""
from __future__ import annotations

from typing import Iterable

import numpy as np

from cities.loader import CityConfig

_METERS_PER_DEG_LAT = 111_320.0


class CTMGrid:
    """2D grid of per-species concentration fields, shape (nx, ny),
    C-contiguous float32, driven entirely by a CityConfig."""

    def __init__(self, city: CityConfig):
        self.city = city
        self.domain = city.domain
        self.nx = city.domain.nx
        self.ny = city.domain.ny
        self.dx = city.domain.dx
        self.dy = city.domain.dy
        self.lat_sw = city.domain.lat_sw
        self.lon_sw = city.domain.lon_sw
        # Reference longitude scale factor fixed at the domain's SW corner --
        # a flat local Cartesian approximation, adequate for a ~tens-of-km
        # urban domain (this is not a GIS-grade projection).
        self._m_per_deg_lon = _METERS_PER_DEG_LAT * np.cos(np.radians(self.lat_sw))

        self.species: list[str] = list(city.species.keys())
        self.fields: dict[str, np.ndarray] = {
            name: np.full((self.nx, self.ny), sp.background_conc, dtype=np.float32, order="C")
            for name, sp in city.species.items()
        }

    def background_conc(self, species: str) -> float:
        return self.city.species[species].background_conc

    def v_dep(self, species: str) -> float:
        return self.city.species[species].v_dep_m_s

    def get_field(self, species: str) -> np.ndarray:
        return self.fields[species]

    def set_field(self, species: str, values: Iterable) -> None:
        if species not in self.fields:
            raise KeyError(f"Unknown species {species!r}; configured species are {sorted(self.fields)}")
        arr = np.array(values, dtype=np.float32, order="C", copy=True)
        if arr.shape != (self.nx, self.ny):
            raise ValueError(
                f"set_field({species!r}): expected shape {(self.nx, self.ny)}, got {arr.shape}"
            )
        np.clip(arr, 0.0, None, out=arr)  # physical constraint: C >= 0
        self.fields[species] = arr

    def xy_m_to_latlon(self, x_m: float, y_m: float) -> tuple[float, float]:
        """Lat/lon at (x_m, y_m) meters from the domain's SW corner."""
        lat = self.lat_sw + y_m / _METERS_PER_DEG_LAT
        lon = self.lon_sw + x_m / self._m_per_deg_lon
        return lat, lon

    def latlon_to_xy_m(self, lat: float, lon: float) -> tuple[float, float]:
        """(x_m, y_m) meters from the domain's SW corner for (lat, lon)."""
        x_m = (lon - self.lon_sw) * self._m_per_deg_lon
        y_m = (lat - self.lat_sw) * _METERS_PER_DEG_LAT
        return x_m, y_m

    def cell_to_latlon(self, i: int, j: int) -> tuple[float, float]:
        """Lat/lon of the CENTER of cell (i, j)."""
        x_m = (i + 0.5) * self.dx
        y_m = (j + 0.5) * self.dy
        return self.xy_m_to_latlon(x_m, y_m)

    def latlon_to_cell(self, lat: float, lon: float) -> tuple[int, int]:
        """Index (i, j) of the cell whose center is nearest (lat, lon)."""
        x_m, y_m = self.latlon_to_xy_m(lat, lon)
        i = int(round(x_m / self.dx - 0.5))
        j = int(round(y_m / self.dy - 0.5))
        return i, j
