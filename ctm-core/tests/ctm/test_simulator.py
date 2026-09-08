"""Tests for ctm/simulator.py, per CLAUDE.md's "Simulator orchestration"
and checkpoint-identity acceptance criteria."""
import pickle

import numpy as np
import pytest

from cities.loader import CityConfig, Domain, EmissionSource, SpeciesConfig
from ctm.diffusion import DiffusionStabilityError
from ctm.simulator import Simulator
from met.weather_station import StationObservation


def _make_city(dt_seconds=60.0, wind_history_hours=10 / 60, nx=10, ny=10, dx=500.0, dy=500.0):
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=nx, ny=ny, dx=dx, dy=dy)
    species = {"pm25": SpeciesConfig(name="pm25", unit="ug_m3", v_dep_m_s=0.001, background_conc=10.0)}
    source = EmissionSource(name="pt", kind="point", profile="flat", rates={"pm25": 0.02}, lat=12.02, lon=77.02)
    return CityConfig(
        city_name="SimTest",
        domain=domain,
        utc_offset_hours=5.5,
        species=species,
        diurnal_profiles={"flat": [1.0] * 24},
        emission_sources=[source],
        dt_seconds=dt_seconds,
        wind_history_hours=wind_history_hours,
    )


def _make_stations():
    return [
        StationObservation("S1", lat=12.01, lon=77.01, wind_speed_m_s=2.5, wind_dir_deg=250.0, temp_c=27.0, rh_pct=55.0),
        StationObservation("S2", lat=12.03, lon=77.03, wind_speed_m_s=2.7, wind_dir_deg=240.0, temp_c=28.0, rh_pct=52.0),
    ]


def _stub_downstream_metric(wind_history):
    """Deterministic stand-in for a real adjoint computation over wind
    history (full adjoint verification is Phase 6). Any function that
    actually reads every entry proves history survives a round-trip
    intact -- that's all this needs to demonstrate here."""
    total = 0.0
    for entry in wind_history:
        total += float(np.mean(entry["u"])) - float(np.mean(entry["v"])) + entry["hour_local"]
    return total


def test_step_order_runs_without_error_and_advances_counters():
    city = _make_city()
    sim = Simulator(city)
    result = sim.step(_make_stations())

    assert sim.step_count == 1
    assert sim.elapsed_seconds == city.dt_seconds
    assert "K_h" in result["met"]
    assert len(sim.wind_history) == 1
    assert len(sim.k_h_history) == 1


def test_wind_history_maxlen_derived_from_city_config_and_truncates():
    city = _make_city(dt_seconds=60.0, wind_history_hours=10 / 60)  # 10 steps of 60s
    sim = Simulator(city)
    assert sim.wind_history_maxlen == 10

    stations = _make_stations()
    for _ in range(15):
        sim.step(stations)

    assert len(sim.wind_history) == 10  # truncated to maxlen, not 15
    assert len(sim.k_h_history) == 10


def test_checkpoint_roundtrip_identity(tmp_path):
    city = _make_city()
    sim = Simulator(city, enable_tagged_tracers=True)
    stations = _make_stations()

    n_steps = 15
    for _ in range(n_steps):
        sim.step(stations)

    checkpoint_path = tmp_path / "checkpoint.pkl"
    sim.save_state(checkpoint_path)

    restored = Simulator(city, enable_tagged_tracers=True)  # fresh simulator instance
    restored.load_state(checkpoint_path)

    # (a) every concentration field byte-identical
    for species in city.species:
        np.testing.assert_array_equal(sim.grid.get_field(species), restored.grid.get_field(species))
    for tag, species_fields in sim.tagged_tracer_fields.items():
        for species, field in species_fields.items():
            np.testing.assert_array_equal(field, restored.tagged_tracer_fields[tag][species])

    # (b) history buffer LENGTHS match
    assert len(sim.wind_history) == len(restored.wind_history) == sim.wind_history_maxlen
    assert len(sim.k_h_history) == len(restored.k_h_history) == sim.wind_history_maxlen

    # (c) downstream computation over wind history identical pre/post
    metric_before = _stub_downstream_metric(sim.wind_history)
    metric_after = _stub_downstream_metric(restored.wind_history)
    print(f"\n[simulator checkpoint] stub downstream metric: before={metric_before!r}, after={metric_after!r}")
    assert metric_before == metric_after
    assert list(sim.k_h_history) == list(restored.k_h_history)
    assert sim.step_count == restored.step_count == n_steps
    assert sim.hour_utc == restored.hour_utc


