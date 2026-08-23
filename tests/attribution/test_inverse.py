"""Tests for attribution/inverse.py, per CLAUDE.md's "Adjoint inverse
layer" item 3 (true inverse source estimation) acceptance criteria:
exact linear unit-response construction, statistically calibrated
recovery, the single-snapshot identifiability trap and its multi-time
fix, species advisory reuse of the forward model's own deposition
numbers, and backward-footprint zone pre-screening."""
import numpy as np
import pytest

from attribution.inverse import InversionObservation, SourceInversion, Zone
from cities.loader import CityConfig, Domain, EmissionSource, Sensor, SpeciesConfig
from ctm.deposition import deposition_rate
from ctm.simulator import Simulator
from met.weather_station import StationObservation

SPECIES = "pm25"


def _make_city(nx=60, ny=30, dx=500.0, dy=500.0, background=10.0, sensors=None, v_dep=0.0002, **kwargs):
    domain = Domain(lat_sw=12.0, lon_sw=77.0, nx=nx, ny=ny, dx=dx, dy=dy)
    species = {SPECIES: SpeciesConfig(name=SPECIES, unit="ug_m3", v_dep_m_s=v_dep, background_conc=background)}
    return CityConfig(
        city_name="InvTest", domain=domain, utc_offset_hours=0.0, species=species,
        diurnal_profiles={"flat": [1.0] * 24}, sensors=sensors or [], dt_seconds=60.0, **kwargs,
    )


def test_unit_response_is_exactly_isolated_from_nonzero_background():
    """'zero ambient background' must hold even when the city's real
    background_conc is large -- otherwise H would be contaminated by a
    constant offset and C = H @ E would not be exact."""
    city = _make_city(background=500.0)  # deliberately huge, unrelated background
    zone = Zone(name="z1", kind="point", lat=12.015, lon=77.03)
    inv = SourceInversion(city, SPECIES, [zone])

    wind_history = [{"u": 2.0, "v": 0.0, "hour_local": 8.0} for _ in range(20)]
    k_h_history = [10.0] * 20
    mixing_height_history = [500.0] * 20

    recorded = inv._run_unit_response(zone, wind_history, k_h_history, mixing_height_history, {19})
    max_val = recorded[19].max()
    print(f"\n[inverse isolation] max concentration in unit-response field (city background=500): {max_val:.6f}")
    assert max_val < 1.0  # nowhere near the 500 background -- confirms isolation


def test_c_equals_h_times_e_exact_linearity():
    """Running two zones TOGETHER at known rates must equal the linear
    combination of their two isolated unit responses -- the whole point of
    the forward-unit-response approach (exact to float32, not
    approximate, and never derived from backward dwell-time weights)."""
    city = _make_city(background=0.0)
    zone_a = Zone(name="A", kind="point", lat=12.015, lon=77.02)
    zone_b = Zone(name="B", kind="point", lat=12.015, lon=77.035)
    inv = SourceInversion(city, SPECIES, [zone_a, zone_b])

    n_steps = 25
    wind_history = [{"u": 2.5, "v": 0.0, "hour_local": 8.0} for _ in range(n_steps)]
    k_h_history = [15.0] * n_steps
    mixing_height_history = [400.0] * n_steps
    rate_a, rate_b = 3.0, 1.7

    response_a = inv._run_unit_response(zone_a, wind_history, k_h_history, mixing_height_history, {n_steps - 1})[n_steps - 1]
    response_b = inv._run_unit_response(zone_b, wind_history, k_h_history, mixing_height_history, {n_steps - 1})[n_steps - 1]
    predicted = rate_a * response_a + rate_b * response_b

    # now run BOTH sources together in one real forward simulation
    from ctm.advection import advect
    from ctm.deposition import deposit
    from ctm.diffusion import diffuse
    from ctm.emissions import EmissionEngine
    from ctm.grid import CTMGrid

    combined_sources = [
        EmissionSource(name="A", kind="point", profile="flat", rates={SPECIES: rate_a}, lat=12.015, lon=77.02),
        EmissionSource(name="B", kind="point", profile="flat", rates={SPECIES: rate_b}, lat=12.015, lon=77.035),
    ]
    grid = CTMGrid(city)
    engine = EmissionEngine(grid, sources=combined_sources)
    for wind, k_h, h_mix in zip(wind_history, k_h_history, mixing_height_history):
        engine.inject(hour_local=8.0, dt=city.dt_seconds, mixing_height_m=h_mix)
        f = grid.get_field(SPECIES)
        f = advect(f, wind["u"], wind["v"], grid.dx, grid.dy, city.dt_seconds, 0.0)
        f = diffuse(f, k_h, grid.dx, grid.dy, city.dt_seconds)
        f = deposit(f, city.species[SPECIES].v_dep_m_s, h_mix, city.dt_seconds)
        grid.set_field(SPECIES, f)
    actual = grid.get_field(SPECIES).astype(np.float64)

    max_abs = float(np.max(np.abs(actual)))
    rel_err = float(np.max(np.abs(actual - predicted))) / max_abs
    print(f"\n[inverse linearity] max|actual - H@rates| relative to max field value: {rel_err:.2e}")
    assert rel_err < 1e-5


