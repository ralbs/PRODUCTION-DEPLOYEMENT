# PROMPT_FLOW_INTEGRATION.md

Directional screening + single-zone emission-rate estimation, feeding the
existing plume view. This document did not exist before Phase I3 (this
phase) -- earlier references to it (root `CLAUDE.md`, prior conversation
turns) were describing intended future work, not a real committed file.
It is written now specifically so a later session has something real to
check against instead of re-discovering this scope from scratch.

Everything below describes what is ACTUALLY BUILT AND TESTED as of this
writing, not aspiration. Where something is a known limitation, it says
so explicitly rather than implying it's solved.

## Phase I1 — migration (done, separate from this feature)

Repointing the repo/infra to the user's own GitHub/Vercel/Render/Atlas
accounts, merging `ctm-core` in as a subtree with real history, migrating
device auth. Not this document's concern beyond noting it happened first.

## Phase I2 — real wind source for the live deployment (done)

See `ctm-core/met/ingest_real_met.py`'s module docstring ("STATIONS WIRED
IN SO FAR") for the full, real verification writeup. Summary: the actual
live device (`ESP32-001` / station `NEL-001`, see `firmware/config.h`,
lat=14.442 lon=79.986) is 0.9km from WMO/Meteostat station 43245
("Nellore") -- found via Meteostat's real public station index, verified
by direct download and row-level inspection of the actual bulk archive,
not by trusting index metadata. A real, complete August 2025 month is
committed at `ctm-core/data/raw/meteostat_nellore/43245_202508.csv`.

**Disclosed limitation, load-bearing for Phase I3 below**: this archive's
freshest real row is 2025-10-15 -- it is real HISTORICAL wind, not a live
feed. No live wind source exists for this deployment yet.

`ctm-core/cities/live_deployment.json` holds this deployment's city
config: real domain center (the device's real coordinates), a domain
extent/resolution reused from `bangalore.json` as an engineering default
(NOT independently verified for Nellore), and `wind_history_hours: 1` --
reduced from an initial, unverified `24` after empirically finding (via
`run_adjoint_tracer()`, see below) that this domain's ~13.5km half-width
is smaller than what Nellore's typical real wind speed (~3.7-6 m/s)
covers in a single real hour. Read that config's own `_wind_history_hours_note`
before changing it -- it is not a tunable "make it work" knob, it reflects
a genuine, disclosed domain-size-vs-wind-speed mismatch that a future
phase (a real, evidence-based domain resize) would need to actually fix.

## Phase I3 — source-direction screening worker (done, this phase)

**Goal**: when a station's latest reading is a genuine statistical spike,
run the CTM's backward adjoint tracer against real wind to produce a
screening-grade "estimated upwind direction," stored via a new
authenticated route.

### Auth pattern -- read before writing anything that touches this route

- `backend/middleware/auth.js`'s `authenticateDevice` is reused VERBATIM
  (same `require`, same middleware call) exactly as
  `backend/routes/telemetry.js`'s `POST /` uses it. No new auth code was
  written.
- Authentication is `X-Device-Id` / `X-Device-Key` checked against
  `DEVICE_KEYS`, keyed ONLY by `device_id`. The worker has its own device
  identity, e.g. `WORKER-SOURCE-DIRECTION:<key>`, added to `DEVICE_KEYS`
  alongside the real device's own entry.
- **`station_id` (e.g. `"NEL-001"`) is NEVER a valid auth credential.**
  It is a grouping/storage key on the `SourceDirection` collection only.
  This was verified directly against the real `/api/stations` response
  shape (`backend/routes/stations.js`): a bare array of
  `{station_id, device_id, last_seen, location}`, where `device_id` and
  `location` can be missing/null for a station with no telemetry yet --
  `scripts/source_direction_worker.py`'s `valid_stations()` drops any
  station missing either, specifically because the worker's own posting
  identity and the adjoint receptor coordinate both require them.

### Spike trigger -- reused, not invented

- `backend/lib/forecast.js` already had Holt-Winters double exponential
  smoothing (`holtWinters()`) inside `buildForecast()`, with a confidence
  band of `sigma * sqrt(h)`. This was NOT a naive baseline (fixed
  `alpha=0.3`/`beta=0.1` constants are a real limitation, but the method
  itself is real exponential smoothing on real stored AQI, not
  persistence/climatology).
- A new function, `checkSpike(stationId, lookbackHours)`, was added to
  the SAME file, reusing `holtWinters()` verbatim: it fits on all real
  AQI readings EXCLUDING the latest one, forecasts 1 step ahead
  (`h=1`, band = `sigma*sqrt(1)`), and compares the actual latest reading
  against that band. `is_spike` = actual outside `[predicted-sigma,
  predicted+sigma]`.
- Exposed via `GET /api/forecast/spike-check?station_id=...&lookback=...`
  (`backend/routes/forecast.js`). This is the ONLY spike trigger the
  worker uses -- no separately-invented threshold exists anywhere in this
  feature.

### What got built

- `backend/lib/forecast.js`: `checkSpike()` added; `holtWinters()` now
  exported (was previously private).
- `backend/routes/forecast.js`: `GET /spike-check` added.
- `backend/models/SourceDirection.js`: new Mongoose model. Fields:
  `timestamp`, `station_id` (grouping only), `device_id` (from auth),
  `trigger` (the spike-check result), `wind` (speed/dir/station/as_of),
  `bearing_deg`, `distance_m`, `confidence`, `boundary_inflow_fraction`,
  `n_particles`, `seed`, and `label`. `label` has a schema DEFAULT set to
  the exact string below and the route never lets a caller override it.
- `backend/routes/source-direction.js`: `POST /ingest` (authenticated,
  as above) and `GET /latest?station_id=...`. Wired into `server.js` at
  `/api/source-direction`.
- `ctm-core/scripts/source_direction_worker.py`: the worker. Polls
  `GET /api/stations`, guards for missing `device_id`/`location`, checks
  each valid station via `GET /api/forecast/spike-check`, and on a real
  spike loads the real Nellore wind window (`met/ingest_real_met.py`),
  builds `wind_history`/`k_h_history` via `met/weather_station.py`'s
  REAL `interpolate_met()`/`mixing_height_m()` (reused verbatim -- no
  reimplemented meteorology), runs `attribution/adjoint.py`'s REAL
  `AdjointTracer.trace()`, reduces the resulting `interior_probability`
  field to a probability-weighted-centroid bearing/distance, and POSTs
  the result.

### The label requirement

Every stored/returned `SourceDirection` document carries, verbatim:

> `estimated upwind direction -- screening only, not confirmed source attribution`

Enforced server-side via the Mongoose schema default (the route never
accepts a caller-supplied `label`), not just by worker convention -- a
malicious or buggy client cannot override it.

### Real, executed verification (not claimed -- see actual output at the

time this was written)

