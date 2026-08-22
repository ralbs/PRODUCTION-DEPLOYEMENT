"""ctm/advection.py — interface-flux donor-cell upwind advection with
CFL-adaptive sub-stepping and open (inflow/outflow) boundaries.

See CLAUDE.md, "Advection": this must be an interface-flux (donor-cell
upwind) formulation, explicitly NOT `np.roll()` cell-centered divergence
-- `np.roll` silently wraps mass around the domain edge (periodic BC),
which is wrong for an open urban domain.
"""
from __future__ import annotations

import numpy as np

CFL_MAX = 0.9


def cfl_number(u, v, dx: float, dy: float, dt: float) -> float:
    """CFL = |u|dt/dx + |v|dt/dy, using the max wind magnitude present."""
    u = np.asarray(u)
    v = np.asarray(v)
    max_u = float(np.max(np.abs(u))) if u.size else 0.0
    max_v = float(np.max(np.abs(v))) if v.size else 0.0
    return max_u * dt / dx + max_v * dt / dy


def advect(C, u, v, dx: float, dy: float, dt: float, background: float, cfl_max: float = CFL_MAX):
    """Advance a single-species concentration field C (nx, ny) by one
    nominal timestep dt.

    u, v: cell-centered wind components (m/s); scalar or (nx, ny) array.
    background: per-species background concentration (from city config)
    used for inflow at open boundaries; outflow uses zero-gradient
    (the last interior cell value) automatically -- see _advect_substep.
    Sub-steps internally so every sub-step's CFL number stays <= cfl_max,
    remaining stable and mass-conservative even under strong wind.
    """
    C = np.asarray(C, dtype=np.float64)
    nx, ny = C.shape
    u = np.broadcast_to(np.asarray(u, dtype=np.float64), (nx, ny))
    v = np.broadcast_to(np.asarray(v, dtype=np.float64), (nx, ny))

    cfl = cfl_number(u, v, dx, dy, dt)
    n_sub = max(1, int(np.ceil(cfl / cfl_max))) if cfl > 0 else 1
    sub_dt = dt / n_sub

    field = C.copy()
    for _ in range(n_sub):
        field = _advect_substep(field, u, v, dx, dy, sub_dt, background)
    return field.astype(np.float32)


def _advect_substep(C, u, v, dx: float, dy: float, dt: float, background: float):
    nx, ny = C.shape

    # Ghost cells hold the background concentration on both sides. The
    # donor-cell upwind formula then resolves the open boundary condition
    # automatically from the local sign of the face velocity: when flow is
    # INTO the domain the upwind donor is the ghost (background) cell --
    # inflow; when flow is OUT of the domain the upwind donor is the
    # interior cell itself -- outflow, i.e. zero-gradient, with no special
    # casing required.
    C_x = np.pad(C, ((1, 1), (0, 0)), mode="constant", constant_values=background)
    C_y = np.pad(C, ((0, 0), (1, 1)), mode="constant", constant_values=background)

    u_face = np.empty((nx + 1, ny))
    u_face[1:nx, :] = 0.5 * (u[:-1, :] + u[1:, :])
    u_face[0, :] = u[0, :]
    u_face[nx, :] = u[-1, :]

    v_face = np.empty((nx, ny + 1))
    v_face[:, 1:ny] = 0.5 * (v[:, :-1] + v[:, 1:])
    v_face[:, 0] = v[:, 0]
    v_face[:, ny] = v[:, -1]

    Fx = np.where(u_face >= 0, u_face * C_x[:-1, :], u_face * C_x[1:, :])
    Fy = np.where(v_face >= 0, v_face * C_y[:, :-1], v_face * C_y[:, 1:])

    C_new = C - (dt / dx) * (Fx[1:, :] - Fx[:-1, :]) - (dt / dy) * (Fy[:, 1:] - Fy[:, :-1])
    return np.clip(C_new, 0.0, None)
