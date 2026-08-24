"""met/ingest_real_met.py — ingest real historical meteorology (station
43295 "Bangalore", WMO/Meteostat) into the StationObservation sequence
ctm.simulator.Simulator / scripts.hindcast_harness.run_hindcast() expect.

Every prior real-data validation in this project used the climatology
FALLBACK for wind (a documented, non-real constant approximation) --
meaning transport (advection/diffusion) was never actually tested against
reality. This module closes that gap with genuinely real historical wind.

SOURCE (confirmed real, publicly downloadable, no API key/account needed
-- verified by direct download and cross-checked against the meteostat-
python library's own v1.6.8 source for the exact column schema, not
assumed): Meteostat's public bulk data archive,
https://bulk.meteostat.net/v2/hourly/<station_id>.csv.gz -- an anonymous
HTTPS GET, same access model as OpenAQ's public S3 archive used
elsewhere in this project. Station 43295 ("Bangalore", WMO station,
lat=12.9667 lon=77.5833, elevation 920m) has confirmed hourly coverage
1973-01-01 through 2025-06, comfortably covering the 2019-07-09 to
2019-07-17 window used by data/processed/bangalore_openaq_20190710_20190716.csv.

CONFIRMED RAW SCHEMA (no header row; verified against meteostat-python
v1.6.8's Hourly._columns, and against the actual downloaded file):

    date,hour,temp,dwpt,rhum,prcp,snow,wdir,wspd,wpgt,pres,tsun,coco
    2019-07-09,00,20.0,17.7,90,,,230,7.6,,,,

  - `date` is YYYY-MM-DD, `hour` is a zero-padded UTC hour (00,03,06,...);
    for this station the native reporting resolution is 3-HOURLY, not
    hourly (a real synoptic/METAR reporting cadence) -- there is no data
    to interpolate between real reports at finer resolution, so this
    module holds the most recent real reading constant until the next
    one arrives (the standard, honest treatment of sparse synoptic obs),
    rather than fabricating an interpolated finer-grained series.
  - Confirmed UTC (meteostat-python's own Hourly.fetch() converts a
    caller-supplied LOCAL start/end range to UTC via
    `timezone.localize(...).astimezone(pytz.utc)` before querying --
    i.e. the underlying stored/queried timestamps are UTC).
  - `temp`, `dwpt` in degrees Celsius; `rhum` in percent; `wdir` in
    degrees (meteorological FROM-direction, the SAME convention
    StationObservation.wind_dir_deg already uses -- no conversion
    needed); `wspd`, `wpgt` in km/h (DOES need /3.6 to reach this
    project's m/s convention); `pres` in hPa; `tsun` in minutes; `coco`
    a weather-condition code. `prcp`/`snow`/`wpgt`/`pres`/`tsun`/`coco`
    are not used by StationObservation and are ignored here.
  - Missing values are empty CSV fields. One real gap was found in the
    target week (2019-07-15 12:00 UTC has no temp/rhum/wspd, only a
    wdir=20 reading inconsistent with the surrounding ~230 deg pattern,
    itself likely also a bad/flagged report) -- rejected via the SAME
    np.isfinite() primitive used at every other ingestion boundary in
    this project, not a new QC path.
"""
from __future__ import annotations

import csv
import gzip
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from met.weather_station import StationObservation

_COLUMNS = ["date", "hour", "temp", "dwpt", "rhum", "prcp", "snow", "wdir", "wspd", "wpgt", "pres", "tsun", "coco"]
_KMH_TO_M_S = 1.0 / 3.6

STATION_ID = "43295"
STATION_NAME = "Bangalore (WMO 43295)"
STATION_LAT = 12.9667
STATION_LON = 77.5833


def read_raw_hourly_csv(path: str | Path) -> list[dict]:
    """Read one Meteostat bulk hourly .csv or .csv.gz file (the confirmed
    schema documented above; no header row) into dict rows."""
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", newline="", encoding="utf-8") as f:
        return [dict(zip(_COLUMNS, row)) for row in csv.reader(f) if row]


