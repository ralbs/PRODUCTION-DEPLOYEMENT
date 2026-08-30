"""scripts/diagnose_phase15.py — diagnoses WHY Phase 15's diurnal-
climatology baseline beats CTM-assimilated in most species/experiment
combinations, before any Phase 16 recalibration is attempted (recalibrating
background_conc/deposition/emission rates would be the WRONG fix if the
problem is diurnal TIMING/SHAPE rather than absolute magnitude/bias --
scaling parameters cannot fix a shape that's wrong, and could even mask it
by coincidentally improving an aggregate RMSE/bias number).

Two diagnostics, both reusing tools already built for exactly this rather
than a new ad hoc formula, run from a SINGLE forward (NO ASSIMILATION,
tagged tracers enabled) simulation over the full real-data window with
real meteorology:

1. Tagged-tracer composition at each real station: how much of the
   forward field is explained by the schematic emission-source categories
   vs background vs (assimilation-only, N/A here since this run never
   assimilates) -- answers "does the schematic inventory even reach this
   station at all."
2. Diurnal TIMING comparison: bins the forward model's predicted
   concentration AND the real observations by LOCAL HOUR (the same
   local_hour_from_utc() convention ctm/emissions.py and
   diurnal_climatology_baseline() both use) and compares the two 24-value
   profiles by Pearson correlation and peak-hour offset. High shape
   correlation + wrong absolute level = a magnitude/bias problem
   (calibration would fix it). Low/negative shape correlation = a
   timing/transport problem (calibration would not fix it).
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from cities.loader import load_city
from ctm.emissions import local_hour_from_utc
from ctm.simulator import Simulator
from met.ingest_real_met import RealMetSeries, load_real_met_series
from scripts.hindcast_harness import load_observations_csv

OBS_CSV = "data/processed/bangalore_openaq_20190710_20190716.csv"
MET_CSV = "data/raw/meteostat_bangalore/43295_201907.csv"

STATIONS = {
    "6983": ("Hombegowda Nagar", 12.938539, 77.5901),
    "6984": ("Hebbal", 13.029152, 77.585901),
    "6973": ("Jayanagar 5th Block", 12.920984, 77.584908),
    "5548": ("BTM Layout", 12.9135218, 77.5950804),
    "6975": ("Silk Board", 12.917348, 77.622813),
}
SPECIES = ["co", "no2", "pm10", "pm25", "so2"]
BURN_IN_STEPS = 1440  # 24h at dt=60s -- exclude the cold-start ramp from the composition average


def main() -> None:
    city = load_city("bangalore")
    records = load_observations_csv(OBS_CSV)
    timestamps = sorted(r.timestamp for r in records)
    start_time = timestamps[0]
    span_s = (timestamps[-1] - start_time).total_seconds()
    n_steps = int(span_s // city.dt_seconds) + 1

    met_series, _ = load_real_met_series([MET_CSV])
    met_stations = RealMetSeries(met_series, start_time, city.dt_seconds)
    hour_utc0 = start_time.hour + start_time.minute / 60.0

    sim = Simulator(city, enable_tagged_tracers=True, hour_utc0=hour_utc0)
    cells = {sid: sim.grid.latlon_to_cell(lat, lon) for sid, (_, lat, lon) in STATIONS.items()}

    # composition[station][species][tag] = running sum over post-burn-in steps
    composition_sum: dict[str, dict[str, dict[str, float]]] = {
        sid: {sp: defaultdict(float) for sp in SPECIES} for sid in STATIONS
    }
    composition_live_sum: dict[str, dict[str, float]] = {sid: defaultdict(float) for sid in STATIONS}
    composition_n = 0

    # predicted_by_hour[station][species][local_hour_bucket] = [values]
    predicted_by_hour: dict[str, dict[str, dict[int, list[float]]]] = {
        sid: {sp: defaultdict(list) for sp in SPECIES} for sid in STATIONS
    }

    for t in range(n_steps):
        sim.step(met_stations(t), observations=None)
        hour_utc = (hour_utc0 + t * city.dt_seconds / 3600.0) % 24.0
        local_hour = int(local_hour_from_utc(hour_utc, city.utc_offset_hours)) % 24

        for sid, (i, j) in cells.items():
            for sp in SPECIES:
                pred = float(sim.grid.get_field(sp)[i, j])
                predicted_by_hour[sid][sp][local_hour].append(pred)
                if t >= BURN_IN_STEPS:
                    composition_live_sum[sid][sp] += pred
                    for tag in sim.tagged_tracer_engine.tags:
                        composition_sum[sid][sp][tag] += float(sim.tagged_tracer_engine.fields[tag][sp][i, j])
        if t >= BURN_IN_STEPS:
            composition_n += 1

    # Real observations, binned by local hour, per station/species (ALL
    # real records -- this is a diagnostic of the model's mechanism, not a
    # scored prediction, so no train/validate split is needed here).
    observed_by_hour: dict[str, dict[str, dict[int, list[float]]]] = {
        sid: {sp: defaultdict(list) for sp in SPECIES} for sid in STATIONS
    }
    for r in records:
        if r.station_id not in STATIONS:
            continue
        hour_utc = r.timestamp.hour + r.timestamp.minute / 60.0 + r.timestamp.second / 3600.0
        local_hour = int(local_hour_from_utc(hour_utc, city.utc_offset_hours)) % 24
        observed_by_hour[r.station_id][r.species][local_hour].append(r.value)

    print("=" * 90)
    print("DIAGNOSTIC 1: tagged-tracer composition (forward model, NO assimilation, real wind)")
    print(f"(time-averaged over the post-burn-in window: steps {BURN_IN_STEPS}..{n_steps-1}, n={composition_n})")
    print("=" * 90)
    for sid, (name, _, _) in STATIONS.items():
        print(f"\n-- {sid} ({name}) --")
        for sp in SPECIES:
            live_mean = composition_live_sum[sid][sp] / composition_n if composition_n else float("nan")
            if live_mean == 0:
                print(f"  {sp}: live field is exactly zero at this cell -- skipping composition (nothing to decompose)")
                continue
            parts = []
            tag_sum = 0.0
            for tag, s in composition_sum[sid][sp].items():
                mean = s / composition_n if composition_n else float("nan")
                tag_sum += mean
                pct = 100 * mean / live_mean if live_mean else float("nan")
                parts.append((tag, mean, pct))
            unexplained_pct = 100 * (live_mean - tag_sum) / live_mean if live_mean else float("nan")
            parts_str = ", ".join(f"{tag}={pct:.1f}%" for tag, _, pct in sorted(parts, key=lambda x: -x[2]))
            print(f"  {sp}: live_mean={live_mean:.3f}  [{parts_str}]  unexplained={unexplained_pct:.1f}%")

    print("\n" + "=" * 90)
    print("DIAGNOSTIC 2: diurnal TIMING -- forward-model (no assimilation) vs real observations, by local hour")
    print("=" * 90)

    verdicts: dict[str, list[str]] = defaultdict(list)
    for sid, (name, _, _) in STATIONS.items():
        print(f"\n-- {sid} ({name}) --")
        for sp in SPECIES:
            pred_hours = predicted_by_hour[sid][sp]
            obs_hours = observed_by_hour[sid][sp]
            hours_both = sorted(set(pred_hours) & set(obs_hours))
            if len(hours_both) < 6:
                print(f"  {sp}: insufficient overlapping local-hour coverage ({len(hours_both)} hours) -- skipped")
                continue
            pred_profile = np.array([np.mean(pred_hours[h]) for h in hours_both])
            obs_profile = np.array([np.mean(obs_hours[h]) for h in hours_both])
            if np.std(pred_profile) == 0 or np.std(obs_profile) == 0:
                corr = float("nan")
            else:
                corr = float(np.corrcoef(pred_profile, obs_profile)[0, 1])
            pred_peak_hour = hours_both[int(np.argmax(pred_profile))]
            obs_peak_hour = hours_both[int(np.argmax(obs_profile))]
            # circular hour offset, shortest direction, range [0,12]
            raw_offset = abs(pred_peak_hour - obs_peak_hour)
            peak_offset = min(raw_offset, 24 - raw_offset)
            scale_ratio = float(np.mean(pred_profile) / np.mean(obs_profile)) if np.mean(obs_profile) != 0 else float("nan")

            if np.isnan(corr):
                mode = "flat profile, cannot classify"
            elif corr >= 0.5:
                mode = "shape/timing OK -> magnitude/bias-only (calibration would help)"
            elif corr <= 0.0:
                mode = "shape/timing WRONG -> calibration would NOT fix, could mask"
            else:
                mode = "weak/mixed shape match"
            verdicts[sp].append(mode.split(" -> ")[0].split(",")[0])

            print(
                f"  {sp}: shape_corr={corr:+.3f}  pred_peak_hour={pred_peak_hour:02d}  "
                f"obs_peak_hour={obs_peak_hour:02d}  peak_offset={peak_offset}h  "
                f"mean_pred/mean_obs={scale_ratio:.2f}x  -> {mode}"
            )

    print("\n" + "=" * 90)
    print("PER-SPECIES SUMMARY ACROSS ALL 5 STATIONS")
    print("=" * 90)
    for sp in SPECIES:
        modes = verdicts.get(sp, [])
        print(f"  {sp}: {modes}")


if __name__ == "__main__":
    main()
