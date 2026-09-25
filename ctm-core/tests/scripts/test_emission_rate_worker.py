"""Tests for scripts/emission_rate_worker.py.

Ordering matches PROMPT_FLOW_INTEGRATION.md's Phase I4 spec: a SYNTHETIC
known-answer recovery case first (ground truth generated through the
REAL, independent ctm.simulator.Simulator -- not SourceInversion's own
internal unit-response replica, so this doesn't validate the module
against itself), THEN a real-data check (real wind, real zone geometry,
confirms the pipeline produces a finite, well-conditioned result -- not
a claim about recovering any real-world truth, since none exists here).
"""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
import requests_mock as rm_module

from attribution.inverse import InversionObservation, SourceInversion, Zone
from cities.loader import EmissionSource, load_city
from ctm.grid import CTMGrid
from ctm.simulator import Simulator
from met.ingest_real_met import NELLORE_STATION_ID, NELLORE_STATION_LAT, NELLORE_STATION_LON, load_real_met_series
from scripts.emission_rate_worker import (
    MAX_ZONE_DISTANCE_M,
    MIN_ZONE_DISTANCE_M,
    ZoneOutOfRangeError,
    build_real_histories,
    compute_enhancement,
    fetch_telemetry_near,
    post_emission_rate,
    validate_zone_range,
    zone_distance_m,
)

CITY = load_city("live_deployment")
GRID = CTMGrid(CITY)
NEL_001_LAT, NEL_001_LON = 14.442, 79.986


# ---------------------------------------------------------------------
# Zone geometry / range validation -- pure, exact
# ---------------------------------------------------------------------

def test_zone_distance_matches_hand_computed_flat_earth_value():
    # 0.03 deg north of the sensor: 0.03 * 111320 = 3339.6m, exactly (same
    # flat-earth convention ctm/grid.py itself uses -- not haversine).
    d = zone_distance_m(GRID, NEL_001_LAT + 0.03, NEL_001_LON, NEL_001_LAT, NEL_001_LON)
    assert d == pytest.approx(0.03 * 111320.0, rel=1e-9)


@pytest.mark.parametrize("distance_m,should_raise", [(1999.0, True), (2000.0, False), (5000.0, False), (5001.0, True)])
def test_validate_zone_range_boundaries(distance_m, should_raise):
    if should_raise:
        with pytest.raises(ZoneOutOfRangeError):
            validate_zone_range(distance_m)
    else:
        validate_zone_range(distance_m)  # must not raise


def test_zone_range_constants_match_the_documented_tested_range():
    assert MIN_ZONE_DISTANCE_M == 2000.0
    assert MAX_ZONE_DISTANCE_M == 5000.0


# ---------------------------------------------------------------------
# compute_enhancement -- exact known arithmetic
# ---------------------------------------------------------------------

def test_compute_enhancement_subtracts_real_configured_background():
    doc = {"pollutants": {"pm2_5": 27.5}}
    background = CITY.species["pm25"].background_conc
    result = compute_enhancement(doc, "pm25", CITY)
    assert result == pytest.approx(27.5 - background)


def test_compute_enhancement_raises_on_missing_field():
    with pytest.raises(ValueError):
        compute_enhancement({"pollutants": {}}, "pm25", CITY)


# ---------------------------------------------------------------------
# HTTP-boundary functions -- mocked responses -> known expected outputs
# ---------------------------------------------------------------------

def test_fetch_telemetry_near_picks_the_closest_real_document():
    target = datetime(2025, 8, 1, 1, 0, tzinfo=timezone.utc)
    docs = [
        {"timestamp": "2025-08-01T00:45:00.000Z", "pollutants": {"pm2_5": 20.0}},
        {"timestamp": "2025-08-01T01:02:00.000Z", "pollutants": {"pm2_5": 30.0}},  # closest to target
        {"timestamp": "2025-08-01T01:20:00.000Z", "pollutants": {"pm2_5": 40.0}},
    ]
    with rm_module.Mocker() as m:
        m.get("http://test-backend/api/telemetry/history", json=docs)
        result = fetch_telemetry_near("http://test-backend", "NEL-001", target)
    assert result["pollutants"]["pm2_5"] == 30.0


def test_fetch_telemetry_near_returns_none_when_empty():
    with rm_module.Mocker() as m:
        m.get("http://test-backend/api/telemetry/history", json=[])
        result = fetch_telemetry_near("http://test-backend", "NEL-001", datetime.now(timezone.utc))
    assert result is None


def test_post_emission_rate_sends_device_auth_headers():
    with rm_module.Mocker() as m:
        m.post("http://test-backend/api/emission-rate/ingest", json={"status": "success"}, status_code=201)
        resp = post_emission_rate("http://test-backend", "WORKER-EMISSION-RATE", "test-key", {"station_id": "NEL-001"})
    assert resp.status_code == 201
    assert m.last_request.headers["X-Device-Id"] == "WORKER-EMISSION-RATE"
    assert m.last_request.headers["X-Device-Key"] == "test-key"


