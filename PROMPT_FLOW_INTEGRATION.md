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

## Phase I4 — NOT STARTED

Single-zone emission-rate (Q) estimation, feeding `backend/lib/plume.js`.
Explicitly out of scope until Phase I3 above is confirmed solid in a real
session -- do not start this without a deliberate decision to do so.
