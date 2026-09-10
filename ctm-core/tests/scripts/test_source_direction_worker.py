"""Tests for scripts/source_direction_worker.py.

Two kinds of test here, matching the CTM core's own testing standard:
- mocked-HTTP-boundary tests (requests_mock): known request -> known
  parsed output, proving the worker's real /api/stations,
  /api/forecast/spike-check, and /api/source-direction/ingest wiring is
  correct without a live server.
- an analytic-invariant test for run_adjoint_tracer(): a KNOWN uniform
  wind direction must produce a bearing pointing back the way the wind
  came FROM (the physically correct "upwind source" direction), within a
  tolerance appropriate for a stochastic particle trace -- not exact
  equality, the same standard ctm-core/CLAUDE.md requires of the
  adjoint/CTM acceptance tests.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
import requests_mock as rm_module

from cities.loader import load_city
from met.weather_station import StationObservation
from scripts.source_direction_worker import (
    fetch_spike_check,
    fetch_stations,
    load_nellore_wind_history,
    post_source_direction,
    run_adjoint_tracer,
    valid_stations,
)

CITY = load_city("live_deployment")


# ---------------------------------------------------------------------
# valid_stations() -- the device_id/location guard
# ---------------------------------------------------------------------

def test_valid_stations_drops_missing_device_id_and_location():
    stations = [
        {"station_id": "NEL-001", "device_id": "ESP32-001", "location": {"lat": 14.442, "lon": 79.986}},
        {"station_id": "NO-DEVICE", "device_id": None, "location": {"lat": 1.0, "lon": 1.0}},
        {"station_id": "NO-LOCATION", "device_id": "ESP32-002", "location": None},
        {"station_id": "PARTIAL-LOCATION", "device_id": "ESP32-003", "location": {"lat": None, "lon": 79.9}},
    ]
    result = valid_stations(stations)
    assert [s["station_id"] for s in result] == ["NEL-001"]


def test_valid_stations_empty_input_returns_empty():
    assert valid_stations([]) == []


# ---------------------------------------------------------------------
# HTTP-boundary functions -- mocked API responses -> known expected outputs
# ---------------------------------------------------------------------

def test_fetch_stations_parses_real_shape():
    real_shape_response = [
        {"station_id": "NEL-001", "device_id": "ESP32-001", "last_seen": "2026-09-08T20:45:00.000Z",
         "location": {"lat": 14.442, "lon": 79.986}},
    ]
    with rm_module.Mocker() as m:
        m.get("http://test-backend/api/stations", json=real_shape_response)
        result = fetch_stations("http://test-backend")
    assert result == real_shape_response


def test_fetch_spike_check_returns_none_on_404():
    with rm_module.Mocker() as m:
        m.get("http://test-backend/api/forecast/spike-check", status_code=404, json={"error": "Not enough data"})
        result = fetch_spike_check("http://test-backend", "NEL-001")
    assert result is None


def test_fetch_spike_check_parses_real_shape():
    real_shape_response = {
        "station_id": "NEL-001", "is_spike": True, "actual_aqi": 180, "predicted_aqi": 90,
        "predicted_low": 70, "predicted_high": 110, "sigma": 20, "timestamp": "2025-08-15T12:00:00.000Z",
    }
    with rm_module.Mocker() as m:
        m.get("http://test-backend/api/forecast/spike-check", json=real_shape_response)
        result = fetch_spike_check("http://test-backend", "NEL-001", lookback=168)
    assert result == real_shape_response
    assert m.last_request.qs == {"station_id": ["nel-001"], "lookback": ["168"]}


def test_post_source_direction_sends_device_auth_headers_not_station_id():
    with rm_module.Mocker() as m:
        m.post("http://test-backend/api/source-direction/ingest", json={"status": "success", "id": "abc"}, status_code=201)
        resp = post_source_direction("http://test-backend", "WORKER-SOURCE-DIRECTION", "test-key", {"station_id": "NEL-001"})
    assert resp.status_code == 201
    sent_headers = m.last_request.headers
    assert sent_headers["X-Device-Id"] == "WORKER-SOURCE-DIRECTION"
    assert sent_headers["X-Device-Key"] == "test-key"


# ---------------------------------------------------------------------
# load_nellore_wind_history() against the REAL committed 2025-08 data
# ---------------------------------------------------------------------

def test_load_nellore_wind_history_real_committed_data_known_window():
    # 2025-08-01T00:00 through 2025-08-02T00:00 UTC inclusive of both ends
    # is exactly 25 real hourly rows (00:00 day1 .. 00:00 day2) -- counted
    # directly against the committed file's known first rows.
    as_of = datetime(2025, 8, 2, 0, 0, tzinfo=timezone.utc)
    window = load_nellore_wind_history(as_of, wind_history_hours=24)
    assert len(window) == 25
    assert window[0][0] == datetime(2025, 8, 1, 0, 0, tzinfo=timezone.utc)
    assert window[-1][0] == as_of


def test_load_nellore_wind_history_outside_real_coverage_returns_empty():
    """The archive's real coverage ends 2025-10-15 (see met/ingest_real_met.py) --
    "now" (2026+) must honestly return no data, not fabricate anything."""
    as_of = datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc)
    window = load_nellore_wind_history(as_of, wind_history_hours=24)
    assert window == []


# ---------------------------------------------------------------------
# run_adjoint_tracer() -- analytic invariant: bearing must point back
# toward where a KNOWN uniform wind actually came from.
# ---------------------------------------------------------------------

def _synthetic_wind_window(dir_from_deg: float, speed_m_s: float, n_hours: int = 1):
    start = datetime(2025, 8, 1, 6, 0, tzinfo=timezone.utc)  # midday IST, avoids night-time K_h edge cases
    return [
        (
            start + timedelta(hours=h),
            StationObservation(
                "43245", lat=14.45, lon=79.9833,
                wind_speed_m_s=speed_m_s, wind_dir_deg=dir_from_deg, temp_c=30.0, rh_pct=50.0,
            ),
        )
        for h in range(n_hours)
    ]


@pytest.mark.parametrize(
    "dir_from_deg,expected_bearing_deg",
    [
        (90.0, 90.0),    # wind FROM the east -> upwind source is east of the receptor
        (270.0, 270.0),  # wind FROM the west -> upwind source is west of the receptor
        (0.0, 0.0),      # wind FROM the north -> upwind source is north of the receptor
    ],
)
def test_bearing_points_back_toward_known_wind_origin(dir_from_deg, expected_bearing_deg):
    # Domain center (~13.5km margin in every direction -- see cities/live_deployment.json's
    # _domain_verification note), and a short single-hour window at a modest real speed
    # (3 m/s * 3600s = 10.8km) specifically so backward-traced mass mostly stays IN the
    # domain -- this test is about verifying the bearing math, not about picking a
    # lookback long enough to be operationally realistic (that's a separate, real
    # limitation: see this domain's actual size vs typical multi-hour real wind speeds).
    from ctm.grid import CTMGrid
    grid = CTMGrid(CITY)
    receptor_lat, receptor_lon = grid.cell_to_latlon(CITY.domain.nx // 2, CITY.domain.ny // 2)
    wind_window = _synthetic_wind_window(dir_from_deg, speed_m_s=3.0)

    result = run_adjoint_tracer(CITY, receptor_lat, receptor_lon, wind_window, n_particles=4000, seed=1)

    assert result is not None
    assert result["bearing_deg"] is not None
    assert result["distance_m"] > 0
    # Circular difference, tolerant of the stochastic random-walk spread --
    # this is a direction-of-travel check, not exact-value equality (the
    # same standard ctm-core/CLAUDE.md uses for adjoint acceptance tests).
    diff = abs((result["bearing_deg"] - expected_bearing_deg + 180) % 360 - 180)
    assert diff < 25.0, f"bearing={result['bearing_deg']}, expected~={expected_bearing_deg}, diff={diff}"
    assert 0.0 <= result["confidence"] <= 1.0


def test_run_adjoint_tracer_returns_none_for_empty_wind_window():
    assert run_adjoint_tracer(CITY, 14.442, 79.986, []) is None


def test_run_adjoint_tracer_returns_none_for_receptor_outside_domain():
    far_away_lat, far_away_lon = 50.0, 50.0  # nowhere near live_deployment's domain
    wind_window = _synthetic_wind_window(90.0, 5.0)
    assert run_adjoint_tracer(CITY, far_away_lat, far_away_lon, wind_window) is None
