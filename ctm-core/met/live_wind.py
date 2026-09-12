"""met/live_wind.py — real, LIVE current-conditions wind for the actual
deployed receptor coordinate (14.442/79.986), closing the gap
met/ingest_real_met.py's module docstring discloses: "No live real-time
wind source has been wired in for this deployment."

SOURCE (confirmed real, publicly accessible, no API key/account needed for
non-commercial use -- verified by direct GET, same access model as the
Meteostat bulk archive and OpenAQ S3 archive used elsewhere in this
project): Open-Meteo's forecast API, https://api.open-meteo.com/v1/forecast.
Per Open-Meteo's own docs (https://open-meteo.com/en/docs, fetched and
quoted here, not assumed): "Current conditions are based on 15-minutely
weather model data." For India this resolves to an interpolated global
NWP model (Open-Meteo does not run a dedicated high-res regional model
here the way it does HRRR/ICON-D2 for North America/Europe) -- i.e. this
is a real, live, current NUMERICAL WEATHER MODEL nowcast that assimilates
real observations, NOT a raw ground-station reading the way
met/ingest_real_met.py's Meteostat archive is. That distinction is
disclosed here exactly because this project treats "real but modeled" and
"real and directly measured" as genuinely different confidence tiers
elsewhere (see ctm-core/CLAUDE.md's confidence-treatment principle).

VERIFIED, not assumed:
- Reachability: `GET .../forecast?latitude=14.442&longitude=79.986&
  current=wind_speed_10m,wind_direction_10m,...` returned real HTTP 200
  JSON with `current.time` matching the actual real wall-clock date this
  module was wired in on.
- Distance from the real deployed coordinate: Open-Meteo resolves
  (14.442, 79.986) to its nearest model grid point (14.446397, 79.99074)
  -- haversine distance 706.8m, comparable to (slightly better than) the
  Meteostat Nellore station's disclosed 0.9km offset.
- wind_direction_10m convention: NOT explicitly documented by Open-Meteo.
  Verified empirically instead of assumed: cross-checked against the real
  Meteostat station 43245 reading (confirmed meteorological FROM-direction)
  at the same real UTC hours (2025-08-01 00:00/01:00/02:00) -- Meteostat
  252/256/265 deg vs Open-Meteo 270/274/279 deg. Both rotate the same
  direction hour-to-hour with a consistent ~+18 deg offset; if Open-Meteo
  used the reciprocal (blowing-TO) convention the values would differ by
  ~180 deg, not ~18 deg. This confirms the same FROM-direction convention
  StationObservation.wind_dir_deg already uses -- no conversion needed.
- Units: requested explicitly via `wind_speed_unit=ms` -- returned unit
  confirmed `"m/s"` in `current_units`/`hourly_units`, avoiding the
  km/h-vs-m/s conversion-bug class met/ingest_real_met.py's docstring
  warns about for Meteostat's raw km/h fields.

NOT solved by this module: a wind SENSOR directly on the ESP32 (the
alternative considered) -- checked firmware/AQMS_Firmware.ino and
firmware/config.h, confirmed no anemometer hardware exists on the device
today. That would be a real hardware addition, out of scope here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import requests

from met.weather_station import StationObservation

LIVE_WIND_BASE_URL = "https://api.open-meteo.com/v1/forecast"
LIVE_WIND_STATION_ID = "open-meteo-live-nowcast"


def fetch_live_wind_series(
    lat: float,
    lon: float,
    hours_back: float = 1.0,
    timeout: float = 10.0,
) -> list[tuple[datetime, StationObservation]]:
    """Real, live wind for `lat`/`lon`, oldest-first, covering the
    `hours_back`-hour window ending at the provider's own real "now"
    (`current.time` in the response -- never the caller's local clock, so
    this stays correct even if the two clocks drift).

    Returns [] on any network/HTTP failure or if every candidate hourly
    row is non-finite/incomplete -- the same honest "no real data, skip"
    behavior scripts/source_direction_worker.py's historical-archive path
    (load_nellore_wind_history) already has for its own coverage gaps.
    Never fabricates a fallback reading.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m",
        "hourly": "wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m",
        "wind_speed_unit": "ms",
        "timezone": "UTC",
        "past_days": 2,
        "forecast_days": 1,
    }
    try:
        resp = requests.get(LIVE_WIND_BASE_URL, params=params, timeout=timeout)
        resp.raise_for_status()
        payload = resp.json()
    except (requests.RequestException, ValueError):
        return []

    try:
        now = datetime.fromisoformat(payload["current"]["time"]).replace(tzinfo=timezone.utc)
        hourly = payload["hourly"]
        times = hourly["time"]
        wspd = hourly["wind_speed_10m"]
        wdir = hourly["wind_direction_10m"]
        temp = hourly["temperature_2m"]
        rhum = hourly["relative_humidity_2m"]
    except (KeyError, TypeError, ValueError):
        return []

    window_start = now - timedelta(hours=hours_back)
    series: list[tuple[datetime, StationObservation]] = []
    for t_str, speed, direction, t_c, rh in zip(times, wspd, wdir, temp, rhum):
        try:
            ts = datetime.fromisoformat(t_str).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if not (window_start <= ts <= now):
            continue
        values = (speed, direction, t_c, rh)
        if any(v is None for v in values):
            continue
        speed_f, direction_f, temp_f, rh_f = (float(v) for v in values)
        # Reject non-finite BEFORE any other use -- same np.isfinite()
        # primitive used at every ingestion boundary in this project (NaN
        # silently passes plain range comparisons).
        if not all(np.isfinite(v) for v in (speed_f, direction_f, temp_f, rh_f)):
            continue
        series.append((
            ts,
            StationObservation(
                station_id=LIVE_WIND_STATION_ID, lat=lat, lon=lon,
                wind_speed_m_s=speed_f, wind_dir_deg=direction_f,
                temp_c=temp_f, rh_pct=rh_f,
            ),
        ))

    series.sort(key=lambda pair: pair[0])
    return series
