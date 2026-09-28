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
import requests
import requests_mock as rm_module

from cities.loader import load_city
from met.weather_station import StationObservation
from scripts.source_direction_worker import (
    fetch_spike_check,
    fetch_stations,
    load_nellore_wind_history,
    make_idempotency_key,
    build_run_record,
    post_run_record,
    post_source_direction,
    process_station,
    record_run,
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
# make_idempotency_key() -- must be deterministic so a retried POST after
# a read-timeout (see _build_session()'s retry-with-backoff) carries the
# SAME key both times, letting the backend's upsert overwrite one document
# instead of inserting a duplicate.
# ---------------------------------------------------------------------

def test_make_idempotency_key_is_deterministic_for_the_same_inputs():
    key1 = make_idempotency_key("NEL-001", "2025-08-15T12:00:00Z")
    key2 = make_idempotency_key("NEL-001", "2025-08-15T12:00:00Z")
    assert key1 == key2


def test_make_idempotency_key_differs_for_different_station_or_timestamp():
    base = make_idempotency_key("NEL-001", "2025-08-15T12:00:00Z")
    assert make_idempotency_key("NEL-002", "2025-08-15T12:00:00Z") != base
    assert make_idempotency_key("NEL-001", "2025-08-15T13:00:00Z") != base


def test_a_simulated_timeout_then_retry_sends_two_posts_with_the_same_idempotency_key():
    """The worker itself can't observe "one document, not two" -- that
    guarantee lives in the backend's unique-index + upsert (see
    backend/tests/source-direction.test.js's own version of this test).
    What the worker IS responsible for is sending the identical key on a
    retry after a timeout -- this proves that half of the contract: a
    dropped-response retry (simulated here as two separate calls, since
    the read-timeout itself happens after the server already received
    and processed the first request) posts the SAME idempotency_key both
    times, which is what makes the backend's dedup actually apply."""
    payload = {
        "station_id": "NEL-001",
        "idempotency_key": make_idempotency_key("NEL-001", "2025-08-15T12:00:00Z"),
    }
    with rm_module.Mocker() as m:
        m.post(
            "http://test-backend/api/source-direction/ingest",
            [
                {"exc": requests.exceptions.ReadTimeout},  # original attempt: server got it, response never arrived
                {"json": {"status": "success", "id": "abc"}, "status_code": 201},  # the retry
            ],
        )
        with pytest.raises(requests.exceptions.ReadTimeout):
            post_source_direction("http://test-backend", "WORKER-SOURCE-DIRECTION", "test-key", payload)
        resp = post_source_direction("http://test-backend", "WORKER-SOURCE-DIRECTION", "test-key", payload)

    assert resp.status_code == 201
    assert len(m.request_history) == 2
    assert m.request_history[0].json()["idempotency_key"] == m.request_history[1].json()["idempotency_key"]


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


# ---------------------------------------------------------------------
# process_station() skip reasons -- three different situations that must
# never read the same. Before this, a real provider failure (Open-Meteo
# 429s were observed for real from Render on 2026-09-27) produced the same
# "no real wind data covering..." string as an archive coverage gap, and a
# skip of any kind left the dashboard indistinguishable from "no spike".
# ---------------------------------------------------------------------
from met.live_wind import LIVE_WIND_BASE_URL  # noqa: E402

BASE = "http://test-backend"
STATION = {"station_id": "NEL-001", "device_id": "ESP32-001", "location": {"lat": 14.442, "lon": 79.986}}
SPIKE = {
    "station_id": "NEL-001", "is_spike": True, "actual_aqi": 180, "predicted_aqi": 90,
    "predicted_low": 70, "predicted_high": 110, "sigma": 20, "timestamp": "2025-08-15T12:00:00.000Z",
    "z": 4.5, "jump_aqi": 90,
}


def _run(m, *, spike, as_of, use_live_wind):
    m.get(f"{BASE}/api/forecast/spike-check", json=spike)
    return process_station(BASE, STATION, CITY, "WORKER-SOURCE-DIRECTION", "k", as_of,
                           use_live_wind=use_live_wind)


def test_skip_no_spike_reads_as_no_spike():
    with rm_module.Mocker() as m:
        out = _run(m, spike={**SPIKE, "is_spike": False}, as_of=datetime.now(timezone.utc), use_live_wind=True)
        assert not any(LIVE_WIND_BASE_URL in r.url for r in m.request_history), "must stop before any wind fetch"
    assert out["action"] == "skipped"
    assert out["reason"] == "no spike"
    assert "wind_failure_reason" not in out


def test_skip_live_wind_rate_limited_names_the_http_status():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, status_code=429, json={"error": True, "reason": "limit exceeded"})
        out = _run(m, spike=SPIKE, as_of=datetime.now(timezone.utc), use_live_wind=True)
        assert not any(r.method == "POST" for r in m.request_history), "a skip must never post an estimate"
    assert out["action"] == "skipped"
    assert out["reason"].startswith("no real wind data: provider_http_429")
    assert out["wind_failure_reason"] == "provider_http_429"


