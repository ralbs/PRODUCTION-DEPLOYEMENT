"""Tests for attribution/tagged_tracers.py, per CLAUDE.md's "Adjoint
inverse layer" item 2 acceptance criteria: exact solver reuse, tag-sum
equals the live field to ~1e-6 relative error, and an integration check
that a synthetic assimilation increment lands in 'unexplained', not
smeared across categories -- which only holds if tagged tracers run
BEFORE assimilation in the simulator's step order."""
import numpy as np

import attribution.tagged_tracers as tagged_tracers_module
import ctm.advection as advection_module
import ctm.deposition as deposition_module
import ctm.diffusion as diffusion_module
from cities.loader import AssimilationConfig, CityConfig, Domain, EmissionSource, Sensor, SpeciesConfig
from ctm.assimilation import Observation
from ctm.simulator import Simulator
from met.weather_station import StationObservation

SPECIES = "pm25"

_MORNING_EVENING_PROFILE = [
    0.2, 0.15, 0.10, 0.10, 0.15, 0.30, 0.70, 1.20, 1.50, 1.30, 1.00, 0.90,
    0.85, 0.80, 0.80, 0.85, 1.10, 1.40, 1.50, 1.30, 1.00, 0.70, 0.50, 0.30,
]
_DAYTIME_PROFILE = [0, 0, 0, 0, 0, 0.1, 0.5, 1.0, 1.2, 1.2, 1.2, 1.1, 1.1, 1.1, 1.2, 1.2, 1.0, 0.8, 0.4, 0.1, 0, 0, 0, 0]


def _make_city():
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=30, ny=30, dx=500.0, dy=500.0)
    species = {SPECIES: SpeciesConfig(name=SPECIES, unit="ug_m3", v_dep_m_s=0.001, background_conc=10.0)}
    sources = [
        EmissionSource(name="traffic1", kind="point", profile="morning_evening", rates={SPECIES: 0.03}, lat=12.02, lon=77.02),
        EmissionSource(name="industry1", kind="point", profile="daytime", rates={SPECIES: 0.05}, lat=12.03, lon=77.03),
    ]
    diurnal_profiles = {"morning_evening": _MORNING_EVENING_PROFILE, "daytime": _DAYTIME_PROFILE}
    sensors = [Sensor(id="S1", lat=12.025, lon=77.025, type="test", species_error_sigma={SPECIES: 2.0})]
    assimilation = AssimilationConfig(bg_error_fraction=0.3, correlation_length_m=2000.0, localisation_radius_m=6000.0)
    return CityConfig(
        city_name="TagTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles=diurnal_profiles, emission_sources=sources, sensors=sensors,
        assimilation=assimilation, dt_seconds=60.0, wind_history_hours=1.0,
    )


def _make_stations():
    return [
        StationObservation("M1", lat=12.015, lon=77.015, wind_speed_m_s=2.0, wind_dir_deg=250.0, temp_c=27.0, rh_pct=55.0),
        StationObservation("M2", lat=12.035, lon=77.035, wind_speed_m_s=2.2, wind_dir_deg=240.0, temp_c=28.0, rh_pct=50.0),
    ]


def test_tagged_tracers_reuse_exact_solver_functions():
    """Never a reimplementation of the transport math -- the imported
    names in attribution.tagged_tracers must literally BE the same
    function objects ctm.simulator.Simulator uses for the live field."""
    assert tagged_tracers_module.advect is advection_module.advect
    assert tagged_tracers_module.diffuse is diffusion_module.diffuse
    assert tagged_tracers_module.deposit is deposition_module.deposit


def test_tag_sum_equals_live_field_over_several_steps():
    city = _make_city()
    sim = Simulator(city, enable_tagged_tracers=True)
    stations = _make_stations()

    for _ in range(10):
        sim.step(stations)  # no observations -- no assimilation in this phase

    live = sim.grid.get_field(SPECIES).astype(np.float64)
    tag_sum = sim.tagged_tracer_engine.tag_sum(SPECIES)

    denom = np.maximum(np.abs(live), 1e-9)
    rel_err = float(np.max(np.abs(live - tag_sum) / denom))
    print(f"\n[tagged tracers] max relative error live vs sum(tags) over 10 steps: {rel_err:.2e}")
    print(f"[tagged tracers] tags present: {sim.tagged_tracer_engine.tags}")

    assert rel_err < 1e-6
    assert set(sim.tagged_tracer_engine.tags) == {"background", "morning_evening", "daytime"}


def test_assimilation_increment_lands_in_unexplained_not_categories():
    """Integration check: tagged tracers must run BEFORE assimilation in
    Simulator's step order (see ctm/simulator.py) -- confirmed here by
    verifying a synthetic assimilation increment appears almost exactly in
    the unexplained residual, meaning it was NOT smeared into any category
    or background tag (which assimilate() never touches)."""
    city = _make_city()
    sim = Simulator(city, enable_tagged_tracers=True)
    stations = _make_stations()

    for _ in range(10):
        sim.step(stations)

    residual_before = sim.tagged_tracer_engine.unexplained_residual(SPECIES)
    max_residual_before = float(np.max(np.abs(residual_before)))
    print(f"\n[tagged tracers] max |unexplained residual| BEFORE assimilation: {max_residual_before:.3e}")
    assert max_residual_before < 1e-3  # near-zero: pure transport+injection kept tags in lockstep with live

    obs_value = 80.0  # well above the live field's current value
    result = sim.step(stations, observations={SPECIES: [Observation(sensor_id="S1", value=obs_value)]})
    diag = result["assimilation"][SPECIES]
    assert diag["analysis_applied"]

    residual_after = sim.tagged_tracer_engine.unexplained_residual(SPECIES)
    max_residual_after = float(np.max(np.abs(residual_after)))

    sensor = city.sensors[0]
    obs_i, obs_j = sim.grid.latlon_to_cell(sensor.lat, sensor.lon)
    expected_increment = diag["increment_at_obs"][0]
    measured_residual_at_obs = float(residual_after[obs_i, obs_j])
    rel_err = abs(measured_residual_at_obs - expected_increment) / abs(expected_increment)

    print(
        f"[tagged tracers] max |unexplained residual| AFTER assimilation: {max_residual_after:.3e}\n"
        f"[tagged tracers] assimilate()'s own increment_at_obs = {expected_increment:.6f}; "
        f"unexplained residual at that cell = {measured_residual_at_obs:.6f}; relative error = {rel_err:.2e}"
    )

    assert max_residual_after > 100 * max_residual_before  # a real, visible jump
    assert rel_err < 1e-3  # the ENTIRE increment landed in "unexplained", not partially