def test_solve_recovers_known_rates_with_synthetic_data():
    sensors = [Sensor(id="S1", lat=12.015, lon=77.08, type="test", species_error_sigma={SPECIES: 0.01})]
    city = _make_city(background=0.0, sensors=sensors)
    zone_a = Zone(name="A", kind="point", lat=12.015, lon=77.01)
    zone_b = Zone(name="B", kind="point", lat=12.015, lon=77.06)
    inv = SourceInversion(city, SPECIES, [zone_a, zone_b])

    n_steps = 60
    wind_history = [{"u": 2.0, "v": 0.0, "hour_local": 8.0} for _ in range(n_steps)]
    k_h_history = [10.0] * n_steps
    mixing_height_history = [500.0] * n_steps
    x_true = np.array([2.0, 0.5])

    time_indices = list(range(10, n_steps, 5))
    obs_template = [InversionObservation(sensor_id="S1", time_index=t, enhancement=0.0) for t in time_indices]
    H = inv.assemble_H(wind_history, k_h_history, mixing_height_history, obs_template)

    rng = np.random.default_rng(0)
    y = H @ x_true + rng.normal(0, 0.01, size=H.shape[0])
    observations = [InversionObservation(sensor_id="S1", time_index=t, enhancement=yy) for t, yy in zip(time_indices, y)]

    result = inv.solve(H, observations)
    print(f"\n[inverse solve] x_hat={result.x_hat}, marginal_std={result.marginal_std}, true={x_true}, chi2_per_obs={result.chi2_per_obs:.3f}")

    assert np.all(np.abs(result.x_hat - x_true) <= 3 * result.marginal_std)
    assert 0.1 < result.chi2_per_obs < 5.0  # roughly calibrated, not wildly off


