"""Tests for ctm/emissions.py, per CLAUDE.md's "Emissions" acceptance
criteria: exact mass injection, correct LOCAL-hour diurnal indexing, and no
shared mutable source state across engine instances."""
import copy

import numpy as np
import pytest

from cities.loader import EmissionSource
from ctm.emissions import EmissionEngine, local_hour_from_utc
from ctm.grid import CTMGrid

from ._testutils import make_city


def _make_engine_with_area_source(nx=20, ny=20, dx=500.0, dy=500.0, rate=0.05, i0=2, i1=6, j0=3, j1=7, background=0.0):
    """Area source spanning an EXACT whole-cell range [i0, i1) x [j0, j1),
    so overlap-area rasterization is trivial (no partial cells) -- good for
    a first, crisp acceptance check. background defaults to 0.0: measuring
    the injected delta against a nonzero background suffers float32
    catastrophic cancellation (~1e-7 relative to the LARGE background, not
    to the small delta) and is not what these tests are checking."""
    city = make_city(nx=nx, ny=ny, dx=dx, dy=dy, background=background)
    grid = CTMGrid(city)
    lat_sw, lon_sw = grid.xy_m_to_latlon(i0 * dx, j0 * dy)
    lat_ne, lon_ne = grid.xy_m_to_latlon(i1 * dx, j1 * dy)
    source = EmissionSource(
        name="test_area",
        kind="area",
        profile="flat",
        rates={"test": rate},
        lat_sw=lat_sw,
        lon_sw=lon_sw,
        lat_ne=lat_ne,
        lon_ne=lon_ne,
    )
    engine = EmissionEngine(grid, sources=[source])
    expected_area = (i1 - i0) * dx * (j1 - j0) * dy
    return grid, engine, expected_area


def test_injected_mass_matches_analytic_area_source_cell_aligned():
    dt, mixing_height = 60.0, 500.0
    rate = 0.05
    grid, engine, expected_area = _make_engine_with_area_source(rate=rate)

    field_before = grid.get_field("test").astype(np.float64).copy()
    injected = engine.inject(hour_local=8.0, dt=dt, mixing_height_m=mixing_height)

    expected_mass = rate * expected_area * dt  # "flat" profile normalises to scale 1
    assert injected["test"] == pytest.approx(expected_mass, rel=1e-12)

    field_after = grid.get_field("test").astype(np.float64)
    delta_conc = field_after - field_before
    mass_added_to_grid = (delta_conc * grid.dx * grid.dy * mixing_height).sum()
    rel_err = abs(mass_added_to_grid - expected_mass) / expected_mass
    print(f"\n[emissions area source, cell-aligned] mass relative error: {rel_err:.2e}")
    assert rel_err < 1e-5  # float32 grid storage rounding of the delta itself (background=0)


def test_injected_mass_matches_analytic_area_source_partial_cell_overlap():
    """Box deliberately NOT aligned to cell boundaries -- proves the
    overlap-area rasterization still conserves total mass exactly even
    when a source straddles cell edges."""
    nx, ny, dx, dy = 20, 20, 500.0, 500.0
    rate = 0.08
    dt, mixing_height = 90.0, 400.0

    city = make_city(nx=nx, ny=ny, dx=dx, dy=dy, background=0.0)
    grid = CTMGrid(city)
    # box from (2.3*dx, 3.7*dy) to (5.6*dx, 6.2*dy) -- straddles cell edges
    x0, y0 = 2.3 * dx, 3.7 * dy
    x1, y1 = 5.6 * dx, 6.2 * dy
    lat_sw, lon_sw = grid.xy_m_to_latlon(x0, y0)
    lat_ne, lon_ne = grid.xy_m_to_latlon(x1, y1)
    source = EmissionSource(
        name="partial", kind="area", profile="flat", rates={"test": rate},
        lat_sw=lat_sw, lon_sw=lon_sw, lat_ne=lat_ne, lon_ne=lon_ne,
    )
    engine = EmissionEngine(grid, sources=[source])

    field_before = grid.get_field("test").astype(np.float64).copy()
    injected = engine.inject(hour_local=8.0, dt=dt, mixing_height_m=mixing_height)

    expected_area = (x1 - x0) * (y1 - y0)
    expected_mass = rate * expected_area * dt
    assert injected["test"] == pytest.approx(expected_mass, rel=1e-12)

    field_after = grid.get_field("test").astype(np.float64)
    mass_added_to_grid = ((field_after - field_before) * dx * dy * mixing_height).sum()
    rel_err = abs(mass_added_to_grid - expected_mass) / expected_mass
    print(f"[emissions area source, partial overlap] mass relative error: {rel_err:.2e}")
    assert rel_err < 1e-5