def test_skip_archive_without_coverage_says_so():
    # The committed archive covers 2025-08; 2030 has no rows.
    with rm_module.Mocker() as m:
        out = _run(m, spike=SPIKE, as_of=datetime(2030, 1, 1, 12, tzinfo=timezone.utc), use_live_wind=False)
    assert out["action"] == "skipped"
    assert out["reason"].startswith("no real wind data: window has no coverage")
    assert out["wind_failure_reason"] == "window has no coverage"


def test_the_three_skip_reasons_are_mutually_distinguishable():
    with rm_module.Mocker() as m:
        no_spike = _run(m, spike={**SPIKE, "is_spike": False}, as_of=datetime.now(timezone.utc), use_live_wind=True)
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, status_code=429)
        rate_limited = _run(m, spike=SPIKE, as_of=datetime.now(timezone.utc), use_live_wind=True)
    with rm_module.Mocker() as m:
        no_coverage = _run(m, spike=SPIKE, as_of=datetime(2030, 1, 1, 12, tzinfo=timezone.utc), use_live_wind=False)

    reasons = [no_spike["reason"], rate_limited["reason"], no_coverage["reason"]]
    assert len(set(reasons)) == 3
    # Different strings aren't enough (the old ones differed only by which
    # source they named): each must name ITS OWN cause, and only its own.
    assert "provider_http_429" in rate_limited["reason"]
    assert "no coverage" in no_coverage["reason"]
    assert "429" not in no_coverage["reason"] and "no coverage" not in rate_limited["reason"]
    assert "no spike" not in rate_limited["reason"] and "no spike" not in no_coverage["reason"]
    assert "wind" not in no_spike["reason"]


# ---------------------------------------------------------------------
# Run records -- the worker reports EVERY run, so the dashboard can tell
# "no spike" from "spike, but no wind" (backend/models/WorkerRun.js).
# Built here from REAL process_station() results, not hand-written dicts.
# ---------------------------------------------------------------------
RAN_AT = datetime(2026, 9, 27, 12, 0, 3, tzinfo=timezone.utc)


def test_run_record_no_spike():
    with rm_module.Mocker() as m:
        result = _run(m, spike={**SPIKE, "is_spike": False, "z": 2.8, "jump_aqi": 19.5}, as_of=datetime.now(timezone.utc), use_live_wind=True)
    rec = build_run_record(result, RAN_AT)
    assert rec == {
        "station_id": "NEL-001", "outcome": "skipped", "reason": "no spike",
        "wind_failure_reason": None, "spike_detected": False, "spike_timestamp": None,
        "spike_z": 2.8, "spike_jump_aqi": 19.5,  # a near-miss is still recorded
        "ran_at": "2026-09-27T12:00:03+00:00",
    }


def test_run_record_spike_but_wind_rate_limited():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, status_code=429)
        result = _run(m, spike=SPIKE, as_of=datetime.now(timezone.utc), use_live_wind=True)
    rec = build_run_record(result, RAN_AT)
    assert rec["outcome"] == "skipped"
    assert rec["spike_detected"] is True
    assert rec["spike_timestamp"] == SPIKE["timestamp"]
    assert (rec["spike_z"], rec["spike_jump_aqi"]) == (4.5, 90)
    assert rec["wind_failure_reason"] == "provider_http_429"
    assert rec["reason"].startswith("no real wind data: provider_http_429")


def test_run_record_spike_but_archive_no_coverage():
    with rm_module.Mocker() as m:
        result = _run(m, spike=SPIKE, as_of=datetime(2030, 1, 1, 12, tzinfo=timezone.utc), use_live_wind=False)
    rec = build_run_record(result, RAN_AT)
    assert rec["spike_detected"] is True
    assert rec["wind_failure_reason"] == "window has no coverage"


def test_run_record_not_enough_data_leaves_spike_unknown():
    with rm_module.Mocker() as m:
        m.get(f"{BASE}/api/forecast/spike-check", status_code=404, json={"error": "Not enough data"})
        result = process_station(BASE, STATION, CITY, "W", "k", datetime.now(timezone.utc), use_live_wind=True)
    rec = build_run_record(result, RAN_AT)
    assert rec["outcome"] == "skipped"
    assert rec["spike_detected"] is None  # the check couldn't run -- not "no spike"
    assert rec["spike_z"] is None and rec["spike_jump_aqi"] is None
    assert rec["reason"] == "not enough data for a spike check"


