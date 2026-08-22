# Prompt Flow for Claude Code CLI

How to use this: `cd` into this repo (it already has `CLAUDE.md`, which
Claude Code reads automatically), run `claude`, and paste each phase's
prompt in order. **Do not start phase N+1 until phase N's acceptance
criteria are shown passing in actual terminal output.** If a phase's tests
fail, paste the failure back and ask Claude Code to fix it before
proceeding — don't move on with red tests.

Each prompt is self-contained but assumes `CLAUDE.md` is already in context
(Claude Code loads it automatically per-session; if you're in a very long
session, remind it with "re-read CLAUDE.md" if behavior drifts).

---

## Phase 0 — Repo scaffold

```
Initialize this as a git repo. Create the directory structure:
  ctm/            (grid, advection, diffusion, deposition, emissions,
                   assimilation, simulator)
  met/            (weather_station)
  attribution/    (adjoint, tagged_tracers, inverse, fingerprint)
  interpolation/  (kriging)
  cities/         (per-city JSON configs + schema)
  ml/             (features)
  tests/          (mirror the package structure: tests/ctm/, tests/attribution/, etc.)
  scripts/        (run_all_tests.sh, hindcast harness stub)

Set up:
- pyproject.toml with numpy, scipy (needed for kriging linear solves and
  variogram fitting), pytest, jsonschema (for city config validation)
- requirements.txt
- README.md stub pointing to CLAUDE.md for architecture and PROMPT_FLOW.md
  for the build sequence
- .gitignore (standard Python + __pycache__ + .venv)
- Empty __init__.py in every package directory
- scripts/run_all_tests.sh that runs `pytest tests/ -v` and prints a
  summary; make it executable

Commit as "Initial scaffold". Show me the directory tree and confirm
`pytest tests/` runs (even with zero tests, it should not error).
```

**Acceptance**: `git log` shows the commit, `bash scripts/run_all_tests.sh`
runs cleanly with 0 tests collected (no import errors).

---

## Phase 1 — City config system

```
Implement the city-configurable inventory system described in CLAUDE.md's
"City-configurable inventory system" section, BEFORE writing any physics —
everything built after this must be driven by these configs, not by
hardcoded constants.

Build:
- cities/schema.json — JSON Schema covering: domain (lat_sw, lon_sw, nx, ny,
  dx, dy), utc_offset_hours (float), species (dict: name -> {unit,
  v_dep_m_s, background_conc, deposition_notes}), diurnal_profiles (dict:
  name -> 24 local-hour fractional-of-mean values), emission_sources (list
  of {name, kind: point|area, lat/lon or lat/lon box, rates per species,
  profile reference}), sensors (list of {id, lat, lon, type, species,
  obs_error_sigma per species}).
- cities/bangalore.json — populate with the Bangalore defaults from
  CLAUDE.md's context (27km x 27km domain, 500m cells, UTC+5.5, six species
  pm25/pm10/co/no2/so2/bc with CO in mg/m3 and the rest in ug/m3, deposition
  velocities from Seinfeld & Pandis Table 19.2 as starting points, the
  traffic/industrial/residential diurnal profile shapes described in
  CLAUDE.md).
- cities/template.json — a second, DIFFERENT example city (different
  domain size, different UTC offset, at least one different species subset)
  specifically to prove the schema isn't secretly Bangalore-specific.
- A Python loader `cities/loader.py`: `load_city(name_or_path) -> CityConfig`
  (a dataclass or pydantic model), validating against schema.json and
  raising a clear error on any missing/invalid field.

Write tests/cities/test_loader.py: both example configs load without error,
loading an intentionally-broken config (missing a required field) raises a
clear validation error, and confirm nothing in the loader assumes Bangalore
specifically (e.g. no hardcoded lat/lon bounds check).

Run the tests and show me the output.
```

**Acceptance**: both city configs load, the broken-config test raises
cleanly, `pytest tests/cities/ -v` green.

