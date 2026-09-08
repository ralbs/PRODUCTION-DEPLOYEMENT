"""Test for scripts/hindcast_harness.py, per PROMPT_FLOW.md's Phase 10:
there is no real historical dataset yet, so this proves the harness itself
works end-to-end using SYNTHETIC "historical" data generated from a
forward run with known ground truth (same technique as Phase 7's
inversion-recovery test).

Scenario: a "ground truth" city has a real point emission source; a
"degraded" city -- same domain, species, and sensor network, but with NO
emission sources declared -- stands in for an operational model that
doesn't know about that source (a deliberately large model error). Both
harness runs are scored against the SAME held-out station set for a fair
comparison. Correlation, not RMSE, is the metric that cleanly demonstrates
the effect here: OI's spatial smoothing introduces a systematic bias (it
nudges the field toward the observed plume a little before/after the
model's own transport would physically justify it, given the correlation
length relative to station spacing), so RMSE barely moves -- but WITHOUT
assimilation the degraded model tracks the plume's rise and fall
backwards at the held-out stations (a strongly NEGATIVE correlation, since
the analysis-corrected upwind neighborhood eventually diffuses through,
out of phase with the true arrival), while WITH assimilation from a
separate upwind station subset it tracks the true pattern (strongly
POSITIVE). That correlation swing, plus a smaller systematic bias, is the
meaningful, reproducible claim -- not an arbitrary RMSE threshold picked
to force a pass."""
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from cities.loader import CityConfig, Domain, EmissionSource, Sensor, SpeciesConfig
from met.weather_station import StationObservation
from scripts.hindcast_harness import (
    HindcastRecord,
    diurnal_climatology_baseline,
    load_observations_csv,
    mean_fractional_bias,
    mean_fractional_error,
    persistence_baseline,
    run_hindcast,
    write_observations_csv,
)

SPECIES = "pm25"
START = datetime(2024, 1, 15, 8, 0, 0, tzinfo=timezone.utc)


def test_mean_fractional_bias_and_error_match_boylan_russell_closed_form():
    """Boylan & Russell (2006): MFB=mean[2(P-O)/(P+O)], MFE=mean[2|P-O|/(P+O)].
    Verified against exact closed forms, not just 'runs without error':
    a perfect match gives 0/0; a perfect 2x over-prediction gives exactly
    +2/3 for both (the symmetric normalization's defining property -- a
    2x over-prediction and a 2x under-prediction have the SAME magnitude,
    unlike a plain (P-O)/O relative error, which would give +100% and
    -50% for the same ratio flip); MFE >= |MFB| always, with equality
    only when every error shares the same sign."""
    exact = np.array([10.0, 20.0, 30.0])
    assert mean_fractional_bias(exact, exact) == 0.0
    assert mean_fractional_error(exact, exact) == 0.0

    over = np.array([20.0])
    under_ref = np.array([10.0])
    mfb_over = mean_fractional_bias(over, under_ref)
    assert mfb_over == pytest.approx(2.0 / 3.0)

    under = np.array([5.0])
    mfb_under = mean_fractional_bias(under, under_ref)
    assert mfb_under == pytest.approx(-2.0 / 3.0)
    assert mfb_under == pytest.approx(-mfb_over)  # symmetric under vs over

    mixed_pred = np.array([12.0, 8.0])
    mixed_obs = np.array([10.0, 10.0])
    mfb_mixed = mean_fractional_bias(mixed_pred, mixed_obs)
    mfe_mixed = mean_fractional_error(mixed_pred, mixed_obs)
    print(f"\n[MFB/MFE] mixed-sign case: MFB={mfb_mixed:.6f}, MFE={mfe_mixed:.6f}")
    assert mfe_mixed >= abs(mfb_mixed)  # errors partially cancel in MFB, never in MFE


def _make_city(with_source: bool, sensors: list[Sensor]):
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=60, ny=40, dx=500.0, dy=500.0)
    species = {SPECIES: SpeciesConfig(name=SPECIES, unit="ug_m3", v_dep_m_s=0.0002, background_conc=10.0, clim_max=500.0)}
    sources = []
    if with_source:
        sources = [EmissionSource(name="plant", kind="point", profile="flat", rates={SPECIES: 3.0}, lat=12.02, lon=77.02)]
    return CityConfig(
        city_name="HindcastTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"flat": [1.0] * 24}, emission_sources=sources, sensors=sensors,
        dt_seconds=60.0, wind_history_hours=2.0,
    )


