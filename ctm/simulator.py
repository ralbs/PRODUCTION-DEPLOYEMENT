"""ctm/simulator.py — per-step orchestration.

See CLAUDE.md, "Simulator orchestration": step order is
    update meteorology -> record wind+K_h history -> inject emissions
    (LOCAL-hour indexed) -> advect -> diffuse -> deposit -> tagged tracers
    (if enabled, BEFORE assimilation) -> assimilate -> update counters.
This is first-order (Godunov) operator splitting -- NOT "Strang splitting"
(that specifically means half/full/half sub-stepping, which this isn't).

Wind and K_h history are recorded in a parallel, 1:1-aligned pair of
rolling buffers (`maxlen` from the city's configured lookback hours): the
adjoint layer must use the SAME K_h the forward model actually used that
step, never a hardcoded constant -- a stable nighttime trace must not be
dispersed with a daytime K_h default.

`save_state`/`load_state` checkpoint the wind history AND K_h history AND
any tagged-tracer fields, not just the concentration snapshot -- a
previous version's checkpoint silently dropped the wind buffer, losing
24h of adjoint capability on every restart with no error raised. Old
checkpoints without history keys must still load cleanly (empty buffer,
not a crash).
"""
from __future__ import annotations

import pickle
from collections import deque
from pathlib import Path

import numpy as np

from attribution.tagged_tracers import TaggedTracerEngine
from cities.loader import CityConfig
from ctm.advection import advect
from ctm.assimilation import Observation, assimilate
from ctm.deposition import deposit
from ctm.diffusion import diffuse
from ctm.emissions import EmissionEngine, local_hour_from_utc
from ctm.grid import CTMGrid
from met.weather_station import StationObservation, interpolate_met

CHECKPOINT_FORMAT_VERSION = 2