---

## Phase 2 — Core grid + advection + diffusion + deposition

```
Build ctm/grid.py, ctm/advection.py, ctm/diffusion.py, ctm/deposition.py
per CLAUDE.md's "Reduced CTM core" section EXACTLY — pay special attention
to the specific bugs called out there (np.roll vs interface flux for
advection; np.pad mode='symmetric' vs 'reflect' for diffusion boundaries;
exp(-k*dt) not (1-k*dt) for deposition). All four modules take their
species list, deposition velocities, and background concentrations from a
CityConfig (Phase 1), never hardcoded.

For each module, write the EXACT analytic-invariant test CLAUDE.md
specifies:
- advection: Gaussian blob centroid translates at exactly the wind speed
  (bg-corrected), mass conserved <0.1%, AND a strong-wind (CFL~2.5)
  stability test.
- diffusion: variance grows as sigma0^2 + 2*K_h*t within 5%, mass
  conserved to machine precision, AND a near-boundary blob test specifically
  designed to catch the reflect-vs-symmetric padding bug (an interior-only
  test cannot catch this — the test must place the blob near an edge).
- deposition: matches the closed-form exponential to 1e-4 relative error.

Also write a Von Neumann stability-violation test for diffusion (should
raise) and an inflow-boundary test for advection (domain should fill toward
the configured background concentration under sustained inflow).

Run all tests, show output, and report actual measured error percentages
in your summary (not just pass/fail) so I can see the invariants were
actually checked quantitatively.
```

**Acceptance**: every quantitative claim above verified with a printed
number (e.g. "mass conservation error: 0.0000012%"), not just a checkmark.

---

## Phase 3 — Emissions + meteorology

```
Build ctm/emissions.py and met/weather_station.py per CLAUDE.md, driven by
CityConfig (Phase 1) for sources, diurnal profiles, and the UTC offset.

Critical: implement the LOCAL-hour diurnal indexing correctly from the
start (CLAUDE.md explains the exact historical bug — hour_local computed
but hour_utc passed to inject() — do not repeat it). Use the city's
utc_offset_hours (fractional) rather than any hardcoded approximation.

Implement the wind FROM-direction conversion with the exact formula in
CLAUDE.md and write the round-trip test (u,v -> dir -> u,v, several
quadrants) explicitly — this is the test that would have caught the mirrored
east-west bug that shipped previously.

Implement NaN-station rejection in the met IDW path BEFORE interpolation
(not after), with a fallback to city climatology defaults when no valid
stations remain, and make sure that fallback still returns the full
diagnostics dict (K_h, mixing_height_m, etc.) — write a test that a single
NaN station doesn't poison the resulting wind field, and a test that the
all-invalid-stations fallback path returns a usable dict, not None.

Write the mass-injection analytic test from CLAUDE.md (injected mass ==
E_rate * area * dt exactly).

Run tests, show output.
```

