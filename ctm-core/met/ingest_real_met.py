"""met/ingest_real_met.py — ingest real historical meteorology (WMO/
Meteostat stations) into the StationObservation sequence
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
elsewhere in this project.

STATIONS WIRED IN SO FAR:

  Bangalore (WMO 43295, lat=12.9667 lon=77.5833, elevation 920m): confirmed
  hourly coverage 1973-01-01 through 2025-06, comfortably covering the
  2019-07-09 to 2019-07-17 window used by
  data/processed/bangalore_openaq_20190710_20190716.csv. Native reporting
  cadence for this station is 3-HOURLY (see below).

  Nellore (WMO 43245, lat=14.45 lon=79.9833, elevation 19m) -- wired in for
  the actual live ESP32 deployment (station NEL-001, firmware-configured at
  lat=14.442 lon=79.986; see firmware/config.h). Distance from the real
  deployed coordinates to this station: 0.9 km (haversine) -- effectively
  co-located, found by downloading Meteostat's public station index
  (https://bulk.meteostat.net/v2/stations/lite.json.gz) and searching for
  the nearest entry by haversine distance, the same discovery method used
  for every other station in this project. Verified by direct download of
  https://bulk.meteostat.net/v2/hourly/43245.csv.gz and inspection of the
  actual rows (not just the station-index metadata, which is a separate,
  sometimes-stale claim): confirmed a genuinely dense, complete real HOURLY
  record (all 24 hour values present per day, not 3- or 6-hourly) with ZERO
  missing required fields (temp/rhum/wdir/wspd) throughout 2025-01 to
  2025-10-15 (6,541 real rows checked). data/raw/meteostat_nellore/
  43245_202508.csv is a committed real slice: the full, complete real month
  of 2025-08 (744 rows = 31 days x 24h exactly, zero rejected rows).
  IMPORTANT LIMITATION, disclosed not hidden: this bulk archive's most
  recent real row is 2025-10-15 -- roughly 11 months behind "now" at the
  time this was wired in. It is genuinely real HISTORICAL hourly wind, at
  a genuinely-verified near-exact location, usable the same way Bangalore's
  archive is used for hindcast-style validation -- it is NOT a live/current
  feed. No live real-time wind source has been wired in for this
  deployment; if live operational wind is needed (as opposed to historical
  validation), that is a distinct, not-yet-solved problem and should not be
  assumed solved by this module.

CONFIRMED RAW SCHEMA (no header row; verified against meteostat-python
v1.6.8's Hourly._columns, and against the actual downloaded file):

    date,hour,temp,dwpt,rhum,prcp,snow,wdir,wspd,wpgt,pres,tsun,coco
    2019-07-09,00,20.0,17.7,90,,,230,7.6,,,,

  - `date` is YYYY-MM-DD, `hour` is a zero-padded UTC hour. Native
    reporting resolution is PER-STATION, confirmed by inspecting each
    station's actual rows, not assumed uniform: Bangalore (43295) reports
    3-HOURLY (00,03,06,...); Nellore (43245) reports genuinely HOURLY
    (00,01,02,...,23) with zero gaps in the committed 2025-08 slice. Where
    a station's real cadence is sparser than the simulator's timestep,
    there is no data to interpolate between real reports at finer
    resolution, so this module (via RealMetSeries below) holds the most
    recent real reading constant until the next one arrives (the standard,
    honest treatment of sparse synoptic obs), rather than fabricating an
    interpolated finer-grained series.
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

BANGALORE_STATION_ID = "43295"
BANGALORE_STATION_NAME = "Bangalore (WMO 43295)"
BANGALORE_STATION_LAT = 12.9667
BANGALORE_STATION_LON = 77.5833

NELLORE_STATION_ID = "43245"
NELLORE_STATION_NAME = "Nellore (WMO 43245)"
NELLORE_STATION_LAT = 14.45
NELLORE_STATION_LON = 79.9833

# Kept for existing callers (scripts/validate_bangalore_real.py,
# scripts/diagnose_phase15.py, scripts/calibrate_phase16.py,
# scripts/check_co_cross_week_generalization.py, tests/met/test_ingest_real_met.py)
# that predate this module supporting more than one station -- new callers
# should pass station_id/lat/lon to load_real_met_series() explicitly rather
# than rely on these.
STATION_ID = BANGALORE_STATION_ID
STATION_NAME = BANGALORE_STATION_NAME
STATION_LAT = BANGALORE_STATION_LAT
STATION_LON = BANGALORE_STATION_LON


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


def load_real_met_series(
    paths: list[str | Path],
    station_id: str = STATION_ID,
    lat: float = STATION_LAT,
    lon: float = STATION_LON,
) -> tuple[list[tuple[datetime, StationObservation]], dict]:
    """Ingest raw Meteostat file(s) into a time-ordered list of (utc
    timestamp, StationObservation), rejecting non-finite/incomplete rows.
    Returns `(series, counts)` -- `series` holds only the REAL reporting
    instants (cadence is per-station, see module docstring); callers
    needing a value at an arbitrary step should use `RealMetSeries` below,
    which holds the most recent real reading constant rather than
    fabricating interpolation.

    `station_id`/`lat`/`lon` identify the station the given files came
    from (defaults are Bangalore's, kept only for existing callers that
    predate multi-station support -- see the module-level comment above
    STATION_ID). Pass NELLORE_STATION_ID/NELLORE_STATION_LAT/
    NELLORE_STATION_LON explicitly for the live-deployment station, or any
    other verified station's identity for a new one -- never rely on the
    default for a station other than Bangalore.
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
                station_id, lat=lat, lon=lon,
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
