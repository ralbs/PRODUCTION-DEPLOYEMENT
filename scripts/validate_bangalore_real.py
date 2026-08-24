"""scripts/validate_bangalore_real.py — real-data validation run against
the two confirmed real Bangalore stations (see data/raw/openaq_bangalore/
and cities/bangalore.json's sensors).

HONESTY NOTE ON METEOROLOGY: no real historical weather-station data was
obtainable for this window (only real AIR QUALITY observations were
pulled). The Simulator is driven by the project's own climatology
FALLBACK path (met.weather_station's empty-station-list branch) with a
documented, non-real approximation of July southwest-monsoon conditions
in Bangalore (moderate WSW wind, humid) -- NOT real hourly wind for these
exact days. This is a real, load-bearing simplification: CTM transport
skill depends heavily on getting the actual wind right, and this run
does not have that. Treat this as a first honest look at real-data skill
under a plausible-but-not-real meteorology, not a claim of validated
forecast accuracy.

Emission sources are also the pre-existing SCHEMATIC bangalore.json
inventory (never calibrated against real 2019 emissions) -- absolute
concentration levels are not expected to match reality without
assimilation; that's exactly why assimilation and the spatial/temporal
holdouts below are the right experiment design to isolate what the model
CAN do (track real spatiotemporal structure once nudged by real data)
from what it cannot (predict absolute pollution from an invented
inventory).
"""
from __future__ import annotations

import dataclasses
from datetime import timedelta, timezone

from cities.loader import ClimatologyConfig, load_city
from scripts.hindcast_harness import load_observations_csv, run_hindcast, run_hindcast_temporal_holdout

OBS_CSV = "data/processed/bangalore_openaq_20190710_20190716.csv"

# Documented, NOT real: a plausible July (SW monsoon) Bangalore climatology
# fallback, used because no real historical weather-station data for this
# window was available (see module docstring).
_JULY_MONSOON_CLIMATOLOGY = ClimatologyConfig(
    default_wind_speed_m_s=3.0,
    default_wind_dir_deg=240.0,  # WSW, typical SW-monsoon inflow direction
    default_temp_c=23.0,
    default_rh_pct=80.0,
)


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
    city = dataclasses.replace(city, climatology=_JULY_MONSOON_CLIMATOLOGY)

    records = load_observations_csv(OBS_CSV)
    timestamps = sorted(r.timestamp for r in records)
    start_time = timestamps[0]
    span_s = (timestamps[-1] - start_time).total_seconds()
    n_steps = int(span_s // city.dt_seconds) + 1

    print(f"Loaded {len(records)} real observation records.")
    print(f"Date range: {timestamps[0].isoformat()} to {timestamps[-1].isoformat()} (UTC)")
    print(f"Stations: {sorted(set(r.station_id for r in records))}")
    print(f"Species: {sorted(set(r.species for r in records))}")
    print(f"n_steps={n_steps} at dt={city.dt_seconds}s")
    print(
        "\nNOTE: this archive window (2018-08 to 2020-04 for these stations) INCLUDES the "
        "COVID-19 period. The window used here (2019-07-10 to 2019-07-16) is entirely "
        "PRE-COVID (India's first lockdown began 2020-03-24), so this specific run is not "
        "COVID-anomalous -- but the archive as a whole does not extend past April 2020, so "
        "it cannot represent current (2025-2026) traffic/emissions conditions either way."
    )

    hour_utc0 = start_time.hour + start_time.minute / 60.0

    # === Spatial holdout, both directions ===
    print("\n" + "=" * 70)
    print("SPATIAL HOLDOUT")
    print("=" * 70)
    metrics_assim_6983 = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids={"6983"}, held_out_station_ids={"6984"},
        met_stations=[], hour_utc0=hour_utc0,
    )
    _print_metrics("assimilate 6983 (Hombegowda Nagar) -> validate against held-out 6984 (Hebbal)", metrics_assim_6983)

    metrics_assim_6984 = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids={"6984"}, held_out_station_ids={"6983"},
        met_stations=[], hour_utc0=hour_utc0,
    )
    _print_metrics("assimilate 6984 (Hebbal) -> validate against held-out 6983 (Hombegowda Nagar)", metrics_assim_6984)

    # === Diagnostic control: NO assimilation at all, scored against BOTH ===
    # real stations. The two stations are 10,097 m apart -- just OUTSIDE
    # bangalore.json's localisation_radius_m=10000, so assimilating at one
    # has ZERO direct effect at the other cell (verified: a tagged-tracer
    # decomposition at the held-out station showed the live field was
    # ~100-107% "background" tag, 0% from any real emission-source tag).
    # If this no-assimilation control shows SIMILAR correlation to the
    # "assimilated" runs above, that proves the spatial holdout's apparent
    # skill isn't coming from assimilation/transport at all -- it's the
    # model's diurnal emission-PROFILE SHAPE (schematic, never calibrated
    # to real Bangalore emissions) coincidentally resembling real
    # diurnal pollution cycles. Reported here so that coincidence can't
    # be silently mistaken for genuine assimilation skill.
    print(
        "\n[diagnostic control] station separation is 10,097 m, just past "
        "localisation_radius_m=10000 -- assimilation at one station cannot "
        "directly correct the other. Compare below to the 'assimilated' "
        "results above: if similar, the apparent skill above is diurnal-"
        "shape coincidence, not real transport/assimilation skill."
    )
    metrics_no_assim_control = run_hindcast(
        city, start_time, n_steps, records,
        assimilated_station_ids=set(), held_out_station_ids={"6983", "6984"},
        met_stations=[], hour_utc0=hour_utc0,
    )
    _print_metrics("NO assimilation control (pure background + schematic emissions) -> both real stations", metrics_no_assim_control)

    # === Temporal holdout: first 4 days train, last ~3 days forecast ===
    print("\n" + "=" * 70)
    print("TEMPORAL HOLDOUT")
    print("=" * 70)
    training_days = 4
    training_steps = int(training_days * 86400 / city.dt_seconds)
    training_end = start_time + timedelta(seconds=training_steps * city.dt_seconds)
    print(f"Training window: {start_time.isoformat()} to {training_end.isoformat()} ({training_steps} steps)")
    print(f"Forecast window: {training_end.isoformat()} to {timestamps[-1].isoformat()} ({n_steps - training_steps} steps)")

    metrics_temporal = run_hindcast_temporal_holdout(
        city, start_time, n_steps, records,
        station_ids={"6983", "6984"}, training_steps=training_steps,
        met_stations=[], hour_utc0=hour_utc0,
    )
    _print_metrics("assimilate both stations through training window, forecast freely, validate on forecast window", metrics_temporal)


if __name__ == "__main__":
    main()
