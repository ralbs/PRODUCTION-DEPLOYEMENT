# Reduced Eulerian CTM + Adjoint Inverse Layer + Co-Kriging — Project Constitution

Read this file in full before touching any code. It encodes a full development
history — real bugs found, fixed, and verified — for a system of this exact
kind. Every "WRONG" pattern below was actually shipped once and caught by an
executed test, not by inspection. Do not reintroduce them.

## What this project is

A real-time, edge-deployable urban air-quality model, three layers:

1. **Reduced 2D Eulerian CTM** — transport-only (no gas/aerosol chemistry),
   single vertical layer, ~500 m grid, ~60 s timestep. Forward simulator.
2. **Adjoint inverse layer** — infers emission STRENGTHS from sensor
   observations (the hard, valuable part). Distinct from forward attribution
   (which needs a known inventory) and from a plain backward trajectory
   (which is kinematics, not inversion).
3. **Co-kriging spatial interpolation** — produces an uncertainty-quantified
   concentration map from sparse sensors, using the CTM field as a physical
   trend/drift and kriging only the residual.

Non-goals, stated explicitly so they aren't quietly "improved" into scope
creep: no chemistry (secondary PM2.5/O3 formation), no vertical layers, no
regulatory-grade (CMAQ-class) claims. This is a screening/operational tool,
not a State Implementation Plan model. Say so in docs wherever attribution
or inversion output is user-facing.

## Non-negotiable engineering rules

- **Multi-city from day one.** NOTHING city-specific (domain bounds, UTC
  offset, emission inventory, sensor network, species list) may be a Python
  constant. All of it loads from a per-city JSON config (see Phase 2 /
  `cities/schema.json`). A previous version hardcoded Bangalore's
  `DOMAIN_LAT_SW = 12.834` and `IST = UTC+5.5` directly in source files —
  that is exactly the mistake to avoid this time.
- **Species are data, not dataclass fields.** A previous version had
  `pm25/pm10/co/no2/so2/bc` as six hardcoded fields on `CTMGrid`,
  `PointSource`, `AreaSource`, and `ChemicalFingerprinter.classify()`.
  Adding a 7th species meant editing five files in lockstep. Use a
  `Dict[str, np.ndarray]` keyed by species name, driven by the city config's
  species list, from the start.
- **One unit convention per species, declared once.** A previous version
  stored CO in mg/m³ and everything else in µg/m³, with an undocumented
  `×1000` scattered wherever CO was compared to other species — a live bug
  risk for anything that stacks species into one vector (e.g. multi-species
  inversion). Declare `unit` per species in the city config; convert at
  ingestion boundaries only; never assume a specific species' unit inline.
- **No shared mutable state across simulator instances.** A previous version
  had `EmissionEngine.__init__` do `list(DEFAULT_SOURCES)` — a shallow copy
  of a shared module-level list — so two cities' engines held the SAME
  mutable source objects, and editing one city's emission rate silently
  mutated another's. Always deep-copy or construct fresh per instance.
- **Determinism by default, real randomness on request.** Any stochastic
  component (adjoint particle ensembles, kriging conditional simulation if
  built) takes an explicit `seed` parameter, defaulting to a fixed value.
  Never hardcode `np.random.default_rng(seed=42)` inside a method body where
  it can't be overridden — a previous version did exactly this, silently
  making "ensemble spread" always zero (one frozen realisation).
- **NaN/inf must be rejected at every ingestion boundary**, not just checked
  with `< / >` range comparisons (NaN fails every such comparison silently,
  so naive QC accepts it). A previous version's sensor QC and met-station
  IDW both had this hole: a single NaN reading poisoned the entire
  interpolated field. Use `np.isfinite()` explicitly, first, before any
  range logic, on every external input (sensor readings, met observations).

## Reduced CTM core — exact physics requirements

### Grid (`ctm/grid.py`)
- 2D array per species, shape `(nx, ny)`, C-contiguous, float32.
- `cell_to_latlon` / `latlon_to_cell` must round-trip exactly at grid
  corners and center (test this directly, not just "doesn't crash").
- `set_field` clamps to `C >= 0` (physical constraint) on every write.

