import ConfidenceBadge from "./ConfidenceBadge";
import { isInconclusive } from "../lib/sourceDirection";

// PROMPT_FLOW_UI.md Phase U3 -- first real end-to-end use of ConfidenceBadge
// on genuinely new data (Phase U2 was a retrofit onto an already-working
// caption). Two independent real confidence dimensions exist on every
// SourceDirection document (backend/models/SourceDirection.js) and are
// shown as two separate badges, never collapsed into one:
//   1. estimate_tier -- "interior" (real probability-weighted centroid,
//      real distance) vs "boundary_sector_fallback" (compass sector only,
//      no distance -- see the model's own comment on why distance_m is
//      null there, never a fabricated number).
//   2. wind.source_tier -- "historical_ground_station" (real measured
//      wind) vs "live_model_nowcast" (a real but MODELED nowcast).
const TIER_LABEL = {
  interior: "INTERIOR TRACE",
  boundary_sector_fallback: "SECTOR FALLBACK",
};

const WIND_TIER_LABEL = {
  historical_ground_station: "GROUND STATION WIND",
  live_model_nowcast: "MODEL NOWCAST WIND",
};

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
function compassPoint(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// PROMPT_FLOW_UI.md Phase U6: qualitative confidence, replacing the raw
// 0-1 score as the primary readout (still available in the raw document
// for anyone reading it directly). Bands chosen so "Uncertain" only
// covers the range just above isInconclusive()'s own cutoff
// (INCONCLUSIVE_CONFIDENCE, 0.1) -- below that, the inconclusive branch
// below takes over entirely and no direction is shown at all. Note
// doc.confidence means something different per tier (interior:
// 1-boundary_inflow_fraction; boundary fallback: sector concentration --
// see SourceDirection.js's own field comment), but both are already
// real confidence-flavored quantities on a 0-1 scale, so one qualitative
// scale over both is a reasonable plain-language gauge, not a conflation
// of unrelated numbers.
function confidenceWord(confidence) {
  if (confidence > 0.6) return "High";
  if (confidence > 0.3) return "Moderate";
  return "Uncertain";
}

// Simple compass + arrow, replacing the old hero-sized raw degree number.
// Dashed/hollow arrowhead for boundary_sector_fallback (no real distance
// behind it) vs. solid for interior -- same structural, not cosmetic,
// distinction Phase U3's map wedge already draws, carried into this
// panel's own visual rather than dropped when the presentation changed.
function CompassArrow({ bearingDeg, dashed }) {
  return (
    <svg width="72" height="72" viewBox="0 0 100 100" style={{ flexShrink: 0 }}>
      <circle cx="50" cy="50" r="44" fill="none" stroke="var(--border)" strokeWidth="2" />
      <text x="50" y="13" textAnchor="middle" fontSize="9" fill="var(--text-dim)" fontFamily="var(--font-mono)">N</text>
      <text x="90" y="54" textAnchor="middle" fontSize="9" fill="var(--text-dim)" fontFamily="var(--font-mono)">E</text>
      <text x="50" y="97" textAnchor="middle" fontSize="9" fill="var(--text-dim)" fontFamily="var(--font-mono)">S</text>
      <text x="10" y="54" textAnchor="middle" fontSize="9" fill="var(--text-dim)" fontFamily="var(--font-mono)">W</text>
      {/* bearing_deg is a compass bearing (0=N, clockwise) -- SVG rotate()
          is also clockwise in screen space, so no sign flip is needed to
          match the arrow's rotation to the real bearing. */}
      <g transform={`rotate(${bearingDeg} 50 50)`}>
        <line x1="50" y1="50" x2="50" y2="18" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={dashed ? "4 4" : undefined} />
        <polygon points="50,9 43,23 57,23" fill={dashed ? "none" : "var(--accent)"}
          stroke={dashed ? "var(--accent)" : "none"} strokeWidth={dashed ? 2 : 0} />
      </g>
      <circle cx="50" cy="50" r="4" fill="var(--accent)" />
    </svg>
  );
}

/**
 * @param state - { status: "idle"|"loading"|"ok"|"not_found"|"error", doc, error }
 *   `doc` is the real SourceDirection document from GET /api/source-direction/latest.
 */
export default function SourceDirectionPanel({ state }) {
  const { status, doc, error } = state;

  // --text-dim on --bg-card fails WCAG AA (2.19:1, needs 4.5:1) -- same
  // finding fixed throughout this file's other states, applied here too.
  if (status === "idle" || status === "loading") {
    return <div style={{ padding: 20, color: "var(--text-sub)", fontSize: 12 }}>Checking for a directional estimate…</div>;
  }

  if (status === "error") {
    return <div style={{ padding: 20, color: "#f87171", fontSize: 12 }}>{error}</div>;
  }

  if (status === "not_found") {
    // A real, expected, non-error state -- per PROMPT_FLOW_INTEGRATION.md's
    // own disclosed finding, most real hours never produce an estimate at
    // all (the worker only runs the tracer on a real statistical spike).
    // This is NOT a generic error state and must not look like one.
    return (
      <div style={{ padding: 20, color: "var(--text-sub)", fontSize: 12, lineHeight: 1.7 }}>
        No directional estimate yet for this station. This screening feature
        only runs when a real statistical spike is detected in the station's
        readings -- most hours produce no estimate at all, which is expected
        behavior, not a failure.
      </div>
    );
  }

  const inconclusive = isInconclusive(doc);

  return (
    <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
      {inconclusive ? (
        <div style={{
          padding: "12px 14px", borderRadius: 10, display: "flex", gap: 10, alignItems: "flex-start",
          background: "rgba(148,163,184,0.06)", border: "1px dashed var(--text-dim)",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 17h.01" />
          </svg>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-sub)" }}>Direction inconclusive</div>
            {/* --text-dim here is the same pre-existing WCAG AA contrast
                failure (2.0:1, needs 4.5:1) the original raw-percentage
                version of this text already had -- fixed while rewriting
                this block for Phase U6.

                Wording corrected after a real re-sweep of
                PROMPT_FLOW_INTEGRATION.md's Phase I3 data (done verifying
                this session's confidenceWord() thresholds): the original
                text here claimed this was "a real, expected outcome ...
                not a bug", implying it's common. A fresh sweep of the
                same real 744-hour archive against the CURRENT code (the
                doc's own table was stale, written before commit e1fbe37
                added the boundary-fallback path) found confidence<=0.1
                only 1.7% of the time now, not the dominant case -- so
                this branch is genuinely uncommon, and the copy must not
                claim otherwise just because it once was. */}
            <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 3, lineHeight: 1.6 }}>
              Confidence: <strong style={{ color: "var(--text-sub)" }}>Uncertain</strong> -- the simulated
              plume mostly exited the edge of the modeled area rather than pointing to a clear source,
              leaving too little signal to trust a direction (see PROMPT_FLOW_INTEGRATION.md's Phase I3
              finding) -- not a bug, but not the common case either.
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <CompassArrow bearingDeg={doc.bearing_deg} dashed={doc.estimate_tier !== "interior"} />
          <div>
            <div style={{ fontSize: 22, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text)" }}>
              {compassPoint(doc.bearing_deg)}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 3 }}>
              {doc.estimate_tier === "interior"
                ? <>~{Math.max(1, Math.round(doc.distance_m / 1000))} km away</>
                : "Direction only -- no distance estimate available"}
            </div>
            {/* --text-dim on this card's bg fails WCAG AA (2.19:1, needs
                4.5:1) -- same finding as the two divs fixed above, caught
                by the same axe scan since this element is new in U6. */}
            <div style={{ fontSize: 10, color: "var(--text-sub)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
              {doc.bearing_deg.toFixed(0)}&deg;
            </div>
          </div>
        </div>
      )}

      {!inconclusive && (
        <div style={{ fontSize: 11, color: "var(--text-sub)" }}>
          Confidence: <strong style={{ color: "var(--text)" }}>{confidenceWord(doc.confidence)}</strong>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <ConfidenceBadge
          state={doc.estimate_tier === "interior" ? "measured" : "estimated"}
          label={TIER_LABEL[doc.estimate_tier] || doc.estimate_tier}
          timestamp={doc.timestamp}
        />
        <ConfidenceBadge
          state={doc.wind.source_tier === "historical_ground_station" ? "measured" : "estimated"}
          label={WIND_TIER_LABEL[doc.wind.source_tier] || doc.wind.source_tier}
          timestamp={doc.wind.as_of}
        />
      </div>
      {/* --text-dim on this card's bg is the same real WCAG AA contrast
          failure (2.19:1, needs 4.5:1) found and fixed twice already in
          PlumeVisualizer.jsx during Phase U5 -- pre-existing here too
          (unchanged by this phase's own edits, confirmed via git diff),
          fixed here since the file is already open for the same reason. */}
      <div style={{ fontSize: 9, color: "var(--text-sub)" }}>
        Left badge ages from the triggering reading's timestamp; right badge ages from the wind window's own timestamp -- these can differ.
      </div>

      {/* Server-authoritative caveat text, verbatim -- never paraphrased,
          matching backend/lib/windSource.js's own comment on why. */}
      <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6 }}>
        {doc.wind.source_label}
      </div>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: "0.4px", color: "var(--poor)",
        textTransform: "uppercase", paddingTop: 10, borderTop: "1px solid var(--border)",
      }}>
        {doc.label}
      </div>
    </div>
  );
}
