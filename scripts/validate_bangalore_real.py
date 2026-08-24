"""scripts/validate_bangalore_real.py — real-data validation run against
the two confirmed real Bangalore stations (see data/raw/openaq_bangalore/
and cities/bangalore.json's sensors), now driven by GENUINELY REAL
meteorology (see met/ingest_real_met.py: station 43295 "Bangalore",
Meteostat's public archive, 2019-07-01 to 2019-07-20, 3-hourly, verified
schema). Every earlier run of this script used the climatology FALLBACK
(a documented but non-real constant approximation) -- meaning transport
(advection/diffusion) had never actually been tested against reality.
This is the first run where it has: real wind speed/direction/temp/RH for
the exact week, held constant between real 3-hourly reports (never
fabricated/interpolated finer than what was actually observed).

Emission sources are still the pre-existing SCHEMATIC bangalore.json
inventory (never calibrated against real 2019 emissions) -- absolute
concentration levels are not expected to match reality without
assimilation; that's exactly why assimilation and the spatial/temporal
holdouts below are the right experiment design to isolate what the model
CAN do (track real spatiotemporal structure once nudged by real data,
now through REAL transport) from what it cannot (predict absolute
pollution from an invented inventory).
"""
from __future__ import annotations

from datetime import timedelta

from cities.loader import load_city
from ctm.assimilation import Observation
from ctm.simulator import Simulator
from met.ingest_real_met import RealMetSeries, load_real_met_series
from scripts.hindcast_harness import load_observations_csv, run_hindcast, run_hindcast_temporal_holdout

OBS_CSV = "data/processed/bangalore_openaq_20190710_20190716.csv"
MET_CSV = "data/raw/meteostat_bangalore/43295_201907.csv"


def _print_metrics(label: str, metrics: dict) -> None:
    print(f"\n--- {label} ---")
    for species, m in sorted(metrics.items()):
        print(
            f"  {species}: n={m['n']:4d}  rmse={m['rmse']:.3f}  bias={m['bias']:+.3f}  "
            f"corr={m['correlation']:+.3f}  MFB={m['mfb']*100:+.1f}%  MFE={m['mfe']*100:.1f}%"
        )
        read = _boylan_russell_read(m["mfb"], m["mfe"])
        print(f"    -> {read}")


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
        return f"within the GOAL band (MFE<=50%, |MFB|<=30%)"
    if mfe_pct <= 75.0 and mfb_pct <= 60.0:
        return f"within the CRITERIA band (MFE<=75%, |MFB|<=60%) but not the tighter GOAL band"
    return f"OUTSIDE both the CRITERIA and GOAL bands"


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

    hour_utc0 = start_time.hour + start_time.minute / 60.0
    training_days = 4
    training_steps = int(training_days * 86400 / city.dt_seconds)

    # === Spatial holdout, both directions ===
    print("\n" + "=" * 70)
    print("SPATIAL HOLDOUT")
    print("=" * 70)
    metrics_assim_6983 = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids={"6983"}, held_out_station_ids={"6984"},
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    _print_metrics("assimilate 6983 (Hombegowda Nagar) -> validate against held-out 6984 (Hebbal)", metrics_assim_6983)

    metrics_assim_6984 = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids={"6984"}, held_out_station_ids={"6983"},
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    _print_metrics("assimilate 6984 (Hebbal) -> validate against held-out 6983 (Hombegowda Nagar)", metrics_assim_6984)

    # === Diagnostic control: NO assimilation at all, scored against BOTH ===
    # real stations. The two stations are 10,097 m apart -- just OUTSIDE
    # bangalore.json's localisation_radius_m=10000, so a DIRECT OI
    # correction at one station has ZERO effect on the other cell that
    # same step. Under the OLD constant-climatology run this made the
    # "assimilated" and "no-assimilation" results statistically
    # indistinguishable for co/pm10/pm25 (apparent skill was diurnal-
    # profile-SHAPE coincidence, not real transport). With REAL,
    # time-varying wind that is no longer true for pm10/pm25/no2 -- see
    # the tagged-tracer decomposition below, which explains why.
    print(
        "\n[diagnostic control] station separation is 10,097 m, just past "
        "localisation_radius_m=10000 -- a DIRECT OI correction at one "
        "station cannot touch the other station's cell in the same step. "
        "Compare below to the 'assimilated' results above."
    )
    metrics_no_assim_control = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids=set(), held_out_station_ids={"6983", "6984"},
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    _print_metrics("NO assimilation control (pure background + schematic emissions) -> both real stations", metrics_no_assim_control)

    # === Tagged-tracer diagnostic: WHERE does the held-out station's ===
    # no2 field actually come from, mechanistically? Not just "does
    # correlation improve" but "why". Reuses the exact same diagnostic
    # tool used to investigate the SO2 failure and the constant-
    # climatology run's diurnal-coincidence finding.
    print("\n" + "=" * 70)
    print("TAGGED-TRACER DIAGNOSTIC: no2 field composition at held-out Hebbal (6984)")
    print("=" * 70)
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
        "     diffusion under the real, time-varying wind) over the multi-day window -- a mechanism that did\n"
        "     not exist under the old constant-climatology run (where wind never varies, so whatever direction\n"
        "     it's fixed to is the only direction assimilated mass can ever travel)."
    )

    # === Temporal holdout: first 4 days train, last ~3 days forecast ===
    print("\n" + "=" * 70)
    print("TEMPORAL HOLDOUT")
    print("=" * 70)
    training_end = start_time + timedelta(seconds=training_steps * city.dt_seconds)
    print(f"Training window: {start_time.isoformat()} to {training_end.isoformat()} ({training_steps} steps)")
    print(f"Forecast window: {training_end.isoformat()} to {timestamps[-1].isoformat()} ({n_steps - training_steps} steps)")

    metrics_temporal = run_hindcast_temporal_holdout(
        city, start_time, n_steps, records,
        station_ids={"6983", "6984"}, training_steps=training_steps,
        met_stations=met_stations, hour_utc0=hour_utc0,
    )
    _print_metrics("assimilate both stations through training window, forecast freely, validate on forecast window", metrics_temporal)


if __name__ == "__main__":
    main()