**Acceptance**: round-trip wind-direction test passes for multiple
quadrants, NaN-poisoning test explicitly shows a poisoned field would have
failed before the fix and passes after, diurnal timing test shows a source
firing at the CORRECT local hour (pick a specific example and print it,
e.g. "daytime profile at 05:00 UTC = 10:30 local: injected X > 0; at 20:00
UTC = 01:30 local: injected == 0").

---

## Phase 4 — Assimilation

```
Build ctm/assimilation.py per CLAUDE.md — the SIMULTANEOUS multi-observation
OI solve, not sequential. Sensor types and obs-error sigma come from
CityConfig. Reject non-finite observations at QC before range checks.

Write the exact regression test CLAUDE.md specifies: 2 and then 4 identical
co-located observations above background must produce analyses that
converge monotonically toward (never overshoot past) the observed value —
and as a documented comparison, compute what a naive SEQUENTIAL
implementation would have given for the same case (CLAUDE.md notes this
overshoots past the observation) so the test file itself documents why
simultaneous solving matters, not just that it "passes."

Also test: correction magnitude decays with distance from the observation,
an out-of-domain observation is safely ignored, and a NaN observation is
rejected without corrupting the analysis.

Run tests, show output including the printed comparison numbers (sequential
vs simultaneous result for the clustered-observation case).
```

**Acceptance**: printed numbers showing simultaneous OI staying at or below
the observed value while the documented sequential-equivalent calculation
would have exceeded it.

---

## Phase 5 — Simulator orchestration + checkpointing

```
Build ctm/simulator.py per CLAUDE.md: the step order specified (meteorology
-> wind/K_h history recording -> emissions with LOCAL hour -> advect ->
diffuse -> deposit -> tagged tracers if enabled, BEFORE assimilation ->
assimilate), the rolling wind-history AND K_h-history buffers (aligned,
same maxlen, configurable lookback hours from CityConfig), and full
save_state/load_state checkpointing that includes BOTH history buffers plus
any tagged-tracer fields — not just the concentration snapshot.

Write the exact checkpoint-identity test from CLAUDE.md: run N steps, save,
load into a fresh simulator, and verify (a) every concentration field is
byte-identical, (b) wind and K_h history buffer LENGTHS match, and (c) a
downstream computation (you can stub this with a simple deterministic
function over the wind history for now — full adjoint verification comes in
Phase 6) gives identical output pre- and post-checkpoint.

Also test that an OLD-FORMAT checkpoint (write one without the history
keys, simulating a file from before this feature existed) still loads
without crashing — empty buffer, not an exception.

Run tests, show output.
```

**Acceptance**: checkpoint round-trip test passes with explicit
byte-identity confirmation printed, old-format-checkpoint compatibility
test passes.

---

## Phase 6 — Backward dispersion tracer + tagged-tracer attribution

```
Build attribution/adjoint.py (AdjointTracer, the backward Lagrangian
dispersion tracer) and attribution/tagged_tracers.py (TaggedTracerEngine,
forward per-category attribution) per CLAUDE.md's "Adjoint inverse layer"
section, items 1 and 2 specifically. Be precise in docstrings that these
are NOT source inversion — that's Phase 7.

For AdjointTracer:
- Correct backward-decay sign (exp(-k_dep*dt)), verified against the
  analytic exp(-k*tau) directly, not just "the code runs."
- Open-boundary termination with an explicit boundary/background category
  (never clip or reflect) — verify with the steady-wind test CLAUDE.md
  describes: source well inside the domain, receptor downwind, confirm the
  edge-band footprint share is small and interior_probability.sum() +
  boundary_inflow_fraction == 1 to high precision.
- K_h pulled from the simulator's per-step history (Phase 5's buffer), not
  a hardcoded constant — verify a stable-night trace (low K_h) produces a
  measurably narrower crosswind footprint than an unstable-daytime trace
  (high K_h) using the SAME wind sequence, different K_h histories.
- Configurable seed, plus a trace_ensemble() that varies seed across
  members and reports nonzero spread — verify the spread is actually
  nonzero (a fixed-seed "ensemble" bug would silently pass a shape-only
  test but fail this).

For TaggedTracerEngine:
- Reuse the simulator's EXACT solver instances for transport — no
  reimplemented advection/diffusion/deposition math.
- Verify sum of all tags (incl. background) equals the live concentration
  field to ~1e-6 relative error.
- Verify a synthetic assimilation increment lands predominantly in an
  'unexplained' residual, not smeared across categories (this only holds
  if tagged-tracer step runs BEFORE assimilation in the simulator's
  order — confirm that ordering here as an integration check).

Run tests, show output with the actual measured numbers (footprint edge
share %, tag-sum relative error, ensemble spread magnitude).
```

**Acceptance**: all four AdjointTracer behaviors and both TaggedTracerEngine
behaviors verified with printed quantitative results.

---

## Phase 7 — True inverse source estimation (the centerpiece)

```
Build attribution/inverse.py (SourceInversion) per CLAUDE.md's item 3 in
the "Adjoint inverse layer" section — this is the actual deliverable of
this whole project, take the most care here.

Implement exactly as specified:
- Zone/category aggregation (never per-cell).
- assemble_H() via FORWARD unit-response simulations using the live
  simulator's exact solver instances, zero-background isolated transport
  per zone (do not reinterpret AdjointTracer's backward weights into a
  physical coefficient).
- Bayesian/Tikhonov solve exactly as specified (the formulas are in
  CLAUDE.md), returning posterior mean, full covariance, marginal std,
  residuals, chi2_per_obs.
- species_advisory() using the SAME deposition/half-life numbers as the
  forward model, non-blocking, with the specific NO2/SO2 photochemistry
  caveat language CLAUDE.md describes.
- A zones_from_footprint_priority() helper using AdjointTracer as a cheap
  pre-filter before expensive H assembly.

Then write the full END-TO-END recovery test CLAUDE.md specifies, and
DELIBERATELY build it to first demonstrate the identifiability trap before
fixing it:

1. Pick known ground-truth emission rates for 3 spatially-separated zones
   (make one of them zero, as a true-negative check).
2. Run the REAL simulator (Phase 5, independent of inverse.py's own code)
   with those rates to generate a ground-truth field.
3. Choose a simulated duration where wind transits the FULL domain within
   the run (pick wind speed and domain size so this is true — CLAUDE.md
   explains why this matters).
4. First, generate synthetic noisy observations from a SINGLE end-of-run
   snapshot at several receptors, run the inversion, and show/print that
   recovery fails or is poorly identified (large posterior std, wrong
   ranking, or a sign flip) — this demonstrates the collinearity problem
   for real, not just in a comment.
5. Then, generate observations STACKED ACROSS MULTIPLE TIMES (several
   sample steps per receptor, not just the final one) from the same
   ground-truth run, rebuild H and re-solve, and show recovery now
   succeeds: the zero-emission zone estimate near zero, the correct
   relative ranking between the two nonzero zones, and every recovered
   rate within ~3 posterior standard deviations of its true value (a
   statistical coverage check, not an arbitrary percentage threshold —
   CLAUDE.md explains why a flat percentage is the wrong criterion here).
6. Also verify: adding more (redundant) observations shrinks posterior std,
   and the o3-doesn't-exist-as-a-species case is rejected cleanly at
   construction.

This test should read like a small worked example in its own right —
print the true rates, the single-snapshot failure, and the multi-time
success, so the test file documents the identifiability lesson for anyone
reading it later.

Run it, show me the full output including the printed before/after
comparison.
```

**Acceptance**: the test output visibly shows single-snapshot inversion
failing (or clearly worse) and multi-time-stacked inversion succeeding,
with actual printed numbers (true vs. estimated vs. posterior std) for
both cases — not just a final pass/fail line.

---

## Phase 8 — Co-kriging spatial interpolation

```
Build interpolation/kriging.py per CLAUDE.md's "Co-kriging spatial
interpolation" section in full: residual computation against the CTM
field, empirical semivariogram estimation, variogram model fitting
(implement at least exponential; spherical and Gaussian if time allows),
ordinary kriging of the residual field (with kriging variance as an output,
not just the point estimate), true co-kriging for a sparse secondary
species using a densely-observed correlated primary species via the
cross-semivariogram (implement the actual block kriging system — auto- and
cross-covariances, unbiasedness constraints for both variables — not a
shortcut like averaging two separate krigings), leave_one_out_cv() for
model validation, and the final estimate = CTM + kriged_residual with its
uncertainty field.

Explain in a module docstring, per CLAUDE.md, how this differs in purpose
and update frequency from ctm/assimilation.py's OI — don't let the two
implementations converge into the same thing by accident.

Write tests:
- Synthetic recovery test: define a known smooth "true" residual field,
  sample it noisily at station locations, fit a variogram, krige, and
  verify the kriged field is close to the true field away from stations
  and matches observations closely AT stations (kriging is an exact
  interpolator at data points with zero nugget — verify this property
  directly).
- Kriging variance test: verify variance is near zero at station locations
  and grows with distance from the nearest station, capping near the fitted
  sill far from all data.
- Co-kriging test: construct two correlated synthetic fields (e.g. species
  Y = a*X + noise), give X many stations and Y few, and verify co-kriging's
  estimate of Y is measurably better (lower leave-one-out RMSE) than
  kriging Y alone with its sparse network.
- Cross-validation: leave_one_out_cv() on a real variogram fit, report
  RMSE/MAE.

Run tests, show output with the actual RMSE numbers for the "co-kriging
beats kriging-alone" comparison — that's the test that most needs a real
printed number, since it's the whole point of doing co-kriging instead of
plain kriging.
```

**Acceptance**: printed RMSE showing co-kriging outperforming single-variable
kriging on the sparse secondary species, kriging-variance test showing the
expected near-zero-at-stations / growing-with-distance pattern.

---

## Phase 9 — ML feature interface

```
Build ml/features.py: MLFeatureExtractor (CNN-ready (C,H,W) tensors and
tabular per-cell vectors from a live simulator, guaranteed float32/finite/
contiguous with stable named channels including tagged-tracer planes if
enabled) and SequenceRecorder (ring buffer producing (T,C,H,W) sequences
for temporal models). Fixed reference normalization scales (never
per-batch statistics — train/serve consistency). Species/channel list
driven by the active CityConfig, not hardcoded.

Test: NaN in the grid is sanitized in the output tensor (last-line-of-defence
guarantee), channel count matches expectation, sequence recorder raises
cleanly on insufficient history, cell_features() is provably the same code
path as feature_tensor() (no drift between the two access patterns).

Run tests, show output.
```

**Acceptance**: the NaN-sanitization guarantee test explicitly poisons the
grid and shows the extracted tensor stays finite.

---

## Phase 10 — Full integration + hindcast harness stub

```
Write scripts/hindcast_harness.py: given a city config, a time range, and a
path to historical sensor observations (accept a simple CSV format for
now — station_id, lat, lon, species, value, timestamp — document the
schema in a comment), run the simulator forward with assimilation, and at
the end report basic skill metrics (RMSE, bias, correlation) against
held-out stations. This won't have real data to run against yet — build it
so it's ready to receive real CPCB (or equivalent) data later, and write a
test using SYNTHETIC "historical" data (generate it from a forward run
with known truth, exactly like Phase 7's approach) to prove the harness
itself works end-to-end.

Then run the FULL test suite (scripts/run_all_tests.sh) and give me:
1. Total test count and pass/fail.
2. A one-paragraph summary per phase of what was verified with actual
   numbers (not just "all green") — pull these from the test output you
   already generated, don't re-derive them from memory.
3. An explicit list of what's still NOT built or validated: real-episode
   hindcast validation (needs real sensor data you don't have), the
   species-dataclass-to-dict scope (if any species-specific code still
   assumes a fixed list — audit for this specifically), and anything you
   had to simplify or defer during the build (state it plainly, don't let
   it go unmentioned).

Commit everything with a clear message.
```

**Acceptance**: full suite green, and a written, honest summary of scope
limits — this is the point where you should push back on Claude Code if the
summary sounds more confident than the actual test coverage supports.

---

## After Phase 10

Don't treat a green test suite as proof the model matches reality — it
proves internal consistency, which is a different, smaller claim. The next
real step is validating against actual observed data (a real CPCB or
equivalent episode) once you have it, which no amount of unit testing
substitutes for. Keep that caveat in the README.