def test_identifiability_trap_single_snapshot_vs_multi_time_stacking():
    """The exact CLAUDE.md regression test: with domain-transit-time
    shorter than the observation window, a single end-of-window snapshot
    (many sensors, one time) makes the zone columns of H nearly collinear
    and can fail to identify sources reliably; stacking observations
    across TIME at even a single sensor decorrelates the columns and
    recovers them. This demonstrates the MECHANISM (correlation/
    conditioning), not just a pass/fail on 3-sigma coverage (which a wide
    enough posterior can trivially satisfy regardless)."""
    sigma_obs = 0.03
    sensor_lats = [12.005, 12.010, 12.015, 12.020, 12.025]
    sensors = [
        Sensor(id=f"S{i}", lat=lat, lon=77.09, type="test", species_error_sigma={SPECIES: sigma_obs})
        for i, lat in enumerate(sensor_lats)
    ]
    city = _make_city(nx=60, ny=30, background=10.0, sensors=sensors, v_dep=0.0002)
    # zone A close to the sensor cluster, zone B far upwind -- their
    # arrival times at the sensors differ enough to be temporally
    # distinguishable, but by the end of a long window both have fully
    # arrived and look nearly proportional across the sensor cluster.
    zone_a = Zone(name="A", kind="point", lat=12.015, lon=77.06)
    zone_b = Zone(name="B", kind="point", lat=12.015, lon=77.01)
    inv = SourceInversion(city, SPECIES, [zone_a, zone_b])

    n_steps = 300
    u_wind = 5.0
    wind_history = [{"u": u_wind, "v": 0.0, "hour_local": 8.0} for _ in range(n_steps)]
    k_h_history = [30.0] * n_steps
    mixing_height_history = [500.0] * n_steps
    domain_transit_s = (city.domain.nx * city.domain.dx) / u_wind
    window_s = n_steps * city.dt_seconds
    assert domain_transit_s < window_s  # the trap's precondition

    x_true = np.array([3.0, 1.0])
    seed = 2

    # --- single end-of-window snapshot, across all 5 sensors ---
    snapshot_template = [InversionObservation(sensor_id=s.id, time_index=n_steps - 1, enhancement=0.0) for s in sensors]
    H_snapshot = inv.assemble_H(wind_history, k_h_history, mixing_height_history, snapshot_template)
    col_corr_snapshot = float(np.corrcoef(H_snapshot[:, 0], H_snapshot[:, 1])[0, 1])
    cond_snapshot = float(np.linalg.cond(H_snapshot.T @ H_snapshot))

    rng = np.random.default_rng(seed)
    y_snapshot = H_snapshot @ x_true + rng.normal(0, sigma_obs, size=H_snapshot.shape[0])
    snapshot_obs = [
        InversionObservation(sensor_id=s.id, time_index=n_steps - 1, enhancement=yy)
        for s, yy in zip(sensors, y_snapshot)
    ]
    result_snapshot = inv.solve(H_snapshot, snapshot_obs)

    # --- multi-time stacking: ONE sensor, times spanning the differential arrival ---
    time_indices = [5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49]
    multi_template = [InversionObservation(sensor_id="S2", time_index=t, enhancement=0.0) for t in time_indices]
    H_multi = inv.assemble_H(wind_history, k_h_history, mixing_height_history, multi_template)
    col_corr_multi = float(np.corrcoef(H_multi[:, 0], H_multi[:, 1])[0, 1])
    cond_multi = float(np.linalg.cond(H_multi.T @ H_multi))

    rng2 = np.random.default_rng(seed)
    y_multi = H_multi @ x_true + rng2.normal(0, sigma_obs, size=H_multi.shape[0])
    multi_obs = [InversionObservation(sensor_id="S2", time_index=t, enhancement=yy) for t, yy in zip(time_indices, y_multi)]
    result_multi = inv.solve(H_multi, multi_obs)

    print(
        f"\n[identifiability trap] domain transit={domain_transit_s:.0f}s < window={window_s:.0f}s\n"
        f"  SINGLE SNAPSHOT (5 sensors, t=final only): column correlation={col_corr_snapshot:.4f}, "
        f"cond(H^T H)={cond_snapshot:.1f}\n"
        f"    x_hat={result_snapshot.x_hat}, std={result_snapshot.marginal_std}, true={x_true}\n"
        f"  MULTI-TIME (1 sensor, {len(time_indices)} times spanning the rise): "
        f"column correlation={col_corr_multi:.4f}, cond(H^T H)={cond_multi:.1f}\n"
        f"    x_hat={result_multi.x_hat}, std={result_multi.marginal_std}, true={x_true}"
    )

    # the trap: single-snapshot H columns are near-collinear and poorly conditioned
    assert col_corr_snapshot > 0.95
    assert cond_snapshot > 50

    # the fix: multi-time stacking meaningfully decorrelates and improves conditioning
    assert col_corr_multi < col_corr_snapshot - 0.3
    assert cond_multi < cond_snapshot / 5

    # the single-snapshot estimate fails to identify zone B's sign/magnitude at this
    # noise level (a real, demonstrated failure -- not just "wide error bars")
    assert np.sign(result_snapshot.x_hat[1]) != np.sign(x_true[1])

    # multi-time stacking recovers both zones within their own posterior uncertainty
    assert np.all(np.abs(result_multi.x_hat - x_true) <= 3 * result_multi.marginal_std)
    # ... and does so with dramatically tighter (more USEFUL) uncertainty
    assert np.all(result_multi.marginal_std < result_snapshot.marginal_std / 3)


def test_species_advisory_reuses_forward_model_deposition_rate():
    city = _make_city(v_dep=0.01, background=0.0)
    zone = Zone(name="z1", kind="point", lat=12.015, lon=77.02)
    inv = SourceInversion(city, SPECIES, [zone])

    mixing_height_m = 500.0
    expected_k = deposition_rate(0.01, mixing_height_m)
    expected_half_life = np.log(2) / expected_k

    short_transit = expected_half_life * 0.01
    long_transit = expected_half_life * 10.0

    advisory_short = inv.species_advisory(transit_time_s=short_transit, mixing_height_m=mixing_height_m)
    advisory_long = inv.species_advisory(transit_time_s=long_transit, mixing_height_m=mixing_height_m)

    print(
        f"\n[species advisory] half_life={advisory_short.half_life_s:.1f}s (expected {expected_half_life:.1f}s)\n"
        f"  short transit ({short_transit:.1f}s): quasi_conservative={advisory_short.quasi_conservative}\n"
        f"  long transit ({long_transit:.1f}s): quasi_conservative={advisory_long.quasi_conservative}"
    )

    assert advisory_short.half_life_s == pytest.approx(expected_half_life)
    assert advisory_short.quasi_conservative is True
    assert advisory_long.quasi_conservative is False
    assert "screening-grade" in advisory_long.message


