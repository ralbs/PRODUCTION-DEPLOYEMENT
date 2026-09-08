"""Analytic-invariant tests for ctm/advection.py, per CLAUDE.md's
"Advection" acceptance criteria."""
import numpy as np
import pytest

from ctm.advection import CFL_MAX, advect, cfl_number

from ._testutils import gaussian_blob


def test_centroid_translates_at_wind_speed_and_mass_conserved():
    """Inject a Gaussian blob under uniform wind, subtract a parallel
    zero-emission background run to remove boundary inflow contribution,
    and verify the centroid translates at exactly the wind speed and mass
    is conserved to <0.1% over tens of steps."""
    nx, ny, dx, dy = 80, 80, 500.0, 500.0
    background = 10.0
    u, v = 2.0, 1.0
    dt = 60.0
    n_steps = 30

    blob = gaussian_blob(nx, ny, x0=20, y0=20, sigma=3.0, amplitude=100.0)
    field_perturbed = (background + blob).astype(np.float32)
    field_background_only = np.full((nx, ny), background, dtype=np.float32)

    for _ in range(n_steps):
        field_perturbed = advect(field_perturbed, u, v, dx, dy, dt, background)
        field_background_only = advect(field_background_only, u, v, dx, dy, dt, background)

    # sanity check: a uniform background field must stay exactly uniform
    assert np.allclose(field_background_only, background, atol=1e-4)

    diff = field_perturbed.astype(np.float64) - field_background_only.astype(np.float64)
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")

    mass0 = blob.sum()
    ci0 = (blob * ii).sum() / mass0
    cj0 = (blob * jj).sum() / mass0

    mass1 = diff.sum()
    ci1 = (diff * ii).sum() / mass1
    cj1 = (diff * jj).sum() / mass1

    elapsed = n_steps * dt
    expected_di = u * elapsed / dx
    expected_dj = v * elapsed / dy
    di_err = abs((ci1 - ci0) - expected_di) / expected_di
    dj_err = abs((cj1 - cj0) - expected_dj) / expected_dj
    mass_err = abs(mass1 - mass0) / mass0

    print(
        f"\n[advection centroid+mass] dx centroid error={di_err:.6%}, "
        f"dy centroid error={dj_err:.6%}, mass error={mass_err:.6%}"
    )

    assert di_err < 0.01
    assert dj_err < 0.01
    assert mass_err < 0.001  # <0.1%


def test_strong_wind_cfl_2p5_remains_stable_and_mass_conservative():
    """Must remain stable and mass-conservative even under strong wind
    (CFL_nominal up to ~2.5), not just the default parameters."""
    nx, ny, dx, dy = 70, 70, 500.0, 500.0
    background = 5.0
    dt = 60.0
    # u = v chosen so nominal CFL = 2*u*dt/dx = 2.5 exactly
    u = v = 2.5 * dx / (2 * dt)

    nominal_cfl = cfl_number(u, v, dx, dy, dt)
    assert nominal_cfl == pytest.approx(2.5, rel=1e-6)
    assert nominal_cfl > CFL_MAX  # confirms sub-stepping is actually required here

    blob = gaussian_blob(nx, ny, x0=15, y0=15, sigma=3.0, amplitude=50.0)
    field = (background + blob).astype(np.float32)
    peak0 = float(field.max())
    mass0 = blob.sum()

    for step in range(15):
        field = advect(field, u, v, dx, dy, dt, background)
        assert np.all(np.isfinite(field)), f"advection blew up under strong wind at step {step}"
        assert field.min() >= -1e-6, f"negative concentration (instability) at step {step}"
        assert field.max() <= peak0 + 1e-6, f"unbounded growth (instability) at step {step}"

    diff = field.astype(np.float64) - background
    mass_final = diff.sum()
    mass_err = abs(mass_final - mass0) / mass0
    print(f"\n[advection strong-wind CFL={nominal_cfl:.2f}] mass error over 15 steps: {mass_err:.6%}")
    assert mass_err < 0.01


def test_negative_wind_translates_centroid_correctly():
    """Every other advection test uses positive u,v -- an audit gap. The
    donor-cell upwind formula picks its donor cell via `u_face >= 0`, which
    is sign-symmetric by construction, but that symmetry had never actually
    been exercised by a test. Same acceptance criteria as the positive-wind
    case, mirrored: negative wind, blob starts near the far corner so it
    has room to translate toward the origin."""
    nx, ny, dx, dy = 80, 80, 500.0, 500.0
    background = 10.0
    u, v = -2.0, -1.0
    dt = 60.0
    n_steps = 30

    blob = gaussian_blob(nx, ny, x0=60, y0=60, sigma=3.0, amplitude=100.0)
    field_perturbed = (background + blob).astype(np.float32)
    field_background_only = np.full((nx, ny), background, dtype=np.float32)

    for _ in range(n_steps):
        field_perturbed = advect(field_perturbed, u, v, dx, dy, dt, background)
        field_background_only = advect(field_background_only, u, v, dx, dy, dt, background)

    assert np.allclose(field_background_only, background, atol=1e-4)

    diff = field_perturbed.astype(np.float64) - field_background_only.astype(np.float64)
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")

    mass0 = blob.sum()
    ci0 = (blob * ii).sum() / mass0
    cj0 = (blob * jj).sum() / mass0
    mass1 = diff.sum()
    ci1 = (diff * ii).sum() / mass1
    cj1 = (diff * jj).sum() / mass1

    elapsed = n_steps * dt
    expected_di = u * elapsed / dx
    expected_dj = v * elapsed / dy
    di_err = abs((ci1 - ci0) - expected_di) / abs(expected_di)
    dj_err = abs((cj1 - cj0) - expected_dj) / abs(expected_dj)
    mass_err = abs(mass1 - mass0) / mass0

    print(
        f"\n[advection negative-wind centroid+mass] dx centroid error={di_err:.6%}, "
        f"dy centroid error={dj_err:.6%}, mass error={mass_err:.6%}"
    )

    assert di_err < 0.01
    assert dj_err < 0.01
    assert mass_err < 0.001
    assert not np.any(field_perturbed < 0)


def test_sustained_inflow_fills_domain_toward_background():
    """Under sustained inflow the domain should fill toward the configured
    background concentration."""
    nx, ny, dx, dy = 20, 20, 500.0, 500.0
    background = 25.0
    u = v = 5.0
    dt = 60.0
    field = np.zeros((nx, ny), dtype=np.float32)

    n_steps = 60  # ~1.8x the domain traversal time at this wind speed
    for _ in range(n_steps):
        field = advect(field, u, v, dx, dy, dt, background)

    max_rel_dev = float(np.max(np.abs(field.astype(np.float64) - background))) / background
    print(f"\n[advection inflow fill] max relative deviation from background after sustained inflow: {max_rel_dev:.6%}")
    assert max_rel_dev < 0.01
