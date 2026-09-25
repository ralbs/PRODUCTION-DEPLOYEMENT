"""Tests for scripts/tracer_accuracy_harness.py.

The end-to-end test is the harness's own analytic check, in the spirit of
CLAUDE.md's testing philosophy: under a steady, spatially uniform wind the
answer is known in closed form -- a source directly UPWIND of the receptor
must be detected and the real tracer must point at it; a source directly
DOWNWIND can never reach the receptor and must produce zero rows (a true
negative, not a quietly-scored miss).
"""
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import tracer_accuracy_harness as h  # noqa: E402
from cities.loader import load_city  # noqa: E402
from met.weather_station import StationObservation  # noqa: E402


@pytest.mark.parametrize("est,true,expected", [
    (90.0, 90.0, 0.0), (350.0, 10.0, 20.0), (10.0, 350.0, 20.0), (0.0, 180.0, 180.0), (270.0, 45.0, 135.0),
])
def test_bearing_error_is_smallest_circular_angle(est, true, expected):
    assert h.bearing_error_deg(est, true) == pytest.approx(expected)


def test_placements_report_snapped_cell_geometry_not_requested():
    city = load_city("live_deployment")
    grid = h.CTMGrid(city)
    (p,) = h.make_placements(grid, 27, 27, [22.5], [2000.0])
    # 2000 m @ 22.5 deg -> (+765 m E, +1848 m N) -> rounds to (+2, +4) cells of 500 m.
    assert (p.i, p.j) == (29, 31)
    assert p.true_bearing_deg == pytest.approx(np.degrees(np.arctan2(1000.0, 2000.0)))
    assert p.distance_m == pytest.approx(np.hypot(1000.0, 2000.0))


def test_source_with_negligible_peak_is_skipped_not_promoted_to_detection():
    t0 = datetime(2025, 8, 1, tzinfo=timezone.utc)
    times = [t0 + timedelta(hours=k) for k in range(3)]
    placements = [h.Placement("strong", 0, 0, 0.0, 1.0), h.Placement("sliver", 0, 0, 90.0, 1.0)]
    series = {"strong": np.array([0.0, 5.0, 10.0]), "sliver": np.array([0.0, 0.0, 1e-6])}
    tracer = {ts: {"bearing_deg": 0.0, "confidence": 1.0, "estimate_tier": "interior"} for ts in times}
    rows = h.evaluate(placements, times, series, tracer, detect_frac=0.05)
    assert {r["source"] for r in rows} == {"strong"}


def test_steady_wind_upwind_source_found_downwind_source_never_detected():
    tracer_city = load_city("live_deployment")
    grid = h.CTMGrid(tracer_city)
    rec = next(s for s in tracer_city.sensors if s.id == "NEL-001")
    ri, rj = grid.latlon_to_cell(rec.lat, rec.lon)

    # Steady 3 m/s wind FROM the west (270): air moves east, so a source
    # west of the receptor (bearing 270) is upwind, one east (90) downwind.
    t0 = datetime(2025, 8, 1, 6, tzinfo=timezone.utc)
    wind = [
        (t0 + timedelta(hours=k),
         StationObservation("SYN", rec.lat, rec.lon, wind_speed_m_s=3.0, wind_dir_deg=270.0, temp_c=30.0, rh_pct=60.0))
        for k in range(8)
    ]

    def wind_loader(as_of, hours):  # same window rule as load_nellore_wind_history
        return [(ts, o) for ts, o in wind if as_of - timedelta(hours=hours) <= ts <= as_of]

    placements = h.make_placements(grid, ri, rj, [270.0, 90.0], [5000.0])
    upwind, downwind = placements
    with tempfile.TemporaryDirectory() as td:
        fwd_city = h.build_forward_city("live_deployment", placements, tracer_city.species["pm25"].v_dep_m_s, Path(td))
    times, series = h.forward_receptor_series(fwd_city, wind, ri, rj)

    assert series[upwind.name].max() > 0.0
    assert series[downwind.name].max() < 1e-6 * series[upwind.name].max()

    tracer_by_hour = h.run_tracer_per_hour(tracer_city, rec.lat, rec.lon, times, wind_loader)
    rows = h.evaluate(placements, times, series, tracer_by_hour, detect_frac=0.05)

    assert rows, "the upwind source must be detected under a steady wind that blows it onto the receptor"
    assert {r["source"] for r in rows} == {upwind.name}
    errs = [r["bearing_error_deg"] for r in rows]
    # The fallback tier quantises to 45 deg sectors, so half a sector is the
    # honest ceiling for a perfect answer; interior centroids should do better.
    assert max(errs) <= 22.5, errs
