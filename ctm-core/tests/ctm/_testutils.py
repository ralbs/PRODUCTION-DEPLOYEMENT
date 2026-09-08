"""Shared helpers for ctm/* tests. Not a test module itself (no test_
prefix), so pytest won't try to collect it."""
from __future__ import annotations

import numpy as np

from cities.loader import CityConfig, Domain, SpeciesConfig


def make_city(
    nx=80,
    ny=80,
    dx=500.0,
    dy=500.0,
    lat_sw=12.834,
    lon_sw=77.470,
    background=10.0,
    v_dep=0.0,
    species_name="test",
):
    """Build a minimal synthetic CityConfig directly (bypassing JSON) so
    ctm/* tests can control exact domain/species parameters without
    depending on -- or accidentally hardcoding assumptions from -- any
    particular real city config."""
    domain = Domain(lat_sw=lat_sw, lon_sw=lon_sw, nx=nx, ny=ny, dx=dx, dy=dy)
    species = {
        species_name: SpeciesConfig(
            name=species_name, unit="ug_m3", v_dep_m_s=v_dep, background_conc=background
        )
    }
    return CityConfig(
        city_name="TestCity",
        domain=domain,
        utc_offset_hours=0.0,
        species=species,
        diurnal_profiles={"flat": [1.0] * 24},
    )


def gaussian_blob(nx, ny, x0, y0, sigma, amplitude=1.0):
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")
    return amplitude * np.exp(-((ii - x0) ** 2 + (jj - y0) ** 2) / (2 * sigma**2))
