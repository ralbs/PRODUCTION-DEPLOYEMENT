"""ml/features.py — feature extraction for downstream ML models.

`MLFeatureExtractor` turns a live `ctm.simulator.Simulator` into CNN-ready
`(C, H, W)` tensors (`feature_tensor()`) and per-cell tabular vectors
(`cell_features(i, j)`), guaranteed float32/finite/C-contiguous. Channel
identity is entirely driven by the Simulator's `CityConfig` (species list,
whether tagged tracers are enabled) -- never a hardcoded species/channel
list (see CLAUDE.md, "Multi-city from day one" and "Species are data").

Normalization uses FIXED reference scales, resolved once at construction
from the city config (`SpeciesConfig.clim_max` when declared, a background-
concentration-derived fallback otherwise) plus fixed physical constants for
meteorology channels -- NEVER per-batch statistics. Per-batch normalization
would make a trained model's inputs depend on whatever happened to be in
that batch, breaking train/serve consistency the moment the batch
composition changes.

`cell_features(i, j)` is deliberately implemented by indexing the exact
same tensor `feature_tensor()` builds and returns -- one code path, so the
two access patterns can never drift apart (a real risk if they were
separately implemented and one code path were updated without the other).

Non-finite values (NaN/inf) are sanitized to 0.0 in the OUTPUT tensor as a
last line of defence -- `ctm.grid.CTMGrid.set_field`'s `C >= 0` clamp does
NOT remove NaN (`np.clip` leaves NaN as NaN), so a poisoned upstream field
is still possible in principle; a model must never silently ingest NaN.

`SequenceRecorder` is a ring buffer of `feature_tensor()` snapshots,
producing `(T, C, H, W)` sequences for temporal models once enough steps
have been recorded; it raises cleanly (not a bad shape) if asked for a
sequence before that.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from ctm.simulator import Simulator

_WIND_SCALE_M_S = 20.0  # fixed reference: a generous urban wind-speed ceiling
_K_H_SCALE_M2_S = 150.0  # fixed reference: CLAUDE.md's K_h upper bound (unstable daytime class)


class MLFeatureExtractor:
    def __init__(self, simulator: Simulator, include_met: bool = True):
        self.simulator = simulator
        self.include_met = include_met
        self.nx = simulator.grid.nx
        self.ny = simulator.grid.ny
        self._species = list(simulator.grid.species)  # order fixed at construction, from CityConfig

        self._scales: dict[str, float] = {}
        for sp in self._species:
            sp_cfg = simulator.city.species[sp]
            scale = float(sp_cfg.clim_max) if sp_cfg.clim_max is not None else max(5.0 * sp_cfg.background_conc, 1.0)
            if not (scale > 0):
                # cities/schema.json places NO constraint on clim_max (it's
                # only documented as a "gross-outlier QC ceiling"), so a
                # config with clim_max<=0 passes validation and reaches
                # here unguarded. A zero scale divides every reading by
                # zero (inf, then clamped by nan_to_num to a fixed but
                # utterly meaningless 1e6 in every cell); a negative scale
                # silently sign-flips the whole channel to a finite-looking
                # but wrong value with no warning at all -- worse than a
                # crash, since it passes any "is finite" sanity check.
                raise ValueError(
                    f"species {sp!r} has a non-positive normalization scale "
                    f"({scale}), from clim_max={sp_cfg.clim_max!r} or the "
                    f"5x-background fallback -- both must be > 0 for a "
                    f"reference-scale normalization to be meaningful."
                )
            self._scales[sp] = scale

        self._channel_names: list[str] = [f"conc_{sp}" for sp in self._species]
        if self.include_met:
            self._channel_names += ["wind_u", "wind_v", "k_h"]
        if simulator.enable_tagged_tracers:
            for tag in simulator.tagged_tracer_engine.tags:
                self._channel_names += [f"tag_{tag}_{sp}" for sp in self._species]

        if not self._channel_names:
            raise ValueError(
                "MLFeatureExtractor has zero channels to extract -- the "
                "city has no species, include_met=False, and tagged "
                "tracers are disabled. There is nothing for feature_tensor() "
                "to build (np.stack() would fail on an empty list)."
            )

    @property
    def channel_names(self) -> list[str]:
        return list(self._channel_names)

    @property
    def n_channels(self) -> int:
        return len(self._channel_names)

    def feature_tensor(self) -> np.ndarray:
        """(C, H, W) float32, C-contiguous, guaranteed finite. Each channel
        is its raw field divided by a FIXED reference scale (see module
        docstring) -- not standardized against this call's own min/max/
        mean, which would break train/serve consistency."""
        grid = self.simulator.grid
        planes = []

        for sp in self._species:
            planes.append(grid.get_field(sp).astype(np.float32) / self._scales[sp])

        if self.include_met:
            if self.simulator.wind_history:
                latest_wind = self.simulator.wind_history[-1]
                u, v = latest_wind["u"], latest_wind["v"]
                k_h = self.simulator.k_h_history[-1]
            else:
                u = v = np.zeros((self.nx, self.ny), dtype=np.float32)
                k_h = 0.0
            planes.append(np.asarray(u, dtype=np.float32) / _WIND_SCALE_M_S)
            planes.append(np.asarray(v, dtype=np.float32) / _WIND_SCALE_M_S)
            planes.append(np.full((self.nx, self.ny), k_h / _K_H_SCALE_M2_S, dtype=np.float32))

        if self.simulator.enable_tagged_tracers:
            tag_fields = self.simulator.tagged_tracer_fields
            for tag in self.simulator.tagged_tracer_engine.tags:
                for sp in self._species:
                    planes.append(tag_fields[tag][sp].astype(np.float32) / self._scales[sp])

        tensor = np.stack(planes, axis=0)
        tensor = np.nan_to_num(tensor, nan=0.0, posinf=1e6, neginf=-1e6).astype(np.float32)
        return np.ascontiguousarray(tensor)

    def cell_features(self, i: int, j: int) -> np.ndarray:
        """Per-cell tabular feature vector, shape (C,). Indexes the exact
        tensor `feature_tensor()` builds -- same code path, so this can
        never drift from the CNN view (see module docstring)."""
        if not (0 <= i < self.nx and 0 <= j < self.ny):
            raise IndexError(f"cell ({i}, {j}) out of bounds for grid shape ({self.nx}, {self.ny})")
        return self.feature_tensor()[:, i, j].copy()


class SequenceRecorder:
    """Ring buffer of `MLFeatureExtractor.feature_tensor()` snapshots,
    producing `(T, C, H, W)` sequences for temporal models once `seq_len`
    steps have been recorded."""

    def __init__(self, extractor: MLFeatureExtractor, seq_len: int):
        if seq_len < 1:
            raise ValueError("seq_len must be >= 1")
        self.extractor = extractor
        self.seq_len = seq_len
        self._buffer: deque = deque(maxlen=seq_len)

    def record(self) -> None:
        self._buffer.append(self.extractor.feature_tensor())

    @property
    def n_recorded(self) -> int:
        return len(self._buffer)

    def is_ready(self) -> bool:
        return len(self._buffer) == self.seq_len

    def sequence(self) -> np.ndarray:
        """(T, C, H, W) float32. Raises cleanly if fewer than `seq_len`
        steps have been recorded -- never returns a short/misshapen array."""
        if not self.is_ready():
            raise ValueError(
                f"SequenceRecorder has {self.n_recorded}/{self.seq_len} steps recorded; "
                "not enough history for a full sequence yet"
            )
        return np.ascontiguousarray(np.stack(list(self._buffer), axis=0).astype(np.float32))
