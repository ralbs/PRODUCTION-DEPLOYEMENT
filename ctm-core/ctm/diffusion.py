"""ctm/diffusion.py — explicit finite-difference Laplacian diffusion with
Von Neumann stability enforcement and zero-flux (Neumann) boundaries.

See CLAUDE.md, "Diffusion": boundary ghost cells MUST use
`np.pad(mode="symmetric")` (ghost cell = the EDGE cell itself => true
zero-flux Neumann, mass-conservative to machine precision), NOT
`mode="reflect"` (ghost cell = the SECOND interior cell => a nonzero
boundary flux, ~+0.9%/4h mass drift observed). This exact substitution
bug shipped once and can only be caught by a test with mass near the
boundary -- an interior-only test cannot distinguish the two modes.
"""
from __future__ import annotations

import numpy as np

VON_NEUMANN_LIMIT = 0.5


class DiffusionStabilityError(ValueError):
    """Raised when the explicit diffusion step violates the Von Neumann
    stability criterion (r_x + r_y > 0.5)."""


def von_neumann_numbers(k_h: float, dt: float, dx: float, dy: float) -> tuple[float, float]:
    r_x = k_h * dt / dx**2
    r_y = k_h * dt / dy**2
    return r_x, r_y


def check_stability(k_h: float, dt: float, dx: float, dy: float, limit: float = VON_NEUMANN_LIMIT):
    r_x, r_y = von_neumann_numbers(k_h, dt, dx, dy)
    if r_x + r_y > limit:
        raise DiffusionStabilityError(
            f"Von Neumann stability violated: r_x+r_y = {r_x + r_y:.4f} > {limit} "
            f"(K_h={k_h}, dt={dt}, dx={dx}, dy={dy}). Reduce dt or K_h, or "
            f"increase grid spacing."
        )
    return r_x, r_y


def diffuse(C, k_h: float, dx: float, dy: float, dt: float):
    """Advance a single-species field C (nx, ny) by one explicit diffusion
    step with zero-flux (Neumann) boundaries. Raises DiffusionStabilityError
    if the Von Neumann criterion (r_x + r_y <= 0.5) is violated.
    """
    r_x, r_y = check_stability(k_h, dt, dx, dy)
    C = np.asarray(C, dtype=np.float64)

    padded = np.pad(C, 1, mode="symmetric")

    laplacian_x = padded[2:, 1:-1] - 2 * padded[1:-1, 1:-1] + padded[:-2, 1:-1]
    laplacian_y = padded[1:-1, 2:] - 2 * padded[1:-1, 1:-1] + padded[1:-1, :-2]

    C_new = C + r_x * laplacian_x + r_y * laplacian_y
    return np.clip(C_new, 0.0, None).astype(np.float32)