def test_point_source_injects_mass_equal_to_rate_times_cell_area():
    nx, ny, dx, dy = 20, 20, 500.0, 500.0
    rate = 0.03
    dt, mixing_height = 60.0, 500.0

    city = make_city(nx=nx, ny=ny, dx=dx, dy=dy, background=8.0)
    grid = CTMGrid(city)
    lat, lon = grid.cell_to_latlon(10, 10)
    source = EmissionSource(name="pt", kind="point", profile="flat", rates={"test": rate}, lat=lat, lon=lon)
    engine = EmissionEngine(grid, sources=[source])

    injected = engine.inject(hour_local=8.0, dt=dt, mixing_height_m=mixing_height)
    expected_mass = rate * (dx * dy) * dt
    assert injected["test"] == pytest.approx(expected_mass, rel=1e-12)


def test_mixing_height_cancels_algebraically():
    """Injected mass (E_rate * area * dt) must not depend on mixing height
    -- only the concentration delta does."""
    grid, engine, expected_area = _make_engine_with_area_source(rate=0.05)
    mass_h200 = engine.inject(hour_local=8.0, dt=60.0, mixing_height_m=200.0)["test"]

    grid2, engine2, _ = _make_engine_with_area_source(rate=0.05)
    mass_h2000 = engine2.inject(hour_local=8.0, dt=60.0, mixing_height_m=2000.0)["test"]

    assert mass_h200 == pytest.approx(mass_h2000, rel=1e-12)


def test_diurnal_profile_indexed_by_local_hour_not_flat():
    nx, ny, dx, dy = 10, 10, 500.0, 500.0
    city = make_city(nx=nx, ny=ny, dx=dx, dy=dy, background=0.0)
    # override diurnal_profiles with a distinct, non-flat, mean-1 profile
    profile = [0.1] * 6 + [2.0] * 12 + [0.1] * 6  # low at night, high midday
    mean = sum(profile) / 24
    normalised = [v / mean for v in profile]
    object.__setattr__(city, "diurnal_profiles", {"rush": normalised})

    grid = CTMGrid(city)
    lat, lon = grid.cell_to_latlon(5, 5)
    source = EmissionSource(name="pt", kind="point", profile="rush", rates={"test": 1.0}, lat=lat, lon=lon)
    engine = EmissionEngine(grid, sources=[source])

    mass_night = engine.inject(hour_local=2.0, dt=60.0, mixing_height_m=500.0)["test"]
    mass_midday = engine.inject(hour_local=12.0, dt=60.0, mixing_height_m=500.0)["test"]

    assert mass_midday > mass_night
    ratio = mass_midday / mass_night
    assert ratio == pytest.approx(20.0, rel=1e-9)  # 2.0/0.1 exactly, both scaled by the same normalisation


def test_local_hour_from_utc_uses_fractional_offset():
    # Bangalore-like IST offset (+5.5): UTC 20:00 -> local 01:30 next day
    assert local_hour_from_utc(20.0, 5.5) == pytest.approx(1.5)
    # A naive hardcoded "+5" approximation would give 1.0, not 1.5 -- confirm
    # our result is NOT the naive-rounded value.
    assert local_hour_from_utc(20.0, 5.5) != pytest.approx(1.0)

    # negative (US Eastern-like) offset
    assert local_hour_from_utc(3.0, -5.0) == pytest.approx(22.0)

    # wraps correctly at the 24h boundary
    assert local_hour_from_utc(23.0, 5.5) == pytest.approx(4.5)


def test_engine_deep_copies_sources_no_shared_mutable_state():
    city = make_city()
    grid1 = CTMGrid(city)
    grid2 = CTMGrid(city)
    shared_source = EmissionSource(name="shared", kind="point", profile="flat", rates={"test": 1.0}, lat=12.0, lon=77.0)
    default_sources = [shared_source]

    engine1 = EmissionEngine(grid1, sources=default_sources)
    engine2 = EmissionEngine(grid2, sources=default_sources)

    # mutate one engine's source rates in place
    engine1.sources[0].rates["test"] = 999.0

    assert engine2.sources[0].rates["test"] == 1.0
    assert default_sources[0].rates["test"] == 1.0  # caller's original list untouched too


def test_engine_defaults_to_deep_copy_of_city_sources():
    city = make_city()
    object.__setattr__(
        city,
        "emission_sources",
        [EmissionSource(name="default", kind="point", profile="flat", rates={"test": 1.0}, lat=12.0, lon=77.0)],
    )
    grid = CTMGrid(city)
    engine = EmissionEngine(grid)  # sources=None -> defaults from city config
    engine.sources[0].rates["test"] = 42.0
    assert city.emission_sources[0].rates["test"] == 1.0