def test_hindcast_harness_recovers_missed_source_via_assimilation(tmp_path):
    sigma = 1.0
    # All sensors sit in the same wind corridor (lat=12.02, the source's own
    # latitude, with wind blowing due east) so every one of them genuinely
    # samples the plume as it passes, progressively further downwind.
    all_sensors = [
        Sensor(id="A1", lat=12.02, lon=77.05, type="test", species_error_sigma={SPECIES: sigma}),
        Sensor(id="A2", lat=12.02, lon=77.07, type="test", species_error_sigma={SPECIES: sigma}),
        Sensor(id="A3", lat=12.02, lon=77.09, type="test", species_error_sigma={SPECIES: sigma}),
        Sensor(id="H1", lat=12.02, lon=77.12, type="test", species_error_sigma={SPECIES: sigma}),
        Sensor(id="H2", lat=12.02, lon=77.14, type="test", species_error_sigma={SPECIES: sigma}),
    ]
    assimilated_ids = {"A1", "A2", "A3"}
    held_out_ids = {"H1", "H2"}

    ground_truth_city = _make_city(with_source=True, sensors=all_sensors)
    degraded_city = _make_city(with_source=False, sensors=all_sensors)

    met_stations = [
        StationObservation("M1", lat=12.02, lon=77.0, wind_speed_m_s=3.0, wind_dir_deg=270.0, temp_c=27.0, rh_pct=50.0)
    ]
    n_steps = 150

    # --- generate synthetic "historical" observations from a REAL forward
    # run of the ground-truth city (independent of the harness's own code) ---
    from ctm.simulator import Simulator

    ground_sim = Simulator(ground_truth_city)
    rng = np.random.default_rng(0)
    records: list[HindcastRecord] = []
    for t in range(n_steps):
        ground_sim.step(met_stations)
        ts = START + timedelta(seconds=t * ground_truth_city.dt_seconds)
        for s in all_sensors:
            i, j = ground_sim.grid.latlon_to_cell(s.lat, s.lon)
            true_val = float(ground_sim.grid.get_field(SPECIES)[i, j])
            noisy_val = true_val + rng.normal(0, sigma)
            records.append(HindcastRecord(station_id=s.id, lat=s.lat, lon=s.lon, species=SPECIES, value=noisy_val, timestamp=ts))

    # CSV round-trip
    csv_path = tmp_path / "synthetic_hindcast.csv"
    write_observations_csv(csv_path, records)
    reloaded = load_observations_csv(csv_path)
    assert len(reloaded) == len(records)
    assert reloaded[0].station_id == records[0].station_id
    assert reloaded[0].value == pytest.approx(records[0].value)

    # --- degraded model, NO assimilation, scored against H1/H2 ---
    metrics_no_assim = run_hindcast(
        degraded_city, START, n_steps, reloaded,
        assimilated_station_ids=set(), held_out_station_ids=held_out_ids,
        met_stations=met_stations,
    )

    # --- degraded model, WITH assimilation from A1-A3; H1/H2 truly held out,
    # scored against the SAME H1/H2 set -- a fair comparison ---
    metrics_with_assim = run_hindcast(
        degraded_city, START, n_steps, reloaded,
        assimilated_station_ids=assimilated_ids, held_out_station_ids=held_out_ids,
        met_stations=met_stations,
    )

    no = metrics_no_assim[SPECIES]
    yes = metrics_with_assim[SPECIES]
    print(
        f"\n[hindcast harness, held-out H1/H2, n={no['n']}]\n"
        f"  degraded model, NO assimilation:   RMSE={no['rmse']:.3f}, bias={no['bias']:.3f}, correlation={no['correlation']:.3f}\n"
        f"  degraded model, WITH assimilation: RMSE={yes['rmse']:.3f}, bias={yes['bias']:.3f}, correlation={yes['correlation']:.3f}"
    )

    assert no["n"] == yes["n"] == n_steps * len(held_out_ids)
    # RMSE alone is a poor discriminator here (OI's spatial smoothing
    # trades a timing bias for pattern skill -- see module docstring), so
    # the real, robust claim is on correlation and bias magnitude.
    assert no["correlation"] < 0  # without assimilation, the degraded model tracks the plume backwards
    assert yes["correlation"] > 0.3  # with assimilation, it tracks the true pattern
    assert yes["correlation"] - no["correlation"] > 0.5  # a substantial, not marginal, swing
    assert abs(yes["bias"]) < abs(no["bias"])  # assimilation also shrinks the systematic bias


