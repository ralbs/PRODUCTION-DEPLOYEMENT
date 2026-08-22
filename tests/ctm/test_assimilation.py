"""Tests for ctm/assimilation.py, per CLAUDE.md's "Assimilation" acceptance
criteria: simultaneous (never sequential) multi-observation OI, monotonic
convergence without overshoot for clustered observations, distance decay,
out-of-domain safety, and NaN rejection at QC."""
import numpy as np
import pytest

from cities.loader import AssimilationConfig, CityConfig, Domain, Sensor, SpeciesConfig
from ctm.assimilation import Observation, assimilate
from ctm.grid import CTMGrid

BACKGROUND = 10.0
SPECIES = "pm25"


def _make_city_with_sensors_at_center(
    nx=41,
    ny=41,
    dx=500.0,
    dy=500.0,
    background=BACKGROUND,
    bg_error_fraction=0.3,
    correlation_length_m=3000.0,
    localisation_radius_m=8000.0,
    n_sensors=4,
    sigma=1.0,
):
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=nx, ny=ny, dx=dx, dy=dy)
    species = {SPECIES: SpeciesConfig(name=SPECIES, unit="ug_m3", v_dep_m_s=0.0, background_conc=background)}
    # temp city (no sensors yet) purely to compute the center cell's lat/lon
    temp_city = CityConfig(
        city_name="Temp", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"flat": [1.0] * 24},
    )
    temp_grid = CTMGrid(temp_city)
    center_i, center_j = nx // 2, ny // 2
    center_lat, center_lon = temp_grid.cell_to_latlon(center_i, center_j)

    sensors = [
        Sensor(id=f"S{k}", lat=center_lat, lon=center_lon, type="test", species_error_sigma={SPECIES: sigma})
        for k in range(1, n_sensors + 1)
    ]
    assimilation = AssimilationConfig(
        bg_error_fraction=bg_error_fraction,
        correlation_length_m=correlation_length_m,
        localisation_radius_m=localisation_radius_m,
    )
    city = CityConfig(
        city_name="AssimTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"flat": [1.0] * 24}, sensors=sensors, assimilation=assimilation,
    )
    grid = CTMGrid(city)
    return city, grid, (center_i, center_j)


def _naive_sequential_oi(background_value, bg_error_fraction, obs_values, obs_sigma):
    """Reimplements the historical BUG described in CLAUDE.md: each
    innovation is computed against the ORIGINAL background, but the update
    is applied cumulatively -- double-correcting for clustered/co-located
    sensors. Kept ONLY in this test file, purely to document why
    simultaneous solving matters; never used in production code."""
    b = (bg_error_fraction * max(background_value, 1e-6)) ** 2
    x_a = background_value
    for y, sigma in zip(obs_values, obs_sigma):
        s = sigma**2
        gain = b / (b + s)
        innovation = y - background_value  # BUG: always against ORIGINAL background
        x_a += gain * innovation  # applied cumulatively
    return x_a


def test_simultaneous_oi_monotonic_no_overshoot_vs_naive_sequential_overshoot():
    """The exact CLAUDE.md acceptance test: 2 and then 4 identical
    co-located observations above background must converge monotonically
    toward the observed value, never past it -- and a naive sequential
    implementation of the SAME case must overshoot, to document why."""
    y_obs = 50.0
    sigma = 1.0
    bg_error_fraction = 0.3

    city, grid, (ci, cj) = _make_city_with_sensors_at_center(
        n_sensors=4, sigma=sigma, bg_error_fraction=bg_error_fraction
    )

    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))
    obs2 = [Observation(sensor_id="S1", value=y_obs), Observation(sensor_id="S2", value=y_obs)]
    diag2 = assimilate(city, grid, SPECIES, obs2)
    analysis_n2 = float(grid.get_field(SPECIES)[ci, cj])

    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))
    obs4 = [Observation(sensor_id=f"S{k}", value=y_obs) for k in range(1, 5)]
    diag4 = assimilate(city, grid, SPECIES, obs4)
    analysis_n4 = float(grid.get_field(SPECIES)[ci, cj])

    seq_n2 = _naive_sequential_oi(BACKGROUND, bg_error_fraction, [y_obs, y_obs], [sigma, sigma])
    seq_n4 = _naive_sequential_oi(BACKGROUND, bg_error_fraction, [y_obs] * 4, [sigma] * 4)

    print(
        f"\n[assimilation clustered-obs comparison] observed value y={y_obs}, background={BACKGROUND}\n"
        f"  SIMULTANEOUS (correct):  n=2 -> {analysis_n2:.4f}   n=4 -> {analysis_n4:.4f}   "
        f"(monotonically toward {y_obs}, never past it)\n"
        f"  NAIVE SEQUENTIAL (bug):  n=2 -> {seq_n2:.4f}   n=4 -> {seq_n4:.4f}   "
        f"(overshoots past {y_obs}, gets WORSE with more clustered obs)"
    )

    assert diag2["n_obs_used"] == 2
    assert diag4["n_obs_used"] == 4

    # Correct behaviour: monotonic approach, strictly bounded by the observation.
    assert BACKGROUND < analysis_n2 < y_obs
    assert BACKGROUND < analysis_n4 < y_obs
    assert analysis_n4 > analysis_n2

    # The naive sequential method reproduces exactly the bug CLAUDE.md warns about.
    assert seq_n2 > y_obs
    assert seq_n4 > y_obs
    assert seq_n4 > seq_n2  # overshoot compounds with more clustered obs, not converges


