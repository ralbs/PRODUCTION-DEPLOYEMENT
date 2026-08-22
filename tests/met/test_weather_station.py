"""Tests for met/weather_station.py, per CLAUDE.md's "Meteorology"
acceptance criteria: reversible wind FROM-direction conversion, pre-IDW
NaN rejection, and a climatology fallback that never returns None."""
import math

import numpy as np
import pytest

from cities.loader import ClimatologyConfig
from met.weather_station import (
    StationObservation,
    interpolate_met,
    uv_from_wind_dir,
    wind_dir_from_uv,
)

from ..ctm._testutils import make_city
from ctm.grid import CTMGrid


def _old_buggy_dir_from_uv(u, v):
    """The historical bug (CLAUDE.md): `180 - atan2(u, v)` instead of
    `180 + atan2(u, v)`, kept ONLY here to demonstrate what it gets wrong."""
    return (180.0 - np.degrees(np.arctan2(u, v))) % 360.0


@pytest.mark.parametrize(
    "dir_from_deg",
    [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0],
)
def test_wind_direction_roundtrip_all_quadrants(dir_from_deg):
    speed = 6.0
    u, v = uv_from_wind_dir(speed, dir_from_deg)
    recovered_dir = wind_dir_from_uv(u, v)
    assert recovered_dir == pytest.approx(dir_from_deg, abs=1e-9)

    u2, v2 = uv_from_wind_dir(speed, recovered_dir)
    assert u2 == pytest.approx(u, abs=1e-9)
    assert v2 == pytest.approx(v, abs=1e-9)


def test_correct_formula_matches_claude_md_exactly():
    u, v = 3.0, 4.0
    expected = (180.0 + math.degrees(math.atan2(u, v))) % 360.0
    assert wind_dir_from_uv(u, v) == pytest.approx(expected)


def test_buggy_formula_mirrors_east_west_component():
    """Demonstrates the specific historical bug: for a pure eastward wind
    (u>0, v=0), the correct formula gives 270 (from the West); the buggy
    `180 - atan2(u,v)` formula gives 90 (from the East) -- mirrored."""
    u, v = 5.0, 0.0
    correct = wind_dir_from_uv(u, v)
    buggy = _old_buggy_dir_from_uv(u, v)

    assert correct == pytest.approx(270.0)
    assert buggy == pytest.approx(90.0)
    assert correct != pytest.approx(buggy)


def test_single_nan_station_does_not_poison_wind_field():
    city = make_city(nx=10, ny=10, dx=500.0, dy=500.0)
    grid = CTMGrid(city)

    good1 = StationObservation("S1", lat=city.domain.lat_sw + 0.01, lon=city.domain.lon_sw + 0.01,
                                wind_speed_m_s=3.0, wind_dir_deg=270.0, temp_c=28.0, rh_pct=55.0)
    good2 = StationObservation("S2", lat=city.domain.lat_sw + 0.02, lon=city.domain.lon_sw + 0.02,
                                wind_speed_m_s=3.2, wind_dir_deg=260.0, temp_c=29.0, rh_pct=50.0)
    nan_station = StationObservation("BAD", lat=city.domain.lat_sw + 0.015, lon=city.domain.lon_sw + 0.015,
                                      wind_speed_m_s=float("nan"), wind_dir_deg=200.0, temp_c=27.0, rh_pct=60.0)

    result_with_nan = interpolate_met([good1, good2, nan_station], grid, hour_local=10.0)
    result_without_nan = interpolate_met([good1, good2], grid, hour_local=10.0)

    assert result_with_nan["n_stations_used"] == 2
    assert not result_with_nan["fallback_to_climatology"]
    assert np.all(np.isfinite(result_with_nan["u"]))
    assert np.all(np.isfinite(result_with_nan["v"]))
    np.testing.assert_allclose(result_with_nan["u"], result_without_nan["u"])
    np.testing.assert_allclose(result_with_nan["v"], result_without_nan["v"])


def test_partial_nan_reading_drops_whole_station():
    city = make_city(nx=10, ny=10)
    grid = CTMGrid(city)
    good = StationObservation("S1", lat=city.domain.lat_sw + 0.01, lon=city.domain.lon_sw + 0.01,
                               wind_speed_m_s=3.0, wind_dir_deg=270.0, temp_c=28.0, rh_pct=55.0)
    only_rh_is_nan = StationObservation("BAD", lat=city.domain.lat_sw + 0.02, lon=city.domain.lon_sw + 0.02,
                                         wind_speed_m_s=3.0, wind_dir_deg=270.0, temp_c=28.0, rh_pct=float("nan"))

    result = interpolate_met([good, only_rh_is_nan], grid, hour_local=10.0)
    assert result["n_stations_used"] == 1


def test_all_invalid_stations_falls_back_to_climatology_and_returns_full_dict():
    city = make_city(nx=8, ny=8)
    climatology = ClimatologyConfig(
        default_wind_speed_m_s=2.5, default_wind_dir_deg=180.0, default_temp_c=30.0, default_rh_pct=45.0
    )
    grid = CTMGrid(city)
    all_bad = [
        StationObservation("BAD1", lat=12.0, lon=77.0, wind_speed_m_s=float("nan"), wind_dir_deg=0.0, temp_c=25.0, rh_pct=50.0),
        StationObservation("BAD2", lat=12.0, lon=77.0, wind_speed_m_s=1.0, wind_dir_deg=float("inf"), temp_c=25.0, rh_pct=50.0),
    ]

    result = interpolate_met(all_bad, grid, hour_local=14.0, climatology=climatology)

    assert result is not None
    for key in ("u", "v", "wind_speed_m_s", "wind_dir_from_deg", "temp_c", "rh_pct",
                "stability_class", "K_h", "mixing_height_m", "n_stations_used"):
        assert key in result

    assert result["fallback_to_climatology"] is True
    assert result["n_stations_used"] == 0
    assert result["K_h"] > 0
    assert result["mixing_height_m"] > 0
    assert np.all(result["wind_speed_m_s"] == 2.5)
    assert np.all(result["temp_c"] == 30.0)


def test_empty_station_list_falls_back_to_climatology():
    city = make_city(nx=6, ny=6)
    grid = CTMGrid(city)
    result = interpolate_met([], grid, hour_local=3.0)
    assert result["fallback_to_climatology"] is True
    assert result["mixing_height_m"] > 0


def test_stability_class_maps_to_k_h_in_spec_range():
    from met.weather_station import k_h_for_class, pasquill_gifford_class

    for wind_speed in (0.5, 2.5, 4.0, 5.5, 8.0):
        for hour in (2.0, 8.0, 12.0, 16.0, 22.0):
            cls = pasquill_gifford_class(wind_speed, hour)
            k_h = k_h_for_class(cls)
            assert 3.0 <= k_h <= 150.0


def test_mixing_height_day_grows_and_night_uses_wind_formula():
    from met.weather_station import mixing_height_m

    h_sunrise = mixing_height_m(hour_local=6.0, wind_speed_m_s=2.0)
    h_noon = mixing_height_m(hour_local=12.0, wind_speed_m_s=2.0)
    assert h_noon > h_sunrise

    h_night = mixing_height_m(hour_local=2.0, wind_speed_m_s=3.0)
    assert h_night == pytest.approx(50.0 + 30.0 * 3.0)
