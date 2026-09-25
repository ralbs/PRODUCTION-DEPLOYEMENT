# PROMPT_FLOW_UI.md

UI redesign that builds the confidence-treatment pattern in from the start
(root `CLAUDE.md`'s non-negotiable rule: every CTM-derived value gets a
value, a STRUCTURAL confidence treatment, and a staleness indicator,
shown the same way every time) rather than retrofitting it after Phase U3's
source-direction view ships. This document did not exist before Phase U0
(this phase) -- earlier references to it (root `CLAUDE.md`) described
intended future work, not a real committed file. It is written now so a
later session has something real to check against instead of re-deriving
this scope from scratch, the same reasoning as `PROMPT_FLOW_INTEGRATION.md`.

Everything below is either marked `(done)` with real evidence, or is a
prescriptive prompt for work not yet started. Don't start phase N+1 until
phase N's acceptance criteria are shown met.

---

## Phase U0 — audit the real frontend before building anything (done)

**Goal**: find out what actually exists in `frontend/` -- package.json,
routing, components, map library, styling -- before Phase U3 builds a
source-direction view against guessed patterns instead of real ones.

Full audit output (from the session that ran it) is reproduced below
verbatim as this phase's evidence, not summarized:

### package.json / stack
- Vite + React 18, no TypeScript. Dependencies: `leaflet` (raw, **not**
  `react-leaflet`), `react`, `react-dom`, `recharts`. Devs:
  `@vitejs/plugin-react`, `vite`.
- **No router** -- no `react-router` or equivalent anywhere in the tree.
  This is a single-route SPA.
- **No CSS framework** -- no Tailwind, no styled-components, no CSS
  modules. One hand-written `src/index.css` with CSS custom properties.
- **No state library** -- plain `useState`/`useEffect`/`useCallback`/
  `useRef` in `App.jsx`, prop-drilled down.
- Dev proxy (`vite.config.js`): `/api`, `/graphql` -> `localhost:4000`.
  Prod base URL from `VITE_API_BASE_URL` (`.env.example`: prod =
  `https://aqms-dedk.onrender.com`). Deployed on Vercel, project `aqhi`.

### Routing
- **None.** `App.jsx` is the entire app -- one component tree. Station
  selection is `useState(null)` + a dropdown, not a URL param. Any new
  "view" has no route to slot into; it's a new section/card on the same
  page unless routing is introduced for the first time.

### Data layer (`src/api.js`)
- Flat `api` object of `fetch` wrappers keyed by intent (`getStations`,
  `getLatest`, `getHistory`, `getForecast`, `estimatePlume`), one per
  backend REST endpoint. No React Query/SWR -- polling is manual
  `setInterval` in `App.jsx` (`REFRESH_MS = 60_000`,
  `FORECAST_MS = 5*60_000`).
- No `getSourceDirection`/`getEmissionRate` entries exist yet.
- Unit-conversion helpers (`conv.*`) live in the same file, not a
  separate domain layer.

### Component/composition pattern
- Every dashboard section is a `<FullscreenCard title=... icon=...
  meta=...>` wrapper (`src/components/FullscreenCard.jsx`) -- consistent
  header (icon + title + optional right-aligned `meta` string) plus a
  built-in expand-to-modal button (`M` key or click). **This is the
  container Phase U3 reuses, not a bespoke card shape.**
- Icons are inline hand-rolled SVG path functions at the top of
  `App.jsx` (the `I(d, extra)` helper) -- no icon library.
- Styling mixes global `index.css` classes (one block per section, e.g.
  `.plume-band`, `.forecast-header`, `.health-metric-grid`) with a lot of
  ad-hoc inline `style={{...}}` objects directly in JSX -- heaviest in
  `PlumeVisualizer.jsx` and `HealthIntelligencePanel.jsx`. No single rule;
  newer/denser components lean inline, page chrome leans on CSS classes.
- Small presentational sub-components are defined inline at the bottom of
  the file that uses them, not extracted to their own files (`ParamItem`
  in `PlumeVisualizer.jsx`; `Ring`/`HBar`/`Card` in
  `HealthIntelligencePanel.jsx`) -- a repeated, real convention.

### Map library
- **Raw Leaflet** (`import L from "leaflet"`), imperative `useEffect`
  setup in `MapPanel.jsx` -- map created once in a ref-guarded effect,
  markers/canvas redrawn in a separate effect keyed on data changes. Dark
  CARTO basemap (`dark_all`), custom canvas-based IDW heatmap layer drawn
  directly via `CanvasRenderingContext2D` (`src/lib/idw.js`'s
  `idwInterpolate`), not a Leaflet plugin. Leaflet's own chrome (popups,
  zoom control) is reskinned via `!important` overrides in `index.css`.
- A **second**, unrelated spatial visualization exists in
  `PlumeVisualizer.jsx`: a plain `<canvas>` grid renderer with a
  hand-written jet colormap, used for the dispersion plume -- not
  Leaflet-based. Two real precedents exist for "draw something spatial";
  Phase U3 below picks one explicitly rather than inventing a third.

### Styling system
- Dark theme only, no light-mode variables. All color/spacing/radius as
  CSS custom properties on `:root` (`--bg-*`, `--accent`, `--border*`,
  `--text*`, AQI category colors `--good`...`--severe`, `--r-card`,
  `--r-btn`).
- Fonts: Inter (body) + JetBrains Mono (`--font-mono`) -- **every numeric
  readout site-wide is monospaced** (AQI values, sensor readings,
  timestamps). Real, consistent convention worth keeping for any new
  estimate value.
