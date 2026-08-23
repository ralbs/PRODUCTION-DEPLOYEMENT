"""scripts/hindcast_harness.py — historical validation harness (stub).

Given a `CityConfig`, a start time, a step count, and a CSV of historical
sensor observations, runs `ctm.simulator.Simulator` forward with OI
assimilation fed from an "assimilated" station subset, and reports basic
skill metrics (RMSE, bias, Pearson correlation, per species) against a
"held-out" subset that is NEVER fed into assimilation.

There is no real historical data behind this yet -- per CLAUDE.md's "After
Phase 10", a green test suite (including this harness's own test) proves
internal consistency, not agreement with reality. This module exists so
it's ready to receive real CPCB (or equivalent) observations once
available; the accompanying test proves the harness itself works end-to-
end using SYNTHETIC "historical" data generated from a forward run with
known ground truth (the same technique Phase 7's inversion recovery test
uses).

CSV schema (documented here since there is no real file to point at yet):

    station_id,lat,lon,species,value,timestamp
    AQMS-01,12.975,77.60,pm25,42.3,2024-01-15T08:00:00

`timestamp` is an ISO-8601 datetime string (naive timestamps are treated
as UTC). `station_id` values in the ASSIMILATED set must match an id
declared in the city config's sensor network -- `ctm.assimilation.
assimilate()` resolves sensor location/observation-error sigma from there.
Held-out stations use the CSV's own lat/lon directly and need not be
declared in the city config at all.
"""
from __future__ import annotations

import csv
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from cities.loader import CityConfig
from ctm.assimilation import Observation
from ctm.simulator import Simulator
from met.weather_station import StationObservation


@dataclass(frozen=True)
class HindcastRecord:
    station_id: str
    lat: float
    lon: float
    species: str
    value: float
    timestamp: datetime


def _parse_timestamp(raw: str) -> datetime:
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def load_observations_csv(path: str | Path) -> list[HindcastRecord]:
    """Load the station_id,lat,lon,species,value,timestamp CSV schema
    documented in the module docstring."""
    records = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            records.append(
                HindcastRecord(
                    station_id=row["station_id"],
                    lat=float(row["lat"]),
                    lon=float(row["lon"]),
                    species=row["species"],
                    value=float(row["value"]),
                    timestamp=_parse_timestamp(row["timestamp"]),
                )
            )
    return records


def write_observations_csv(path: str | Path, records: list[HindcastRecord]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["station_id", "lat", "lon", "species", "value", "timestamp"])
        for r in records:
            writer.writerow([r.station_id, r.lat, r.lon, r.species, r.value, r.timestamp.isoformat()])


def run_hindcast(
    city: CityConfig,
    start_time: datetime,
    n_steps: int,
    observations: list[HindcastRecord],
    assimilated_station_ids: set[str],
    held_out_station_ids: set[str],
    met_stations: list[StationObservation] | Callable[[int], list[StationObservation]],
    hour_utc0: float = 0.0,
) -> dict:
    """Run the Simulator forward for `n_steps`, assimilating observations
    from `assimilated_station_ids` and scoring the model against
    `held_out_station_ids` (never assimilated). `met_stations` is either a
    fixed station list (used every step) or a callable `step_index ->
    list[StationObservation]`, so this is ready for real per-step
    historical meteorology later without changing the signature.

    Returns `{species: {"rmse", "bias", "correlation", "n"}}`.
    """
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    dt = city.dt_seconds

    by_step_assim: dict[int, dict[str, list[Observation]]] = {}
    by_step_heldout: dict[int, list[HindcastRecord]] = {}
    for rec in observations:
        offset_s = (rec.timestamp - start_time).total_seconds()
        step = round(offset_s / dt)
        if not (0 <= step < n_steps):
            continue
        if rec.station_id in assimilated_station_ids:
            by_step_assim.setdefault(step, {}).setdefault(rec.species, []).append(
                Observation(sensor_id=rec.station_id, value=rec.value)
            )
        elif rec.station_id in held_out_station_ids:
            by_step_heldout.setdefault(step, []).append(rec)

    sim = Simulator(city, hour_utc0=hour_utc0)
    predictions: dict[str, list[tuple[float, float]]] = {}

    for t in range(n_steps):
        stations = met_stations(t) if callable(met_stations) else met_stations
        sim.step(stations, observations=by_step_assim.get(t))

        for rec in by_step_heldout.get(t, []):
            i, j = sim.grid.latlon_to_cell(rec.lat, rec.lon)
            if not (0 <= i < sim.grid.nx and 0 <= j < sim.grid.ny):
                continue
            pred = float(sim.grid.get_field(rec.species)[i, j])
            predictions.setdefault(rec.species, []).append((pred, rec.value))

    metrics = {}
    for species, pairs in predictions.items():
        pred_arr = np.array([p for p, _ in pairs])
        obs_arr = np.array([o for _, o in pairs])
        errors = pred_arr - obs_arr
        if len(pairs) >= 2 and np.std(pred_arr) > 0 and np.std(obs_arr) > 0:
            correlation = float(np.corrcoef(pred_arr, obs_arr)[0, 1])
        else:
            correlation = float("nan")
        metrics[species] = {
            "rmse": float(np.sqrt(np.mean(errors**2))),
            "bias": float(np.mean(errors)),
            "correlation": correlation,
            "n": len(pairs),
        }
    return metrics
