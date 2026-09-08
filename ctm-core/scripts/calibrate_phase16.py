"""scripts/calibrate_phase16.py — Phase 16 TRIAL recalibration script.

*** DO NOT RE-RUN THIS UNMODIFIED — see PHASE16_CALIBRATION_REPORT.md. ***
Its pm10/pm25 background_conc trial (training-window mean) was RUN,
DIAGNOSED, AND REJECTED: it overfit a real within-week pollution drift
(training days were ~35% higher than validation days, confirmed directly
against real station data) and made validation-window skill WORSE, not
better. `cities/bangalore.json` has since been reverted to its original
pm10/pm25 background_conc (35.0 / 15.0) by hand. Re-running this script
as-is will silently reapply the rejected values and overwrite that
revert. Its co/Hosur-Road-Corridor trial, by contrast, WAS applied (it
generalized to a second, entirely different week — see
scripts/check_co_cross_week_generalization.py) and is reflected in the
current config. This file is kept for the reasoning/method it documents,
not as a script safe to re-run blindly.

Original scope, per the Phase 15 diagnosis (scripts/diagnose_phase15.py):
pm10/pm25 background_conc (magnitude/bias-only failure mode -> calibration
seemed defensible, but see above), co's Hosur Road Corridor source rate
ONLY (the one station -- Silk Board, 6975 -- with clean composition +
shape + timing agreement; NOT extrapolated to any other station or
source), so2 EXCLUDED (timing-wrong, calibration would mask it), no2
DEFERRED (documented photochemistry-timing gap).

Per this project's train/validate rule: calibration fits ONLY on a
TRAINING sub-window of the disjoint week 2019-07-17..2019-07-23 (confirmed
real and never used in any Phase 15 reported skill number), and is scored
ONLY on that same week's VALIDATION sub-window -- never on the Phase 15
window, and never on the same data used to fit it.

background_conc method: the training-window MEAN of real observations
across all 5 real stations (documented in CLAUDE.md's Phase 16 example:
"background_conc = training-window mean at stations far from known
sources" -- the Phase 15 tagged-tracer composition diagnostic already
showed pm10/pm25 are ~95-100% background at every station, i.e. all 5
stations qualify as "far from known sources" for these two species in
this model).

Hosur Road Corridor co rate method: TWO forward (no-assimilation) runs
over the training window with the CURRENT config -- (A) as-is, (B) with
ONLY Hosur Road Corridor's co rate set to zero -- isolates that one
source's own contribution to Silk Board's cell (mean_full - mean_without
_hosur) by differencing, cleanly separated from Outer Ring Road NE (same
"morning_evening" profile/tag, but a different source) and from
background. The new rate is solved so that source's contribution alone
would make the model's Silk Board mean match the real training-window
Silk Board mean, holding everything else fixed -- exact under this
model's linearity in emission rate (CLAUDE.md's SourceInversion assumes
the same C = H @ E linearity).
"""
from __future__ import annotations

import copy
import json
from datetime import timedelta

import numpy as np

from cities.loader import load_city
from ctm.simulator import Simulator
from met.ingest_real_met import RealMetSeries, load_real_met_series
from scripts.hindcast_harness import (
    diurnal_climatology_baseline,
    load_observations_csv,
    persistence_baseline,
    run_hindcast,
    skill_metrics,
)

NEW_OBS_CSV = "data/processed/bangalore_openaq_20190717_20190723.csv"
NEW_MET_CSV = "data/raw/meteostat_bangalore/43295_20190717_0723.csv"
PHASE15_OBS_CSV = "data/processed/bangalore_openaq_20190710_20190716.csv"
PHASE15_MET_CSV = "data/raw/meteostat_bangalore/43295_201907.csv"
CITY_JSON_PATH = "cities/bangalore.json"

STATIONS = {
    "6983": (12.938539, 77.5901),
    "6984": (13.029152, 77.585901),
    "6973": (12.920984, 77.584908),
    "5548": (12.9135218, 77.5950804),
    "6975": (12.917348, 77.622813),
}
SILK_BOARD = "6975"
BURN_IN_STEPS = 1440  # 24h at dt=60s, same convention as diagnose_phase15.py


