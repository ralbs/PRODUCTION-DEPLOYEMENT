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
met. Adapt each to the ACTUAL stack audited in Phase U0 rather than
generic advice:

- **Mobile/responsive pass on the new components specifically.** The
  existing breakpoints (1100px/768px/480px in index.css) are
  desktop-first grid collapses; the new bearing overlay and
  ConfidenceBadge need their own check at 400px width (this project's
  stated minimum), not just inheriting whatever MapPanel already does --
  a wedge overlay and two stacked badges inside a FullscreenCard at
  phone width is a real, unverified layout, not the same problem as the
  existing charts collapsing to one column.
- **Accessibility on the badge/pill idiom generally**, since Phase U1
  adds a THIRD semantic meaning (confidence) to a visual pattern
  (`category-pill`/`trend-badge`) that today encodes severity/trend via
  color alone -- confirm real contrast ratios for the new
  measured/estimated/stale treatments specifically (don't assume the
  existing palette's category colors, chosen for AQI severity, happen to
  pass contrast for this different purpose), and make sure the
  distinction isn't color-only (the existing icon/border requirement in
  Phase U1 already helps here, but verify it, don't assume it).
- **Extend emission-rate.js's GET /latest (confirm it exists first --
  see the open question from this repo's own prior session about
  whether it was added yet) into the same view or a sibling
  FullscreenCard**, reusing Phase U1's ConfidenceBadge for its own
  confidence fields once that route's actual response shape is
  confirmed by reading the real model/route, not assumed to mirror
  SourceDirection's shape.
- **Revisit REFRESH_MS/FORECAST_MS-style fixed polling** once real
  usage data exists on how often source-direction/emission-rate
  documents actually change (per Phase I3's disclosed ~9-in-10
  no-estimate finding, aggressive polling of an endpoint that rarely
  changes is wasted load) -- an actual measurement, not a guess, should
  set whatever interval (if any) replaces the "poll on station change
  only" default Phase U3 ships with.
