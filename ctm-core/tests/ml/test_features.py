"""Tests for ml/features.py, per PROMPT_FLOW.md's Phase 9 acceptance
criteria: NaN in the grid is sanitized in the output tensor (a poisoned
field, not just a smoke test), channel count matches the config-driven
expectation, SequenceRecorder raises cleanly on insufficient history, and
cell_features() is provably the same code path as feature_tensor() (built
by literally indexing the same tensor, not a separate implementation)."""
import numpy as np
import pytest

from cities.loader import CityConfig, Domain, EmissionSource, SpeciesConfig
from ctm.simulator import Simulator
from met.weather_station import StationObservation
from ml.features import MLFeatureExtractor, SequenceRecorder

PM25, CO = "pm25", "co"


def _make_city(nx=20, ny=15, dx=500.0, dy=500.0, with_sources=True):
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=nx, ny=ny, dx=dx, dy=dy)
    species = {
        PM25: SpeciesConfig(name=PM25, unit="ug_m3", v_dep_m_s=0.0002, background_conc=10.0, clim_max=500.0),
        CO: SpeciesConfig(name=CO, unit="mg_m3", v_dep_m_s=0.0001, background_conc=0.5, clim_max=None),
    }
    sources = []
    if with_sources:
        sources = [
            EmissionSource(name="traffic1", kind="point", profile="rush", rates={PM25: 2.0, CO: 0.1}, lat=12.03, lon=77.03),
            EmissionSource(name="industry1", kind="point", profile="daytime", rates={PM25: 1.0, CO: 0.05}, lat=12.05, lon=77.05),
        ]
    return CityConfig(
        city_name="MLTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"rush": [1.0] * 24, "daytime": [1.0] * 24},
        emission_sources=sources, sensors=[], dt_seconds=60.0,
    )


def _run_one_step(sim: Simulator):
    stations = [StationObservation("M1", lat=12.02, lon=77.02, wind_speed_m_s=2.0, wind_dir_deg=270.0, temp_c=27.0, rh_pct=50.0)]
    sim.step(stations)


def test_channel_count_matches_expectation_with_and_without_tagged_tracers():
    city = _make_city()

    sim_plain = Simulator(city)
    _run_one_step(sim_plain)
    extractor_plain = MLFeatureExtractor(sim_plain, include_met=True)
    n_species = len(city.species)
    expected_plain = n_species + 3  # + wind_u, wind_v, k_h
    print(f"\n[channel count, no tagged tracers] channels={extractor_plain.channel_names}")
    assert extractor_plain.n_channels == expected_plain
    assert extractor_plain.feature_tensor().shape == (expected_plain, sim_plain.grid.nx, sim_plain.grid.ny)

    sim_tagged = Simulator(city, enable_tagged_tracers=True)
    _run_one_step(sim_tagged)
    extractor_tagged = MLFeatureExtractor(sim_tagged, include_met=True)
    n_tags = len(sim_tagged.tagged_tracer_engine.tags)  # "background" + {"rush","daytime"}
    expected_tagged = n_species + 3 + n_tags * n_species
    print(f"[channel count, tagged tracers] n_tags={n_tags}, channels={extractor_tagged.channel_names}")
    assert extractor_tagged.n_channels == expected_tagged
    assert extractor_tagged.feature_tensor().shape == (expected_tagged, sim_tagged.grid.nx, sim_tagged.grid.ny)
    assert n_tags == 3  # background, daytime, rush


def test_nan_in_grid_is_sanitized_in_output_tensor():
    city = _make_city()
    sim = Simulator(city)
    _run_one_step(sim)
    extractor = MLFeatureExtractor(sim)

    # Poison the grid directly -- bypassing CTMGrid.set_field's clip, which
    # does NOT remove NaN (np.clip leaves NaN as NaN). This simulates
    # whatever upstream bug might otherwise leak a NaN into the field.
    sim.grid.fields[PM25][3, 4] = np.nan
    sim.grid.fields[CO][5, 6] = np.inf

    tensor = extractor.feature_tensor()
    all_finite = bool(np.all(np.isfinite(tensor)))
    print(f"\n[NaN sanitization] tensor all finite after poisoning grid: {all_finite}, "
          f"poisoned-cell value (pm25 channel)={tensor[extractor.channel_names.index('conc_' + PM25), 3, 4]}")

    assert all_finite
    assert tensor[extractor.channel_names.index("conc_" + PM25), 3, 4] == 0.0