# ---------------------------------------------------------------------
# SYNTHETIC known-answer recovery -- ground truth from the REAL,
# independent Simulator (not SourceInversion's own internal replica).
# ---------------------------------------------------------------------

def _receptor_and_zone():
    # Zone ~2.9km from the real sensor, aligned with the real wind at the
    # test window's start hour (252 deg FROM -- see met/ingest_real_met.py's
    # committed data) so the plume actually reaches the receptor.
    rad = np.radians(252.0)
    dx_east = 2900.0 * np.sin(rad)
    dy_north = 2900.0 * np.cos(rad)
    rx, ry = GRID.latlon_to_xy_m(NEL_001_LAT, NEL_001_LON)
    zlat, zlon = GRID.xy_m_to_latlon(rx + dx_east, ry + dy_north)
    return zlat, zlon


def test_noiseless_recovery_is_accurate_across_a_day_night_stability_boundary():
    """Regression test for a real bug found via this exact scenario: an
    earlier build_real_histories() held ONE stability class (hour_local)
    for an entire real hour. This test's window (2025-08-01 00:00-02:00
    UTC = 05:30-07:30 IST) straddles the day/night boundary (hour_local
    crosses 6.0 partway through the first hour) -- with the bug, noiseless
    recovery was ~36% off true Q (0.0315 vs 0.05); fixed (hour_local now
    advances every sub-step, matching ctm.simulator.Simulator exactly),
    it's within ~0.01%. Uses NO noise specifically to isolate the forward-
    model consistency question from statistical estimation -- the noisy
    version of this same scenario is test_synthetic_known_answer_recovery_
    within_3_posterior_std below."""
    Q_TRUE = 0.05
    zlat, zlon = _receptor_and_zone()
    start = datetime(2025, 8, 1, 0, 0, tzinfo=timezone.utc)
    n_hours = 2
    steps_per_hour = int(round(3600.0 / CITY.dt_seconds))
    receptor_i, receptor_j = GRID.latlon_to_cell(NEL_001_LAT, NEL_001_LON)

    series, _ = load_real_met_series(
        [
            __import__("pathlib").Path(__file__).resolve().parents[2]
            / "data" / "raw" / "meteostat_nellore" / "43245_202508.csv"
        ],
        station_id=NELLORE_STATION_ID, lat=NELLORE_STATION_LAT, lon=NELLORE_STATION_LON,
    )
    series_by_ts = {ts: obs for ts, obs in series}

    known_source = EmissionSource(name="known-source", kind="point", profile="24h", rates={"pm25": Q_TRUE}, lat=zlat, lon=zlon)
    test_city = dataclasses.replace(CITY, emission_sources=[known_source])
    sim_with_zone = Simulator(test_city, hour_utc0=0.0)
    sim_control = Simulator(CITY, hour_utc0=0.0)

    true_enhancement_at = {}
    for h in range(n_hours):
        ts = start + timedelta(hours=h)
        obs = series_by_ts[ts]
        for _sub in range(steps_per_hour):
            sim_with_zone.step([obs])
            sim_control.step([obs])
        step_idx = (h + 1) * steps_per_hour - 1
        wv = float(sim_with_zone.grid.get_field("pm25")[receptor_i, receptor_j])
        cv = float(sim_control.grid.get_field("pm25")[receptor_i, receptor_j])
        true_enhancement_at[step_idx] = wv - cv

    wind_history, k_h_history, mixing_history, _ = build_real_histories(
        start + timedelta(hours=n_hours - 1), n_hours, CITY, GRID
    )
    zone = Zone(name="test-zone", kind="point", lat=zlat, lon=zlon)
    inv = SourceInversion(CITY, species="pm25", zones=[zone])
    observations = [
        InversionObservation(sensor_id="NEL-001", time_index=idx, enhancement=val)
        for idx, val in true_enhancement_at.items()
    ]
    H = inv.assemble_H(wind_history, k_h_history, mixing_history, observations)
    result = inv.solve(H, observations)

    rel_error = abs(result.x_hat[0] - Q_TRUE) / Q_TRUE
    print(f"\n[noiseless, dawn-crossing window] x_hat={result.x_hat[0]:.6f} Q_true={Q_TRUE} rel_error={rel_error:.4%}")
    assert rel_error < 0.05, (
        f"noiseless recovery off by {rel_error:.2%} across a day/night boundary -- "
        f"the stability-class-per-substep fix may have regressed"
    )


