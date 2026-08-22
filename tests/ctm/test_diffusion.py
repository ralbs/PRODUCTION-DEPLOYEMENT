"""Analytic-invariant tests for ctm/diffusion.py, per CLAUDE.md's
"Diffusion" acceptance criteria."""
import numpy as np
import pytest

from ctm.diffusion import DiffusionStabilityError, check_stability, diffuse


def _diffuse_with_pad_mode(C, k_h, dx, dy, dt, mode):
    """Reimplements the diffusion step with a caller-chosen padding mode,
    purely so the test below can demonstrate the reflect-vs-symmetric
    difference. Production code (ctm.diffusion.diffuse) always uses
    "symmetric" and never exposes this choice."""
    r_x, r_y = check_stability(k_h, dt, dx, dy)
    C = np.asarray(C, dtype=np.float64)
    padded = np.pad(C, 1, mode=mode)
    lap_x = padded[2:, 1:-1] - 2 * padded[1:-1, 1:-1] + padded[:-2, 1:-1]
    lap_y = padded[1:-1, 2:] - 2 * padded[1:-1, 1:-1] + padded[1:-1, :-2]
    return C + r_x * lap_x + r_y * lap_y


def test_variance_grows_as_analytic_diffusion_solution():
    """A Gaussian blob's variance must grow as sigma0^2 + 2*K_h*t, verified
    to <5% over several hours simulated time."""
    nx, ny, dx, dy = 120, 120, 500.0, 500.0
    k_h = 10.0  # m^2/s
    dt = 60.0
    n_steps = 240  # 4 hours
    sigma0_m = 1500.0  # 3 grid cells

    x0, y0 = nx // 2, ny // 2
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")
    x_m = (ii - x0) * dx
    y_m = (jj - y0) * dy
    field = np.exp(-(x_m**2 + y_m**2) / (2 * sigma0_m**2))
    mass0 = field.sum()

    for _ in range(n_steps):
        field = diffuse(field, k_h, dx, dy, dt)

    t = n_steps * dt
    mass1 = field.sum()
    x_bar = (field * x_m).sum() / mass1
    y_bar = (field * y_m).sum() / mass1
    var_x = (field * (x_m - x_bar) ** 2).sum() / mass1
    var_y = (field * (y_m - y_bar) ** 2).sum() / mass1
    sigma2_measured = 0.5 * (var_x + var_y)

    sigma2_expected = sigma0_m**2 + 2 * k_h * t
    rel_err = abs(sigma2_measured - sigma2_expected) / sigma2_expected
    mass_err = abs(mass1 - mass0) / mass0

    print(
        f"\n[diffusion variance growth] measured sigma^2={sigma2_measured:.1f} m^2, "
        f"expected={sigma2_expected:.1f} m^2, relative error={rel_err:.4%}; "
        f"mass conservation error={mass_err:.2e}"
    )

    assert rel_err < 0.05
    # "machine precision" here means float32 (diffuse() returns float32,
    # per CLAUDE.md's grid spec) accumulated over 240 steps, not float64:
    # float32 eps ~1.19e-7, so O(1e-7)-O(1e-6) drift from rounding alone is
    # expected and is NOT the reflect-vs-symmetric bug (that bug produces
    # ~0.5-1%/100 steps, four+ orders of magnitude larger -- see the
    # near-boundary test below).
    assert mass_err < 1e-5


def test_near_boundary_blob_mass_conservation_symmetric_vs_reflect():
    """Boundary padding must use symmetric (true zero-flux), not reflect
    (nonzero boundary flux). Placing the blob near the edge is essential --
    an interior-only test cannot catch this, since the two modes only
    differ at the boundary."""
    nx, ny, dx, dy = 40, 40, 500.0, 500.0
    k_h = 5.0
    dt = 60.0
    n_steps = 100

    x0, y0 = 1, 1  # one cell from the SW corner: tails overlap the boundary immediately
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")
    blob = np.exp(-((ii - x0) ** 2 + (jj - y0) ** 2) / (2 * 2.0**2))
    mass0 = blob.sum()

    field_symmetric = blob.copy()
    field_reflect = blob.copy()
    for _ in range(n_steps):
        field_symmetric = diffuse(field_symmetric, k_h, dx, dy, dt)  # production path
        field_reflect = _diffuse_with_pad_mode(field_reflect, k_h, dx, dy, dt, mode="reflect")

    err_symmetric = abs(field_symmetric.sum() - mass0) / mass0
    err_reflect = abs(field_reflect.sum() - mass0) / mass0

    print(
        f"\n[diffusion near-boundary blob] symmetric mass error={err_symmetric:.8%}, "
        f"reflect mass error={err_reflect:.4%}"
    )

    assert err_symmetric < 1e-6, "symmetric padding should be mass-conservative to ~machine precision"
    assert err_reflect > 0.001, "reflect padding should show a measurable mass drift near the boundary"
    assert err_reflect > err_symmetric * 100, "symmetric must dramatically outperform reflect"


def test_von_neumann_stability_violation_raises():
    """r_x + r_y > 0.5 must raise, not silently produce an unstable step."""
    nx, ny, dx, dy = 20, 20, 500.0, 500.0
    k_h = 100.0
    dt = 1200.0  # r_x+r_y = 2*(100*1200/500^2) = 0.96 > 0.5

    field = np.full((nx, ny), 10.0)
    with pytest.raises(DiffusionStabilityError):
        diffuse(field, k_h, dx, dy, dt)


def test_von_neumann_stable_case_does_not_raise():
    nx, ny, dx, dy = 20, 20, 500.0, 500.0
    k_h = 5.0
    dt = 60.0  # r_x+r_y = 2*(5*60/500^2) = 0.0024, well under 0.5

    field = np.full((nx, ny), 10.0)
    result = diffuse(field, k_h, dx, dy, dt)  # should not raise
    assert np.all(np.isfinite(result))