def forward_no_assim_pooled(city, start_time, n_steps, met_stations, hour_utc0, station_filter=None):
    """Runs the forward model (no assimilation) for n_steps and returns,
    per step, the predicted value at every station in `station_filter`
    (default: all STATIONS) for every species the city tracks -- used both
    for calibration-window averaging and validation-window scoring."""
    sim = Simulator(city, hour_utc0=hour_utc0)
    ids = station_filter or list(STATIONS)
    cells = {sid: sim.grid.latlon_to_cell(*STATIONS[sid]) for sid in ids}
    species_list = list(city.species)
    out = {sid: {sp: [] for sp in species_list} for sid in ids}
    for t in range(n_steps):
        sim.step(met_stations(t), observations=None)
        for sid, (i, j) in cells.items():
            for sp in species_list:
                out[sid][sp].append(float(sim.grid.get_field(sp)[i, j]))
    return out


def mean_after_burn_in(series: list[float], burn_in: int) -> float:
    tail = series[burn_in:]
    return float(np.mean(tail)) if tail else float("nan")


def main() -> None:
    city_old = load_city("bangalore")

    records = load_observations_csv(NEW_OBS_CSV)
    timestamps = sorted(r.timestamp for r in records)
    start_time = timestamps[0]
    span_s = (timestamps[-1] - start_time).total_seconds()
    n_steps = int(span_s // city_old.dt_seconds) + 1
    hour_utc0 = start_time.hour + start_time.minute / 60.0

    training_days = 4
    training_steps = int(training_days * 86400 / city_old.dt_seconds)
    training_end = start_time + timedelta(seconds=training_steps * city_old.dt_seconds)

    print(f"Disjoint calibration week: {start_time.isoformat()} to {timestamps[-1].isoformat()}")
    print(f"Training sub-window: {start_time.isoformat()} to {training_end.isoformat()} ({training_steps} steps)")
    print(f"Validation sub-window: {training_end.isoformat()} to {timestamps[-1].isoformat()}")
    print(f"n_steps={n_steps}, {len(records)} real records this week")

    met_series, met_counts = load_real_met_series([NEW_MET_CSV])
    met_stations = RealMetSeries(met_series, start_time, city_old.dt_seconds)
    print(f"Real met: {met_counts['n_usable']} usable reports, {met_counts['n_rejected_incomplete_or_nonfinite']} rejected")

    # === Derive new background_conc for pm10/pm25 from TRAINING window ===
    training_records = [r for r in records if r.timestamp < training_end]
    new_background = {}
    for sp in ("pm10", "pm25"):
        vals = [r.value for r in training_records if r.species == sp]
        new_background[sp] = float(np.mean(vals))
        print(f"\n{sp}: training-window mean across all 5 stations, n={len(vals)}: {new_background[sp]:.3f}")

    # === Derive new Hosur Road Corridor co rate from TRAINING window ===
    print("\n--- CO / Silk Board / Hosur Road Corridor calibration ---")
    hosur_idx = next(i for i, s in enumerate(city_old.emission_sources) if s.name == "Hosur Road Corridor")
    old_hosur_rate = city_old.emission_sources[hosur_idx].rates["co"]
    print(f"Hosur Road Corridor old co rate: {old_hosur_rate}")

    # Run A: current config, no assimilation, training window only.
    resA = forward_no_assim_pooled(city_old, start_time, training_steps, met_stations, hour_utc0, station_filter=[SILK_BOARD])
    mean_full = mean_after_burn_in(resA[SILK_BOARD]["co"], BURN_IN_STEPS)

    # Run B: same, but Hosur Road Corridor's co rate zeroed (in-memory only).
    city_no_hosur = copy.deepcopy(city_old)
    city_no_hosur.emission_sources[hosur_idx].rates["co"] = 0.0
    resB = forward_no_assim_pooled(city_no_hosur, start_time, training_steps, met_stations, hour_utc0, station_filter=[SILK_BOARD])
    mean_without_hosur = mean_after_burn_in(resB[SILK_BOARD]["co"], BURN_IN_STEPS)

    hosur_contribution = mean_full - mean_without_hosur
    real_co_training = [r.value for r in training_records if r.species == "co" and r.station_id == SILK_BOARD]
    real_mean_training = float(np.mean(real_co_training))
    print(f"model co @ Silk Board (training window, post-burn-in): full={mean_full:.4f}  without_hosur={mean_without_hosur:.4f}  hosur_contribution={hosur_contribution:.4f}")
    print(f"real co @ Silk Board (training window): mean={real_mean_training:.4f}  n={len(real_co_training)}")

    target_hosur_contribution = real_mean_training - mean_without_hosur
    if hosur_contribution <= 0 or target_hosur_contribution <= 0:
        raise RuntimeError(
            f"co calibration degenerate: hosur_contribution={hosur_contribution}, "
            f"target={target_hosur_contribution} -- cannot solve a positive rate scaling"
        )
    new_hosur_rate = old_hosur_rate * target_hosur_contribution / hosur_contribution
    print(f"new Hosur Road Corridor co rate: {old_hosur_rate:.4f} -> {new_hosur_rate:.4f} (x{new_hosur_rate/old_hosur_rate:.3f})")

    def score_from_series(res, recs, start, dt_seconds, station_ids, species_list, t_min, t_max):
        """Scores an already-simulated `res` (from forward_no_assim_pooled)
        against `recs` restricted to [t_min, t_max) -- lets one simulation
        run serve BOTH a training-window and a validation-window score."""
        metrics = {}
        for sp in species_list:
            preds, obs = [], []
            for sid in station_ids:
                series = res[sid][sp]
                for r in recs:
                    if r.station_id != sid or r.species != sp or not (t_min <= r.timestamp < t_max):
                        continue
                    step = round((r.timestamp - start).total_seconds() / dt_seconds)
                    if 0 <= step < len(series):
                        preds.append(series[step])
                        obs.append(r.value)
            metrics[sp] = skill_metrics(np.array(preds), np.array(obs))
        return metrics

    def print_metrics(d):
        for sp, m in d.items():
            print(f"  {sp}: n={m['n']} rmse={m['rmse']:.3f} bias={m['bias']:+.3f} corr={m['correlation']:+.3f} mfb={m['mfb']*100:+.1f}% mfe={m['mfe']*100:.1f}%")

    far_future = timestamps[-1] + timedelta(days=1)

    # One full-window (no-assim) forward run with the OLD config, covering
    # BOTH the training and validation sub-windows -- reused for both
    # scores below (and for the training-window "own-data" fit quality
    # check in point 3) rather than re-simulating per window.
    res_old_full = forward_no_assim_pooled(city_old, start_time, n_steps, met_stations, hour_utc0, station_filter=list(STATIONS))

    print("\n--- BEFORE calibration, TRAINING window (own-data fit quality, for the overfitting check) ---")
    before_train_pm = score_from_series(res_old_full, records, start_time, city_old.dt_seconds, list(STATIONS), ["pm10", "pm25"], start_time, training_end)
    before_train_co = score_from_series(res_old_full, records, start_time, city_old.dt_seconds, [SILK_BOARD], ["co"], start_time, training_end)
    print_metrics({**before_train_pm, **before_train_co})

    print("\n--- BEFORE calibration, VALIDATION window, OLD config ---")
    before_pm = score_from_series(res_old_full, records, start_time, city_old.dt_seconds, list(STATIONS), ["pm10", "pm25"], training_end, far_future)
    before_co = score_from_series(res_old_full, records, start_time, city_old.dt_seconds, [SILK_BOARD], ["co"], training_end, far_future)
    print_metrics({**before_pm, **before_co})

    # === Phase 15 window, OLD config, SAME pooled-no-assim methodology ===
    # (a like-for-like reference point -- Phase 15's own "no-assimilation
    # control" table only covered 6983/6984, not all 5 stations, and never
    # covered Silk Board's co at all, so this is computed fresh here for
    # comparability, NOT a new tuning claim -- config is untouched.)
    p15_records = load_observations_csv(PHASE15_OBS_CSV)
    p15_start = sorted(r.timestamp for r in p15_records)[0]
    p15_end = sorted(r.timestamp for r in p15_records)[-1]
    p15_n_steps = int((p15_end - p15_start).total_seconds() // city_old.dt_seconds) + 1
    p15_met_series, _ = load_real_met_series([PHASE15_MET_CSV])
    p15_met_stations = RealMetSeries(p15_met_series, p15_start, city_old.dt_seconds)
    p15_hour_utc0 = p15_start.hour + p15_start.minute / 60.0
    res_p15 = forward_no_assim_pooled(city_old, p15_start, p15_n_steps, p15_met_stations, p15_hour_utc0, station_filter=list(STATIONS))
    print("\n--- REFERENCE: Phase 15 window, OLD config, same pooled no-assim methodology ---")
    p15_pm = score_from_series(res_p15, p15_records, p15_start, city_old.dt_seconds, list(STATIONS), ["pm10", "pm25"], p15_start, p15_end + timedelta(days=1))
    p15_co = score_from_series(res_p15, p15_records, p15_start, city_old.dt_seconds, [SILK_BOARD], ["co"], p15_start, p15_end + timedelta(days=1))
    print_metrics({**p15_pm, **p15_co})

    # === Apply calibration to cities/bangalore.json ===
    with open(CITY_JSON_PATH, "r", encoding="utf-8") as f:
        city_json = json.load(f)
    old_pm10_bg = city_json["species"]["pm10"]["background_conc"]
    old_pm25_bg = city_json["species"]["pm25"]["background_conc"]
    city_json["species"]["pm10"]["background_conc"] = round(new_background["pm10"], 3)
    city_json["species"]["pm25"]["background_conc"] = round(new_background["pm25"], 3)
    for src in city_json["emission_sources"]:
        if src["name"] == "Hosur Road Corridor":
            src["rates"]["co"] = round(new_hosur_rate, 4)
    city_json.setdefault("_phase16_calibration", {})
    city_json["_phase16_calibration"] = {
        "method": "Phase 16 -- calibrated ONLY on the disjoint 2019-07-17..2019-07-23 training sub-window (first 4 days); "
                  "validated on that week's remaining ~3 days, never on the Phase 15 window.",
        "pm10_background_conc": {"old": old_pm10_bg, "new": round(new_background["pm10"], 3), "method": "training-window mean, all 5 real stations"},
        "pm25_background_conc": {"old": old_pm25_bg, "new": round(new_background["pm25"], 3), "method": "training-window mean, all 5 real stations"},
        "hosur_road_corridor_co_rate": {"old": old_hosur_rate, "new": round(new_hosur_rate, 4), "method": "forward with/without-Hosur differencing at Silk Board (6975) ONLY, training window"},
        "so2": "EXCLUDED this round -- negative-or-near-zero shape correlation in all 7 checked Phase 15 rows",
        "no2": "DEFERRED -- documented photochemistry-timing limitation, not a magnitude problem",
        "co_scope": "Hosur Road Corridor rate only, fit against Silk Board (6975) only -- NOT extrapolated to any other source or station",
    }
    with open(CITY_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(city_json, f, indent=2)
        f.write("\n")
    print(f"\nWrote calibrated config to {CITY_JSON_PATH}")

    # === AFTER scoring: one full-window run with the NEW config, reused
    # for both the training-window own-data check and the validation score ===
    city_new = load_city("bangalore")
    res_new_full = forward_no_assim_pooled(city_new, start_time, n_steps, met_stations, hour_utc0, station_filter=list(STATIONS))

    print("\n--- AFTER calibration, TRAINING window (own-data fit quality, for the overfitting check) ---")
    after_train_pm = score_from_series(res_new_full, records, start_time, city_new.dt_seconds, list(STATIONS), ["pm10", "pm25"], start_time, training_end)
    after_train_co = score_from_series(res_new_full, records, start_time, city_new.dt_seconds, [SILK_BOARD], ["co"], start_time, training_end)
    print_metrics({**after_train_pm, **after_train_co})

    print("\n--- AFTER calibration, VALIDATION window, NEW config ---")
    after_pm = score_from_series(res_new_full, records, start_time, city_new.dt_seconds, list(STATIONS), ["pm10", "pm25"], training_end, far_future)
    after_co = score_from_series(res_new_full, records, start_time, city_new.dt_seconds, [SILK_BOARD], ["co"], training_end, far_future)
    print_metrics({**after_pm, **after_co})

    # === Baselines on the SAME validation window ===
    print("\n--- Baselines, NEW week validation window ---")
    validation_records_pm = [r for r in records if r.station_id in STATIONS and r.species in ("pm10", "pm25") and r.timestamp >= training_end]
    validation_records_co = [r for r in records if r.station_id == SILK_BOARD and r.species == "co" and r.timestamp >= training_end]
    persist_pm = persistence_baseline(records, set(STATIONS), reference_time=training_end)
    persist_co = persistence_baseline(records, {SILK_BOARD}, reference_time=training_end)
    train_obs_pm = [r for r in training_records if r.station_id in STATIONS and r.species in ("pm10", "pm25")]
    train_obs_co = [r for r in training_records if r.station_id == SILK_BOARD and r.species == "co"]
    clim_pm = diurnal_climatology_baseline(train_obs_pm, validation_records_pm, city_new.utc_offset_hours)
    clim_co = diurnal_climatology_baseline(train_obs_co, validation_records_co, city_new.utc_offset_hours)
    for label, d in (("persistence", {**persist_pm, **persist_co}), ("climatology", {**clim_pm, **clim_co})):
        for sp in ("pm10", "pm25", "co"):
            if sp not in d:
                continue
            m = d[sp]
            print(f"  {label:12s} {sp}: n={m['n']} rmse={m['rmse']:.3f} bias={m['bias']:+.3f} corr={m['correlation']:+.3f} mfb={m['mfb']*100:+.1f}% mfe={m['mfe']*100:.1f}%")


if __name__ == "__main__":
    main()