def test_synthetic_known_answer_recovery_within_3_posterior_std():
    Q_TRUE = 0.05  # pm25 rate-unit (ug_m3) / m^2 / s -- arbitrary, real-order-of-magnitude test value
    zlat, zlon = _receptor_and_zone()
    start = datetime(2025, 8, 1, 0, 0, tzinfo=timezone.utc)
    n_hours = 2
    steps_per_hour = int(round(3600.0 / CITY.dt_seconds))
    receptor_i, receptor_j = GRID.latlon_to_cell(NEL_001_LAT, NEL_001_LON)

    series, _ = load_real_met_series(
        [
            __import__("pathlib").Path(__file__).resolve().parents[2]
            / "data" / "raw" / "meteostat_nellore" / "43245_202508.csv"
        ],
        station_id=NELLORE_STATION_ID, lat=NELLORE_STATION_LAT, lon=NELLORE_STATION_LON,
    )
    series_by_ts = {ts: obs for ts, obs in series}

    known_source = EmissionSource(name="known-source", kind="point", profile="24h", rates={"pm25": Q_TRUE}, lat=zlat, lon=zlon)
    test_city = dataclasses.replace(CITY, emission_sources=[known_source])

    sim_with_zone = Simulator(test_city, hour_utc0=0.0)
    sim_control = Simulator(CITY, hour_utc0=0.0)  # CITY's own emission_sources is already empty -- a real control

    true_enhancement_at = {}
    for h in range(n_hours):
        ts = start + timedelta(hours=h)
        obs = series_by_ts[ts]
        for _sub in range(steps_per_hour):
            sim_with_zone.step([obs])
            sim_control.step([obs])
        step_idx = (h + 1) * steps_per_hour - 1
        with_zone_val = float(sim_with_zone.grid.get_field("pm25")[receptor_i, receptor_j])
        control_val = float(sim_control.grid.get_field("pm25")[receptor_i, receptor_j])
        true_enhancement_at[step_idx] = with_zone_val - control_val

    assert any(v > 0 for v in true_enhancement_at.values()), (
        "known source produced no enhancement at all at the receptor -- test geometry/wind is wrong, "
        "not just noisy"
    )

    sigma = CITY.sensors[0].species_error_sigma["pm25"]  # NEL-001, real config value
    rng = np.random.default_rng(12345)
    observations = []
    for step_idx, true_val in true_enhancement_at.items():
        noisy = true_val + rng.normal(0.0, sigma)
        observations.append(InversionObservation(sensor_id="NEL-001", time_index=step_idx, enhancement=noisy))

    wind_history, k_h_history, mixing_history, _ = build_real_histories(
        start + timedelta(hours=n_hours - 1), n_hours, CITY, GRID
    )

    zone = Zone(name="test-zone", kind="point", lat=zlat, lon=zlon)
    inv = SourceInversion(CITY, species="pm25", zones=[zone])  # fresh instance, doesn't know Q_TRUE
    H = inv.assemble_H(wind_history, k_h_history, mixing_history, observations)
    result = inv.solve(H, observations)

    print(f"\n[synthetic recovery] Q_true={Q_TRUE} x_hat={result.x_hat[0]:.6f} "
          f"marginal_std={result.marginal_std[0]:.6f} chi2_per_obs={result.chi2_per_obs:.4f}")

    assert np.isfinite(result.x_hat[0])
    assert result.marginal_std[0] > 0 and np.isfinite(result.marginal_std[0])
    assert abs(result.x_hat[0] - Q_TRUE) <= 3.0 * result.marginal_std[0], (
        f"recovered {result.x_hat[0]} not within 3 posterior std ({result.marginal_std[0]}) of true {Q_TRUE}"
    )


# ---------------------------------------------------------------------
# Real-data check -- real wind, real zone geometry, finite well-
# conditioned result. NOT a claim about recovering a real-world truth
# (no independently-known real emission event exists for this site).
# ---------------------------------------------------------------------

def test_real_wind_pipeline_produces_finite_well_conditioned_result():
    zlat, zlon = _receptor_and_zone()
    as_of_end = datetime(2025, 8, 1, 1, 0, tzinfo=timezone.utc)
    wind_history, k_h_history, mixing_history, steps_per_hour = build_real_histories(as_of_end, 2, CITY, GRID)

    zone = Zone(name="test-zone", kind="point", lat=zlat, lon=zlon)
    inv = SourceInversion(CITY, species="pm25", zones=[zone])
    # Plausible real-shaped enhancement values (same order of magnitude as
    # the Node test fixture) -- not fetched from a real telemetry document,
    # since no real telemetry exists at this real wind timestamp yet (see
    # module docstring's REAL DATA CONSTRAINT).
    observations = [
        InversionObservation(sensor_id="NEL-001", time_index=steps_per_hour - 1, enhancement=12.3),
        InversionObservation(sensor_id="NEL-001", time_index=2 * steps_per_hour - 1, enhancement=15.1),
    ]
    H = inv.assemble_H(wind_history, k_h_history, mixing_history, observations)
    result = inv.solve(H, observations)

    print(f"\n[real-data check] x_hat={result.x_hat[0]:.6f} marginal_std={result.marginal_std[0]:.6f} "
          f"H={H.tolist()} chi2_per_obs={result.chi2_per_obs:.4f}")

    assert np.all(np.isfinite(H))
    assert np.any(H > 0), "zero forward response at this real geometry/wind -- not well-conditioned"
    assert np.isfinite(result.x_hat[0])
    assert result.marginal_std[0] > 0 and np.isfinite(result.marginal_std[0])
    assert np.isfinite(result.chi2_per_obs)
