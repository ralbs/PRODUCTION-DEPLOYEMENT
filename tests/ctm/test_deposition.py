"""Analytic-invariant test for ctm/deposition.py, per CLAUDE.md's
"Deposition" acceptance criterion."""
import numpy as np
import pytest

from ctm.deposition import deposit, deposition_rate


def test_deposition_matches_closed_form_exponential():
    """Decay over N steps must match the closed-form C0*exp(-k*dt*N) to
    <1e-4 relative error."""
    v_dep = 0.01  # m/s
    mixing_height = 500.0  # m
    dt = 60.0
    n_steps = 100
    C0 = 50.0

    k = deposition_rate(v_dep, mixing_height)
    field = np.full((10, 10), C0, dtype=np.float64)
    for _ in range(n_steps):
        field = deposit(field, v_dep, mixing_height, dt)

    expected = C0 * np.exp(-k * dt * n_steps)
    rel_err = float(np.max(np.abs(field.astype(np.float64) - expected))) / expected
    print(f"\n[deposition closed-form] measured={field[0, 0]:.10f}, expected={expected:.10f}, relative error={rel_err:.2e}")
    assert rel_err < 1e-4


def test_deposition_rate_requires_positive_mixing_height():
    with pytest.raises(ValueError):
        deposition_rate(0.01, 0.0)