def test_fixed_reference_scale_uses_clim_max_or_background_fallback():
    city = _make_city()
    sim = Simulator(city)
    _run_one_step(sim)
    extractor = MLFeatureExtractor(sim)

    # pm25 has clim_max=500 declared -- setting the field to exactly that
    # value should normalize to 1.0.
    field = np.full((sim.grid.nx, sim.grid.ny), 500.0, dtype=np.float32)
    sim.grid.set_field(PM25, field)
    # co has NO clim_max -- fallback is 5*background_conc = 5*0.5 = 2.5.
    sim.grid.set_field(CO, np.full((sim.grid.nx, sim.grid.ny), 2.5, dtype=np.float32))

    tensor = extractor.feature_tensor()
    pm25_val = float(tensor[extractor.channel_names.index("conc_" + PM25), 0, 0])
    co_val = float(tensor[extractor.channel_names.index("conc_" + CO), 0, 0])
    print(f"\n[fixed reference scale] normalized pm25 (clim_max=500)={pm25_val}, normalized co (5x background fallback)={co_val}")

    assert pm25_val == pytest.approx(1.0, abs=1e-5)
    assert co_val == pytest.approx(1.0, abs=1e-5)


def test_cell_features_matches_feature_tensor_same_code_path():
    city = _make_city()
    sim = Simulator(city, enable_tagged_tracers=True)
    _run_one_step(sim)
    extractor = MLFeatureExtractor(sim)

    tensor = extractor.feature_tensor()
    for (i, j) in [(0, 0), (5, 7), (sim.grid.nx - 1, sim.grid.ny - 1)]:
        cell_vec = extractor.cell_features(i, j)
        np.testing.assert_array_equal(cell_vec, tensor[:, i, j])

    with pytest.raises(IndexError):
        extractor.cell_features(sim.grid.nx, 0)


def test_sequence_recorder_snapshots_are_independent_not_aliased():
    """Adversarial case: a classic numpy ring-buffer hazard -- if
    feature_tensor() ever returned a VIEW instead of a fresh array,
    mutating the grid after recording would retroactively corrupt already-
    recorded snapshots. Verified NOT to happen: record 3 distinct steps,
    then mutate the grid directly, and confirm the last recorded snapshot
    is unchanged."""
    city = _make_city()
    sim = Simulator(city)
    extractor = MLFeatureExtractor(sim)
    recorder = SequenceRecorder(extractor, seq_len=3)

    for _ in range(3):
        _run_one_step(sim)
        recorder.record()
    seq = recorder.sequence()
    values_before_mutation = seq[:, 0, 0, 0].copy()

    sim.grid.fields[PM25][0, 0] = 99999.0  # direct mutation, bypassing set_field's clamp
    print(f"\n[sequence recorder aliasing] recorded values={values_before_mutation!r}")
    print(f"after direct grid mutation, seq unchanged: {np.array_equal(seq[:, 0, 0, 0], values_before_mutation)}")

    assert len({round(float(v), 6) for v in values_before_mutation}) == 3  # genuinely distinct per step
    np.testing.assert_array_equal(seq[:, 0, 0, 0], values_before_mutation)


def test_sequence_recorder_slides_correctly_past_seq_len():
    """Adversarial case: record() called MORE times than seq_len. Must
    behave as a proper sliding window (deque maxlen), keeping the LAST
    seq_len snapshots, not crash or keep stale/extra entries."""
    city = _make_city()
    sim = Simulator(city)
    extractor = MLFeatureExtractor(sim)
    recorder = SequenceRecorder(extractor, seq_len=3)

    values_at_each_step = []
    for _ in range(6):
        _run_one_step(sim)
        recorder.record()
        values_at_each_step.append(float(extractor.feature_tensor()[0, 0, 0]))

    seq = recorder.sequence()
    print(f"\n[sequence recorder overflow] last 3 expected={values_at_each_step[-3:]}, got={seq[:,0,0,0].tolist()}")
    assert seq.shape == (3, extractor.n_channels, sim.grid.nx, sim.grid.ny)
    np.testing.assert_allclose(seq[:, 0, 0, 0], values_at_each_step[-3:])


def test_negative_cell_index_raises_not_silent_numpy_wraparound():
    """Adversarial case: numpy natively treats a negative index as
    wraparound-from-the-end (arr[-1] == arr[shape-1]), which for
    cell_features() would silently return a DIFFERENT, real cell's
    features instead of erroring on invalid input. Must raise IndexError
    before that wraparound can happen."""
    city = _make_city()
    sim = Simulator(city)
    _run_one_step(sim)
    extractor = MLFeatureExtractor(sim)

    with pytest.raises(IndexError):
        extractor.cell_features(-1, 0)
    with pytest.raises(IndexError):
        extractor.cell_features(0, -1)
    with pytest.raises(IndexError):
        extractor.cell_features(-1, -1)