### Advection (`ctm/advection.py`)
- **Interface-flux (donor-cell upwind) formulation, not** `np.roll()`
  cell-centered divergence — `np.roll` silently creates periodic boundary
  conditions (mass wraps around the domain edge), which is wrong for an
  open urban domain.
- CFL-safe adaptive sub-stepping: `CFL = |u|dt/dx + |v|dt/dy <= CFL_MAX`
  (use 0.9), sub-step within one nominal timestep if violated. Must remain
  stable and mass-conservative even under strong wind (CFL_nominal up to
  ~2.5) — test this explicitly with a strong-wind case, not just the
  default parameters.
- Open boundaries: inflow uses a per-species background concentration
  (from city config), outflow uses zero-gradient (last interior cell value).
- **Acceptance test**: inject a Gaussian blob under uniform wind, subtract
  a parallel zero-emission background run to remove boundary inflow
  contribution, and verify (a) the plume centroid translates at *exactly*
  the wind speed and (b) mass is conserved to <0.1% over tens of steps.
  This is an analytic invariant check, not a smoke test.

### Diffusion (`ctm/diffusion.py`)
- Explicit finite-difference Laplacian, Von Neumann stability check
  (`r = K_h*dt/dx² `, `r_x+r_y <= 0.5`, raise if violated).
- **Boundary padding must use `np.pad(mode="symmetric")`, NOT
  `mode="reflect"`.** `reflect` sets the ghost cell equal to the SECOND
  interior cell (nonzero boundary flux, mass drift ~+0.9%/4h observed);
  `symmetric` sets it equal to the EDGE cell (true zero-flux Neumann,
  mass-conservative to machine precision). This exact substitution bug
  shipped once — verify with a near-boundary Gaussian blob mass-conservation
  test, not just an interior-domain test (interior-only tests can't catch
  this, since the two padding modes only differ at the edges).
- **Acceptance test**: a Gaussian blob's variance must grow as
  `sigma0^2 + 2*K_h*t` (the analytic diffusion solution), verified to <5%
  over several hours simulated time.

### Deposition (`ctm/deposition.py`)
- First-order exponential decay `C(t+dt) = C(t) * exp(-k*dt)`,
  `k = v_dep / H_mix`, never the linear `(1 - k*dt)` form (unstable for
  large `k*dt`).
- Species-specific `v_dep` from city config (defaults from Seinfeld &
  Pandis Table 19.2 / Zhang et al. 2001 are reasonable starting points, but
  must be overridable per city).
- **Acceptance test**: decay over N steps must match the closed-form
  `C0 * exp(-k*dt*N)` to <1e-4 relative error.

### Emissions (`ctm/emissions.py`)
- Point and area sources, diurnal profiles (rush-hour, industrial daytime,
  residential night, flat) — all as CITY CONFIG DATA, not hardcoded arrays.
- **Diurnal profiles are authored in LOCAL time. The injection call must
  be indexed by local hour, not UTC hour.** A previous version computed
  `hour_local` correctly but then called `inject(hour_utc=hour_utc)` —
  every profile fired ~5.5h off wall-clock. Pass local hour through
  explicitly; use the city's declared UTC offset (fractional, e.g. +5.5 for
  IST), never a hardcoded `+5` approximation.
- `EmissionEngine(grid, sources=None)` must deep-copy any default source
  list, never shallow-copy a shared module-level list (see rules above).