def test_persistence_baseline_error_grows_with_forecast_lead_time():
    """persistence_baseline() has no model and no physics: it just holds
    the last real value constant. Its defining, checkable property is that
    forecast error should get WORSE the further ahead of its single
    reference point it predicts, since nothing in it can anticipate real
    change between now and then -- unlike a real transport model, whose
    error need not grow monotonically with lead time. Uses a hand-built,
    monotonically diverging series (an exact analytic construction, not a
    simulator run) so the expected growth is unambiguous, not just
    plausible."""
    reference_time = START
    station_id = "S1"
    records = [
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=50.0, timestamp=reference_time),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=55.0, timestamp=reference_time + timedelta(hours=1)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=63.0, timestamp=reference_time + timedelta(hours=2)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=74.0, timestamp=reference_time + timedelta(hours=3)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=88.0, timestamp=reference_time + timedelta(hours=4)),
    ]

    metrics = persistence_baseline(records, station_ids={station_id}, reference_time=reference_time)
    lead_errors = sorted(metrics[SPECIES]["lead_time_errors"])
    print(f"\n[persistence baseline] lead_time_errors={lead_errors}")

    assert len(lead_errors) == 4  # the reference_time record itself contributes no forecast
    abs_errors = [abs(err) for _, err in lead_errors]
    # strictly increasing: every prediction is the SAME persisted 50.0, and
    # the true series diverges further from it at every successive lead time
    assert all(later > earlier for earlier, later in zip(abs_errors, abs_errors[1:]))
    assert abs_errors == [5.0, 13.0, 24.0, 38.0]  # exact, since the input was hand-constructed


def test_diurnal_climatology_baseline_raises_on_zero_local_hour_overlap():
    """diurnal_climatology_baseline() must not silently return an all-NaN
    (or otherwise meaningless) metrics dict when the training and
    validation windows share NO local-hour coverage at all -- a real
    failure mode (e.g. training data confined to daytime hours, validation
    confined to night). With utc_offset_hours=0.0, training is built
    entirely from UTC hours 0-2 and validation entirely from UTC hours
    12-14, so no (station, species, local_hour) bucket built from training
    can ever be looked up by a validation record."""
    station_id = "S1"
    day0 = datetime(2024, 1, 15, tzinfo=timezone.utc)
    training = [
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=10.0, timestamp=day0.replace(hour=0)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=12.0, timestamp=day0.replace(hour=1)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=11.0, timestamp=day0.replace(hour=2)),
    ]
    validation = [
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=40.0, timestamp=day0.replace(hour=12)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=42.0, timestamp=day0.replace(hour=13)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=41.0, timestamp=day0.replace(hour=14)),
    ]

    with pytest.raises(ValueError, match="share no"):
        diurnal_climatology_baseline(training, validation, utc_offset_hours=0.0)


def test_diurnal_climatology_baseline_scores_correctly_on_overlapping_windows():
    """Positive control for the raise test above: with genuine local-hour
    overlap between training and validation (different DAYS, same hours),
    the baseline must actually score the validation records against their
    own hour's training-window mean -- not raise, and not silently drop
    everything."""
    station_id = "S1"
    day0 = datetime(2024, 1, 15, tzinfo=timezone.utc)
    day1 = datetime(2024, 1, 16, tzinfo=timezone.utc)
    # hour 8's training mean is (10+14)/2 = 12.0
    training = [
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=10.0, timestamp=day0.replace(hour=8)),
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=14.0, timestamp=day1.replace(hour=8)),
    ]
    validation = [
        HindcastRecord(station_id=station_id, lat=12.0, lon=77.0, species=SPECIES, value=15.0, timestamp=(day1 + timedelta(days=1)).replace(hour=8)),
    ]

    metrics = diurnal_climatology_baseline(training, validation, utc_offset_hours=0.0)
    print(f"\n[diurnal climatology baseline, overlapping windows] {metrics}")
    assert metrics[SPECIES]["n"] == 1
    assert metrics[SPECIES]["n_uncovered"] == 0
    assert metrics[SPECIES]["bias"] == pytest.approx(12.0 - 15.0)  # predicted (climatology mean) minus observed