def test_never_stepped_simulator_gives_zero_met_channels_not_a_crash():
    """Adversarial case: MLFeatureExtractor built from a Simulator that
    has never taken a step (empty wind_history/k_h_history)."""
    city = _make_city()
    sim = Simulator(city)  # zero steps taken
    extractor = MLFeatureExtractor(sim)
    tensor = extractor.feature_tensor()

    print(f"\n[never-stepped simulator] all finite={np.all(np.isfinite(tensor))}")
    assert np.all(np.isfinite(tensor))
    wind_u_idx = extractor.channel_names.index("wind_u")
    k_h_idx = extractor.channel_names.index("k_h")
    assert np.all(tensor[wind_u_idx] == 0.0)
    assert np.all(tensor[k_h_idx] == 0.0)


def test_nan_in_met_history_is_also_sanitized_not_just_concentration():
    """Adversarial case: the original NaN-sanitization test only poisoned
    a concentration field. Poison the recorded wind history directly
    (simulating a met-pipeline bug reaching the stored history) and
    confirm the met channels are sanitized too -- nan_to_num applies to
    the WHOLE stacked tensor, not selectively."""
    city = _make_city()
    sim = Simulator(city)
    _run_one_step(sim)
    extractor = MLFeatureExtractor(sim)

    sim.wind_history[-1]["u"][0, 0] = np.nan
    sim.wind_history[-1]["v"][1, 1] = np.inf
    tensor = extractor.feature_tensor()

    print(f"\n[met NaN sanitization] all finite={np.all(np.isfinite(tensor))}")
    assert np.all(np.isfinite(tensor))
    assert tensor[extractor.channel_names.index("wind_u"), 0, 0] == 0.0


def test_nonpositive_clim_max_rejected_not_silently_wrong():
    """Adversarial case: cities/schema.json places NO constraint on
    clim_max (documented only as a 'gross-outlier QC ceiling'), so a
    config with clim_max<=0 passes validation and would otherwise reach
    feature_tensor() unguarded. A zero scale divides by zero (inf, then
    clamped by nan_to_num to a fixed, meaningless 1e6 in every cell,
    destroying the channel's information content); a NEGATIVE scale
    silently sign-flips the whole channel to a finite-looking but wrong
    value with NO warning at all -- worse than the zero case, since it
    passes any 'is finite' sanity check silently."""
    for bad_clim_max in [0.0, -100.0]:
        city = _make_city()
        object.__setattr__(
            city, "species",
            {**city.species, PM25: SpeciesConfig(name=PM25, unit="ug_m3", v_dep_m_s=0.0002, background_conc=10.0, clim_max=bad_clim_max)},
        )
        sim = Simulator(city)
        _run_one_step(sim)
        with pytest.raises(ValueError):
            MLFeatureExtractor(sim)


def test_zero_channels_raises_clearly_not_a_bare_numpy_stack_error():
    """Adversarial case: a city with no species, include_met=False, and no
    tagged tracers has nothing for feature_tensor() to build. Before this
    check, np.stack([]) would fail with a bare, uninformative
    'need at least one array to stack'."""
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=10, ny=8, dx=500.0, dy=500.0)
    city = CityConfig(city_name="Empty", domain=domain, utc_offset_hours=0.0, species={}, diurnal_profiles={"flat": [1.0] * 24}, dt_seconds=60.0)
    sim = Simulator(city)
    _run_one_step(sim)
    with pytest.raises(ValueError, match="zero channels"):
        MLFeatureExtractor(sim, include_met=False)


def test_sequence_recorder_raises_cleanly_on_insufficient_history():
    city = _make_city()
    sim = Simulator(city)
    _run_one_step(sim)
    extractor = MLFeatureExtractor(sim)
    recorder = SequenceRecorder(extractor, seq_len=5)

    for _ in range(3):
        _run_one_step(sim)
        recorder.record()

    assert not recorder.is_ready()
    with pytest.raises(ValueError):
        recorder.sequence()

    for _ in range(2):
        _run_one_step(sim)
        recorder.record()

    assert recorder.is_ready()
    seq = recorder.sequence()
    print(f"\n[sequence recorder] final sequence shape={seq.shape}")
    assert seq.shape == (5, extractor.n_channels, sim.grid.nx, sim.grid.ny)
    assert seq.dtype == np.float32