- **Acceptance test**: injected mass over one step must equal
  `E_rate * source_area * dt` exactly (mixing height cancels algebraically —
  verify this cancellation numerically, it's a good regression check).

### Meteorology (`met/weather_station.py`)
- IDW interpolation of sparse station wind/temp/RH to the grid.
- Pasquill-Gifford stability class from wind speed + insolation proxy (hour
  of day), mapped to `K_h` (~3–150 m²/s depending on class) and PBL/mixing
  height (day: grows with `sqrt(t since sunrise)`, capped ~2km; night:
  shallow, `50 + 30*u10`).
- **Wind FROM-direction conversion must be reversible.** The correct
  meteorological formula is `dir_from = (180 + atan2(u, v)) % 360` with
  round-trip `u = -speed*sin(dir), v = -speed*cos(dir)`. A previous version
  used `180 - atan2(u,v)`, which mirrors the east-west (u) component —
  verify round-trip exactness (`u,v -> dir -> u,v`) for several quadrants
  as an explicit test, not just "produces a wind field."
- Drop any station with a non-finite reading BEFORE IDW, not after (see
  NaN rule above). Empty/all-invalid station list falls back to a
  per-city climatology default, and this fallback must still RETURN the
  same diagnostics dict (`K_h`, `mixing_height_m`, etc.) as the normal
  path — don't let it silently return `None`.

### Assimilation (`ctm/assimilation.py`)
- Optimal Interpolation with Gaussian background-error correlation,
  localisation radius, per-sensor-type observation error (from city config).
- **Solve ALL observations for one species SIMULTANEOUSLY, not
  sequentially.** A sequential per-observation loop (each innovation
  computed against the ORIGINAL background, but updates applied
  cumulatively) double-corrects when sensors are spatially clustered — two
  co-located identical readings can push the analysis PAST the observed
  value. The correct form solves the joint `n_obs x n_obs` innovation
  covariance system once:
  `x_a = x_b + B H^T (H B H^T + R)^-1 (y - H x_b)`.
  With realistic sensor counts (dozens) this dense solve costs microseconds.
- **Acceptance test**: 2 and 4 identical co-located observations of a value
  above background must produce analyses that converge monotonically
  toward (never past) the observed value.
- Reject non-finite observations at QC, before range checks (see rule above).

### Simulator orchestration (`ctm/simulator.py`)
- Per-step order: update meteorology -> record wind+K_h history -> inject
  emissions (local-hour indexed) -> advect -> diffuse -> deposit -> tagged
  tracers (if enabled, BEFORE assimilation, see below) -> assimilate ->
  update counters. This is first-order (Godunov) operator splitting — if
  you document it, don't call it "Strang splitting" (that specifically
  means half/full/half sub-stepping, which this isn't).
- Maintain a rolling wind-history buffer (deque, `maxlen` from a configured
  lookback in hours) for the adjoint layer, AND a parallel `K_h` history
  buffer aligned 1:1 with it (stability-synced diffusivity — a stable
  nighttime trace must not be dispersed with a daytime K_h default; this
  was a real, non-obvious bug: the adjoint's random walk was pinned at a
  hardcoded 20 m²/s regardless of what the forward model was actually using
  that step).
- **`save_state`/`load_state` must checkpoint the wind history AND K_h
  history AND any tagged-tracer fields, not just the concentration
  snapshot.** A previous version's checkpoint silently dropped the wind
  buffer — every restart/rebalance lost 24h of adjoint capability with no
  error raised. Verify a full round-trip: post-restore adjoint traces must
  be bit-identical to pre-checkpoint traces (this only holds if history is
  actually restored). Old checkpoints without history keys must still load
  cleanly (empty buffer, not a crash) — don't break backward compatibility.

## Adjoint inverse layer — the centerpiece

This is three DIFFERENT things that must not be conflated. Build all three,
name them distinctly, and be explicit in every docstring about which one a
method is:

1. **Backward dispersion tracer** (`attribution/adjoint.py`,
   `AdjointTracer.trace()`): stochastic backward Lagrangian particle
   ensemble through stored wind + diffusion (HYSPLIT/FLEXPART family).
   Answers "which upstream cells influenced this receptor." NOT source
   inversion by itself.
   - Correct backward-decay weighting: `weight *= exp(-k_dep * dt)` each
     backward step (an emission further in the past is MORE depleted before
     reaching the receptor, so contributes LESS). The wrong sign,
     `exp(+k_dep*dt)`, was shipped once — it overweights old sources
     (observed: a 24h-old SO2 source overweighted ~32x). Verify sign with
     a direct analytic check: `exp(-k*tau)` for a known `k`, `tau`.
   - **Open boundaries: terminate particles that exit the domain and book
     their remaining weight to an explicit "boundary/background" category**
     — never clip (pins weight on the edge cell, creates a spurious
     boundary pileup) and never reflect (unphysical for pollution that
     genuinely exits/enters an open urban domain). Verify: edge-band
     footprint mass should be small under steady wind with a receptor well
     inside the domain, and `interior_probability.sum() +
     boundary_inflow_fraction == 1`.
   - K_h used in the random walk must come from the SAME per-step history
     the forward model actually used that step (see simulator rule above),
     not a hardcoded constant.
   - Ensemble uncertainty: seed must be a parameter; provide an explicit
     `trace_ensemble()` (or equivalent) that varies the seed across members
     and reports real spread — a fixed-seed "ensemble" has zero spread by
     construction and is not an uncertainty estimate.

2. **Forward tagged-tracer attribution** (given a KNOWN inventory): one
   extra transported field per source category, injected only from that
   category, advected/diffused/deposited with the IDENTICAL solver
   instances as the main model (never a separate reimplementation of the
   transport math — that's a guaranteed future divergence bug). Sum of all
   tags must equal the live field (verify to ~1e-6 relative, since the
   model is linear and this should hold near-exactly). Include an explicit
   "background" tag (carries boundary inflow) and an "unexplained" residual
   (catches assimilation increments and any inventory gaps — run tagged
   tracers BEFORE assimilation in the step order specifically so
   assimilation's mass injection lands in "unexplained," not smeared across
   categories).

3. **True inverse source estimation** (`attribution/inverse.py`,
   `SourceInversion`): observations -> emission STRENGTHS. This is the part
   that doesn't exist unless you build it — a backward trajectory or a
   forward tagged-tracer accounting are NOT this, however similar the
   vocabulary sounds.
   - **Aggregate unknowns into a small number of zones or categories.**
     Per-grid-cell inversion (thousands of unknowns against a dozen
     sensors) is hopeless and don't attempt it. A dozen zones/categories
     against many stacked observations (multiple times x multiple sensors)
     is well-posed.
   - **Assemble the sensitivity matrix H from FORWARD unit-response
     simulations using the exact same `AdvectionSolver`/`DiffusionSolver`/
     `DepositionSolver` instances as the live model** — run each zone in
     isolation at unit emission intensity, zero ambient background (so the
     zone's own signal is isolated and the linear map is exact), and read
     off the resulting concentration at each observation's (cell, time).
     Do NOT try to reinterpret the backward tracer's dwell-time weights
     into an absolute physical sensitivity coefficient via a memory-derived
     atmospheric-science scaling formula — that introduces unverifiable
     assumptions. The forward-unit-response approach makes `C = H @ E`
     exact to float32 and directly testable.
   - Solve as a Bayesian linear / Tikhonov estimator:
     `Sigma_post = (H^T Sy^-1 H + Sx^-1)^-1`,
     `x_hat = x_prior + Sigma_post @ H^T @ Sy^-1 @ (y - H @ x_prior)`,
     with `Sy = diag(sigma_obs^2)` (reuse the same per-observation sigma
     convention as assimilation's `Observation`) and `Sx` a prior
     covariance (default: weak/uninformative, so the estimate is
     data-dominated unless a real prior is supplied). Return the full
     posterior covariance, marginal std per zone, fit residuals, and a
     `chi2_per_obs` calibration diagnostic (should be near 1 if `sigma`/prior
     are well-calibrated).
   - Observations are supplied as ENHANCEMENT above a caller-estimated
     baseline (background + regional contribution) — this module does not
     guess a baseline itself, matching the same externalisation principle
     used for enhancement-based source fingerprinting.
   - **Known identifiability trap, worth building a regression test for**:
     a single end-of-window snapshot observation, once the wind has
     transited the FULL domain within the observation window, mixes all
     zones' signals at every downwind receptor and makes the zone columns
     of H nearly collinear (unidentifiable from one time slice). The fix
     is standard in atmospheric inversion: stack observations across TIME
     as well as space (multiple sample times per receptor). Build the
     acceptance test to demonstrate this explicitly — generate a case with
     domain-transit-time shorter than the observation window, show a
     single-snapshot inversion fails to identify sources, then show
     multi-time stacking recovers them within posterior uncertainty. This
     is a genuinely instructive test, not just a pass/fail check.
   - **Species scope is advisory, not a hard block.** The linear algebra
     runs for any species the CTM tracks (loss is just first-order decay in
     this model). What differs is whether interpreting `x_hat` as a real
     primary-emission rate is SCIENTIFICALLY sound: species with fast
     non-transport chemistry this model doesn't represent (e.g. real NO2's
     minute-timescale NO<->NO2 photostationary cycling; SO2's atmospheric
     oxidation) will have their "emission rate" entangled with processes
     the model can't separate. Provide a `species_advisory()` using the
     SAME deposition/half-life numbers as the forward model (one source of
     truth) that reports a transit-time-based quasi-conservation flag and a
     plain-language caveat — but let the solve proceed if the caller wants
     a screening-grade estimate anyway.
   - Recovery must be validated end-to-end, not just unit-tested piece by
     piece: known ground-truth emission rates -> run through the REAL
     simulator (independent of the inversion module's own code) ->
     synthetic noisy observations -> independently constructed zones ->
     fresh `SourceInversion` instance -> solve -> check recovered rates for
     STATISTICAL COVERAGE against the method's own reported posterior
     uncertainty (e.g. within ~3 posterior std of truth), not an arbitrary
     flat percentage threshold (which unfairly penalises small true values
     or zones with genuinely higher correlation/uncertainty).
   - Forward/backward synergy worth building: use a cheap backward
     `trace()` footprint to drop zones with negligible backward sensitivity
     BEFORE paying for the expensive per-zone forward unit-response runs in
     H assembly — pure compute optimisation, doesn't change the physics of
     zones that remain, verify it keeps the true source region.

## Co-kriging spatial interpolation

> **STATUS: QUARANTINED, out of scope for the current sprint.** The
> implementation lives in `interpolation/_experimental/kriging.py` (moved
> out of the main `interpolation/` package, tests skipped) pending an
> LMC-based (linear model of coregionalization) redesign of the co-kriging
> cross-variogram fit. The hard adversarial audit found that an
> unconstrained least-squares fit of the cross-semivariogram — with the
> realistically small number of co-located secondary-species stations —
> can produce a cross-covariance that violates the Cauchy-Schwarz bound
> `|C_XY(h)| <= sqrt(C_XX(h)*C_YY(h))`, which isn't just numerically ugly:
> it means the fitted model doesn't correspond to any valid joint
> covariance structure, so the co-kriging system it feeds is unsound by
> construction, not just imprecise. The current code clamps the fit to
> respect that bound (see the module's Cauchy-Schwarz regression test),
> which stops the worst failures but is a patch, not a fix — a proper LMC
> fit (jointly estimating a shared spatial structure across both
> variables, e.g. via a positive-semidefinite coregionalization matrix)
> is the real fix and hasn't been built yet. Ordinary kriging (single-
> variable, `ordinary_kriging()`) has no such issue and is NOT part of
> this quarantine — only the multivariate co-kriging path is deferred.
> Nothing outside `interpolation/` imports this module (verified by grep
> in commit history) — it never shipped as a dependency of the rest of
> the system, so quarantining it is a pure subtraction, not a break.

This is a DIFFERENT layer from OI assimilation, serving a different purpose
— don't merge or confuse them:

- **OI (`ctm/assimilation.py`)**: fast, in-the-loop nudge of the forecast
  state every timestep, using a simplified/fixed covariance model. Cheap,
  runs every cycle, keeps the CTM's own forecast on track.
- **Co-kriging (`interpolation/kriging.py`)**: heavier, statistically
  rigorous batch analysis producing an uncertainty-quantified concentration
  MAP, typically run less frequently (e.g. hourly) as the "published"
  output. Fits its own spatial correlation model from recent data rather
  than using a fixed one.

Design (regression kriging / kriging-with-external-drift, standard practice
in air-quality mapping — e.g. Hooyberghs et al., Denby et al.):

1. **Residual computation**: at each station, `r(s) = obs(s) - CTM(s)` —
   the CTM field supplies the large-scale physical trend (driven by real
   emissions and transport), so the residual should be a much smoother,
   closer-to-stationary random field than raw concentration. This is why
   kriging the residual (not raw concentration) is the right design, not
   an incidental choice — document why.
2. **Empirical semivariogram**: `gamma(h) = 0.5 * mean[(r(s_i)-r(s_j))^2]`
   over station pairs binned by separation distance `h`.
3. **Variogram model fit**: fit nugget/sill/range for at least the
   exponential model (`gamma(h) = nugget + sill*(1 - exp(-h/range))`);
   support spherical and Gaussian forms too if time allows. Fit via
   least squares against the empirical variogram.
4. **Ordinary kriging of the residual field**: solve the kriging linear
   system (covariance matrix from the fitted model, plus a Lagrange
   multiplier row/column enforcing weights sum to 1 for unbiasedness) at
   every grid cell (or at a coarser interpolation grid if performance
   requires), producing both the kriged residual AND the kriging variance
   (the uncertainty map — should be near-zero at stations, growing with
   distance from the nearest station, capped near the sill far from all
   data).
5. **Co-kriging proper**: for a sparse secondary species Y with a densely
   observed correlated primary species X (e.g. many PM2.5 sensors, few PM10
   or BC sensors), use the cross-semivariogram between `r_X` and `r_Y`
   (needs co-located or nearby paired observations) to improve `Y`'s
   estimate using both `Y`'s own sparse observations and `X`'s dense ones.
   This means a bigger block kriging system (auto- and cross-covariances,
   unbiasedness constraints for both variables) — implement it as the
   actual multivariate co-kriging system, not just "run kriging twice and
   average."
6. **Final map**: `estimate(cell) = CTM(cell) + kriged_residual(cell)`.
   Report the uncertainty field alongside — never publish a concentration
   map without its variance/uncertainty companion.
7. **Cross-validation**: implement leave-one-out CV over stations
   (`leave_one_out_cv()`), report RMSE/MAE, and use it to justify variogram
   model choice (nugget/sill/range, which of exponential/spherical/
   Gaussian) rather than picking parameters by eye.
8. Same unit-per-species and NaN-rejection rules as everywhere else apply.
   Anisotropy (pollution fields are elongated along the mean wind
   direction) is worth a stretch-goal: a wind-aligned coordinate transform
   before computing separation distances, but don't block v1 on it —
   isotropic kriging is a legitimate, documented simplification if flagged
   as such.

## City-configurable inventory system

Every city-specific number lives in `cities/<name>.json`, validated against
`cities/schema.json`. At minimum: domain (SW corner lat/lon, nx, ny, dx, dy),
UTC offset (fractional hours), species list with per-species unit/deposition
velocity/background concentration/obs-error-by-sensor-type, emission sources
(point/area, per-species rates, diurnal profile reference), diurnal profile
definitions (24 local-hour values, or references to a shared library),
sensor network (station id, lat/lon, type, species measured). Provide at
least TWO example configs (e.g. Bangalore matching prior defaults, plus one
more city) specifically to prove the abstraction actually works and nothing
is still hardcoded — if the second city's config can't run the full
pipeline unmodified, the abstraction has failed and must be fixed before
moving on.

## Testing philosophy — apply to every phase

- Every physics module needs an ANALYTIC INVARIANT test (translation speed,
  variance growth rate, exponential decay match, mass conservation), not
  just "the code runs without raising." "Runs" and "is correct" are
  different claims — this project has shipped confident-sounding bugs that
  passed casual inspection and only failed under an executed, quantitative
  check.
- Every fix or new capability gets an end-to-end test that PROVES the
  specific claim (e.g. inversion recovery, checkpoint round-trip identity,
  boundary-fix footprint no longer piling on the edge) — not just a unit
  test of the surrounding scaffolding.
- Before claiming ANY task done: run the full test suite, paste the actual
  output, and only report pass/fail counts that were just executed. Never
  state a test result without having run it in that turn.
- When a test fails, diagnose whether it's a code bug or a bad test
  assumption (e.g. an identifiability limit, an unfair tolerance) before
  changing anything — and when it's the latter, fix the test to use a
  statistically/physically appropriate criterion, don't just loosen a
  threshold until it passes.