- A badge/pill idiom recurs constantly: `.category-pill`, `.trend-badge`,
  `.aqi-category-badge`, `.live-badge`, `.si-index-badge` -- small
  rounded pill, colored border+background+text triad keyed to a semantic
  state. **Closest existing thing to a confidence treatment, but
  currently only used for AQI category or trend direction, never for a
  measured-vs-estimated distinction.**
- Responsive breakpoints at 1100px/768px/480px, desktop-first (grid
  collapses down), not mobile-first.

### The confidence-treatment gap (why Phase U1 exists)
- `useDataFreshness()` (age-in-seconds formatter, `App.jsx`) and
  `.freshness-bar`/`.freshness-dot` (`index.css` lines 565-573) **already
  exist but are dead** -- `grep -rn "freshness-bar\|freshness-dot"
  src/` matches only their own CSS declarations, zero JSX usage anywhere.
  `dataAge` itself is only ever surfaced as a plain `meta` string on the
  Weather card (`Updated 47m ago`).
- **Nothing in the codebase structurally distinguishes "measured" from
  "estimated."** `PlumeVisualizer.jsx`'s `ParamItem` sub-component
  renders exactly this distinction today as a plain caption string --
  `sub={wind ? "From sensor" : "Default (no sensor)"}` -- which is the
  literal anti-pattern root `CLAUDE.md` calls out ("captions get skimmed
  past"). This is the first thing Phase U2 retrofits.
- No existing structural confidence-badge component can be reused as-is.
  Phase U1 builds it new, from the declared-but-unused freshness classes
  plus the existing pill/badge idiom -- not from scratch stylistically,
  but genuinely new as a component.

**Acceptance**: real audit findings above, citing actual files/greps, not
generic placeholders -- met by this section itself.

---

## Phase U1 — the confidence-treatment component

```
Build the structural confidence-treatment component root CLAUDE.md
requires for every CTM-derived value: a value, a STRUCTURAL state (not a
caption), and a staleness indicator relative to the data's real age.

Decision, made explicitly here rather than left open: revive
.freshness-bar/.freshness-dot (declared in index.css, currently unused
anywhere) and extend the existing badge/pill idiom
(.category-pill/.trend-badge/.live-badge/.si-index-badge -- rounded pill,
colored border+background+text triad) rather than inventing a new visual
language. Reuse the existing CSS custom properties (--good/--mod/--poor
etc. for severity-flavored states if applicable, --accent/--text-dim for
neutral ones) and the site-wide monospace-for-numbers convention
(var(--font-mono)) for the value itself.

Build ONE new component, e.g. src/components/ConfidenceBadge.jsx,
following this codebase's existing convention of small presentational
sub-components defined alongside their consumer OR promoted to their own
file when reused across >1 component (this one will be reused by both
Phase U2's retrofit and Phase U3's new view, so it earns its own file
from the start -- don't inline it once and duplicate it later).

Three structural states, each visually distinct (border color + icon or
symbol + background tint -- not just a text label):
1. MEASURED -- a real sensor/ground-truth reading. Use --good-flavored
   or --accent treatment (this codebase's existing "real data" color).
2. ESTIMATED -- a model-derived value (e.g. CTM output, a nowcast, a
   heuristic default). Visually distinct border/icon from MEASURED --
   this is the state PlumeVisualizer's "Default (no sensor)" caption
   should have been from the start.
3. STALE -- age-relative-to-cadence indicator, e.g. "updated 47m ago,
   next expected in ~1h 13m" rather than a bare timestamp, per CLAUDE.md's
   exact example. Needs a caller-supplied expected-cadence (e.g. the
   worker's polling interval) to compute "next expected," not just now()
   minus timestamp -- don't fake a cadence if the caller doesn't supply
   one; render "updated Nm ago" alone in that case rather than a
   fabricated ETA.

Props shape (adjust as needed once building, but keep the three states
and the cadence-aware staleness distinct, not collapsed into one enum):
  <ConfidenceBadge
    state="measured" | "estimated"
    timestamp={isoString}
    cadenceMinutes={number}        // optional; omits "next in" if absent
    label={string}                 // optional short text, e.g. "GROUND STATION"
  />

Test it in isolation (a small story/demo usage in one existing card is
fine, doesn't need a dedicated test harness given this codebase has none)
before Phase U2 wires it into a real caller.
```

**Acceptance**: `ConfidenceBadge.jsx` exists, renders all three states
with genuinely distinct visual treatment (verify by screenshot/DOM
inspection, not just "the code runs"), computes staleness from a real
timestamp using the freshness math already proven in `useDataFreshness()`,
and is not yet wired into any real screen (that's Phase U2).

---

## Phase U2 — retrofit onto PlumeVisualizer.jsx (proves it on a real case)

```
Before Phase U3 builds something new on top of ConfidenceBadge, prove it
works on a real EXISTING case: PlumeVisualizer.jsx's ParamItem captions.

Specifically replace the `sub` caption on the "Wind Speed" ParamItem
(currently `sub={wind ? "From sensor" : "Default (no sensor)"}`,
src/components/PlumeVisualizer.jsx around line 211) with a real
<ConfidenceBadge> usage:
  - state="measured" when `wind` (i.e. latest.weather.windSpeed) is
    present, state="estimated" when it falls back to the hardcoded
    default (3 m/s, see the `windSpeed = weather.windSpeed || 3` line).
  - timestamp from `latest.timestamp` (already available in this
    component's props).
  - No cadenceMinutes yet at this call site (telemetry arrival isn't on
    a fixed cadence the way a scheduled worker is) -- confirms the
    component's "omit next-expected gracefully" path for real, not just
    in isolation.

Do NOT touch the other three ParamItems (Source Height, Emission Rate,
Time of Day) in this phase -- they're heuristic-always, not
measured-vs-estimated, and forcing them into this component would be
scope creep past what this phase's acceptance needs.

This is a visual regression on a shipped component -- take a
before/after screenshot (or run the app and describe the rendered
difference) rather than trusting the diff alone.
```

**Acceptance**: `PlumeVisualizer.jsx`'s Wind Speed caption uses the real
`ConfidenceBadge` component, toggles state correctly when a real station
with live weather data vs. one without is selected, and every other
`ParamItem` in the file is provably unchanged.

---

## Phase U3 — the source-direction view

```
Build the UI for backend/routes/source-direction.js's
GET /api/source-direction/latest?station_id=... (confirmed real and
already wired at /api/source-direction in server.js -- see
PROMPT_FLOW_INTEGRATION.md's Phase I3 for what actually produces these
documents: ctm-core/scripts/source_direction_worker.py's adjoint tracer).

### Map-overlay-vs-canvas decision -- made explicitly here, not left open

Extend the existing Leaflet MapPanel.jsx with a bearing/sector overlay,
NOT a standalone canvas widget like PlumeVisualizer's. Reasoning: a
source-direction estimate (models/SourceDirection.js's bearing_deg,
FROM the real receptor station's real lat/lon) is inherently geographic
-- it only means something relative to the station's real position on
the real map, the same way the station markers themselves are. A
detached canvas (PlumeVisualizer's pattern) would force re-deriving the
station's position and a from-scratch compass rendering, duplicating
what Leaflet already gives MapPanel.jsx for free (real projection,
pan/zoom, existing marker layer to anchor to). PlumeVisualizer's canvas
approach exists because a dispersion GRID has no natural home on a
world map at station scale -- that reasoning doesn't apply here.

Concretely: add a new overlay pane to MapPanel.jsx (same pattern as the
existing `idwPane` for the IDW heatmap -- map.createPane(), a z-index
between the heatmap and the station markers so the wedge doesn't occlude
click targets) that draws a bearing wedge/sector from the source station
marker's real coordinates, oriented on bearing_deg, sized/faded by
distance_m when estimate_tier is "interior" (real distance available)
vs. a sector-only wedge with no radius when estimate_tier is
"boundary_sector_fallback" (see SourceDirection.js's own comment: "gives
a direction but genuinely no distance -- null here, never a fabricated
number"). Do NOT invent a fake distance for the fallback tier to make
the drawing simpler -- render it visibly different (e.g. an
unbounded/dashed wedge vs. a solid bounded one), matching this
project's "structural, not cosmetic" confidence rule.

### Wiring

1. Add to src/api.js, matching the existing getForecast/getLatest
   pattern exactly:
     getSourceDirection: (id) => get(`/api/source-direction/latest?station_id=${encodeURIComponent(id)}`)
   This is a public GET, no auth needed client-side (confirmed: the
   route has no authenticateDevice on GET /latest).
2. In App.jsx, add a fetch + state slot for the selected station's
   source-direction result, following the SAME refresh pattern as
   refreshStation/refreshForecast (a useCallback, called on station
   change, no fixed polling interval needed since this is worker-produced
   and updates only when a real spike fires -- polling on every
   REFRESH_MS would mostly re-fetch the same stale document; consider
   polling at a slower interval, or only re-fetching on demand, and say
   in a comment why, rather than copying REFRESH_MS blindly).
3. Wrap the new view in a <FullscreenCard title="Source Direction"
   icon={...} meta={...}>, matching every other dashboard section --
   NOT a new card shape.
4. Inside it, use TWO ConfidenceBadges from Phase U1, not one -- this
   feature genuinely has two independent confidence dimensions, both
   real fields on the stored document, don't collapse them:
     - bearing estimate_tier ("interior" -> measured-flavored/higher
       confidence; "boundary_sector_fallback" -> estimated-flavored/
       lower confidence) using the document's own `confidence` field
       (0-1) and `boundary_inflow_fraction`.
     - wind.source_tier ("historical_ground_station" -> measured;
       "live_model_nowcast" -> estimated) -- see backend/lib/windSource.js's
       WIND_SOURCE_LABELS for the exact real caveat text to surface
       (don't paraphrase it; that module's strings are the
       server-authoritative wording for exactly this distinction).
   Staleness badge uses the document's own `timestamp` (the triggering
   reading's time, not `ingested_at`) -- state in the UI which one is
   shown, since they can differ.
5. Handle the 404 case (GET /latest returns 404 "No source-direction
   estimate found for this station" when a station has never had a real
   spike) as a real, expected, non-error empty state -- per
   PROMPT_FLOW_INTEGRATION.md's own disclosed finding that ~86% of real
   hours produce no usable estimate at the currently-shipped domain
   size, THIS WILL BE THE COMMON CASE, not a bug to hide. Show something
   like "No directional estimate yet for this station" rather than a
   generic error state, and never fabricate a placeholder bearing.
6. Always render the SOURCE_DIRECTION_LABEL text
   ("estimated upwind direction -- screening only, not confirmed source
   attribution") verbatim near the estimate, the same way the backend
   enforces it verbatim server-side -- this is a screening tool, not
   attribution, and the UI must say so as plainly as the stored document
   does.
```

**Acceptance**: `api.js` has `getSourceDirection`; `MapPanel.jsx` draws a
real bearing wedge from real `bearing_deg`/`distance_m`/`estimate_tier`
data, visually distinguishing the two estimate tiers rather than faking a
distance for the fallback case; both confidence dimensions (bearing
tier, wind tier) are shown via real `ConfidenceBadge` instances, not
captions; the verbatim screening-only label is always visible next to
the estimate; the common no-estimate-yet case renders as an honest empty
state, not an error.

---

## Phase U4+ — remaining UI work, adapted to this real stack

Only sequenced after U1-U3 are done and their acceptance criteria shown
met. U0-U3's own established standard applies to every phase below: real
dev server, real screenshots, before/after comparison, a real
axe/Lighthouse check as part of that phase's own verification -- not
deferred to a separate pass at the end. This replaces an earlier,
looser plan for a single "U4: mobile/accessibility pass"; accessibility
is folded into each phase's own acceptance criteria instead, which is
better practice than a bolt-on pass after the fact.

Core direction, applying everywhere design decisions get made in these
phases: the product's visual identity should come from having a REAL,
LIVE PHYSICS MODEL behind it (real wind, real dispersion), not from a
generic dashboard template — see root `CLAUDE.md`'s ambient-data
principle, which this phase sequence is the first concrete application
of, not the only one.

---

### Phase U4 — Design language audit + direction (done)

```
Before touching any component: catalog every place CTM-derived data is
currently shown in a "scientific instrument" style rather than a
"decision-support" style -- specifically PlumeVisualizer's jet-colormap
canvas grid, and any raw coordinate/bearing-degree display in
SourceDirectionPanel. For each, propose (in writing, not code yet) a
plain-language, AQI-category-color-consistent replacement -- reuse the
EXISTING AQI category color tokens already in index.css (Good/
Satisfactory/Moderate/Poor/etc), don't introduce a separate scientific
palette.

Also propose a concrete ambient design element driven by REAL live wind
data (speed + direction, already available from met/live_wind.py's
output surfaced through the backend) -- something persistent, not
confined to one card, that makes the interface feel alive and
location-specific. Sketch this in writing/CSS pseudocode, not a full
build yet.

Get explicit sign-off on this direction before U5 starts building.
```

**Acceptance**: a written direction doc (colors, ambient concept,
plain-language reframing plan for the two identified "too technical"
displays) reviewed and approved before any component changes -- met by
the direction doc below, approved before U5 started.

#### Direction doc (real evidence, reviewed and approved)

**1. PlumeVisualizer's dispersion grid — exact colors, exact conversion
path**

Current (`PlumeVisualizer.jsx:6-13`): a hand-rolled `jet(t)` colormap --
blue->cyan->yellow->red, `t = sqrt(concentration/max)`. Scientifically
standard, semantically meaningless next to the rest of the dashboard.

Finding: there are two different "AQI palettes" already in this
codebase, and they disagree --

| Category | `index.css` custom prop | `lib/aqiColor.js` `STOPS` (used by `MapPanel.jsx`'s real heatmap) |
|---|---|---|
| Good | `--good #22c55e` | `[34,197,94]` (same) |
| Satisfactory | `--sat #a3e635` | `[132,204,22]` (different -- `#84cc16`) |
| Moderate | `--mod #facc15` | `[234,179,8]` (different -- `#eab308`) |
| Poor | `--poor #f97316` | `[249,115,22]` (same) |
| Very Poor | `--vpoor #ef4444` | `[239,68,68]` (same) |
| Severe | `--severe #9f1239` | `[153,27,27]` (different -- `#991b1b`) |

Decision: use `lib/aqiColor.js`'s `aqiToRgb()` -- the continuous-
interpolation function, not the discrete CSS pills -- because it's
already exactly what `MapPanel.jsx`'s own IDW heatmap uses for the same
"concentration -> gradient on a canvas" problem (`MapPanel.jsx:113`).
This resolves the CSS-vs-JS mismatch above by picking the one already
used for canvas gradients as authoritative for this use case; the CSS
pills stay authoritative for discrete badges/pills, unchanged.

Real gap this surfaces, must be closed in U5, not glossed over:
`aqiToRgb(aqi)` takes an AQI index (0-500), but `PlumeVisualizer`'s grid
holds raw µg/m³ PM2.5 concentration from the Gaussian plume math --
feeding µg/m³ straight into `aqiToRgb` as if it were an AQI number would
silently mis-color the grid. U5 must first convert each grid cell's
µg/m³ through the same CPCB PM2.5 breakpoint table `backend/lib/aqi.js:
35-42` already encodes (`[0,30]->[0,50]`, `[31,60]->[51,100]`,
`[61,90]->[101,200]`, `[91,120]->[201,300]`, `[121,250]->[301,400]`,
`[251,380]->[401,500]`) before calling `aqiToRgb`. That breakpoint table
is 24hr-average-basis and the dispersion grid is instantaneous -- a
known approximation, but the same one the backend already makes for
real sensor readings, not a new inconsistency.

Also remove: the canvas's burned-in `"Peak: 42.3 µg/m³"` / `"Stability:
D"` `fillText` calls (`PlumeVisualizer.jsx:84-85`) -- redundant with the
plain-language "What This Means" block (`PlumeVisualizer.jsx:229-249`)
that already says the same thing in prose.

**2. SourceDirectionPanel's bearing readout — scope boundary**

Current (`SourceDirectionPanel.jsx:86-94`): `247.3°` at 26px font-mono
as the hero element, compass point in a smaller parenthetical, raw
`distance_m` division, raw `confidence.toFixed(2)` decimal in the
inconclusive branch.

U4 only sets direction, does not rebuild: flagged as the second catalog
target; the actual compass/arrow + plain-distance + qualitative-
confidence-word rebuild is Phase U6's explicit job, which must keep the
verbatim screening-only `doc.label` disclosure untouched. Nothing here
is built in U4.

**3. Ambient wind-driven background — concrete spec, built in U5**

Real data source, confirmed: `ctm-core/met/live_wind.py:83-130` --
Open-Meteo `wind_speed_10m` (m/s) + `wind_direction_10m` (degrees),
surfaced through the backend as the station document's
`weather.windSpeed`/wind bearing, already flowing into the frontend
(`PlumeVisualizer.jsx:123` already reads `weather.windSpeed`).

One new full-viewport `<div className="ambient-wind-field">`, mounted
once at the root of `App.jsx` (sibling to the main layout grid, not
inside any `FullscreenCard`), `position: fixed; inset: 0; z-index: 0` --
behind every card, in front of the flat `--bg-deep` body background,
`pointer-events: none` (same non-interactive convention `MapPanel.jsx:
210` already uses for `idwPane`). Always visible dashboard-wide,
regardless of which station/card has focus.

```css
.ambient-wind-field {
  position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(
    ellipse 140% 100% at var(--wind-origin-x) var(--wind-origin-y),
    var(--aqi-tint) 0%, transparent 60%
  );
  transform: rotate(var(--wind-bearing-deg));
  opacity: var(--wind-ambient-opacity);
  transition: transform 2s linear, opacity 1s linear;
  animation: wind-drift var(--wind-drift-duration) linear infinite;
}
@keyframes wind-drift {
  from { background-position: 0% 0%; }
  to   { background-position: 100% 0%; }
}
@media (prefers-reduced-motion: reduce) {
  .ambient-wind-field { animation: none; transition: none; }
}
```

- `--wind-bearing-deg`: set from the selected station's live wind
  direction -- the gradient's rotation points the way the wind blows.
- `--wind-drift-duration`: inversely proportional to live wind speed
  (e.g. `Math.max(8, 40 - windSpeed * 3)`s) -- calm air drifts almost
  imperceptibly slowly, high wind drifts fast enough to notice.
- `--aqi-tint`: the current station's AQI category color (same
  `aqiToRgb`/category source as everywhere else) at ~6-10% opacity.
- `--wind-ambient-opacity`: full (~1) when `wind.source_tier ===
  "historical_ground_station"`; reduced (e.g. 0.4) when
  `"live_model_nowcast"` -- the ambient layer obeys the same
  confidence-treatment principle as every other CTM-derived value (root
  `CLAUDE.md`'s ambient-data rule); it doesn't get a pass for being
  decorative.
- No station selected / no wind data: element renders `opacity: 0`
  rather than a fabricated default bearing -- mirrors U1's "never fake a
  cadence/number" rule.
- `prefers-reduced-motion: reduce` disables the rotation/drift animation
  and transition entirely (element still renders, statically oriented,
  just without motion) -- verification of this moved to U5's own
  acceptance criteria below, since U5 is where this element is actually
  built, not U4.

---

### Phase U5 — Redesign the plume view (done)

```
Rebuild PlumeVisualizer's rendering per U4's approved direction:
- Replace the jet-colormap canvas grid with an AQI-category-color-based
  soft overlay (use the same green/yellow/orange/red/etc tokens the rest
  of the dashboard already uses for AQI category).
- Move it onto the real Leaflet map as an overlay (consistent with how
  SourceDirectionPanel's bearing wedge already lives on the map) rather
  than a separate standalone canvas widget, unless U4's direction doc
  specifically decided otherwise -- if so, state why.
- Add a plain-language caption (e.g. "Estimated affected area based on
  current wind and source strength") and a distance scale, replacing
  raw µg/m³ grid-cell values as the primary readout.
- Keep ConfidenceBadge's measured/estimated/stale treatment intact on
  whatever replaces the old parameter captions.
- Build `.ambient-wind-field` per U4's approved spec above, mounted at
  the `App.jsx` root -- real wind bearing/speed driving rotation/drift,
  real AQI-category tint, confidence-aware opacity, `opacity: 0` when no
  wind data. This ships alongside the plume-view recolor since both
  consume the same real wind + AQI-color plumbing.

Real dev server, real screenshots, before/after comparison against the
current jet-colormap version. Real axe/Lighthouse check on the new
component specifically (color contrast on the new overlay matters here).
Commit on its own.
```

**Acceptance**: real screenshots showing old vs. new side by side,
real accessibility score for the new version, confirmed no regression
in the underlying plume calculation display (the science is unchanged,
only its presentation); `.ambient-wind-field` respects
`prefers-reduced-motion` -- the rotation/drift animation disabled or
drastically simplified when set, verified with a real
`prefers-reduced-motion` emulation in devtools (not assumed safe),
screenshots of both the motion and reduced-motion states.

#### Evidence (real, verified via `$B` headless browser against a temporary
in-memory api.js mock -- no local MongoDB is reachable in this dev
environment; mock shapes matched against the real routes, reverted after
verification, never committed)

**Map-move decision, resolved (not left open as U4's doc originally left
it)**: `backend/routes/plume.js`'s grid coordinates are meters
downwind/crosswind from an assumed source AT the selected station (`Q` is
derived from that station's own PM2.5 reading) -- the same real lat/lon
the bearing wedge already anchors to. This IS geo-referenced in practice,
unlike the "no natural home on a world map" reasoning that applies to
PlumeVisualizer's OLD canvas. Moved it: `MapPanel.jsx` gained a
`plumePane` (z-index 360, between `idwPane` 350 and `bearingPane` 375)
whose canvas projects each grid cell's real (x downwind, y crosswind)
meters into a real lat/lon via the same spherical `destinationPoint()`
already used for the bearing wedge (move along the wind bearing by x
meters, then perpendicular to it by y meters), cached separately from
screen-pixel projection so pan/zoom redraws don't repeat the trig.
Verified: `.plume-overlay-canvas` has real non-transparent pixels
(1000 at the initial zoom, 3600 after zooming in twice -- confirms
`resetPlumeOverlay`'s moveend/zoomend redraw hook works and cell pixel
size correctly scales with zoom), co-located with the station marker and
bearing wedge in the screenshot below.

`PlumeVisualizer.jsx`'s right column no longer draws a canvas at all --
it shows the plain-language "colored overlay on the Station Map above...
extending N km downwind" caption plus a static AQI-gradient legend bar
(0 µg/m³ to peak), satisfying the "distance scale, replacing raw µg/m³
grid-cell values as the primary readout" requirement without a
standalone widget.

**Recolor**: real hand-checked conversions (not the informal example this
doc's own U4 section got wrong and is corrected here) -- 42 µg/m³ PM2.5 →
CPCB sub-index 70 → **Satisfactory** (yellow-green), not Moderate; 75
µg/m³ (this session's mock `latest.pollutants.pm2_5`) → sub-index ~124 →
**Moderate** (yellow/orange). Both match `lib/aqiColor.js`'s
`pm25ToRgb()` output exactly since that's the real conversion path now
wired in, not a manual estimate.

**Accessibility**: real axe-core 4.9.1 (CDN-injected for the scan, not a
new dependency) scoped to the Pollution Dispersion card found ONE real
WCAG AA failure pre-existing in `PlumeVisualizer.jsx` before this
phase's own changes touched anything (`--text-dim` on `--bg-card`/
`--bg-card2`, 2.19:1 and 2.03:1, both need 4.5:1) -- confirmed pre-existing
via `git diff` showing neither flagged div was touched by U5's own edits.
Both fixed in this same commit (changed to `--text-sub`) since the file
was already open; re-scan after the fix: zero violations, one pass.
`prefers-reduced-motion` verified via the real CDP `Emulation.
setEmulatedMedia` method (not a static code read): with it emulated,
`.ambient-wind-field`'s computed `animationName` is `"none"` and
`transitionProperty` is `"none"`; cleared, `animationName` is
`"wind-drift"` and `transitionProperty` is `"transform, opacity"`.

**Confidence-aware opacity**, all three real states verified via computed
style, not just code inspection: `historical_ground_station` wind →
opacity `1`; `live_model_nowcast` → opacity `0.4`; no wind data (the
common case -- source-direction only fires on a real statistical spike)
→ opacity `0`, no fabricated bearing rendered.

No console errors in any state tested. Old jet-colormap version
(including the burned-in `Peak:`/`Stability:` canvas text) reproduced via
`git stash` on just the two changed files for a true before/after,
popped back immediately after the comparison screenshot.

**Coordinate-alignment spot-check** (prompted by a direct question on
whether the plume overlay and bearing wedge actually align on screen, not
just that they call the same projection function): verified by walking
the live React fiber tree to pull the real `L.Map` instance, the bearing
wedge's actual `L.Polygon`, and the plume's cached geo cells directly out
of running component state -- not by re-deriving from source. The wedge's
apex `getLatLngs()[0][0]` matched the mocked station coordinate exactly
(0m, 0px offset from the marker). The plume grid's nearest real cell
(excluding `i=0`, which the real backend always skips -- see
`routes/plume.js`) sat exactly 100.0m from the station, matching
`maxDist/xSteps` (8000/80) precisely, and projected to 3px from the
marker on screen at zoom 12 -- the expected small offset for a 100m
real-world distance, not a misalignment.

That same check surfaced a real bug this phase introduced: `MapPanel.jsx`
anchors `plumeResult`'s grid to `selectedStation` (the currently selected
station), while the pre-existing bearing wedge anchors to
`sourceDirection.station_id`, and (unlike `sourceDirection`, which
`App.jsx` already reset to `idle` synchronously on station change) the
lifted `plumeResult` state had no equivalent reset -- so between
selecting a new station and its plume re-fetch resolving, the map would
render the OLD station's stale dispersion estimate anchored at the NEW
station's real coordinates. Fixed by adding `setPlumeResult(null)` to the
same station-change effect that already resets `latest`/`sourceDirection`
(`App.jsx`). Verified with an artificially delayed two-station mock: the
overlay showed 0 rendered pixels in the gap immediately after switching
(previously would have shown station A's plume at station B's location),
then rendered correctly at the new station's real position once the
fetch resolved (confirmed both via direct prop inspection and, after
panning the map into view, a real non-empty canvas at the right spot).

**Follow-up: the plumeResult fix above was checked against the wrong
failure window.** A direct question forced re-verification: that fix and
its test only covered switching stations AFTER the old station's fetch
had fully settled -- a clean handoff. The real failure window is
switching WHILE a fetch for the previous station is still genuinely in
flight. Re-tested properly: station A given an artificial 4s fetch
delay, switched to station B at ~300ms (well before A's fetch resolves),
verified against a **production build** (`vite build` + `vite preview`,
not the dev server) to rule out React StrictMode's dev-only double-effect
invocation as a confound, with real timestamped trace logs plus direct
React state inspection (walking the fiber tree, not inferring from
rendered output).

Result: this reproduced a real, pre-existing bug -- NOT fixed by the
plumeResult change above, and predating this phase entirely. `latest`
itself has zero guard against a stale response: `refreshStation` (and
identically-shaped `refreshForecast`/`refreshSourceDirection`) commit
whatever they fetch unconditionally, with no check that `selected`
hasn't since changed. Confirmed via direct fiber inspection: ~4s after
switching to B, `latest.meta.station_id` silently reverted to `"KSPCB-A"`
(`pm2_5=75`, station A's stale value) while `selected` still correctly
read `"KSPCB-B"` -- a real, user-visible "station B" screen silently
showing station A's numbers. It "corrected" itself ~60s later only by
coincidence: `REFRESH_MS`'s pre-existing periodic timer happened to
re-fetch the (by-then-still) selected station and overwrite the
corruption. Absent that lucky timing, a real user could see the wrong
station's data for up to a minute.

Fixed by adding a `selectedRef` (assigned every render, same pattern as
`MapPanel.jsx`'s `dataRef`) that all three fetchers check against the
station they were called for before committing state, discarding the
response if the user has since switched away -- `App.jsx`. Re-ran the
identical adversarial sequence against a fresh production build after
the fix: `latest.meta.station_id` stayed `"KSPCB-B"` (`pm2_5=20`,
correct) straight through A's stale resolution, no console errors.

**All three, individually, not generalized from one.** The claim above
only directly exercised `refreshStation` (via `latest`); `refreshForecast`
and `refreshSourceDirection` were fixed on the reasoning that they share
the identical shape, not verified independently -- a real gap, caught by
a direct follow-up question. Re-tested properly: all three endpoints
mocked with the same asymmetric delay (station A 4s, station B 0.3s) in
one run, each returning a payload distinguishable per station
(`forecast.station_marker`, `sourceDirection.bearing_deg` 111.1 vs.
222.2), switched to B at ~300ms, confirmed via trace log that all three
of A's stale responses genuinely resolved ~4s later (t=30.106 in that
run), then checked each of the three resulting states independently via
direct fiber inspection: `latest.meta.station_id`, `forecast.
station_marker`, and `sourceDirection.doc.station_id` all correctly read
`"KSPCB-B"` (bearing `222.2`, B's value, not A's `111.1`). No console
errors. All three guards confirmed working individually, not assumed
from the shared code shape.

---

### Phase U6 — Reframe source direction in plain language (done)

```
SourceDirectionPanel's backend/data layer is fully done -- this is pure
presentation work. Replace raw bearing-degree + boundary_inflow_fraction
display with: a simple compass/arrow visual, distance in plain terms
("~4km away"), and confidence as a qualitative word (High/Moderate/
Uncertain) backed by ConfidenceBadge's existing states rather than a raw
percentage. Keep the "screening only, not confirmed" label exactly as-is
per CLAUDE.md's standing rule -- reframing the presentation must not
soften or remove that disclosure.

Real dev server, real screenshots of all states (interior, boundary-
fallback, inconclusive, no-data) in the new presentation. Commit on its
own, separate from U5.
```

**Acceptance**: same four states from the original U3 verification,
re-verified visually correct under the new plain-language presentation --
met, evidence below.

#### Evidence (real, verified via `$B` headless browser against a
temporary api.js mock -- no local MongoDB reachable in this environment;
mock reverted after verification, never committed)

**Compass/arrow**: new `CompassArrow` SVG replaces the old 26px raw
`247.3°` hero number -- solid filled arrowhead for `estimate_tier ===
"interior"`, dashed line + hollow arrowhead for
`"boundary_sector_fallback"`, carrying Phase U3's map-wedge structural
distinction (real distance behind it vs. not) into this panel's own
visual rather than losing it when the presentation changed. `bearing_deg`
drives the arrow's rotation directly (SVG `rotate()` is clockwise in
screen space, same direction as a compass bearing, confirmed no sign
flip needed). Compass point (e.g. "WSW") is now the primary readout; the
raw degree value is demoted to small secondary text, not removed.

**Distance**: `~4 km away` (interior tier, real `distance_m`) replaces
`~4.2 km upwind`; `"Direction only -- no distance estimate available"`
(boundary-fallback tier) replaces the old `distance not available --
compass sector only`.

**Confidence**: new `confidenceWord()` bands `doc.confidence` into
High (>0.6) / Moderate (>0.3) / Uncertain (below, but this branch is
only reached above `isInconclusive()`'s own 0.1 cutoff) -- verified
against mocked confidences 0.71 -> "High", 0.42 -> "Moderate". The
inconclusive branch's raw `confidence 0.07 (...)... 23% boundary
inflow` sentence is replaced with `Confidence: Uncertain` plus a
plain-language explanation, keeping the real citation
(`PROMPT_FLOW_INTEGRATION.md`'s Phase I3 saturation sweep) rather than
just deleting the substance along with the raw numbers.

**Disclosure label untouched**: `doc.label` (the server-enforced
`SOURCE_DIRECTION_LABEL`) renders byte-for-byte identical to before in
every state screenshotted -- confirmed by direct comparison, not just
by not having edited that line.

**All four states, screenshotted for real** (mocked `getSourceDirection`
responses, `$B` headless browser, real DOM, real CSS):
- `interior` (confidence 0.71): compass -> WSW, solid arrow, `~4 km
  away`, `247°`, `Confidence: High`, both badges green/measured.
- `boundary_sector_fallback` (confidence 0.42, nowcast wind): compass ->
  SE, dashed arrow, `Direction only -- no distance estimate available`,
  `135°`, `Confidence: Moderate`, both badges dashed/estimated.
- `inconclusive` (confidence 0.04, below the 0.1 cutoff): no arrow shown
  (correct -- `isInconclusive()` still gates this entirely), `Direction
  inconclusive` / `Confidence: Uncertain` with the plain-language
  boundary-saturation explanation.
- `not_found`: unchanged empty state (this branch wasn't touched).

**Accessibility, all four states individually, not just one**: real
axe-core 4.9.1 scoped to the card found FIVE real WCAG AA color-contrast
failures across this file (`--text-dim` on dark card backgrounds,
~2.0-2.19:1 where 4.5:1 is required) -- two in newly-added elements
(the demoted degree readout; none from the compass SVG itself, which
has no text-contrast-checkable content), three in code carried over
unchanged from before this phase (the `idle`/`loading` state, the
`not_found` state, and the badge-timestamp caveat line -- the same
systemic `--text-dim` issue already found and fixed three times in
`PlumeVisualizer.jsx` during Phase U5). All five fixed (changed to
`--text-sub`) since the file was already open; re-scanned each of the
four states individually after fixing: zero violations in all four, not
inferred from one representative case. No console errors in any state.

**Threshold sanity check, done, not skipped**: `confidenceWord()`'s
High(>0.6)/Moderate(>0.3)/Uncertain bands were picked by feel, not from
data -- caught by a direct question. Checked against real historical
confidence values by re-running the exact real functions
(`load_nellore_wind_history`, `run_adjoint_tracer`) across the same real
744-hour Nellore archive PROMPT_FLOW_INTEGRATION.md's Phase I3 used. This
surfaced that Phase I3's own disclosed table was itself stale (see
`6f4416f`'s correction) -- the REAL current distribution (731 hours with
confidence > 0.1) is: High 692 (94.7%), Moderate 32 (4.4%), Uncertain-
but-shown 7 (1.0%). `Moderate` is a real, non-empty band (not dead code),
just a genuine minority -- a user will see "High" almost every time a
bearing is shown at all. Decision: keep 0.6/0.3 as-is -- this was a
sanity check to rule out an empty/unreachable band, not a request to
optimize the split, and the real data doesn't rule the bands out.
Also triggered two follow-up fixes for stale-statistic-driven copy this
phase had written: `6f4416f` (the doc itself) and `4187c8d`
(SourceDirectionPanel.jsx's inconclusive-state text, which had cited the
stale figure to claim commonality it doesn't have).

---

### Phase U7 — Trend/forecast visualization

```
Wire a real recharts line chart (already a project dependency, currently
unused per the Phase U0 audit) to the existing Holt-Winters forecast data
(lib/forecast.js / GET /api/forecast) -- show near-term trend visually
rather than only as the existing trend-badge text. Reuse FullscreenCard
as the container, matching every other dashboard section.

Real dev server, real screenshot with real or realistic mock data.
Commit on its own.
```

**Acceptance**: a real, working chart showing real forecast data,
screenshotted and verified.

**Outcome (done -- premise was stale, two real bugs fixed instead)**:
the phase text above is wrong that recharts was unused. The Phase U0
audit only listed it as a dependency, and `ForecastPanel.jsx` has
rendered a recharts `ComposedChart` of this exact forecast data inside
`FullscreenCard` since the initial commit. Verifying it for real found
two bugs:
- **Backend: 500 for any station with 3-23 readings.** `history_aqi`
  indexed `orderedDocs[length - 24 + i]`, which goes negative with fewer
  than 24 readings. The result was an `Invalid Date`, whose
  `toISOString()` threw. The frontend swallows forecast errors, so these
  stations showed "Loading forecast..." forever. Fixed by using each
  doc's own timestamp. The regression test in
  `backend/tests/forecast.test.js` fails 3 of 5 cases without the fix.
- **Frontend: confidence band drawn as 0..high, not low..high.** The
  band was a `high` area masked by a `--bg-deep`-filled `low` area. That
  mask rendered at recharts' default 0.6 fill-opacity over a card that
  isn't `--bg-deep`, so it showed up as a dark slab from 0 up to low.
  Replaced with a single range `<Area>` over `[aqi_low, aqi_high]`.

Verification: real Vite dev server against a mock `:4000` whose
`/api/forecast` ran the real `buildForecast()` over a stubbed Telemetry
model with a realistic diurnal PM series, at 72 readings and at 10
readings (the second case was a 500 before the fix). Headless `$B`
element screenshots were taken before and after. No console errors
beyond the deliberately unmocked endpoints' 404s. The live backend was
not started, because it would connect to the real Mongo and MQTT broker.

---

### Phase U8 — Source-composition breakdown (BLOCKED, do not start)

```
DO NOT START until cities/live_deployment.json has a real, non-empty
emission_sources inventory -- currently empty, confirmed earlier in this
project. TaggedTracerEngine's composition output (background %, category
%, unexplained %) has nothing meaningful to show without real source
data behind it. This phase is a placeholder until that dependency is
resolved -- revisit it then, don't build a UI for data that can't exist
yet.
```

---

### Phase U9 — Emission-rate gauge (BLOCKED, do not start)

```
DO NOT START until Phase I4's emission-rate estimation is actually wired
to a live backend route -- the CTM-side code is built and tested, but it
was never connected to a Node endpoint (deferred during tonight's
security work). Wire that route first, verify it end-to-end the same way
source-direction was, THEN build this gauge against real data. Once
unblocked, reuse Phase U1's ConfidenceBadge for its own confidence
fields, confirming that route's actual response shape by reading the
real model/route rather than assuming it mirrors SourceDirection's
shape.
```

---

### Phase U10 — polling cadence revisit

```
Revisit REFRESH_MS/FORECAST_MS-style fixed polling once real usage data
exists on how often source-direction/emission-rate documents actually
change (per Phase I3's disclosed ~9-in-10 no-estimate finding,
aggressive polling of an endpoint that rarely changes is wasted load) --
an actual measurement, not a guess, should set whatever interval (if
any) replaces the "poll on station change only" default Phase U3 ships
with.
```
