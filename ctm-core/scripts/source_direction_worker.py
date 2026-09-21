"""scripts/source_direction_worker.py — polls the real backend for
stations, checks each for a real Holt-Winters spike (reusing the backend's
own lib/forecast.js checkSpike() via GET /api/forecast/spike-check --
NEVER reimplemented here), and on a real trigger runs AdjointTracer
against real wind to produce a bearing/distance/confidence screening
estimate, POSTed to the real authenticated /api/source-direction/ingest
route using the exact same authenticateDevice pattern telemetry ingest
uses.

See PROMPT_FLOW_INTEGRATION.md for the full spec this implements.

WIND SOURCE, chosen by `--as-of`:
- Omitted (default, real live run): "now" + met/live_wind.py's real LIVE
  current-conditions wind (Open-Meteo, no API key needed) for the
  station's own real coordinates. This closes the gap the previous
  version of this docstring disclosed ("no live real-time wind source has
  been wired in") -- see met/live_wind.py's module docstring for the
  disclosed model-vs-ground-station caveat and the empirical verification
  of its wind-direction convention.
- Given (backtest/testing use): replays met/ingest_real_met.py's real
  HISTORICAL Meteostat archive for station 43245 (freshest real row
  2025-10-15, NOT live) at that exact timestamp, unchanged from before.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # allow running as a plain script

from attribution.adjoint import AdjointTracer
from cities.loader import CityConfig, load_city
from ctm.emissions import local_hour_from_utc
from ctm.grid import CTMGrid
from met.ingest_real_met import (
    NELLORE_STATION_ID,
    NELLORE_STATION_LAT,
    NELLORE_STATION_LON,
    load_real_met_series,
)
from met.live_wind import fetch_live_wind_series
from met.weather_station import StationObservation, interpolate_met, mixing_height_m

NELLORE_MET_CSV = Path(__file__).resolve().parents[1] / "data" / "raw" / "meteostat_nellore" / "43245_202508.csv"

SOURCE_DIRECTION_LABEL = "estimated upwind direction -- screening only, not confirmed source attribution"

# The real backend (aqhi-backend on Render's free plan) spins down after
# ~15min idle and can take 30-50s to cold-start back up -- a real failure
# observed 2026-09-21 (ReadTimeoutError on fetch_stations with a 10s
# timeout, right after this worker's own cron tick found the service
# asleep). 60s gives a safe margin over that; the retry below covers a
# cold-start that's still mid-boot after the first attempt.
REQUEST_TIMEOUT = 60


def _build_session() -> requests.Session:
    """requests.Session with retry-with-backoff mounted for both schemes.
    Retries on connection errors, read timeouts, and 502/503/504 (all
    consistent with "the service was still waking up"), never on 4xx --
    those are real application errors (bad payload, bad auth key) that a
    retry can't fix."""
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=2,  # 2s, 4s, 8s between attempts
        status_forcelist=(502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


_session = _build_session()


def fetch_stations(base_url: str) -> list[dict]:
    """GET /api/stations -- real shape confirmed against
    backend/routes/stations.js: a bare JSON array, each entry
    {station_id, device_id, last_seen, location}. device_id/location can
    be missing/None for a station with no telemetry yet -- callers MUST
    guard for that (see valid_stations()), never assume presence."""
    resp = _session.get(f"{base_url}/api/stations", timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def valid_stations(stations: list[dict]) -> list[dict]:
    """Drop any station missing device_id or location. device_id is
    required because authentication -- and this worker's own posting
    identity -- is keyed on device_id, NEVER station_id (station_id is
    for grouping/storage in the SourceDirection collection only). A
    station with no location has no receptor coordinate for the adjoint
    trace either."""
    out = []
    for s in stations:
        if not s.get("device_id"):
            continue
        loc = s.get("location")
        if not loc or loc.get("lat") is None or loc.get("lon") is None:
            continue
        out.append(s)
    return out


def fetch_spike_check(base_url: str, station_id: str, lookback: int = 168) -> dict | None:
    """GET /api/forecast/spike-check -- the ONLY spike trigger this worker
    uses. That endpoint calls backend/lib/forecast.js's checkSpike(),
    which itself reuses holtWinters() (the same function buildForecast()
    uses) -- nothing here reimplements Holt-Winters or invents a
    threshold. Returns None on 404 (not enough data yet); raises on any
    other HTTP error."""
    resp = _session.get(
        f"{base_url}/api/forecast/spike-check",
        params={"station_id": station_id, "lookback": lookback},
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def load_nellore_wind_history(as_of: datetime, wind_history_hours: float) -> list[tuple[datetime, StationObservation]]:
    """Real, verified Nellore wind (met/ingest_real_met.py) for the
    `wind_history_hours` window ending at `as_of`, oldest-first. Returns
    [] if the real archive has no coverage for that window -- the
    honest, disclosed behavior when `as_of` falls outside the archive's
    real coverage (e.g. "now" on a live run today; see module docstring)."""
    series, _counts = load_real_met_series(
        [NELLORE_MET_CSV], station_id=NELLORE_STATION_ID, lat=NELLORE_STATION_LAT, lon=NELLORE_STATION_LON,
    )
    window_start = as_of - timedelta(hours=wind_history_hours)
    return [(ts, obs) for ts, obs in series if window_start <= ts <= as_of]


def run_adjoint_tracer(
    city: CityConfig,
    receptor_lat: float,
    receptor_lon: float,
    wind_window: list[tuple[datetime, StationObservation]],
    dt_seconds: float = 3600.0,  # matches the real data's native hourly cadence -- see met/ingest_real_met.py
    n_particles: int = 2000,
    seed: int = 0,
) -> dict | None:
    """Builds real wind_history/k_h_history from `wind_window` (real
    StationObservations, oldest-first) via met/weather_station.py's
    interpolate_met()/mixing_height_m() (reused verbatim, never
    reimplemented), then runs attribution/adjoint.py's REAL
    AdjointTracer.trace() -- the same backward-dispersion module
    ctm-core/CLAUDE.md's adjoint inverse layer section describes.
    Reduces the resulting interior_probability field to a single
    bearing/distance/confidence screening estimate (the probability-
    weighted centroid of where the traced mass ended up, i.e. the
    estimated upwind source region). Returns None if there's no real
    wind for this window, or the receptor falls outside the domain."""
    if not wind_window:
        return None

    grid = CTMGrid(city)
    receptor_i, receptor_j = grid.latlon_to_cell(receptor_lat, receptor_lon)
    if not (0 <= receptor_i < grid.nx and 0 <= receptor_j < grid.ny):
        return None

    wind_history: list[dict] = []
    k_h_history: list[float] = []
    last_speed = 0.0
    last_ts = wind_window[-1][0]
    for ts, obs in wind_window:
        hour_local = local_hour_from_utc(ts.hour + ts.minute / 60.0, city.utc_offset_hours)
        met = interpolate_met([obs], grid, hour_local, city.climatology)
        wind_history.append({"u": met["u"], "v": met["v"]})
        k_h_history.append(met["K_h"])
        last_speed = obs.wind_speed_m_s

    hour_local_last = local_hour_from_utc(last_ts.hour + last_ts.minute / 60.0, city.utc_offset_hours)
    h_mix = mixing_height_m(hour_local_last, last_speed)
    v_dep = city.species["pm25"].v_dep_m_s  # pm25 as the representative screening species
    k_dep = v_dep / h_mix

    tracer = AdjointTracer(grid.nx, grid.ny, grid.dx, grid.dy)
    result = tracer.trace(
        receptor_i, receptor_j, wind_history, k_h_history,
        k_dep=k_dep, dt=dt_seconds, n_particles=n_particles, seed=seed,
    )

    total_interior = float(result.interior_probability.sum())
    n_sectors = len(result.boundary_exit_by_sector)
    sector_width_deg = 360.0 / n_sectors

    if total_interior <= 0.0:
        # The dominant real failure mode at this project's domain size --
        # see PROMPT_FLOW_INTEGRATION.md's 744-hour saturation finding
        # (86.3% of real hours land exactly here). Rather than reporting
        # "no estimate", fall back to the dominant BOUNDARY EXIT sector --
        # which way the traced mass actually left the domain is still a
        # real, honest (if coarser and lower-confidence) directional
        # signal, distinct from the interior-centroid estimate below.
        total_boundary = float(result.boundary_exit_by_sector.sum())
        if total_boundary <= 0.0:
            # Genuinely no particles went anywhere -- shouldn't happen
            # with n_particles > 0, but never silently fabricate a bearing.
            return {
                "bearing_deg": None, "distance_m": None, "confidence": 0.0,
                "boundary_inflow_fraction": result.boundary_inflow_fraction,
                "n_particles": result.n_particles, "seed": seed, "estimate_tier": "none",
            }

        dominant_sector = int(np.argmax(result.boundary_exit_by_sector))
        dominant_fraction = float(result.boundary_exit_by_sector[dominant_sector] / total_boundary)
        uniform_fraction = 1.0 / n_sectors
        # 0 when exit weight is spread evenly across all sectors (everything
        # hit the boundary, but with no real directional preference -- a
        # genuinely uninformative case); 1 when it's entirely concentrated
        # in one sector (as directionally clear as the boundary can be).
        boundary_confidence = max(0.0, (dominant_fraction - uniform_fraction) / (1.0 - uniform_fraction))

        return {
            "bearing_deg": float(dominant_sector * sector_width_deg),
            "distance_m": None,  # a boundary exit gives a direction, not a distance -- never fabricated
            "confidence": boundary_confidence,
            "boundary_inflow_fraction": result.boundary_inflow_fraction,
            "n_particles": result.n_particles, "seed": seed,
            "estimate_tier": "boundary_sector_fallback",
            "dominant_exit_sector": dominant_sector,
            "dominant_exit_sector_fraction": dominant_fraction,
        }

    ii, jj = np.meshgrid(np.arange(grid.nx), np.arange(grid.ny), indexing="ij")
    grid_x_m = (ii + 0.5) * grid.dx
    grid_y_m = (jj + 0.5) * grid.dy
    weighted_x = float((result.interior_probability * grid_x_m).sum() / total_interior)
    weighted_y = float((result.interior_probability * grid_y_m).sum() / total_interior)

    receptor_x_m = (receptor_i + 0.5) * grid.dx
    receptor_y_m = (receptor_j + 0.5) * grid.dy
    dx_east = weighted_x - receptor_x_m
    dy_north = weighted_y - receptor_y_m

    distance_m = float(np.hypot(dx_east, dy_north))
    # Plain compass bearing FROM the receptor TO the estimated upwind
    # source region -- grid's i-axis is east (x), j-axis is north (y), per
    # ctm/grid.py -- NOT the meteorological wind FROM-direction convention
    # (that's wind_dir_from_uv, a different, deliberately distinct thing).
    bearing_deg = float(np.degrees(np.arctan2(dx_east, dy_north)) % 360.0)
    confidence = max(0.0, min(1.0, 1.0 - result.boundary_inflow_fraction))

    return {
        "bearing_deg": bearing_deg, "distance_m": distance_m, "confidence": confidence,
        "boundary_inflow_fraction": result.boundary_inflow_fraction,
        "n_particles": result.n_particles, "seed": seed, "estimate_tier": "interior",
    }


def make_idempotency_key(station_id: str, timestamp: str) -> str:
    """Deterministic ID for one (station_id, decision timestamp) pair --
    same inputs always produce the same key. `payload["idempotency_key"]`
    below carries this into routes/source-direction.js, whose upsert
    (keyed on the model's unique idempotency_key index) is what makes a
    read-timeout retry (see _build_session()) overwrite the SAME document
    instead of inserting a duplicate."""
    return hashlib.sha256(f"{station_id}|{timestamp}".encode("utf-8")).hexdigest()


def post_source_direction(base_url: str, device_id: str, device_key: str, payload: dict) -> requests.Response:
    """POST /api/source-direction/ingest -- same auth pattern as
    routes/telemetry.js's POST /: X-Device-Id/X-Device-Key checked
    against DEVICE_KEYS via the shared authenticateDevice middleware,
    reused verbatim server-side. station_id in `payload` is for
    grouping/storage only -- these headers are the ONLY authentication.

    The session-level retry (see _build_session()) covers this call too,
    per the same cold-start risk as fetch_stations()/fetch_spike_check() --
    a read-timeout retry here CAN resend a POST whose insert already
    succeeded server-side but was slow to respond. That's made safe by
    `payload["idempotency_key"]` (see make_idempotency_key()): the backend
    upserts on it, so a resend overwrites the same document rather than
    creating a second one."""
    headers = {"X-Device-Id": device_id, "X-Device-Key": device_key}
    return _session.post(
        f"{base_url}/api/source-direction/ingest", json=payload, headers=headers, timeout=REQUEST_TIMEOUT,
    )


def process_station(
    base_url: str, station: dict, city: CityConfig, device_id: str, device_key: str,
    as_of: datetime, lookback: int = 168, use_live_wind: bool = False,
) -> dict:
    """Returns a status dict describing what happened for this station.
    Never raises for an expected "nothing to do" outcome (no spike, no
    real wind for the window, receptor outside the domain) -- only lets
    a genuinely unexpected HTTP/network error propagate.

    `use_live_wind` selects the wind source: False (default, used for any
    explicit `--as-of`) replays met/ingest_real_met.py's real HISTORICAL
    Nellore archive for backtesting/reproducibility -- this is what
    tests/scripts/test_source_direction_worker.py exercises and must keep
    working unchanged. True (used for a real live run, `--as-of` omitted)
    fetches met/live_wind.py's real, live current-conditions wind for this
    station's own real coordinates -- see that module's docstring for the
    disclosed model-vs-observation caveat."""
    station_id = station["station_id"]

    spike = fetch_spike_check(base_url, station_id, lookback)
    if spike is None:
        return {"station_id": station_id, "action": "skipped", "reason": "not enough data for a spike check"}
    if not spike["is_spike"]:
        return {"station_id": station_id, "action": "skipped", "reason": "no spike", "spike": spike}

    # wind_source_tier is a distinct confidence sub-label for the WIND
    # itself (separate from estimate_tier, which is about the tracer's
    # geometry) -- backend/models/SourceDirection.js's WIND_SOURCE_TIERS
    # enum, server-enforced into a human label there so this never reads
    # the same as a real on-site sensor reading would. See
    # ctm-core/CLAUDE.md's confidence-treatment principle.
    if use_live_wind:
        wind_window = fetch_live_wind_series(
            station["location"]["lat"], station["location"]["lon"], hours_back=city.wind_history_hours,
        )
        wind_source_desc = "met/live_wind.py's real live current-conditions feed"
        wind_source_tier = "live_model_nowcast"
    else:
        wind_window = load_nellore_wind_history(as_of, city.wind_history_hours)
        wind_source_desc = (
            "met/ingest_real_met.py's archive (real HISTORICAL data, not a live feed -- "
            "see its module docstring)"
        )
        wind_source_tier = "historical_ground_station"
    if not wind_window:
        return {
            "station_id": station_id, "action": "skipped",
            "reason": (
                f"no real wind data covering the {city.wind_history_hours}h window ending "
                f"{as_of.isoformat()} ({wind_source_desc})"
            ),
            "spike": spike,
        }

    tracer_result = run_adjoint_tracer(city, station["location"]["lat"], station["location"]["lon"], wind_window)
    # bearing_deg is None ONLY in the genuine no-particles-anywhere case
    # (estimate_tier == "none") -- a saturated interior (the dominant real
    # case, see PROMPT_FLOW_INTEGRATION.md) now falls back to
    # estimate_tier == "boundary_sector_fallback" instead of None, and is
    # still posted, with its own honest (possibly low) confidence.
    if tracer_result is None or tracer_result["bearing_deg"] is None:
        return {
            "station_id": station_id, "action": "skipped",
            "reason": "adjoint trace produced no directional signal at all (receptor outside domain, or zero particles reached any boundary sector)",
            "spike": spike,
        }

    last_wind_ts, last_wind_obs = wind_window[-1]
    payload = {
        "timestamp": spike["timestamp"],
        "station_id": station_id,
        "idempotency_key": make_idempotency_key(station_id, spike["timestamp"]),
        "trigger": {
            "actual_aqi": spike["actual_aqi"], "predicted_aqi": spike["predicted_aqi"],
            "predicted_low": spike["predicted_low"], "predicted_high": spike["predicted_high"],
            "sigma": spike["sigma"],
        },
        "wind": {
            "speed_m_s": last_wind_obs.wind_speed_m_s, "dir_from_deg": last_wind_obs.wind_dir_deg,
            "station_id": last_wind_obs.station_id, "as_of": last_wind_ts.isoformat(),
            "source_tier": wind_source_tier,
        },
        "bearing_deg": tracer_result["bearing_deg"],
        "distance_m": tracer_result["distance_m"],  # None for a boundary-fallback estimate -- never fabricated
        "confidence": tracer_result["confidence"],
        "boundary_inflow_fraction": tracer_result["boundary_inflow_fraction"],
        "n_particles": tracer_result["n_particles"],
        "seed": tracer_result["seed"],
        "estimate_tier": tracer_result["estimate_tier"],
        "label": SOURCE_DIRECTION_LABEL,  # the backend enforces this regardless; sent for clarity/logging only
    }

    resp = post_source_direction(base_url, device_id, device_key, payload)
    return {
        "station_id": station_id,
        "action": "ingested" if resp.ok else "post_failed",
        "status_code": resp.status_code,
        "spike": spike,
        "tracer": tracer_result,
        # Surfaced at the top level (not buried inside "tracer") so it's
        # visible wherever this result's bearing is printed/logged --
        # never let a model-derived-wind bearing read the same as one
        # backed by a real ground-station reading.
        "wind_source_tier": wind_source_tier,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:4000")
    parser.add_argument("--city", default="live_deployment")
    parser.add_argument("--device-id", default="WORKER-SOURCE-DIRECTION")
    parser.add_argument("--device-key", required=True)
    parser.add_argument(
        "--as-of", default=None,
        help=(
            "ISO timestamp to backtest against met/ingest_real_met.py's real HISTORICAL "
            "Nellore archive. Omit for a real live run (default): uses 'now' and fetches "
            "met/live_wind.py's real live current-conditions wind instead."
        ),
    )
    parser.add_argument("--lookback", type=int, default=168)
    args = parser.parse_args()

    use_live_wind = args.as_of is None
    as_of = (
        datetime.now(timezone.utc)
        if args.as_of is None
        else datetime.fromisoformat(args.as_of).replace(tzinfo=timezone.utc)
    )
    city = load_city(args.city)

    stations = fetch_stations(args.base_url)
    valid = valid_stations(stations)
    print(f"[source-direction-worker] {len(stations)} station(s) reported, {len(valid)} valid (have device_id + location)")

    for station in valid:
        result = process_station(
            args.base_url, station, city, args.device_id, args.device_key, as_of, args.lookback,
            use_live_wind=use_live_wind,
        )
        print(f"[source-direction-worker] {result}")


if __name__ == "__main__":
    main()
