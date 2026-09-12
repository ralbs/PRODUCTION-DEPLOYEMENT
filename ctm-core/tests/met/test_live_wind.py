"""Tests for met/live_wind.py.

Mocked-HTTP-boundary tests (requests_mock), matching the project's own
standard (see tests/scripts/test_source_direction_worker.py's module
docstring): known request -> known parsed output, without a live network
call. The real-shape response fixture below is the ACTUAL shape returned
by https://api.open-meteo.com/v1/forecast for lat=14.442/lon=79.986,
captured by a real GET during development (see met/live_wind.py's module
docstring for the verification details -- reachability, distance,
wind-direction-convention cross-check, units)."""
from __future__ import annotations

from datetime import datetime, timezone

import requests_mock as rm_module

from met.live_wind import LIVE_WIND_BASE_URL, fetch_live_wind_series

REAL_SHAPE_RESPONSE = {
    "latitude": 14.446397, "longitude": 79.99074,
    "current_units": {"time": "iso8601", "wind_speed_10m": "m/s", "wind_direction_10m": "°"},
    "current": {
        "time": "2026-09-12T08:45", "interval": 900,
        "wind_speed_10m": 0.75, "wind_direction_10m": 217,
        "temperature_2m": 37.2, "relative_humidity_2m": 40,
    },
    "hourly_units": {"time": "iso8601", "wind_speed_10m": "m/s", "wind_direction_10m": "°"},
    "hourly": {
        "time": ["2026-09-12T06:00", "2026-09-12T07:00", "2026-09-12T08:00", "2026-09-12T09:00"],
        "wind_speed_10m": [1.60, 3.75, 1.12, 0.74],
        "wind_direction_10m": [141, 121, 243, 200],
        "temperature_2m": [35.9, 33.9, 37.0, 37.1],
        "relative_humidity_2m": [43, 55, 41, 40],
    },
}


def test_fetch_live_wind_series_parses_real_shape_and_filters_to_window():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, json=REAL_SHAPE_RESPONSE)
        series = fetch_live_wind_series(14.442, 79.986, hours_back=1.0)

    # window ending at current.time=2026-09-12T08:45, 1h back -> only the
    # 08:00 hourly row falls in [07:45, 08:45]; 06:00/07:00/09:00 excluded.
    assert len(series) == 1
    ts, obs = series[0]
    assert ts == datetime(2026, 9, 12, 8, 0, tzinfo=timezone.utc)
    assert obs.wind_speed_m_s == 1.12
    assert obs.wind_dir_deg == 243
    assert obs.lat == 14.442 and obs.lon == 79.986  # real requested coordinate, not the model grid point


def test_fetch_live_wind_series_oldest_first_for_wider_window():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, json=REAL_SHAPE_RESPONSE)
        series = fetch_live_wind_series(14.442, 79.986, hours_back=2.5)

    timestamps = [ts for ts, _ in series]
    assert timestamps == sorted(timestamps)
    assert len(series) == 2  # window is [06:15, 08:45]; 06:00 falls just outside it, 07:00/08:00 inside


def test_fetch_live_wind_series_rejects_non_finite_rows():
    bad = {
        **REAL_SHAPE_RESPONSE,
        "hourly": {
            **REAL_SHAPE_RESPONSE["hourly"],
            "wind_speed_10m": [1.60, 3.75, None, 0.74],  # 08:00 row now missing
        },
    }
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, json=bad)
        series = fetch_live_wind_series(14.442, 79.986, hours_back=1.0)
    assert series == []  # the only row in-window was the rejected one


def test_fetch_live_wind_series_returns_empty_on_http_error():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, status_code=500)
        series = fetch_live_wind_series(14.442, 79.986)
    assert series == []


def test_fetch_live_wind_series_returns_empty_on_malformed_json():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, json={"unexpected": "shape"})
        series = fetch_live_wind_series(14.442, 79.986)
    assert series == []
