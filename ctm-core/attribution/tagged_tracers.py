"""attribution/tagged_tracers.py — forward per-category tagged-tracer
attribution.

See CLAUDE.md, "Adjoint inverse layer", item 2. Given a KNOWN emissions
inventory, tracks one extra transported field per source category (tag),
injected ONLY from that category's own emission sources, and
advected/diffused/deposited with the IDENTICAL solver function instances
used by the main model (`ctm.advection.advect`, `ctm.diffusion.diffuse`,
`ctm.deposition.deposit`) -- never a separate reimplementation of the
transport math, which would be a guaranteed future divergence bug.

This is explicitly NOT source inversion (see `attribution/inverse.py`, a
later phase): it requires a known inventory and simply partitions the
forward model's own field by category. It is also not the backward
dispersion tracer (`attribution/adjoint.py`), which needs no inventory at
all and answers a different question ("which upstream cells influenced
this receptor") via a stochastic particle ensemble.

Includes an explicit "background" tag (boundary inflow) and an
"unexplained" residual, computed on demand as `live_field - sum(tags)`.
This residual is a pure diagnostic, not a fourth transported field, and is
specifically designed to catch assimilation increments: `step()` must run
BEFORE assimilation in the simulator's order so the residual captures
exactly what assimilation injects, rather than smearing it across
categories (assimilation only ever touches the live field, never the tag
fields).

Linearity note (why this is exact, not approximate): `ctm.advection.advect`
is jointly LINEAR in (field, background_conc) for a fixed wind field --
the open-boundary ghost cells are a direct substitution of `background`,
not an additive offset, so `advect(C1, b1) + advect(C2, b2) ==
advect(C1+C2, b1+b2)`. For the tag decomposition to sum exactly back to
the live field, only the "background" tag may use the real
`background_conc` as its own inflow constant; every category tag must use
an inflow of 0 (all boundary inflow is attributed to "background" alone).
Diffusion and deposition are already linear with no free constant, so they
trivially preserve the sum.
"""
from __future__ import annotations

import numpy as np

from ctm.advection import advect
from ctm.deposition import deposit
from ctm.diffusion import diffuse
from ctm.emissions import EmissionEngine
from ctm.grid import CTMGrid

BACKGROUND_TAG = "background"


class _TagFieldView:
    """Minimal adapter so EmissionEngine.inject() -- UNCHANGED, not
    reimplemented -- can write into one tag's own field storage instead of
    the main grid, while reusing the main grid's geometry/city."""

    def __init__(self, main_grid: CTMGrid, fields: dict[str, np.ndarray]):
        self._main_grid = main_grid
        self._fields = fields

    @property
    def city(self):
        return self._main_grid.city

    @property
    def nx(self):
        return self._main_grid.nx

    @property
    def ny(self):
        return self._main_grid.ny

    @property
    def dx(self):
        return self._main_grid.dx

    @property
    def dy(self):
        return self._main_grid.dy

    @property
    def species(self):
        return self._main_grid.species

    def latlon_to_cell(self, lat, lon):
        return self._main_grid.latlon_to_cell(lat, lon)

    def latlon_to_xy_m(self, lat, lon):
        return self._main_grid.latlon_to_xy_m(lat, lon)

    def get_field(self, species):
        return self._fields[species]

    def set_field(self, species, values):
        arr = np.array(values, dtype=np.float32, order="C", copy=True)
        np.clip(arr, 0.0, None, out=arr)
        self._fields[species] = arr


class TaggedTracerEngine:
    def __init__(
        self,
        grid: CTMGrid,
        emission_engine: EmissionEngine,
        source_to_tag: dict[str, str] | None = None,
    ):
        self.grid = grid

        if source_to_tag is None:
            # Zero-config default: group by each source's diurnal profile
            # name (a reasonable proxy for category, e.g. "morning_evening"
            # ~ traffic, "daytime" ~ industrial, "night" ~ residential).
            source_to_tag = {src.name: src.profile for src in emission_engine.sources}
        self.source_to_tag = dict(source_to_tag)

        category_tags = sorted(set(self.source_to_tag.values()))
        self.tags = [BACKGROUND_TAG] + category_tags

        self.fields: dict[str, dict[str, np.ndarray]] = {
            tag: {
                sp: (grid.get_field(sp).copy() if tag == BACKGROUND_TAG else np.zeros_like(grid.get_field(sp)))
                for sp in grid.species
            }
            for tag in self.tags
        }

        self._tag_engines: dict[str, EmissionEngine] = {}
        for tag in category_tags:
            tag_sources = [src for src in emission_engine.sources if self.source_to_tag.get(src.name) == tag]
            self._tag_engines[tag] = EmissionEngine(_TagFieldView(grid, self.fields[tag]), sources=tag_sources)

    def step(self, met: dict, hour_local: float, dt: float) -> None:
        """Inject each category's own emissions, then transport EVERY tag
        (including "background") with the identical advect/diffuse/deposit
        calls the main model uses. Must run BEFORE assimilation."""
        for engine in self._tag_engines.values():
            engine.inject(hour_local=hour_local, dt=dt, mixing_height_m=met["mixing_height_m"])

        for tag in self.tags:
            # Only "background" carries the real inflow constant -- see
            # the linearity note in the module docstring.
            for species in self.grid.species:
                inflow = self.grid.background_conc(species) if tag == BACKGROUND_TAG else 0.0
                field = self.fields[tag][species]
                field = advect(field, met["u"], met["v"], self.grid.dx, self.grid.dy, dt, inflow)
                field = diffuse(field, met["K_h"], self.grid.dx, self.grid.dy, dt)
                field = deposit(field, self.grid.v_dep(species), met["mixing_height_m"], dt)
                self.fields[tag][species] = field.astype(np.float32)

    def tag_sum(self, species: str) -> np.ndarray:
        total = np.zeros((self.grid.nx, self.grid.ny), dtype=np.float64)
        for tag in self.tags:
            total += self.fields[tag][species].astype(np.float64)
        return total

    def unexplained_residual(self, species: str) -> np.ndarray:
        """live_field - sum(tags). A pure diagnostic: catches assimilation
        increments (which only ever touch the live field) and any
        inventory gaps -- see module docstring."""
        live = self.grid.get_field(species).astype(np.float64)
        return live - self.tag_sum(species)
