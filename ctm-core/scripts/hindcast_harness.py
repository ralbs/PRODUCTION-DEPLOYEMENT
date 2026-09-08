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
from ctm.emissions import local_hour_from_utc
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
        metrics[species] = skill_metrics(pred_arr, obs_arr)
    return metrics


def run_hindcast_temporal_holdout(
    city: CityConfig,
    start_time: datetime,
    n_steps: int,
    observations: list[HindcastRecord],
    station_ids: set[str],
    training_steps: int,
    met_stations: list[StationObservation] | Callable[[int], list[StationObservation]],
    hour_utc0: float = 0.0,
) -> dict:
    """A TEMPORAL holdout, distinct from run_hindcast()'s SPATIAL one:
    the SAME stations (`station_ids`) are assimilated for `t <
    training_steps`, then assimilation stops entirely and the model runs
    forward freely (persistence/forecast, no further nudging) for the
    remaining steps -- scored against those same stations' real
    observations during that forecast period only. run_hindcast()'s
    station-based assimilated/held-out partition can't express this (a
    station there is either always-assimilated or never-assimilated for
    the whole run); this is a genuinely different experimental axis
    (time, not space), so it gets its own function rather than a
    forced-fit reuse of the spatial one.

    Returns `{species: {"rmse", "bias", "correlation", "mfb", "mfe", "n"}}`.
    """
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    dt = city.dt_seconds

    by_step_assim: dict[int, dict[str, list[Observation]]] = {}
    by_step_score: dict[int, list[HindcastRecord]] = {}
    for rec in observations:
        if rec.station_id not in station_ids:
            continue
        offset_s = (rec.timestamp - start_time).total_seconds()
        step = round(offset_s / dt)
        if not (0 <= step < n_steps):
            continue
        if step < training_steps:
            by_step_assim.setdefault(step, {}).setdefault(rec.species, []).append(
                Observation(sensor_id=rec.station_id, value=rec.value)
            )
        else:
            by_step_score.setdefault(step, []).append(rec)

    sim = Simulator(city, hour_utc0=hour_utc0)
    predictions: dict[str, list[tuple[float, float]]] = {}

    for t in range(n_steps):
        stations = met_stations(t) if callable(met_stations) else met_stations
        sim.step(stations, observations=by_step_assim.get(t) if t < training_steps else None)

        for rec in by_step_score.get(t, []):
            i, j = sim.grid.latlon_to_cell(rec.lat, rec.lon)
            if not (0 <= i < sim.grid.nx and 0 <= j < sim.grid.ny):
                continue
            pred = float(sim.grid.get_field(rec.species)[i, j])
            predictions.setdefault(rec.species, []).append((pred, rec.value))

    metrics = {}
    for species, pairs in predictions.items():
        pred_arr = np.array([p for p, _ in pairs])
        obs_arr = np.array([o for _, o in pairs])
        metrics[species] = skill_metrics(pred_arr, obs_arr)
    return metrics


def mean_fractional_bias(pred: np.ndarray, obs: np.ndarray) -> float:
    """MFB = mean[2*(P-O)/(P+O)], Boylan & Russell (2006), "PM air quality
    model performance metrics: a comparison of predictive and explanatory
    performance" (Atmospheric Environment 40). The symmetric 2*(P-O)/(P+O)
    normalization (not a plain (P-O)/O relative error) is specifically
    chosen because a plain O-only denominator blows up / is asymmetric
    near zero; this form is bounded in [-200%, +200%] by construction.
    Pairs where P+O == 0 are excluded (undefined, not zero)."""
    pred = np.asarray(pred, dtype=np.float64)
    obs = np.asarray(obs, dtype=np.float64)
    denom = pred + obs
    valid = denom != 0
    if not np.any(valid):
        return float("nan")
    return float(np.mean(2.0 * (pred[valid] - obs[valid]) / denom[valid]))