- **Node**: `npm test` in `backend/` -- 2 suites, 9 tests, all passing.
  Covers `checkSpike()` (known series -> exact predicted/band/is_spike
  values, independently verified via direct `node -e` execution before
  being baked into the test) and the route (401 on missing/wrong/
  station-id-as-device-id auth, 201 + correct stored fields + forced
  label on success, 400 on a payload missing a required field).
- **Python**: `pytest tests/scripts/test_source_direction_worker.py` --
  13 tests, all passing. Covers `valid_stations()`'s guard, the three
  HTTP-boundary functions against mocked responses shaped exactly like
  the real endpoints, `load_nellore_wind_history()` against the real
  committed CSV (exact known window length/boundaries), and an analytic-
  invariant test: a KNOWN synthetic wind direction must produce a bearing
  pointing back the way the wind came from (circular-distance tolerance
  25 degrees, not exact equality -- appropriate for a stochastic particle
  trace, the same standard `ctm-core/CLAUDE.md` requires of adjoint
  acceptance tests).
- **Real local end-to-end run** (docker-compose Mongo, real `node
  server.js`, real HTTP throughout):
  1. Real Mongo container + single-node replica set (had to fix
     `rs.initiate()`'s default config, which registers the container's
     internal hostname -- unresolvable from the host -- reconfigured to
     `localhost:27017`).
  2. 5 real `POST /api/telemetry` calls (4 flat + 1 spiking reading) for
     device `ESP32-001` / station `NEL-001`, using its real device key.
  3. `GET /api/forecast/spike-check?station_id=NEL-001` confirmed a real
     spike (`is_spike: true, actual_aqi: 167, predicted_aqi: 50,
     predicted_low: 40, predicted_high: 60`).
  4. Ran the real worker: `py scripts/source_direction_worker.py
     --base-url http://localhost:4000 --device-key test-worker-key-123
     --as-of 2025-08-01T00:00:00`. Real output:
     `action: 'ingested', status_code: 201`, tracer result
     `bearing_deg: 251.99, distance_m: 13704, confidence: 0.998,
     boundary_inflow_fraction: 0.0025`.
  5. `GET /api/source-direction/latest?station_id=NEL-001` returned the
     real stored document with the exact label string and
     `device_id: "WORKER-SOURCE-DIRECTION"` (from auth, never the body).
  6. Real negative-auth checks against the live server: no headers -> 401,
     `station_id` used as `device_id` -> 401, wrong key -> 401.

  `--as-of 2025-08-01T00:00:00` was used deliberately -- it's a real
  timestamp within the committed archive's actual coverage, and one of
  the few real hours where the resulting trace stays mostly inside the
  domain (see Phase I2's `wind_history_hours` note). A run with no
  `--as-of` (defaulting to "now") would currently find NO real wind data
  at all, since the archive doesn't cover the present -- it would
  correctly skip every spike rather than post anything. That is honest,
  disclosed behavior, not a bug, and is not yet fixed (no live wind feed
  exists).

### Known limitation of the SHIPPED feature: real saturation rate over the full committed month

This is a finding about the directional tracer described above -- already
built, tested, and merged -- not about a future phase. Swept
`run_adjoint_tracer()` (via `load_nellore_wind_history()`, the exact
function the real worker calls) across all 744 real hours in
`data/raw/meteostat_nellore/43245_202508.csv`, at the real `NEL-001`
receptor, with the actual shipped config (`wind_history_hours: 1`):

| metric | value |
|---|---|
| fully saturated (confidence == 0.0) | 642 / 744 (86.3%) |
| usable signal (confidence > 0.1) | 87 / 744 (11.7%) |
| reasonably usable (confidence > 0.5) | 75 / 744 (10.1%) |
| mean confidence | 0.10 |
| mean boundary_inflow_fraction | 0.89 |

**At this domain size and Nellore's real wind climatology, the
directional-screening feature will report "no usable estimate" on
roughly 9 of 10 real spikes. This is the DOMINANT real behavior, not an
edge case.** The single successful example in the E2E run above
(`confidence: 0.998`) was a real result, but a favorable, unrepresentative
one -- picked deliberately because it was one of the few hours that
works, not because most hours work. Do not read that E2E success as
evidence the feature works reliably; read this table as what it actually
does across a real month.

### Real scheduling, added and verified unattended (this session)

**Goal**: `source_direction_worker.py` must run automatically at a real
interval using its default LIVE-wind path (no `--as-of`), not be
something a human has to remember to invoke.

- **`render.yaml`** now declares a second, real Render service:
  `type: cron`, `name: source-direction-scheduler`, `schedule: "*/15 * * *
  *"` (every 15 min), `startCommand` invoking the worker with no
  `--as-of` (confirmed by reading the worker's own `--help` output before
  writing this -- omitting `--as-of` is exactly what selects
  `use_live_wind=True`, i.e. `met/live_wind.py`'s real Open-Meteo
  nowcast, never the static 2025-08 Meteostat archive).
- **Real bug caught and fixed before calling this done**: the cron
  service was originally written with `plan: free`. Checked against
  Render's own docs (render.com/docs/cronjobs and /docs/blueprint-spec,
  fetched directly, not recalled from memory) -- Render does NOT offer a
  free plan for cron job services (only web services and Key Value
  instances get one); `free` would have been rejected by Render's
  blueprint validator or failed at deploy time. Fixed by omitting `plan`
  (defaults to the smallest paid compute tier), with a comment disclosing
  the real, non-hypothetical minimum cost this introduces (Render's
  stated $1/month-per-cron-service floor, plus that compute plan's own
  cost) -- this is a real new line item, not swept under a "free" label.