def test_backward_footprint_screening_keeps_true_source_drops_decoy():
    sensors = [Sensor(id="S1", lat=12.015, lon=77.06, type="test", species_error_sigma={SPECIES: 1.0})]
    city = _make_city(nx=60, ny=30, background=10.0, sensors=sensors, v_dep=0.0002)
    zone_true = Zone(name="true_upwind", kind="point", lat=12.015, lon=77.02)
    zone_decoy = Zone(name="decoy_downwind", kind="point", lat=12.015, lon=77.12)
    inv = SourceInversion(city, SPECIES, [zone_true, zone_decoy])

    receptor_cell = inv._grid.latlon_to_cell(12.015, 77.06)
    n_steps = 25  # tuned so backward-displaced particles land right around zone_true, well short of zone_decoy
    wind_history = [{"u": 3.0, "v": 0.0, "hour_local": 8.0} for _ in range(n_steps)]
    k_h_history = [20.0] * n_steps

    kept = inv.screen_zones_by_backward_footprint(
        [receptor_cell], wind_history, k_h_history, k_dep=1e-6, dt=60.0, threshold=1e-4, n_particles=3000, seed=1
    )
    kept_names = [z.name for z in kept]
    print(f"\n[backward screening] kept zones: {kept_names}")

    assert "true_upwind" in kept_names
    assert "decoy_downwind" not in kept_names


def test_end_to_end_recovery_through_real_simulator():
    """Ground-truth emission rates -> run through the REAL Simulator
    (independent of SourceInversion's own code) -> synthetic noisy
    observations -> independently constructed zones -> fresh
    SourceInversion -> solve -> check statistical coverage against the
    method's own reported posterior uncertainty."""
    true_rate_a, true_rate_b = 2.0, 1.5
    sources = [
        EmissionSource(name="srcA", kind="point", profile="flat", rates={SPECIES: true_rate_a}, lat=12.015, lon=77.02),
        EmissionSource(name="srcB", kind="point", profile="flat", rates={SPECIES: true_rate_b}, lat=12.015, lon=77.03),
    ]
    sensor_lats = [12.010, 12.015, 12.020]
    sigma_obs = 0.02
    sensors = [
        Sensor(id=f"S{i}", lat=lat, lon=77.08, type="test", species_error_sigma={SPECIES: sigma_obs})
        for i, lat in enumerate(sensor_lats)
    ]
    city = _make_city(nx=50, ny=30, background=0.0, sensors=sensors, v_dep=0.0002, emission_sources=sources, wind_history_hours=2.0)

    sim = Simulator(city)
    stations = [StationObservation("M1", lat=12.02, lon=77.01, wind_speed_m_s=3.0, wind_dir_deg=270.0, temp_c=27.0, rh_pct=50.0)]

    n_steps = 60
    obs_time_indices = [10, 20, 30, 40, 50, 59]
    mixing_height_history = []
    field_snapshots = {}
    for t in range(n_steps):
        result = sim.step(stations)
        mixing_height_history.append(result["met"]["mixing_height_m"])
        if t in obs_time_indices:
            field_snapshots[t] = sim.grid.get_field(SPECIES).astype(np.float64).copy()

    wind_history = list(sim.wind_history)
    k_h_history = list(sim.k_h_history)

    # independently constructed zones (the inversion never sees the real EmissionSource objects)
    zone_a = Zone(name="srcA", kind="point", lat=12.015, lon=77.02)
    zone_b = Zone(name="srcB", kind="point", lat=12.015, lon=77.03)
    inv = SourceInversion(city, SPECIES, [zone_a, zone_b])

    rng = np.random.default_rng(0)
    observations = []
    for t in obs_time_indices:
        for s in sensors:
            i, j = sim.grid.latlon_to_cell(s.lat, s.lon)
            noisy_val = field_snapshots[t][i, j] + rng.normal(0, sigma_obs)
            observations.append(InversionObservation(sensor_id=s.id, time_index=t, enhancement=noisy_val))

    H = inv.assemble_H(wind_history, k_h_history, mixing_height_history, observations)
    result = inv.solve(H, observations)
    x_true = np.array([true_rate_a, true_rate_b])

    print(
        f"\n[end-to-end recovery] x_hat={result.x_hat}, marginal_std={result.marginal_std}, "
        f"true={x_true}, chi2_per_obs={result.chi2_per_obs:.3f}"
    )

    assert np.all(np.abs(result.x_hat - x_true) <= 3 * result.marginal_std)
    assert 0.1 < result.chi2_per_obs < 5.0