def mean_fractional_error(pred: np.ndarray, obs: np.ndarray) -> float:
    """MFE = mean[2*|P-O|/(P+O)], Boylan & Russell (2006) -- see
    mean_fractional_bias()'s docstring for the citation and why this
    symmetric normalization is used. Bounded in [0%, 200%] by
    construction. Boylan & Russell's suggested PM2.5 performance
    thresholds (also widely applied to other species in practice):
    GOAL (tighter, desirable): MFE <= 50%, |MFB| <= 30%.
    CRITERIA (looser, acceptable): MFE <= 75%, |MFB| <= 60%."""
    pred = np.asarray(pred, dtype=np.float64)
    obs = np.asarray(obs, dtype=np.float64)
    denom = pred + obs
    valid = denom != 0
    if not np.any(valid):
        return float("nan")
    return float(np.mean(2.0 * np.abs(pred[valid] - obs[valid]) / denom[valid]))


def skill_metrics(pred: np.ndarray, obs: np.ndarray) -> dict:
    """RMSE, bias, Pearson correlation, MFB, and MFE for one (pred, obs)
    pair array -- the single source of truth run_hindcast() and any
    caller comparing predictions to observations should use, so these
    numbers are never computed two different ways in two different
    places."""
    pred = np.asarray(pred, dtype=np.float64)
    obs = np.asarray(obs, dtype=np.float64)
    errors = pred - obs
    if len(pred) >= 2 and np.std(pred) > 0 and np.std(obs) > 0:
        correlation = float(np.corrcoef(pred, obs)[0, 1])
    else:
        correlation = float("nan")
    return {
        "rmse": float(np.sqrt(np.mean(errors**2))) if len(pred) else float("nan"),
        "bias": float(np.mean(errors)) if len(pred) else float("nan"),
        "correlation": correlation,
        "mfb": mean_fractional_bias(pred, obs),
        "mfe": mean_fractional_error(pred, obs),
        "n": len(pred),
    }


def persistence_baseline(
    observations: list[HindcastRecord],
    station_ids: set[str],
    reference_time: datetime,
) -> dict:
    """No model, no physics: for each (station_id, species) pair among
    `station_ids`, the prediction for every REAL observation AFTER
    `reference_time` is simply the value of that (station, species)'s
    most recent REAL observation AT OR BEFORE `reference_time`, held
    constant -- the standard "can you beat doing nothing" floor. A pair
    with no observation at or before `reference_time` contributes no
    predictions (nothing to persist from) and is silently skipped, not
    treated as an error -- a genuinely absent baseline reference is a
    real, unremarkable outcome for a station that just hadn't reported
    yet, not a data-quality problem.

    Returns `{species: {"rmse", "bias", "correlation", "mfb", "mfe", "n",
    "lead_time_errors": [(lead_time_seconds, signed_error), ...]}}` --
    the same shape run_hindcast() returns, PLUS `lead_time_errors` so
    callers (and this function's own test) can verify error grows with
    forecast lead time: a persistence forecast should get WORSE the
    further ahead of its single reference point it predicts, since it
    has no physics to actually simulate what changes in between --
    unlike a real transport model, which should not degrade this way.
    """
    if reference_time.tzinfo is None:
        reference_time = reference_time.replace(tzinfo=timezone.utc)

    by_key: dict[tuple[str, str], list[HindcastRecord]] = {}
    for rec in observations:
        if rec.station_id not in station_ids:
            continue
        by_key.setdefault((rec.station_id, rec.species), []).append(rec)

    predictions: dict[str, list[tuple[float, float, float]]] = {}  # species -> [(pred, obs, lead_s), ...]
    for (station_id, species), recs in by_key.items():
        recs.sort(key=lambda r: r.timestamp)
        reference_recs = [r for r in recs if r.timestamp <= reference_time]
        if not reference_recs:
            continue
        reference_rec = reference_recs[-1]  # most recent at or before reference_time
        for rec in recs:
            if rec.timestamp <= reference_time:
                continue
            lead_s = (rec.timestamp - reference_rec.timestamp).total_seconds()
            predictions.setdefault(species, []).append((reference_rec.value, rec.value, lead_s))

    metrics = {}
    for species, triples in predictions.items():
        pred_arr = np.array([p for p, _, _ in triples])
        obs_arr = np.array([o for _, o, _ in triples])
        m = skill_metrics(pred_arr, obs_arr)
        m["lead_time_errors"] = [(lead_s, p - o) for p, o, lead_s in triples]
        metrics[species] = m
    return metrics