- **BASE_URL / web-service-name mismatch: resolved, not left
  disclosed-but-unresolved.** Checked directly rather than assumed:
  `firmware/config.h`'s `SERVER_URL` hardcodes
  `https://aqhi-backend.onrender.com/api/telemetry`, and a live HTTPS
  `GET https://aqhi-backend.onrender.com/health` returned a real `200
  {"status":"ok"}` -- the exact route `backend/server.js` defines, i.e.
  this genuinely is the live Express instance real devices hit right
  now. `https://aqms-backend.onrender.com` (this repo's
  `package.json`/README name, and what both `render.yaml`'s web-service
  `name` and the cron's `BASE_URL` used to say) is a real, separate,
  currently-existing Render service too, but returns a real `503
  "Service Suspended"` -- consistent with root `CLAUDE.md`'s framing of
  an old-account deployment being kept as a live fallback during
  migration, except it's `aqhi-backend` that's actually the live one and
  `aqms-backend` that's dormant. Fixed both fields to match: the web
  service's `name` is now `aqhi-backend` (so a future Blueprint sync
  manages/targets that real service, not the suspended one -- syncing
  under the old `aqms-backend` name would have adopted/woken the wrong,
  disconnected service instead), and the cron's `BASE_URL` is hardcoded
  to `https://aqhi-backend.onrender.com` (a plain `value`, not `sync:
  false`, since a hostname isn't a secret). A later, deliberate rename to
  `aqms-backend` to finish the migration still requires reflashing every
  real device's `SERVER_URL` first, never the other way around.

**Real, executed verification of unattended scheduling** (not Render's
own infra -- no Render API/CLI credentials are available in this
environment, so this deliberately uses this machine's own real OS-level
scheduler, Windows Task Scheduler, as the "or equivalent" the task
allowed, running the exact same command render.yaml's cron service runs,
against a real local stack):

1. Real Mongo (`docker compose up -d`, reused the existing `rs0`
   replica set from prior sessions, `rs.status()` confirmed healthy
   first) + real `node server.js`, both local, real HTTP throughout.
2. Confirmed real pre-existing data was untouched: `GET /api/stations`
   returned the same `NEL-001`/`ESP32-001` station from a prior session's
   telemetry, and `GET /api/forecast/spike-check` found a real spike
   already present in that data (`actual_aqi: 400` vs `predicted_aqi:
   58`) -- no synthetic telemetry was injected for this test.
3. One real manual run first (`py scripts/source_direction_worker.py
   --base-url http://localhost:4000 --device-key
   <WORKER-SOURCE-DIRECTION key>`, no `--as-of`) as a sanity check only --
   real output `action: 'ingested', status_code: 201, wind_source_tier:
   'live_model_nowcast', estimate_tier: 'boundary_sector_fallback'`.
   This one doesn't count toward "unattended" -- it was a manual
   pre-check, disclosed as such.
4. Registered a real Windows Scheduled Task
   (`AQMS-SourceDirection-SchedulingTest`) running that exact command on
   a 3-minute repeating trigger (shortened only so 2-3 cycles fit inside
   a real session -- render.yaml's own actual interval stays 15 min, per
   the task's instruction; nothing about the worker or its arguments
   differs between the two).
   - **First attempt silently never fired.** `schtasks`'s default
     `DisallowStartIfOnBatteries` setting blocked every occurrence
     because this machine was genuinely running on battery
     (`Win32_Battery.PowerOnline: False` at the time, verified directly,
     not assumed) -- a real, disclosed cause, not a guess. Root-caused
     via `Get-ScheduledTask`/`Get-ScheduledTaskInfo` showing
     `LastRunTime` still unset ~10 real minutes after the first scheduled
     occurrence should have run.
   - Fixed by recreating the task via
     `New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries
     -DontStopIfGoingOnBatteries`. This is a local-machine-only fix --
     Render's own cron infrastructure has no battery, so this specific
     failure mode does not apply to the real production service, but is
     recorded here since it's exactly the kind of "add scheduling, it
     silently never runs" failure the task asked to guard against.
5. **Real, unattended verification, nobody manually triggering the
   worker**: 3 automatic runs at `22:57:11`, `23:00:12`, `23:03:12` (real
   wall-clock timestamps, ~3 min apart as scheduled), each logging
   `action: 'ingested', status_code: 201` and each independently fetching
   real live wind (`wind_source_tier: 'live_model_nowcast'`) and POSTing
   to the real authenticated route. Real stored-document count in Mongo
   went from 5 (pre-existing, from prior sessions) to 8 -- exactly 3 new
   documents, one per automatic run, `estimate_tier: 'interior'` each
   time (`bearing_deg: 119.81, distance_m: 9116.5, confidence: 1.0`) --
   confirmed by querying `db.sourcedirections` directly in `mongosh`, not
   through the API, and cross-checked against the scheduler's own log
   timestamps.
6. Cleanup after verification, nothing left running: the test scheduled
   task was deleted (`Unregister-ScheduledTask`), the local `node`
   process was stopped, and `docker compose down` (real Mongo data
   volume `backend_aqms_mongo_data` deliberately NOT deleted -- `down`
   without `-v` -- so the pre-existing real historical data survives this
   session, confirmed present via `docker volume ls` afterward).

**Caveat, stated as plainly as elsewhere in this doc**: this verifies the
worker fires unattended and posts real results on a real recurring OS
scheduler talking to a real local backend -- it does NOT verify Render's
own cron infrastructure specifically, since no Render account
credentials exist in this environment. Before trusting this in
production, whoever has Render dashboard access needs to: push this
`render.yaml` (`BASE_URL` is now hardcoded to the confirmed-live
`https://aqhi-backend.onrender.com`, nothing to set there), set
`WORKER_SOURCE_DIRECTION_KEY` (matching an entry already in the web
service's own `DEVICE_KEYS`) as a real env var on the new cron service,
confirm the Blueprint sync actually adopts the existing `aqhi-backend`
web service rather than creating a new one (should follow from `name`
matching, but verify in the dashboard, not assumed), and confirm at
least one real Render-triggered run of the cron service in the Render
dashboard's own logs.

## Phase I4 — BUILT, TESTED, real end-to-end verified

### Forward-response check, done ahead of starting this phase (real evidence, not a plan)

Before scoping any Q-estimation work, checked whether the FORWARD
unit-response approach (`attribution/inverse.py`'s already-existing
`SourceInversion.assemble_H()` / `_run_unit_response()` -- reused, not
reimplemented) suffers the same domain-exit problem as the backward
tracer above. It does not, in the cases checked: real wind at 2 real
hours (2025-08-01 00:00, 3.81 m/s; 2025-08-15 11:00, 5.50 m/s) x 3 zone
placements each (upwind 2km, upwind 5km, crosswind 2km/misaligned),
using the live simulator's real `dt_seconds=60` resolution:

| real hour | placement | H (conc/unit rate at NEL-001, 3h) |
|---|---|---|
| 2025-08-01 00:00 (3.81 m/s) | upwind 2km | 1.84e-02 |
| | upwind 5km | 6.80e-03 |
| | crosswind 2km (misaligned) | 3.55e-05 |
| 2025-08-15 11:00 (5.50 m/s) | upwind 2km | 2.04e-01 |
| | upwind 5km | 1.27e-01 |
| | crosswind 2km (misaligned) | 4.13e-09 |

Upwind placement gives a real, substantial, physically-sensible signal;
misaligned placement drops 3-9 orders of magnitude -- genuinely
discriminating geometry, not degenerate. The likely reason this differs
from the backward tracer: `assemble_H` only needs a plume's near-field
LEADING EDGE to reach a receptor a few km away -- it does not need the
whole particle ensemble/mass budget to stay bounded inside the domain
the way the backward tracer's global accounting does. That global
containment requirement is exactly what the 86.3% saturation rate above
is measuring, and the forward check simply never hits it at short range.

**Caveat, stated as plainly as the result above**: this is 6 real test
cases at short zone-receptor distances (2-5km), not proof across all
geometries. Zones near the domain edge, longer ranges, or other species
have not been checked and may not behave this well.

**Forward pointer**: given this evidence, Phase I4 should be scoped as a
SHORT-RANGE (2-5km) single-zone estimator, not assumed to work at longer
range without further testing.

### Spec (real, not a placeholder)

**Goal**: given a hypothesized single zone near a real sensor, estimate
its emission rate (Q, in the species' declared rate unit/m^2/s) from real
telemetry, with real posterior uncertainty, reusing
`attribution/inverse.py`'s existing `SourceInversion` directly -- no
reimplemented linear algebra, no reimplemented forward transport.

- **Scope: single zone only.** Multi-zone identifiability (the
  single-snapshot collinearity trap `ctm-core/CLAUDE.md` describes) is
  explicitly NOT this phase's problem -- it doesn't arise with one zone.
- **Range: 2-5km from the receptor, per the tested forward-response
  evidence above.** The worker validates zone-to-sensor distance and
  REJECTS (does not silently clamp or warn-and-proceed) any zone outside
  `[2000, 5000]` meters. Zones near the domain edge or beyond ~5-8km are
  explicitly UNTESTED -- v1 excludes them rather than allowing an
  unverified result; broadening this range needs its own real test
  first, the same way the 2-5km range itself was established.
- **Observations: real 2-hour-stacked**, one real telemetry reading per
  real hour (2 observations total per estimate), not a single snapshot
  -- matching `ctm-core/CLAUDE.md`'s own stated practice of stacking
  observations across time, applied here even though a single zone
  doesn't strictly require it for solvability; it gives a real accuracy
  benefit (2 constraints instead of 1) at negligible extra cost.
- **Enhancement, not raw concentration**: `InversionObservation.enhancement`
  is real telemetry `pollutants.pm2_5` (note the telemetry schema's
  underscore vs. the city config's `pm25` species key -- a real naming
  difference between the two systems, not a typo to "fix" by renaming
  either one) minus the city config's `species['pm25'].background_conc`
  -- the SAME disclosed-as-unverified generic default already in
  `cities/live_deployment.json`, not a new number invented here.
- **Wind**: same real Nellore archive as Phase I3
  (`met/ingest_real_met.py`), same `interpolate_met()`/
  `mixing_height_m()` reuse, at the live simulator's real
  `dt_seconds=60` resolution (NOT the adjoint's coarse offline
  `dt=3600` -- `assemble_H`'s forward transport is CFL-sensitive the way
  the backward tracer's random walk isn't, so it needs the real
  simulator resolution).
- **Uncertainty is not optional**: the response always carries
  `marginal_std` (from `InversionResult`, real posterior std, not a
  guessed error bar) alongside `x_hat`, plus `chi2_per_obs` and
  `fit_residuals` for calibration diagnostics, and `species_advisory()`'s
  real quasi-conservative flag/message (same deposition numbers the
  forward model uses -- reused, not reimplemented).
- **Auth**: identical pattern to Phase I3 -- `authenticateDevice` reused
  verbatim, `device_id`-only, `station_id` for grouping/storage only.
- **Endpoint**: `POST /api/emission-rate/ingest` (+ `GET .../latest`),
  mirroring `/api/source-direction` exactly.
- **Tests, in this order**: (1) a SYNTHETIC known-answer recovery case
  first -- a known true Q run through the REAL, independent
  `ctm.simulator.Simulator` (not `SourceInversion`'s own internal
  unit-response replica, so the test doesn't validate the module against
  itself) over real wind, noise added per the sensor's real
  `species_error_sigma`, then solved with a FRESH `SourceInversion`
  instance and checked for statistical coverage (within ~3 posterior std
  of truth, per `ctm-core/CLAUDE.md`'s own stated criterion) -- (2) THEN
  a real-data check (real wind, real zone geometry, confirms the
  pipeline produces a finite, well-conditioned result end-to-end) --
  same ordering discipline as Phase I2/I3: prove the numbers are right
  on a case where the answer is known before trusting real, unverifiable
  cases.

### Real, executed verification (not claimed -- see actual output at the
time this was written)

- **Python**: `pytest tests/scripts/test_emission_rate_worker.py` -- 14
  tests, all passing. Covers zone-distance geometry (exact flat-earth
  arithmetic), `validate_zone_range()` boundaries (1999/2000/5000/5001m),
  `compute_enhancement()` against the real configured background, the
  three HTTP-boundary functions against mocked responses shaped like the
  real endpoints, and -- the two tests that matter most -- a NOISELESS
  synthetic recovery across a real day/night stability-class boundary
  (regression test for a real bug: an earlier `build_real_histories()`
  held one stability class per real hour instead of advancing it every
  sub-step, producing recovery ~36% off true Q for a window straddling
  the boundary; fixed, it's ~0.01% off) and a NOISY synthetic recovery
  checked for statistical coverage (recovered `x_hat` within 3 posterior
  `marginal_std` of the known true Q, run through the REAL independent
  `ctm.simulator.Simulator`, solved with a fresh `SourceInversion`
  instance that never saw the true value).
- **Full ctm-core suite**: `pytest` (repo root) -- 146 passed, 13 skipped
  (the quarantined co-kriging tests, expected -- see `ctm-core/CLAUDE.md`),
  0 failed.
- **Node**: `npm test` in `backend/` -- 3 suites, 15 tests, all passing
  (includes `emission-rate.test.js`: 401 on missing/wrong auth, 201 +
  correct stored fields + forced label on success, 400 on a payload
  missing a required field or a negative `marginal_std`).
- **Real bug found while wiring this phase, fixed before claiming done**:
  `backend/routes/source-direction.js` (Phase I3's route, untouched by
  this phase's changes to the model/worker) was never updated when
  `estimate_tier` became a required field on `SourceDirection` and a
  required top-level field the worker now sends -- the route neither
  required it in `validatePayload` nor passed it into `.create()`. Since
  Mongoose enforces `required: true` on save (not just on the route's own
  hand-rolled validation), every real POST carrying an `estimate_tier`
  would have hit the DB write and failed there with a 500, not the 400
  the missing-field path is supposed to give. Fixed by adding
  `estimate_tier` to `REQUIRED_TOP` and to the `.create()` call; caught
  by reasoning about the diff, not by an existing test (the existing
  `source-direction.test.js` mocks `SourceDirection.create` entirely, so
  it couldn't have caught a real Mongoose validation failure) -- added
  two real tests for it (`accepts a boundary_sector_fallback estimate
  with a null distance_m`, `rejects a payload missing estimate_tier with
  400`) and confirmed the fix against real Mongo below, not just the
  mock.
- **Real local end-to-end run** (docker-compose Mongo + mosquitto, real
  `node server.js`, real HTTP throughout, real backdated telemetry per
  the worker's disclosed REAL DATA CONSTRAINT):
  1. Real Mongo container (reused the existing `rs0` replica set already
     configured with `host: 'localhost:27017'` from Phase I3's session --
     confirmed via `rs.conf().members` before use, not re-initiated blind).
  2. 2 real `POST /api/telemetry` calls for device `ESP32-001` / station
     `NEL-001`, backdated to `2025-08-01T00:00:00Z` (`pm2_5: 27.3`) and
     `2025-08-01T01:00:00Z` (`pm2_5: 30.1`) -- inside the real wind
     archive's actual coverage, disclosed as backdated per the worker's
     own docstring, not silently passed off as live.
  3. Ran the real worker: `py scripts/emission_rate_worker.py --base-url
     http://localhost:4000 --station-id NEL-001 --species pm25 --zone-lat
     14.433949790840035 --zone-lon 79.96042943509974 --device-key
     e2e-worker-key-er --as-of 2025-08-01T01:00:00` (zone at the real,
     validated 2900m -- inside the tested [2000,5000]m range). Real
     output: `x_hat=127.68, marginal_std=59.12, chi2_per_obs=0.632,
     quasi_conservative=true`, `POST status=201`.
  4. `GET /api/emission-rate/latest?station_id=NEL-001` returned the real
     stored document with the exact enforced label,
     `device_id: "WORKER-EMISSION-RATE"` (from auth, never the body), and
     both real observations with their `time_index`/`enhancement`.
  5. Re-ran the real Phase I3 worker (`source_direction_worker.py`)
     against the now-fixed route to confirm the `estimate_tier` bug fix
     end-to-end, not just against the mock: real output
     `estimate_tier: 'interior', status_code: 201`.
  6. Posted a synthetic-but-real-shaped `boundary_sector_fallback`
     payload (`distance_m: null`) directly to the fixed route and read
     the document back straight out of `mongosh` (not through the API,
     to rule out any response-serialization masking a stored problem):
     `distance_m: null, estimate_tier: "boundary_sector_fallback"` --
     confirms the schema's nullable-`distance_m` + required-`estimate_tier`
     combination round-trips through real Mongo, not just the mocked
     Jest test.
  7. Negative-auth checks against the live emission-rate route: no
     headers -> 401, `station_id` used as `device_id` -> 401.

  Docker Desktop was not running at the start of this verification and
  was started for it (`docker compose up -d` after that came up clean);
  both the Mongo container and the node server were stopped after this
  run, not left running.

**Caveat, stated as plainly as everywhere else in this doc**: this is one
real zone geometry (2.9km, upwind-ish of the archived wind) and one
device/species pairing (`ESP32-001`/`pm25`). The forward-response
evidence above covers 6 geometry/hour combinations; this run adds a 7th,
end-to-end through the real ingest/store/retrieve path, not a new
geometry sweep. Broadening beyond the tested [2000,5000]m range, or to
other species, needs its own real test first, per the spec above.
