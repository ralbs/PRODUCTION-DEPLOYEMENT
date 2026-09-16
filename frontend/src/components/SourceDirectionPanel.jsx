import ConfidenceBadge from "./ConfidenceBadge";
import { isInconclusive, INCONCLUSIVE_CONFIDENCE } from "../lib/sourceDirection";

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

/**
 * @param state - { status: "idle"|"loading"|"ok"|"not_found"|"error", doc, error }
 *   `doc` is the real SourceDirection document from GET /api/source-direction/latest.
 */
export default function SourceDirectionPanel({ state }) {
  const { status, doc, error } = state;

  if (status === "idle" || status === "loading") {
    return <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 12 }}>Checking for a directional estimate…</div>;
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
      <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 12, lineHeight: 1.7 }}>
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
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.6 }}>
              confidence {doc.confidence.toFixed(2)} (at or below the {INCONCLUSIVE_CONFIDENCE} screening
              threshold) -- the adjoint trace was boundary-saturated
              ({(doc.boundary_inflow_fraction * 100).toFixed(0)}% boundary inflow). This is a real,
              expected outcome at the currently shipped domain size (see
              PROMPT_FLOW_INTEGRATION.md's Phase I3 saturation sweep), not a bug -- no bearing is
              shown because none would be trustworthy.
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 26, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text)" }}>
            {doc.bearing_deg.toFixed(1)}&deg; <span style={{ fontSize: 15, color: "var(--text-sub)" }}>({compassPoint(doc.bearing_deg)})</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 3 }}>
            {doc.estimate_tier === "interior"
              ? <>~{(doc.distance_m / 1000).toFixed(1)} km upwind</>
              : "distance not available -- compass sector only"}
          </div>
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
      <div style={{ fontSize: 9, color: "var(--text-dim)" }}>
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