def diurnal_climatology_baseline(
    training_observations: list[HindcastRecord],
    validation_observations: list[HindcastRecord],
    utc_offset_hours: float,
) -> dict:
    """No persistence, no physics: fits a simple mean-by-LOCAL-HOUR
    profile per (station_id, species) from `training_observations`
    (bucketed by `int(local_hour_from_utc(...))`, the SAME local-hour
    convention ctm/emissions.py's diurnal-profile indexing uses -- one
    source of truth, not a duplicated formula), then predicts every
    `validation_observations` record using its own local hour's
    TRAINING-window climatological mean -- "what does this station and
    species usually look like at this time of day." This is specifically
    designed to catch a model whose apparent skill is just matching the
    typical diurnal shape: such a model should score similarly to this
    baseline, not obviously better.

    MUST be fit and scored on genuinely disjoint windows --
    `training_observations` and `validation_observations` should never
    overlap in time; this function does not (and cannot) verify that
    itself, since it only sees the records it's given, not the windows
    they were drawn from -- that separation is the caller's
    responsibility, per this project's train/validate rule.

    A (station_id, species, local_hour) bucket with NO training-window
    coverage cannot be scored (there's no climatological mean to predict
    from); such validation records are excluded and counted under
    `n_uncovered`. If EVERY validation record across ALL species ends up
    uncovered (e.g. training and validation windows share no local-hour
    coverage at all -- a real, checkable failure mode, not hypothetical),
    raises ValueError rather than silently returning an all-NaN metrics
    dict that could be mistaken for "ran fine, just no signal."

    Returns `{species: {"rmse", "bias", "correlation", "mfb", "mfe", "n",
    "n_uncovered"}}`.
    """
    climatology: dict[tuple[str, str, int], list[float]] = {}
    for rec in training_observations:
        hour_utc = rec.timestamp.hour + rec.timestamp.minute / 60.0 + rec.timestamp.second / 3600.0
        local_hour = local_hour_from_utc(hour_utc, utc_offset_hours)
        bucket = int(local_hour) % 24
        climatology.setdefault((rec.station_id, rec.species, bucket), []).append(rec.value)
    climatology_mean = {key: float(np.mean(vals)) for key, vals in climatology.items()}

    predictions: dict[str, list[tuple[float, float]]] = {}
    n_uncovered = 0
    for rec in validation_observations:
        hour_utc = rec.timestamp.hour + rec.timestamp.minute / 60.0 + rec.timestamp.second / 3600.0
        local_hour = local_hour_from_utc(hour_utc, utc_offset_hours)
        bucket = int(local_hour) % 24
        key = (rec.station_id, rec.species, bucket)
        if key not in climatology_mean:
            n_uncovered += 1
            continue
        predictions.setdefault(rec.species, []).append((climatology_mean[key], rec.value))

    total_usable = sum(len(pairs) for pairs in predictions.values())
    if total_usable == 0:
        raise ValueError(
            "diurnal_climatology_baseline(): zero validation records could be scored -- "
            "the training and validation windows share no (station, species, local_hour) "
            "coverage at all. This usually means the validation window's local-hour range "
            "doesn't overlap the training window's at all (e.g. training covers only "
            "daytime hours, validation only night); check the windows, don't ignore this."
        )

    metrics = {}
    for species, pairs in predictions.items():
        pred_arr = np.array([p for p, _ in pairs])
        obs_arr = np.array([o for _, o in pairs])
        m = skill_metrics(pred_arr, obs_arr)
        m["n_uncovered"] = sum(
            1 for rec in validation_observations
            if rec.species == species
            and (rec.station_id, rec.species, int(local_hour_from_utc(rec.timestamp.hour + rec.timestamp.minute / 60.0 + rec.timestamp.second / 3600.0, utc_offset_hours)) % 24) not in climatology_mean
        )
        metrics[species] = m
    return metrics
