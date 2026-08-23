"""Tests for attribution/adjoint.py, per CLAUDE.md's "Adjoint inverse
layer" item 1 acceptance criteria: correct backward-decay sign, exact
boundary/interior mass accounting, K_h pulled from per-step history (not a
hardcoded constant), and a real (nonzero-spread) ensemble."""
import numpy as np
import pytest

from attribution.adjoint import AdjointTracer

NX, NY, DX, DY = 60, 60, 500.0, 500.0


def _flat_history(n_steps, u=0.0, v=0.0, k_h=10.0):
    wind_history = [{"u": u, "v": v, "hour_local": 8.0} for _ in range(n_steps)]
    k_h_history = [k_h] * n_steps
    return wind_history, k_h_history


def test_backward_decay_matches_analytic_exp_minus_k_tau():
    """Direct analytic check of the decay SIGN: with zero wind and zero
    diffusivity, every particle stays exactly at the receptor for the
    whole trace (no boundary exits), so the only thing changing weight is
    decay -- the result must equal exp(-k*tau) to near machine precision,
    not exp(+k*tau) (CLAUDE.md's historical bug, ~32x overweighting)."""
    k_dep = 1.0e-5  # 1/s, e.g. v_dep/H_mix for a fast-depositing species
    dt = 60.0
    n_steps = 240  # tau = 4 hours
    tau = n_steps * dt

    wind_history, k_h_history = _flat_history(n_steps, u=0.0, v=0.0, k_h=0.0)
    tracer = AdjointTracer(NX, NY, DX, DY)
    result = tracer.trace(NX // 2, NY // 2, wind_history, k_h_history, k_dep, dt, n_particles=500, seed=0)

    expected = np.exp(-k_dep * tau)
    measured = result.interior_probability.sum()  # boundary_inflow_fraction == 0 here
    rel_err = abs(measured - expected) / expected

    print(
        f"\n[adjoint decay sign] measured survival={measured:.10f}, "
        f"exp(-k*tau)={expected:.10f}, relative error={rel_err:.2e}, "
        f"boundary_inflow_fraction={result.boundary_inflow_fraction:.2e}"
    )

    assert result.boundary_inflow_fraction == 0.0  # nothing could have exited: zero wind, zero K_h
    assert rel_err < 1e-9

    # contrast with the historical WRONG-SIGN bug, kept only here
    wrong_sign_survival = np.exp(+k_dep * tau)
    assert wrong_sign_survival > 1.0  # growth, not decay -- unphysical
    assert measured < wrong_sign_survival
    assert measured != pytest.approx(wrong_sign_survival)


def test_interior_plus_boundary_equals_one_and_edge_band_share_is_small():
    """Steady wind, receptor well inside the domain, downwind of where a
    backward trace would walk: edge-band footprint mass must be small, and
    interior_probability.sum() + boundary_inflow_fraction == 1 exactly.

    k_dep=0 here deliberately: weight decay shrinks whatever a particle
    carries by the time it lands in either bucket, so the sum can only
    equal exactly 1 when nothing decays. This isolates the boundary/
    interior PARTICLE-ACCOUNTING invariant from decay, which has its own
    dedicated analytic test above."""
    k_dep = 0.0
    dt = 60.0
    n_steps = 60  # 1 hour of backward history
    u, v = 2.0, 0.0  # steady zonal wind
    k_h = 10.0

    wind_history, k_h_history = _flat_history(n_steps, u=u, v=v, k_h=k_h)
    tracer = AdjointTracer(NX, NY, DX, DY)
    # receptor downwind (east side), well clear of every edge given the
    # backward displacement (~2*3600/500 = 14.4 cells) plus diffusion spread
    receptor_i, receptor_j = 45, NY // 2
    result = tracer.trace(receptor_i, receptor_j, wind_history, k_h_history, k_dep, dt, n_particles=4000, seed=1)

    total = result.interior_probability.sum() + result.boundary_inflow_fraction
    edge_margin = 3  # cells
    edge_mask = np.zeros((NX, NY), dtype=bool)
    edge_mask[:edge_margin, :] = True
    edge_mask[-edge_margin:, :] = True
    edge_mask[:, :edge_margin] = True
    edge_mask[:, -edge_margin:] = True
    edge_band_share = result.interior_probability[edge_mask].sum() / (
        result.interior_probability.sum() + result.boundary_inflow_fraction
    )

    print(
        f"\n[adjoint boundary accounting] interior_probability.sum()={result.interior_probability.sum():.6f}, "
        f"boundary_inflow_fraction={result.boundary_inflow_fraction:.6f}, sum={total:.12f}\n"
        f"[adjoint edge-band share] {edge_band_share:.4%} of total mass within {edge_margin} cells of any edge"
    )

    assert total == pytest.approx(1.0, abs=1e-9)
    assert edge_band_share < 0.05
    assert result.boundary_inflow_fraction < 0.05


def test_k_h_from_history_gives_narrower_footprint_for_stable_low_k_h():
    """SAME wind sequence, different K_h histories: a stable-night (low
    K_h) trace must produce a measurably narrower crosswind footprint than
    an unstable-daytime (high K_h) trace. Proves K_h actually comes from
    the per-step history, not a hardcoded constant (a hardcoded K_h would
    make these two identical)."""
    dt = 60.0
    n_steps = 60
    u, v = 2.0, 0.0  # zonal wind -> crosswind = y-direction
    k_dep = 0.0
    receptor_i, receptor_j = 45, NY // 2

    wind_history, k_h_low = _flat_history(n_steps, u=u, v=v, k_h=3.0)  # stable ("F")
    _, k_h_high = _flat_history(n_steps, u=u, v=v, k_h=100.0)  # unstable ("B")

    tracer = AdjointTracer(NX, NY, DX, DY)
    result_low = tracer.trace(receptor_i, receptor_j, wind_history, k_h_low, k_dep, dt, n_particles=6000, seed=2)
    result_high = tracer.trace(receptor_i, receptor_j, wind_history, k_h_high, k_dep, dt, n_particles=6000, seed=2)

    def crosswind_std(result):
        p = result.interior_probability
        total = p.sum()
        jj = np.arange(NY)
        mean_j = (p.sum(axis=0) * jj).sum() / total
        var_j = (p.sum(axis=0) * (jj - mean_j) ** 2).sum() / total
        return np.sqrt(var_j) * DY

    std_low = crosswind_std(result_low)
    std_high = crosswind_std(result_high)
    ratio = std_high / std_low

    print(
        f"\n[adjoint K_h sensitivity] stable (K_h=3 m^2/s) crosswind std={std_low:.1f} m, "
        f"unstable (K_h=100 m^2/s) crosswind std={std_high:.1f} m, ratio={ratio:.2f}x"
    )

    assert std_high > std_low
    assert ratio > 2.0  # clearly, not marginally, wider


def test_out_of_domain_receptor_raises_instead_of_silently_reporting_full_boundary_inflow():
    """Adversarial case: a receptor cell outside the grid (e.g. from an
    unchecked CTMGrid.latlon_to_cell() result for a sensor just past the
    domain edge). Before this check, trace() ran anyway and returned
    boundary_inflow_fraction~1.0 -- a value indistinguishable from a
    legitimate 'this receptor is right at the edge and everything blew
    out' result, silently masking a caller bug. Every other consumer of
    latlon_to_cell() in this codebase (assimilation.py, inverse.py,
    kriging.py) bounds-checks explicitly; trace() must too."""
    tracer = AdjointTracer(NX, NY, DX, DY)
    wind_history, k_h_history = _flat_history(10, u=1.0, v=0.0, k_h=10.0)

    with pytest.raises(ValueError):
        tracer.trace(-1, 0, wind_history, k_h_history, k_dep=0.0, dt=60.0, n_particles=100, seed=0)
    with pytest.raises(ValueError):
        tracer.trace(0, NY, wind_history, k_h_history, k_dep=0.0, dt=60.0, n_particles=100, seed=0)
    # the boundary-most VALID cell must still work fine
    result = tracer.trace(0, 0, wind_history, k_h_history, k_dep=0.0, dt=60.0, n_particles=100, seed=0)
    assert np.isfinite(result.interior_probability).all()


def test_receptor_at_domain_corner_with_wind_blowing_out_reports_near_total_boundary_inflow():
    """Adversarial case: receptor at the EXACT domain corner (0,0), wind
    backward-displacing particles further into negative territory (i.e.
    straight out through the corner) on the very first backward step.
    Must not crash and must still satisfy the exact accounting identity."""
    tracer = AdjointTracer(NX, NY, DX, DY)
    wind_history, k_h_history = _flat_history(60, u=3.0, v=3.0, k_h=20.0)
    result = tracer.trace(0, 0, wind_history, k_h_history, k_dep=0.0, dt=60.0, n_particles=4000, seed=3)

    total = result.interior_probability.sum() + result.boundary_inflow_fraction
    print(
        f"\n[adjoint corner receptor] interior={result.interior_probability.sum()!r}, "
        f"boundary={result.boundary_inflow_fraction!r}, total={total!r}"
    )
    assert total == pytest.approx(1.0, abs=1e-9)
    assert result.boundary_inflow_fraction > 0.99
    assert np.all(np.isfinite(result.interior_probability))


def test_trace_ensemble_reports_nonzero_spread_unlike_fixed_seed():
    """Receptor placed close to an edge with enough diffusion/duration
    that SOME (not zero, not all) particles randomly cross the boundary --
    this is what makes boundary_inflow_fraction itself a meaningful,
    genuinely stochastic per-member statistic (a receptor safely in the
    interior would give exactly 0 for every member regardless of seed,
    which wouldn't actually distinguish a real ensemble from a fixed-seed
    fake one)."""
    dt = 60.0
    n_steps = 200
    wind_history, k_h_history = _flat_history(n_steps, u=0.0, v=0.0, k_h=80.0)
    tracer = AdjointTracer(NX, NY, DX, DY)
    receptor_i, receptor_j = 6, NY // 2  # near the west edge

    ensemble = tracer.trace_ensemble(
        receptor_i, receptor_j, wind_history, k_h_history, k_dep=0.0, dt=dt,
        n_particles=800, n_members=12, seed=7,
    )

    print(
        f"\n[adjoint ensemble] boundary_inflow_fraction per member: "
        f"{[round(m.boundary_inflow_fraction, 5) for m in ensemble['members']]}\n"
        f"[adjoint ensemble] mean={ensemble['boundary_inflow_fraction_mean']:.6f}, "
        f"std={ensemble['boundary_inflow_fraction_std']:.6e}"
    )

    assert ensemble["boundary_inflow_fraction_std"] > 1e-4
    assert np.any(ensemble["interior_probability_std"] > 0)

    # contrast: a fixed-seed "ensemble" has zero spread by construction,
    # even in this exact same boundary-sensitive scenario
    fixed_seed_members = [
        tracer.trace(receptor_i, receptor_j, wind_history, k_h_history, k_dep=0.0, dt=dt, n_particles=800, seed=42)
        for _ in range(12)
    ]
    fixed_boundary_fracs = np.array([m.boundary_inflow_fraction for m in fixed_seed_members])
    print(f"[adjoint ensemble] fixed-seed 'ensemble' boundary_inflow_fraction std={fixed_boundary_fracs.std():.6e}")
    # all 12 values are identically 0.01875 (every member is bit-identical);
    # np.std's summation order leaves ~1e-18 floating-point noise, not a
    # real difference -- compare against the genuine spread above, which is
    # ~4.7e-3, four orders of magnitude larger.
    assert fixed_boundary_fracs.std() < 1e-12
    assert fixed_boundary_fracs.std() < ensemble["boundary_inflow_fraction_std"] / 1000