def test_step_rolls_back_atomically_on_mid_step_exception():
    """Adversarial case: a REAL exception raised partway through step()'s
    per-species transport loop (a DiffusionStabilityError from an unstable
    K_h/dt combination -- K_h is applied uniformly to every species at the
    SAME loop position each step). Before the fix, wind_history/k_h_history
    were already appended (pipeline stage 2, before the loop that can
    fail) while step_count/elapsed_seconds/hour_utc were not incremented --
    a real, reproducible inconsistency: len(wind_history) == step_count + 1.
    A caller that catches the exception and calls save_state() to
    'preserve progress' would get an internally inconsistent checkpoint.
    step() must instead roll back to EXACTLY its pre-step state."""
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=10, ny=10, dx=500.0, dy=500.0)
    species = {
        "a": SpeciesConfig(name="a", unit="ug_m3", v_dep_m_s=0.001, background_conc=10.0),
        "b": SpeciesConfig(name="b", unit="ug_m3", v_dep_m_s=0.001, background_conc=10.0),
    }
    # dt=1200s with the daytime-climatology K_h (150 m^2/s, class A) gives
    # r_x+r_y = 1.44 > 0.5 -- a real DiffusionStabilityError, not a stub.
    city = CityConfig(
        city_name="CrashTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"flat": [1.0] * 24}, dt_seconds=1200.0, wind_history_hours=10 / 60,
    )
    sim = Simulator(city, hour_utc0=12.0, enable_tagged_tracers=True)  # noon local -> daytime climatology

    pre_fields = {sp: sim.grid.get_field(sp).copy() for sp in sim.grid.species}
    pre_step_count = sim.step_count
    pre_wind_len = len(sim.wind_history)

    with pytest.raises(DiffusionStabilityError):
        sim.step([])  # empty stations -> climatology fallback -> the unstable K_h above

    print(
        f"\n[simulator atomic step] after caught exception: step_count={sim.step_count} "
        f"(pre={pre_step_count}), wind_history len={len(sim.wind_history)} (pre={pre_wind_len})"
    )
    assert sim.step_count == pre_step_count
    assert len(sim.wind_history) == pre_wind_len
    assert len(sim.k_h_history) == pre_wind_len
    for sp in sim.grid.species:
        np.testing.assert_array_equal(sim.grid.get_field(sp), pre_fields[sp])

    # the rolled-back state must checkpoint consistently
    checkpoint_path = "rollback_test_checkpoint.pkl"
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        path = f"{d}/{checkpoint_path}"
        sim.save_state(path)
        restored = Simulator(city, enable_tagged_tracers=True)
        restored.load_state(path)
        assert restored.step_count == len(restored.wind_history) or len(restored.wind_history) == 0
        assert len(restored.wind_history) == pre_wind_len


def test_old_format_checkpoint_loads_cleanly_with_empty_history(tmp_path):
    """Simulates a checkpoint written before the history-buffer feature
    existed: no wind_history/k_h_history/tagged_tracer_fields keys at all.
    Must load without raising, with empty (not missing/crashing) buffers."""
    city = _make_city()
    sim = Simulator(city)
    sim.step(_make_stations())  # give it a non-trivial field to restore

    old_format_state = {
        "step_count": sim.step_count,
        "elapsed_seconds": sim.elapsed_seconds,
        "hour_utc": sim.hour_utc,
        "fields": {sp: sim.grid.get_field(sp).copy() for sp in city.species},
        # deliberately NO wind_history / k_h_history / tagged_tracer_fields keys
    }
    old_path = tmp_path / "old_checkpoint.pkl"
    with open(old_path, "wb") as f:
        pickle.dump(old_format_state, f)

    fresh = Simulator(city)
    fresh.load_state(old_path)  # must not raise

    print(
        f"\n[simulator old-format checkpoint] loaded OK; "
        f"wind_history len={len(fresh.wind_history)}, k_h_history len={len(fresh.k_h_history)}"
    )

    assert len(fresh.wind_history) == 0
    assert len(fresh.k_h_history) == 0
    assert fresh.tagged_tracer_fields == {}
    assert fresh.enable_tagged_tracers is False
    for species in city.species:
        np.testing.assert_array_equal(fresh.grid.get_field(species), sim.grid.get_field(species))
