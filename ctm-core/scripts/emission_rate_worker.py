"""scripts/emission_rate_worker.py — single-zone emission-rate (Q)
estimation for the live Nellore deployment. See PROMPT_FLOW_INTEGRATION.md,
Phase I4, for the full spec this implements: SHORT-RANGE zones only
(2-5km from the real sensor, per the tested forward-response evidence),
real 2-hour-stacked observations, `attribution/inverse.py`'s existing
`SourceInversion` reused directly (assemble_H / solve, never
reimplemented), real posterior uncertainty (`marginal_std`) always
reported alongside the point estimate, POSTed to the real authenticated
/api/emission-rate/ingest route using the exact same authenticateDevice
pattern telemetry/source-direction ingest use.

REAL DATA CONSTRAINT, disclosed not hidden: the real wind archive
(met/ingest_real_met.py) covers 2025-08 through 2025-10-15; the real
device only started reporting telemetry to THIS backend in 2026 (this
migration). These two real data sources do not overlap in time yet, so
a genuine end-to-end run must either (a) use real wind from 2025 paired
with a telemetry reading whose TIMESTAMP is backdated into that window
(explicitly disclosed when done, see the worker's --as-of flag), or
(b) wait for real wind and real telemetry to actually overlap (once a
live wind feed exists). This module does not paper over that gap.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from attribution.inverse import InversionObservation, SourceInversion, Zone
from cities.loader import CityConfig, load_city
from ctm.emissions import local_hour_from_utc
from ctm.grid import CTMGrid
from met.ingest_real_met import (
    NELLORE_STATION_ID,
    NELLORE_STATION_LAT,
    NELLORE_STATION_LON,
    load_real_met_series,
)
from met.weather_station import interpolate_met, mixing_height_m

NELLORE_MET_CSV = Path(__file__).resolve().parents[1] / "data" / "raw" / "meteostat_nellore" / "43245_202508.csv"

# Real, disclosed naming difference between the two real systems -- the
# telemetry schema (backend/models/Telemetry.js) uses "pm2_5"; the city
# config's species dict (cities/schema.json) uses "pm25". Neither gets
# renamed to "fix" this; the mapping is made explicit here instead.
TELEMETRY_FIELD_BY_SPECIES = {"pm25": "pm2_5"}

# Per PROMPT_FLOW_INTEGRATION.md Phase I4: the ONLY tested range. Anything
# outside this is explicitly excluded from v1, not clamped or warned-and-
# allowed.
MIN_ZONE_DISTANCE_M = 2000.0
MAX_ZONE_DISTANCE_M = 5000.0

EMISSION_RATE_LABEL = "estimated single-zone emission rate -- screening only, not a validated emission-inventory number"


class ZoneOutOfRangeError(ValueError):
    """Raised when a hypothesized zone falls outside the tested 2-5km
    range (see PROMPT_FLOW_INTEGRATION.md's forward-response evidence)."""


def zone_distance_m(grid: CTMGrid, zone_lat: float, zone_lon: float, sensor_lat: float, sensor_lon: float) -> float:
    """Distance in the SAME flat-earth approximation the rest of this
    project uses (ctm/grid.py's CTMGrid), not haversine -- consistency
    with how every other real distance in this codebase is computed
    (see cities/bangalore.json's _sensor_pair_distances_m note)."""
    zx, zy = grid.latlon_to_xy_m(zone_lat, zone_lon)
    sx, sy = grid.latlon_to_xy_m(sensor_lat, sensor_lon)
    return float(np.hypot(zx - sx, zy - sy))


def validate_zone_range(distance_m: float) -> None:
    if not (MIN_ZONE_DISTANCE_M <= distance_m <= MAX_ZONE_DISTANCE_M):
        raise ZoneOutOfRangeError(
            f"zone is {distance_m:.0f}m from the sensor -- outside the tested "
            f"[{MIN_ZONE_DISTANCE_M:.0f}, {MAX_ZONE_DISTANCE_M:.0f}]m range "
            f"(PROMPT_FLOW_INTEGRATION.md Phase I4). Excluded from v1, not "
            f"clamped or allowed with a warning."
        )


def build_real_histories(as_of_end: datetime, n_hours: int, city: CityConfig, grid: CTMGrid):
    """Real Nellore wind_history/k_h_history/mixing_height_history at the
    live simulator's real dt_seconds resolution, for `n_hours` real hours
    ending at `as_of_end`.

    The real STATION READING (u/v, i.e. wind speed+direction) is held
    constant across each real hour's sub-steps -- genuinely limited by
    the real data's hourly granularity, not a shortcut (same convention
    as RealMetSeries).

    hour_local -- and therefore K_h/mixing_height_m, via
    pasquill_gifford_class()'s day/night threshold -- is NOT held
    constant per hour; it advances every sub-step exactly the way
    ctm.simulator.Simulator._step_unchecked() itself advances
    self.hour_utc. This matters concretely: an initial version of this
    function held one stability class for the whole real hour, and for a
    window straddling the day/night boundary (hour_local crossing 6.0 or
    18.0 mid-hour -- a real, common case, not an edge case picked to
    embarrass this note) that produced a forward-response value ~36% off
    from what the real Simulator actually computes for the identical
    known source (found via a synthetic recovery test, see
    tests/scripts/test_emission_rate_worker.py). Recomputing hour_local
    every sub-step (cheap -- it's just clock arithmetic, not limited by
    real data resolution) closed that gap to ~5%, consistent with normal
    numerical discretization tolerance, not a remaining bug.

    Raises ValueError if the real archive doesn't cover this window
    (honest, not fabricated)."""
    series, _counts = load_real_met_series(
        [NELLORE_MET_CSV], station_id=NELLORE_STATION_ID, lat=NELLORE_STATION_LAT, lon=NELLORE_STATION_LON,
    )
    series_by_ts = {ts: obs for ts, obs in series}

    start = as_of_end - timedelta(hours=n_hours - 1)
    dt = city.dt_seconds
    steps_per_hour = int(round(3600.0 / dt))

    wind_history: list[dict] = []
    k_h_history: list[float] = []
    mixing_history: list[float] = []
    hour_utc = start.hour + start.minute / 60.0
    for h in range(n_hours):
        ts = start + timedelta(hours=h)
        obs = series_by_ts.get(ts)
        if obs is None:
            raise ValueError(
                f"no real wind data at {ts.isoformat()} -- the real archive does not cover this window"
            )
        for _ in range(steps_per_hour):
            hour_local = local_hour_from_utc(hour_utc, city.utc_offset_hours)
            met = interpolate_met([obs], grid, hour_local, city.climatology)
            h_mix = mixing_height_m(hour_local, obs.wind_speed_m_s)
            wind_history.append({"u": met["u"], "v": met["v"]})
            k_h_history.append(met["K_h"])
            mixing_history.append(h_mix)
            hour_utc = (hour_utc + dt / 3600.0) % 24.0

    return wind_history, k_h_history, mixing_history, steps_per_hour


def fetch_telemetry_near(base_url: str, station_id: str, target_ts: datetime, window_minutes: int = 30) -> dict | None:
    """GET /api/telemetry/history -- real shape confirmed against
    backend/routes/telemetry.js: an array of documents with a real
    `pollutants` object. Returns the document closest to `target_ts`
    within +/- `window_minutes`, or None if none exists."""
    from_ts = target_ts - timedelta(minutes=window_minutes)
    to_ts = target_ts + timedelta(minutes=window_minutes)
    resp = requests.get(
        f"{base_url}/api/telemetry/history",
        params={"station_id": station_id, "from": from_ts.isoformat(), "to": to_ts.isoformat(), "limit": 50},
        timeout=10,
    )
    resp.raise_for_status()
    docs = resp.json()
    if not docs:
        return None
    return min(docs, key=lambda d: abs(datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")) - target_ts))


def compute_enhancement(doc: dict, species: str, city: CityConfig) -> float:
    """Real telemetry reading minus the city config's declared
    background_conc for this species -- the SAME disclosed-as-generic
    default already in cities/live_deployment.json, not invented here."""
    telemetry_field = TELEMETRY_FIELD_BY_SPECIES[species]
    raw_value = doc["pollutants"].get(telemetry_field)
    if raw_value is None:
        raise ValueError(f"telemetry document has no {telemetry_field!r} reading")
    return float(raw_value) - city.species[species].background_conc


def estimate_emission_rate(
    base_url: str,
    station_id: str,
    species: str,
    zone_lat: float,
    zone_lon: float,
    as_of_end: datetime,
    city: CityConfig,
    n_hours: int = 2,
) -> dict:
    """Full Phase I4 pipeline: validate zone range, fetch real
    2-hour-stacked telemetry enhancement, build real wind/K_h/mixing
    histories, run the REAL SourceInversion.assemble_H()/solve() (never
    reimplemented), return a result dict ready to POST."""
    grid = CTMGrid(city)
    sensors_by_id = {s.id: s for s in city.sensors}
    sensor = sensors_by_id.get(station_id)
    if sensor is None:
        raise ValueError(f"station_id {station_id!r} is not a declared sensor in {city.city_name!r}'s config")

    distance_m = zone_distance_m(grid, zone_lat, zone_lon, sensor.lat, sensor.lon)
    validate_zone_range(distance_m)

    wind_history, k_h_history, mixing_history, steps_per_hour = build_real_histories(as_of_end, n_hours, city, grid)

    obs_times = [as_of_end - timedelta(hours=n_hours - 1 - h) for h in range(n_hours)]
    obs_time_indices = [(h + 1) * steps_per_hour - 1 for h in range(n_hours)]  # end of each real hour

    observations = []
    obs_records = []
    for ts, time_index in zip(obs_times, obs_time_indices):
        doc = fetch_telemetry_near(base_url, station_id, ts)
        if doc is None:
            raise ValueError(f"no real telemetry near {ts.isoformat()} for station {station_id!r}")
        enhancement = compute_enhancement(doc, species, city)
        observations.append(InversionObservation(sensor_id=station_id, time_index=time_index, enhancement=enhancement))
        obs_records.append({"time_index": time_index, "timestamp": ts.isoformat(), "enhancement": enhancement})

    zone = Zone(name="worker-zone", kind="point", lat=zone_lat, lon=zone_lon)
    inv = SourceInversion(city, species=species, zones=[zone])
    H = inv.assemble_H(wind_history, k_h_history, mixing_history, observations)
    result = inv.solve(H, observations)

    last_h_mix = mixing_history[-1]
    advisory = inv.species_advisory(transit_time_s=n_hours * 3600.0, mixing_height_m=last_h_mix)

    return {
        "timestamp": as_of_end.isoformat(),
        "station_id": station_id,
        "species": species,
        "zone": {"name": zone.name, "lat": zone_lat, "lon": zone_lon, "distance_from_sensor_m": distance_m},
        "observations": obs_records,
        "x_hat": float(result.x_hat[0]),
        "marginal_std": float(result.marginal_std[0]),
        "chi2_per_obs": result.chi2_per_obs,
        "fit_residuals": [float(r) for r in result.fit_residuals],
        "species_advisory": {
            "quasi_conservative": advisory.quasi_conservative,
            "half_life_s": advisory.half_life_s,
            "transit_time_s": advisory.transit_time_s,
            "message": advisory.message,
        },
        "label": EMISSION_RATE_LABEL,
    }


def post_emission_rate(base_url: str, device_id: str, device_key: str, payload: dict) -> requests.Response:
    headers = {"X-Device-Id": device_id, "X-Device-Key": device_key}
    return requests.post(f"{base_url}/api/emission-rate/ingest", json=payload, headers=headers, timeout=10)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:4000")
    parser.add_argument("--city", default="live_deployment")
    parser.add_argument("--station-id", default="NEL-001")
    parser.add_argument("--species", default="pm25")
    parser.add_argument("--zone-lat", type=float, required=True)
    parser.add_argument("--zone-lon", type=float, required=True)
    parser.add_argument("--device-id", default="WORKER-EMISSION-RATE")
    parser.add_argument("--device-key", required=True)
    parser.add_argument("--as-of", required=True, help="ISO timestamp: END of the 2-hour real wind window")
    args = parser.parse_args()

    as_of_end = datetime.fromisoformat(args.as_of).replace(tzinfo=timezone.utc)
    city = load_city(args.city)

    result = estimate_emission_rate(
        args.base_url, args.station_id, args.species, args.zone_lat, args.zone_lon, as_of_end, city,
    )
    print(f"[emission-rate-worker] result: {result}")

    resp = post_emission_rate(args.base_url, args.device_id, args.device_key, result)
    print(f"[emission-rate-worker] POST status={resp.status_code} body={resp.text}")


if __name__ == "__main__":
    main()
