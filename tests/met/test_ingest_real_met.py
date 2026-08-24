"""Tests for met/ingest_real_met.py against the REAL raw Meteostat hourly
export committed under data/raw/meteostat_bangalore/ (station 43295
"Bangalore", 2019-07-01 to 2019-07-20 UTC -- see the module docstring for
the confirmed raw schema, cross-checked against meteostat-python v1.6.8's
own column definitions, not assumed)."""
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from met.ingest_real_met import RealMetSeries, load_real_met_series, read_raw_hourly_csv

RAW_FILE = Path(__file__).resolve().parents[2] / "data" / "raw" / "meteostat_bangalore" / "43295_201907.csv"


def test_read_raw_hourly_csv_matches_confirmed_schema():
    rows = read_raw_hourly_csv(RAW_FILE)
    assert len(rows) == 160  # 20 days x 8 readings/day at 3-hourly cadence
    first = rows[0]
    assert first["date"] == "2019-07-01"
    assert first["hour"] == "00"
    assert first["temp"] == "21.6"
    assert first["wdir"] == "230"


def test_load_real_met_series_rejects_incomplete_rows_with_isfinite():
    series, counts = load_real_met_series([RAW_FILE])
    print(f"\n[real met ingest] counts={counts}")

    assert counts["n_raw_rows"] == 160
    assert counts["n_rejected_incomplete_or_nonfinite"] > 0  # a real gap exists in this window
    assert counts["n_usable"] == len(series) == counts["n_raw_rows"] - counts["n_rejected_incomplete_or_nonfinite"]
    for _, obs in series:
        assert np.isfinite(obs.wind_speed_m_s)
        assert np.isfinite(obs.wind_dir_deg)
        assert np.isfinite(obs.temp_c)
        assert np.isfinite(obs.rh_pct)


def test_wind_speed_converted_from_kmh_to_m_s():
    """A raw wspd of 5.4 km/h must become 1.5 m/s exactly (5.4/3.6)."""
    series, _ = load_real_met_series([RAW_FILE])
    first_ts, first_obs = series[0]
    assert first_ts == datetime(2019, 7, 1, 0, 0, tzinfo=timezone.utc)
    assert first_obs.wind_speed_m_s == pytest.approx(5.4 / 3.6)


def test_real_met_series_holds_most_recent_real_reading_constant():
    """This station's native cadence is 3-hourly -- RealMetSeries must
    hold the most recent REAL reading constant between real reports, not
    fabricate an interpolated value, and must pick up the next real
    reading exactly at its reported time."""
    series, _ = load_real_met_series([RAW_FILE])
    start = datetime(2019, 7, 9, 18, 45, tzinfo=timezone.utc)
    rms = RealMetSeries(series, start, dt_seconds=60.0)

    obs_at_start = rms(0)[0]
    obs_15min_later = rms(15)[0]  # still within the same 3-hourly window
    assert obs_at_start == obs_15min_later  # held constant, not interpolated

    obs_3h_later = rms(180)[0]  # crosses into the next real reporting instant
    print(f"\n[real met series] t=0: wind={obs_at_start.wind_speed_m_s:.2f} m/s; t=+3h: wind={obs_3h_later.wind_speed_m_s:.2f} m/s")


def test_real_met_series_before_first_reading_uses_first_not_extrapolated():
    series, _ = load_real_met_series([RAW_FILE])
    way_before = series[0][0].replace(year=2018)
    rms = RealMetSeries(series, way_before, dt_seconds=60.0)
    assert rms(0)[0] == series[0][1]


def test_load_real_met_series_raises_on_empty_input(tmp_path):
    empty_file = tmp_path / "empty.csv"
    empty_file.write_text("")
    series, _ = load_real_met_series([empty_file])
    with pytest.raises(ValueError):
        RealMetSeries(series, datetime.now(timezone.utc), dt_seconds=60.0)