def _parse_row(row: dict) -> tuple[datetime, float, float, float, float] | None:
    """Returns (timestamp_utc, wind_speed_m_s, wind_dir_deg, temp_c,
    rh_pct) for one raw row, or None if any required field is missing/
    non-finite -- rejected with the same np.isfinite() primitive used
    everywhere else in this project, before any other processing."""
    try:
        timestamp = datetime.strptime(f"{row['date']} {row['hour']}", "%Y-%m-%d %H").replace(tzinfo=timezone.utc)
    except ValueError:
        return None

    def _to_float(s: str) -> float:
        try:
            return float(s)
        except (ValueError, TypeError):
            return float("nan")

    temp_c = _to_float(row["temp"])
    rh_pct = _to_float(row["rhum"])
    wdir_deg = _to_float(row["wdir"])
    wspd_kmh = _to_float(row["wspd"])

    if not all(np.isfinite(v) for v in (temp_c, rh_pct, wdir_deg, wspd_kmh)):
        return None

    return timestamp, wspd_kmh * _KMH_TO_M_S, wdir_deg, temp_c, rh_pct


def load_real_met_series(paths: list[str | Path]) -> tuple[list[tuple[datetime, StationObservation]], dict]:
    """Ingest raw Meteostat file(s) into a time-ordered list of (utc
    timestamp, StationObservation), rejecting non-finite/incomplete rows.
    Returns `(series, counts)` -- `series` holds only the REAL reporting
    instants (3-hourly here); callers needing a value at an arbitrary
    step should use `RealMetSeries` below, which holds the most recent
    real reading constant rather than fabricating interpolation.
    """
    rows: list[dict] = []
    for path in paths:
        rows.extend(read_raw_hourly_csv(path))

    series: list[tuple[datetime, StationObservation]] = []
    counts = {"n_raw_rows": len(rows), "n_rejected_incomplete_or_nonfinite": 0, "n_usable": 0}
    for row in rows:
        parsed = _parse_row(row)
        if parsed is None:
            counts["n_rejected_incomplete_or_nonfinite"] += 1
            continue
        timestamp, wind_speed_m_s, wind_dir_deg, temp_c, rh_pct = parsed
        series.append((
            timestamp,
            StationObservation(
                STATION_ID, lat=STATION_LAT, lon=STATION_LON,
                wind_speed_m_s=wind_speed_m_s, wind_dir_deg=wind_dir_deg,
                temp_c=temp_c, rh_pct=rh_pct,
            ),
        ))
    series.sort(key=lambda ts_obs: ts_obs[0])
    counts["n_usable"] = len(series)
    return series, counts


class RealMetSeries:
    """Wraps `load_real_met_series()`'s output into the
    `step_index -> list[StationObservation]` callable
    `run_hindcast()`/`Simulator.step()` expect for `met_stations`, holding
    the most recent REAL reading constant between real reporting instants
    (this station's native cadence is 3-hourly) -- never fabricating a
    finer-grained interpolation that wasn't actually observed."""

    def __init__(self, series: list[tuple[datetime, StationObservation]], start_time: datetime, dt_seconds: float):
        if not series:
            raise ValueError("empty real met series -- nothing to serve")
        self.series = series
        self.start_time = start_time if start_time.tzinfo else start_time.replace(tzinfo=timezone.utc)
        self.dt_seconds = dt_seconds

    def __call__(self, step_index: int) -> list[StationObservation]:
        step_time = self.start_time + timedelta(seconds=step_index * self.dt_seconds)
        # most recent real reading at or before step_time; if step_time
        # precedes the first real reading, use the first one (no data to
        # extrapolate backward from).
        candidate = self.series[0][1]
        for ts, obs in self.series:
            if ts > step_time:
                break
            candidate = obs
        return [candidate]