class Simulator:
    def __init__(
        self,
        city: CityConfig,
        enable_tagged_tracers: bool = False,
        hour_utc0: float = 0.0,
        source_to_tag: dict[str, str] | None = None,
    ):
        self.city = city
        self.grid = CTMGrid(city)
        self.emission_engine = EmissionEngine(self.grid)

        self.hour_utc = hour_utc0 % 24.0
        self.step_count = 0
        self.elapsed_seconds = 0.0

        steps_per_hour = 3600.0 / city.dt_seconds
        self.wind_history_maxlen = max(1, round(city.wind_history_hours * steps_per_hour))
        self.wind_history: deque = deque(maxlen=self.wind_history_maxlen)
        self.k_h_history: deque = deque(maxlen=self.wind_history_maxlen)

        self.enable_tagged_tracers = enable_tagged_tracers
        self.tagged_tracer_engine: TaggedTracerEngine | None = None
        if enable_tagged_tracers:
            self.tagged_tracer_engine = TaggedTracerEngine(
                self.grid, self.emission_engine, source_to_tag=source_to_tag
            )

    @property
    def tagged_tracer_fields(self) -> dict[str, dict[str, np.ndarray]]:
        return self.tagged_tracer_engine.fields if self.tagged_tracer_engine is not None else {}

    def step(
        self,
        stations: list[StationObservation],
        observations: dict[str, list[Observation]] | None = None,
    ) -> dict:
        """Runs one full simulation step ATOMICALLY: on any exception raised
        partway through (e.g. `DiffusionStabilityError` from an unstable
        K_h/dt combination discovered mid-species-loop -- a real,
        reproducible case, not hypothetical), the simulator is rolled back
        to EXACTLY its pre-step state -- concentration fields, tagged-
        tracer fields, and wind/K_h history -- before the exception is
        re-raised.

        Without this, a caller that catches the exception and calls
        `save_state()` to "preserve progress" gets an internally
        inconsistent checkpoint: `wind_history`/`k_h_history` already have
        one more entry than `step_count` reflects (they're recorded at
        pipeline stage 2, before the per-species transport loop that can
        fail), and species processed before the failure point are left
        transported while later ones are not -- exactly the kind of silent
        divergence the adjoint tracer's 1:1 wind/K_h-history alignment
        assumption depends on never happening.
        """
        field_snapshot = {sp: self.grid.get_field(sp).copy() for sp in self.grid.species}
        tag_field_snapshot = None
        if self.tagged_tracer_engine is not None:
            tag_field_snapshot = {
                tag: {sp: arr.copy() for sp, arr in species_fields.items()}
                for tag, species_fields in self.tagged_tracer_fields.items()
            }
        wind_history_snapshot = list(self.wind_history)
        k_h_history_snapshot = list(self.k_h_history)

        try:
            return self._step_unchecked(stations, observations)
        except Exception:
            for sp, arr in field_snapshot.items():
                self.grid.set_field(sp, arr)
            if tag_field_snapshot is not None and self.tagged_tracer_engine is not None:
                for tag, species_fields in tag_field_snapshot.items():
                    for sp, arr in species_fields.items():
                        self.tagged_tracer_engine.fields[tag][sp] = arr.copy()
            self.wind_history = deque(wind_history_snapshot, maxlen=self.wind_history_maxlen)
            self.k_h_history = deque(k_h_history_snapshot, maxlen=self.wind_history_maxlen)
            raise

    def _step_unchecked(
        self,
        stations: list[StationObservation],
        observations: dict[str, list[Observation]] | None = None,
    ) -> dict:
        dt = self.city.dt_seconds
        hour_local = local_hour_from_utc(self.hour_utc, self.city.utc_offset_hours)

        # 1. meteorology
        met = interpolate_met(stations, self.grid, hour_local, self.city.climatology)

        # 2. record wind + K_h history, aligned 1:1
        self.wind_history.append(
            {"u": np.asarray(met["u"]).copy(), "v": np.asarray(met["v"]).copy(), "hour_local": hour_local}
        )
        self.k_h_history.append(met["K_h"])

        # 3. emissions -- LOCAL hour, never UTC (see module docstring)
        self.emission_engine.inject(hour_local=hour_local, dt=dt, mixing_height_m=met["mixing_height_m"])

        # 4-6. advect -> diffuse -> deposit, per species
        for species in self.grid.species:
            field = self.grid.get_field(species)
            background = self.grid.background_conc(species)
            field = advect(field, met["u"], met["v"], self.grid.dx, self.grid.dy, dt, background)
            field = diffuse(field, met["K_h"], self.grid.dx, self.grid.dy, dt)
            field = deposit(field, self.grid.v_dep(species), met["mixing_height_m"], dt)
            self.grid.set_field(species, field)

        # 7. tagged tracers, if enabled -- BEFORE assimilation, so any
        # assimilation increment lands outside every tag's accounting (it
        # only ever touches the live field, never the tag fields -- see
        # attribution/tagged_tracers.py's "unexplained" residual).
        if self.tagged_tracer_engine is not None:
            self.tagged_tracer_engine.step(met, hour_local, dt)

        # 8. assimilate
        assimilation_diagnostics = {}
        if observations:
            for species, obs_list in observations.items():
                assimilation_diagnostics[species] = assimilate(self.city, self.grid, species, obs_list)

        # 9. update counters
        self.step_count += 1
        self.elapsed_seconds += dt
        self.hour_utc = (self.hour_utc + dt / 3600.0) % 24.0

        return {"met": met, "assimilation": assimilation_diagnostics}

    def save_state(self, path: str | Path) -> None:
        state = {
            "format_version": CHECKPOINT_FORMAT_VERSION,
            "step_count": self.step_count,
            "elapsed_seconds": self.elapsed_seconds,
            "hour_utc": self.hour_utc,
            "fields": {sp: self.grid.get_field(sp).copy() for sp in self.grid.species},
            "wind_history": list(self.wind_history),
            "k_h_history": list(self.k_h_history),
            "enable_tagged_tracers": self.enable_tagged_tracers,
            "tagged_tracer_fields": {
                tag: {sp: field.copy() for sp, field in species_fields.items()}
                for tag, species_fields in self.tagged_tracer_fields.items()
            },
        }
        with open(path, "wb") as f:
            pickle.dump(state, f)

    def load_state(self, path: str | Path) -> None:
        with open(path, "rb") as f:
            state = pickle.load(f)

        self.step_count = state["step_count"]
        self.elapsed_seconds = state["elapsed_seconds"]
        self.hour_utc = state["hour_utc"]
        for species, field in state["fields"].items():
            self.grid.set_field(species, field)

        # Old-format checkpoints (pre-history-buffer) must still load
        # cleanly: empty buffer, not a crash -- never break backward
        # compatibility.
        self.wind_history = deque(state.get("wind_history", []), maxlen=self.wind_history_maxlen)
        self.k_h_history = deque(state.get("k_h_history", []), maxlen=self.wind_history_maxlen)

        self.enable_tagged_tracers = state.get("enable_tagged_tracers", False)
        saved_tag_fields = state.get("tagged_tracer_fields", {})
        if self.enable_tagged_tracers and saved_tag_fields:
            if self.tagged_tracer_engine is None:
                self.tagged_tracer_engine = TaggedTracerEngine(self.grid, self.emission_engine)
            for tag, species_fields in saved_tag_fields.items():
                self.tagged_tracer_engine.fields.setdefault(tag, {})
                for species, field in species_fields.items():
                    self.tagged_tracer_engine.fields[tag][species] = field.copy()
        elif not self.enable_tagged_tracers:
            self.tagged_tracer_engine = None
