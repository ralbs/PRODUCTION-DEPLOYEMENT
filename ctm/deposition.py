"""ctm/deposition.py — first-order exponential dry deposition decay.

See CLAUDE.md, "Deposition": exact exponential
`C(t+dt) = C(t) * exp(-k*dt)`, `k = v_dep / H_mix` -- NEVER the linear
`(1 - k*dt)` approximation, which goes unstable (and unphysically
negative) once `k*dt` approaches or exceeds 1.
"""
from __future__ import annotations

import numpy as np


def deposition_rate(v_dep_m_s: float, mixing_height_m: float) -> float:
    if mixing_height_m <= 0:
        raise ValueError(f"mixing_height_m must be > 0, got {mixing_height_m}")
    return v_dep_m_s / mixing_height_m


def deposit(C, v_dep_m_s: float, mixing_height_m: float, dt: float):
    """Advance a single-species field C by one dry-deposition step.

    v_dep_m_s: species-specific deposition velocity, from city config
    (Seinfeld & Pandis Table 19.2 / Zhang et al. 2001 are reasonable
    starting points, always overridable per city).
    """
    k = deposition_rate(v_dep_m_s, mixing_height_m)
    C = np.asarray(C, dtype=np.float64)
    C_new = C * np.exp(-k * dt)
    return C_new.astype(np.float32)