def test_run_record_post_failure_is_an_error_not_a_skip():
    rec = build_run_record({"station_id": "NEL-001", "action": "post_failed", "status_code": 500, "spike": SPIKE}, RAN_AT)
    assert rec["outcome"] == "error"
    assert rec["reason"] == "post_failed: HTTP 500"


# ---------------------------------------------------------------------
# Deploy-window compatibility: the backend and this cron worker redeploy
# independently, so for a while either can be the older one.
# ---------------------------------------------------------------------
# What a backend BEFORE the windowed rule returned (no z / jump_aqi).
OLD_SHAPE_SPIKE = {k: v for k, v in SPIKE.items() if k not in ("z", "jump_aqi")}
# What the per-pollutant backend returns: the same keys plus extras.
NEW_SHAPE_SPIKE = {
    **SPIKE, "rule": "windowed-per-pollutant", "pollutant": "no2", "sigma_unit": "ug/m3",
    "baseline_points": 60, "pollutants": {"pm2_5": {"z": 0.4, "jump_aqi": 1.0, "is_spike": False},
                                          "no2": {"z": 4.5, "jump_aqi": 90, "is_spike": True}},
}


def test_old_backend_response_still_makes_a_valid_run_record():
    for spike in ({**OLD_SHAPE_SPIKE, "is_spike": False}, OLD_SHAPE_SPIKE):
        with rm_module.Mocker() as m:
            m.get(LIVE_WIND_BASE_URL, status_code=429)
            result = _run(m, spike=spike, as_of=datetime.now(timezone.utc), use_live_wind=True)
        rec = build_run_record(result, RAN_AT)
        assert rec["spike_detected"] is spike["is_spike"]
        assert rec["spike_z"] is None and rec["spike_jump_aqi"] is None  # absent -> None, never a crash


def test_new_backend_response_extra_fields_are_ignored_by_the_record():
    with rm_module.Mocker() as m:
        m.get(LIVE_WIND_BASE_URL, status_code=429)
        result = _run(m, spike=NEW_SHAPE_SPIKE, as_of=datetime.now(timezone.utc), use_live_wind=True)
    rec = build_run_record(result, RAN_AT)
    assert (rec["spike_z"], rec["spike_jump_aqi"]) == (4.5, 90)
    assert set(rec) == {"station_id", "outcome", "reason", "wind_failure_reason", "spike_detected",
                        "spike_timestamp", "spike_z", "spike_jump_aqi", "ran_at"}


def test_ingest_payload_trigger_is_exactly_the_five_fields_for_either_shape():
    # Real archive window (2025-08) so the real tracer runs and a POST happens.
    for spike in (OLD_SHAPE_SPIKE, NEW_SHAPE_SPIKE):
        with rm_module.Mocker() as m:
            m.post(f"{BASE}/api/source-direction/ingest", status_code=201, json={"status": "success", "id": "x"})
            out = _run(m, spike=spike, as_of=datetime(2025, 8, 2, 0, 0, tzinfo=timezone.utc), use_live_wind=False)
            posts = [r for r in m.request_history if r.method == "POST"]
        assert out["action"] == "ingested", out
        trigger = posts[0].json()["trigger"]
        assert set(trigger) == {"actual_aqi", "predicted_aqi", "predicted_low", "predicted_high", "sigma"}
        assert all(isinstance(v, (int, float)) for v in trigger.values())


def test_post_run_record_uses_worker_auth_headers():
    with rm_module.Mocker() as m:
        m.post(f"{BASE}/api/source-direction/runs", status_code=201, json={"status": "success"})
        post_run_record(BASE, "WORKER-SOURCE-DIRECTION", "secret", {"station_id": "NEL-001"})
    assert m.last_request.headers["X-Device-Id"] == "WORKER-SOURCE-DIRECTION"
    assert m.last_request.headers["X-Device-Key"] == "secret"


def test_record_run_never_breaks_the_run(capsys):
    with rm_module.Mocker() as m:
        m.post(f"{BASE}/api/source-direction/runs", exc=requests.exceptions.ConnectionError)
        record_run(BASE, "W", "k", {"station_id": "NEL-001", "action": "skipped", "reason": "no spike"}, RAN_AT)
    assert "run record not stored" in capsys.readouterr().out