def test_correction_magnitude_decays_with_distance():
    city, grid, (ci, cj) = _make_city_with_sensors_at_center(n_sensors=1, sigma=1.0)
    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))

    field_before = grid.get_field(SPECIES).astype(np.float64).copy()
    assimilate(city, grid, SPECIES, [Observation(sensor_id="S1", value=50.0)])
    increment = grid.get_field(SPECIES).astype(np.float64) - field_before

    offsets = [o for o in (1, 3, 6, 10) if ci + o < grid.nx]
    mags = [abs(increment[ci + o, cj]) for o in offsets]
    print(f"\n[assimilation distance decay] |increment| at offsets {offsets} cells from obs: {mags}")

    assert increment[ci, cj] > 0
    for closer, farther in zip(mags, mags[1:]):
        assert farther < closer


def test_out_of_domain_observation_safely_ignored():
    city, grid, (ci, cj) = _make_city_with_sensors_at_center(n_sensors=1, sigma=1.0)
    far_sensor = Sensor(
        id="FAR", lat=city.domain.lat_sw - 5.0, lon=city.domain.lon_sw - 5.0,
        type="test", species_error_sigma={SPECIES: 1.0},
    )
    object.__setattr__(city, "sensors", list(city.sensors) + [far_sensor])

    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))
    diag = assimilate(city, grid, SPECIES, [Observation(sensor_id="FAR", value=999.0)])

    assert diag["n_obs_used"] == 0
    assert diag["n_obs_rejected_out_of_domain"] == 1
    assert diag["analysis_applied"] is False
    assert np.all(grid.get_field(SPECIES) == np.float32(BACKGROUND))


def test_nan_observation_rejected_without_corrupting_analysis():
    city, grid, (ci, cj) = _make_city_with_sensors_at_center(n_sensors=2, sigma=1.0)

    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))
    diag = assimilate(
        city, grid, SPECIES,
        [Observation(sensor_id="S1", value=50.0), Observation(sensor_id="S2", value=float("nan"))],
    )
    field_with_nan_rejected = grid.get_field(SPECIES).copy()

    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))
    assimilate(city, grid, SPECIES, [Observation(sensor_id="S1", value=50.0)])
    field_clean_only = grid.get_field(SPECIES).copy()

    print(f"\n[assimilation NaN QC] rejected={diag['n_obs_rejected_nonfinite']}, used={diag['n_obs_used']}")

    assert diag["n_obs_rejected_nonfinite"] == 1
    assert diag["n_obs_used"] == 1
    assert np.all(np.isfinite(field_with_nan_rejected))
    np.testing.assert_array_equal(field_with_nan_rejected, field_clean_only)


def test_unknown_sensor_id_rejected_gracefully():
    city, grid, _ = _make_city_with_sensors_at_center(n_sensors=1, sigma=1.0)
    grid.set_field(SPECIES, np.full((grid.nx, grid.ny), BACKGROUND, dtype=np.float32))
    diag = assimilate(city, grid, SPECIES, [Observation(sensor_id="NOT_A_REAL_SENSOR", value=50.0)])

    assert diag["n_obs_used"] == 0
    assert diag["n_obs_rejected_unknown_sensor"] == 1
    assert diag["analysis_applied"] is False
