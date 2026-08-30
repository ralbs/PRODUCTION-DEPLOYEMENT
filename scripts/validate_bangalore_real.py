"""scripts/validate_bangalore_real.py — real-data validation run against
FIVE confirmed real Bangalore stations (see data/raw/openaq_bangalore/ and
cities/bangalore.json's sensors), driven by GENUINELY REAL meteorology
(see met/ingest_real_met.py: station 43295 "Bangalore", Meteostat's public
archive, 2019-07-01 to 2019-07-20, 3-hourly, verified schema).

Phase 15 of PROMPT_FLOW_VALIDATION.md: re-runs the spatial and temporal
holdouts now that (a) real wind exists (Phase 12) and (b) a tight cluster
of 4 stations well inside localisation_radius_m=10000 exists alongside the
original 6983/6984 pair, which sits just OUTSIDE it (Phase 13) -- so a
spatial holdout can finally test whether OI assimilation has a real direct
effect, not just a diurnal-shape coincidence. Every result below is now
also checked against two TRIVIAL baselines (Phase 14):
persistence_baseline() (repeat the last observed value) and
diurnal_climatology_baseline() (typical value for that station/species/
local-hour, fit on a disjoint training window) -- a CTM number only means
something once it's shown to beat both.

Emission sources are still the pre-existing SCHEMATIC bangalore.json
inventory (never calibrated against real 2019 emissions) -- absolute
concentration levels are not expected to match reality without
assimilation; that's exactly why assimilation and the spatial/temporal
holdouts below are the right experiment design to isolate what the model
CAN do (track real spatiotemporal structure once nudged by real data)
from what it cannot (predict absolute pollution from an invented
inventory).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from cities.loader import load_city
from ctm.assimilation import Observation
from ctm.simulator import Simulator
from met.ingest_real_met import RealMetSeries, load_real_met_series
from scripts.hindcast_harness import (
    HindcastRecord,
    diurnal_climatology_baseline,
    load_observations_csv,
    persistence_baseline,
    run_hindcast,
    run_hindcast_temporal_holdout,
)

OBS_CSV = "data/processed/bangalore_openaq_20190710_20190716.csv"
MET_CSV = "data/raw/meteostat_bangalore/43295_201907.csv"

# Station names, for readable output only (ids are the source of truth).
STATION_NAMES = {
    "6983": "Hombegowda Nagar",
    "6984": "Hebbal",
    "6973": "Jayanagar 5th Block",
    "5548": "BTM Layout",
    "6975": "Silk Board",
}


def _boylan_russell_read(mfb: float, mfe: float) -> str:
    """Boylan & Russell (2006) PM2.5 goal/criteria bands, applied here to
    every species for a consistent read (the bands were derived for PM2.5
    specifically; treat the gas-species reads as an approximate reference
    point, not a literature-validated threshold for those species)."""
    import math

    if math.isnan(mfb) or math.isnan(mfe):
        return "insufficient data to classify"
    mfb_pct, mfe_pct = abs(mfb) * 100, mfe * 100
    if mfe_pct <= 50.0 and mfb_pct <= 30.0:
        return "within the GOAL band (MFE<=50%, |MFB|<=30%)"
    if mfe_pct <= 75.0 and mfb_pct <= 60.0:
        return "within the CRITERIA band (MFE<=75%, |MFB|<=60%) but not the tighter GOAL band"
    return "OUTSIDE both the CRITERIA and GOAL bands"


def _print_metrics(label: str, metrics: dict) -> None:
    print(f"\n--- {label} ---")
    for species, m in sorted(metrics.items()):
        print(
            f"  {species}: n={m['n']:4d}  rmse={m['rmse']:.3f}  bias={m['bias']:+.3f}  "
            f"corr={m['correlation']:+.3f}  MFB={m['mfb']*100:+.1f}%  MFE={m['mfe']*100:.1f}%"
        )
        print(f"    -> {_boylan_russell_read(m['mfb'], m['mfe'])}")


def _fmt(m: dict | None) -> str:
    if not m or m.get("n", 0) == 0:
        return "  (no data)"
    return (
        f"n={m['n']:4d}  rmse={m['rmse']:7.3f}  bias={m['bias']:+7.3f}  "
        f"corr={m['correlation']:+.3f}  MFB={m['mfb']*100:+6.1f}%  MFE={m['mfe']*100:5.1f}%"
    )


def comparison_table(
    label: str,
    city,
    start_time: datetime,
    n_steps: int,
    records: list[HindcastRecord],
    held_out_ids: set[str],
    met_stations,
    hour_utc0: float,
    training_end: datetime,
    assimilated_ids: set[str] | None = None,
    precomputed_assim: dict | None = None,
) -> dict:
    """Runs and prints the Phase 15 four-way comparison for one experiment:
    CTM-assimilated, CTM-no-assimilation-control, persistence-baseline,
    diurnal-climatology-baseline -- all scored on the EXACT SAME held-out
    records (only those AFTER `training_end`, so the climatology baseline's
    own training/validation split is genuinely disjoint, per this
    project's train/validate rule; CTM-assimilated and CTM-control are
    restricted to the same post-training_end records for a fair,
    matched comparison, even though the CTM itself never uses held-out
    station data for assimilation regardless of timestamp).

    Either pass `assimilated_ids` (disjoint from `held_out_ids`) to have
    this function run the CTM-assimilated case itself via `run_hindcast()`
    (the spatial-holdout shape: assimilation runs continuously for the
    whole period), OR pass `precomputed_assim` -- a metrics dict already
    computed by the caller -- when the assimilation schedule isn't
    expressible by continuous run_hindcast() at all (the temporal
    holdout's train-then-stop schedule, via run_hindcast_temporal_holdout(),
    needs its OWN function and cannot reuse assimilated_ids/held_out_ids
    as disjoint sets since it assimilates and later scores the SAME
    stations). Exactly one of the two must be given.

    Returns the four raw metrics dicts, keyed
    "ctm_assim"/"ctm_control"/"persistence"/"climatology", for callers
    that want the numbers beyond the printed table.
    """
    if (assimilated_ids is None) == (precomputed_assim is None):
        raise ValueError("comparison_table(): pass exactly one of assimilated_ids or precomputed_assim")

    print("\n" + "=" * 78)
    print(label)
    print("=" * 78)

    # Held-out records are only scored in the validation window (after
    # training_end); assimilated-station records are left untouched (full
    # period) since spatial-holdout assimilation runs the whole run, not
    # just a training window.
    filtered_for_ctm = [
        r for r in records if not (r.station_id in held_out_ids and r.timestamp <= training_end)
    ]
    training_obs = [r for r in records if r.station_id in held_out_ids and r.timestamp <= training_end]
    validation_obs = [r for r in records if r.station_id in held_out_ids and r.timestamp > training_end]

    if precomputed_assim is not None:
        metrics_assim = precomputed_assim
    else:
        metrics_assim = run_hindcast(
            city, start_time, n_steps, filtered_for_ctm,
            assimilated_station_ids=assimilated_ids, held_out_station_ids=held_out_ids,
            met_stations=met_stations, hour_utc0=hour_utc0,
        )
    metrics_control = run_hindcast(
        city, start_time, n_steps, filtered_for_ctm,
        assimilated_station_ids=set(), held_out_station_ids=held_out_ids,
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    metrics_persist = persistence_baseline(records, held_out_ids, reference_time=training_end)
    try:
        metrics_clim = diurnal_climatology_baseline(training_obs, validation_obs, city.utc_offset_hours)
    except ValueError as exc:
        print(f"  [diurnal_climatology_baseline unavailable: {exc}]")
        metrics_clim = {}

    species_all = sorted(set(metrics_assim) | set(metrics_control) | set(metrics_persist) | set(metrics_clim))
    for species in species_all:
        print(f"\n  {species}:")
        print(f"    CTM-assimilated  : {_fmt(metrics_assim.get(species))}")
        print(f"    CTM-control      : {_fmt(metrics_control.get(species))}")
        print(f"    persistence      : {_fmt(metrics_persist.get(species))}")
        print(f"    climatology      : {_fmt(metrics_clim.get(species))}")

        assim_m = metrics_assim.get(species)
        if assim_m and assim_m.get("n", 0) > 0:
            beats = []
            loses = []
            for name, other in (("persistence", metrics_persist.get(species)), ("climatology", metrics_clim.get(species))):
                if not other or other.get("n", 0) == 0:
                    continue
                (beats if assim_m["rmse"] < other["rmse"] else loses).append(name)
            if beats and not loses:
                verdict = f"beats BOTH baselines (lower RMSE than {', '.join(beats)})"
            elif beats and loses:
                verdict = f"beats {', '.join(beats)} but NOT {', '.join(loses)} (mixed)"
            elif loses:
                verdict = f"beats NEITHER baseline (RMSE >= {', '.join(loses)})"
            else:
                verdict = "no baseline available for comparison"
            print(f"    verdict          : {verdict}")

    return {
        "ctm_assim": metrics_assim,
        "ctm_control": metrics_control,
        "persistence": metrics_persist,
        "climatology": metrics_clim,
    }


def main() -> None:
    city = load_city("bangalore")

    records = load_observations_csv(OBS_CSV)
    timestamps = sorted(r.timestamp for r in records)
    start_time = timestamps[0]
    span_s = (timestamps[-1] - start_time).total_seconds()
    n_steps = int(span_s // city.dt_seconds) + 1

    met_series, met_counts = load_real_met_series([MET_CSV])
    met_stations = RealMetSeries(met_series, start_time, city.dt_seconds)

    print(f"Loaded {len(records)} real observation records.")
    print(f"Date range: {timestamps[0].isoformat()} to {timestamps[-1].isoformat()} (UTC)")
    print(f"Stations: {sorted(set(r.station_id for r in records))}")
    print(f"Species: {sorted(set(r.species for r in records))}")
    print(f"n_steps={n_steps} at dt={city.dt_seconds}s")
    print(
        f"\nReal meteorology: station 43295 'Bangalore' (Meteostat), {met_counts['n_usable']} usable "
        f"3-hourly reports ({met_counts['n_rejected_incomplete_or_nonfinite']} rejected as incomplete/non-finite) "
        f"over the run window, held constant between real reports."
    )
    print(
        "\nNOTE: this archive window (2018-08 to 2020-04 for these AQ stations) INCLUDES the "
        "COVID-19 period. The window used here (2019-07-10 to 2019-07-16) is entirely "
        "PRE-COVID (India's first lockdown began 2020-03-24), so this specific run is not "
        "COVID-anomalous -- but the archive as a whole does not extend past April 2020, so "
        "it cannot represent current (2025-2026) traffic/emissions conditions either way."
    )
    print(
        "\nStation pair separations (see cities/bangalore.json's _sensor_pair_distances_m): "
        "6983<->6984 = 10,097m (just OUTSIDE localisation_radius_m=10000 -- last round's only "
        "real pair). 6973<->5548 = 1,381m (the tightest pair, well INSIDE the radius -- new "
        "this round). Both are used below for a direct inside-vs-outside-radius comparison."
    )

    hour_utc0 = start_time.hour + start_time.minute / 60.0
    training_days = 4
    training_steps = int(training_days * 86400 / city.dt_seconds)
    training_end = start_time + timedelta(seconds=training_steps * city.dt_seconds)
    print(
        f"\nTraining/validation split for all comparison tables below: training window "
        f"{start_time.isoformat()} to {training_end.isoformat()} ({training_steps} steps), "
        f"validation window {training_end.isoformat()} to {timestamps[-1].isoformat()}. "
        f"The diurnal-climatology baseline is fit ONLY on the training window and scored "
        f"ONLY on the validation window; CTM-assimilated and CTM-control are restricted to "
        f"scoring on the same validation-window records for a fair, matched comparison."
    )

    results = {}

    # === Spatial holdout: original pair, just OUTSIDE localisation_radius_m ===
    results["spatial_6983_to_6984"] = comparison_table(
        "SPATIAL HOLDOUT (outside radius, 10,097m): assimilate 6983 (Hombegowda Nagar) "
        "-> validate held-out 6984 (Hebbal)  [before/after ref: last round found no2 "
        "correlation 0.564 assim vs -0.045 control under this same pair with real wind, "
        "no cluster stations]",
        city, start_time, n_steps, records,
        assimilated_ids={"6983"}, held_out_ids={"6984"},
        met_stations=met_stations, hour_utc0=hour_utc0, training_end=training_end,
    )
    results["spatial_6984_to_6983"] = comparison_table(
        "SPATIAL HOLDOUT (outside radius, 10,097m): assimilate 6984 (Hebbal) "
        "-> validate held-out 6983 (Hombegowda Nagar)",
        city, start_time, n_steps, records,
        assimilated_ids={"6984"}, held_out_ids={"6983"},
        met_stations=met_stations, hour_utc0=hour_utc0, training_end=training_end,
    )

    # === Spatial holdout: new close pair, well INSIDE localisation_radius_m ===
    results["spatial_6973_to_5548"] = comparison_table(
        "SPATIAL HOLDOUT (INSIDE radius, 1,381m -- new this round): assimilate 6973 "
        "(Jayanagar 5th Block) -> validate held-out 5548 (BTM Layout)",
        city, start_time, n_steps, records,
        assimilated_ids={"6973"}, held_out_ids={"5548"},
        met_stations=met_stations, hour_utc0=hour_utc0, training_end=training_end,
    )
    results["spatial_5548_to_6973"] = comparison_table(
        "SPATIAL HOLDOUT (INSIDE radius, 1,381m -- new this round): assimilate 5548 "
        "(BTM Layout) -> validate held-out 6973 (Jayanagar 5th Block)",
        city, start_time, n_steps, records,
        assimilated_ids={"5548"}, held_out_ids={"6973"},
        met_stations=met_stations, hour_utc0=hour_utc0, training_end=training_end,
    )

    # === Diagnostic control: NO assimilation at all, both original stations ===
    print(
        "\n[diagnostic control, both original stations at once] station separation is "
        "10,097 m, just past localisation_radius_m=10000 -- a DIRECT OI correction at one "
        "station cannot touch the other station's cell in the same step."
    )
    metrics_no_assim_control = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids=set(), held_out_station_ids={"6983", "6984"},
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    _print_metrics("NO assimilation control (pure background + schematic emissions) -> both original stations", metrics_no_assim_control)

    # === Tagged-tracer diagnostic: WHERE does the held-out station's ===
    # no2 field actually come from, mechanistically?
    print("\n" + "=" * 78)
    print("TAGGED-TRACER DIAGNOSTIC: no2 field composition at held-out Hebbal (6984)")
    print("=" * 78)
    sim_diag = Simulator(city, enable_tagged_tracers=True, hour_utc0=hour_utc0)
    by_step_diag: dict[int, list[Observation]] = {}
    for r in records:
        if r.station_id != "6983" or r.species != "no2":
            continue
        step = round((r.timestamp - start_time).total_seconds() / city.dt_seconds)
        if 0 <= step < training_steps:
            by_step_diag.setdefault(step, []).append(Observation("6983", r.value))
    hebbal_i, hebbal_j = sim_diag.grid.latlon_to_cell(13.029152, 77.585901)
    for t in range(training_steps):
        sim_diag.step(met_stations(t), observations={"no2": by_step_diag[t]} if t in by_step_diag else None)
    live = float(sim_diag.grid.get_field("no2")[hebbal_i, hebbal_j])
    tag_values = {tag: float(sim_diag.tagged_tracer_engine.fields[tag]["no2"][hebbal_i, hebbal_j]) for tag in sim_diag.tagged_tracer_engine.tags}
    unexplained = live - sum(tag_values.values())
    print(f"live no2 at Hebbal after {training_days} days of assimilating ONLY 6983: {live:.4f}")
    for tag, val in tag_values.items():
        print(f"  tag={tag}: {val:.4f} ({100*val/live:.1f}% of live field)")
    print(f"  unexplained (live - sum(tags)): {unexplained:.4f} ({100*unexplained/live:.1f}% of live field)")
    print(
        "  -> every schematic emission-source tag is 0% (those sources never reach Hebbal, real wind or not).\n"
        "  -> assimilation only ever touches the LIVE field, never tag fields, and never touches Hebbal's\n"
        "     cell directly (outside localisation_radius_m). So a NONZERO 'unexplained' fraction here can only\n"
        "     be assimilation-corrected mass that reached Hebbal through REAL PHYSICAL TRANSPORT (advection/\n"
        "     diffusion under the real, time-varying wind) over the multi-day window."
    )

    # === Temporal holdout: first 4 days train, last ~3 days forecast ===
    # run_hindcast_temporal_holdout() assimilates {"6983","6984"} only for
    # t < training_steps, then stops and scores the SAME two stations for
    # t >= training_steps -- a schedule run_hindcast() cannot express (it
    # treats a station as either always-assimilated or never-assimilated
    # for the whole run), so this is computed directly and handed to
    # comparison_table() as precomputed_assim rather than re-derived from
    # disjoint assimilated_ids/held_out_ids sets.
    metrics_temporal = run_hindcast_temporal_holdout(
        city, start_time, n_steps, records,
        station_ids={"6983", "6984"}, training_steps=training_steps,
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    results["temporal"] = comparison_table(
        "TEMPORAL HOLDOUT: assimilate both original stations through the training window, "
        "forecast freely (no further nudging), validate on the forecast window",
        city, start_time, n_steps, records,
        held_out_ids={"6983", "6984"},
        met_stations=met_stations, hour_utc0=hour_utc0, training_end=training_end,
        precomputed_assim=metrics_temporal,
    )

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    print(
        "See per-experiment 'verdict' lines above for whether CTM-assimilated beats both "
        "trivial baselines, one, or neither, per species."
    )


if __name__ == "__main__":
    main()
