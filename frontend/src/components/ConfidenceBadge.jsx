import { useEffect, useState } from "react";

// PROMPT_FLOW_UI.md Phase U1 -- the structural confidence-treatment
// component root CLAUDE.md requires for every CTM-derived value: a
// visually distinct state for "estimated" vs "measured" (never a caption
// underneath a normal-looking number -- captions get skimmed past, see
// PlumeVisualizer.jsx's ParamItem `sub` strings this replaces in Phase U2),
// plus a staleness indicator relative to the data's actual expected
// cadence, not a bare timestamp.
//
// `stale` is a third, visually-overriding state layered on top of
// measured/estimated: once age exceeds the caller's expected cadence (or
// an explicit staleAfterMinutes), the badge switches to the stale
// treatment regardless of whether the underlying value was measured or
// estimated -- an old measurement is not "confidently measured" anymore,
// it's stale, and that has to be structural too.

function formatAgo(ageSeconds) {
  if (ageSeconds < 60) return `${Math.max(0, Math.round(ageSeconds))}s ago`;
  const ageMin = ageSeconds / 60;
  if (ageMin < 60) return `${Math.floor(ageMin)}m ago`;
  const ageHr = ageMin / 60;
  if (ageHr < 24) return `${Math.floor(ageHr)}h ago`;
  return `${Math.floor(ageHr / 24)}d ago`;
}

function formatDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 1) return "<1m";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  return `${mm}m`;
}

// Ticks every 15s -- fine-grained enough for "Xs ago" early on without
// re-rendering every card on the page every second.
function useStaleness(timestamp, cadenceMinutes, staleAfterMinutes) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!timestamp) return;
    const t = setInterval(() => forceTick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, [timestamp]);

  if (!timestamp) return { ageText: null, nextText: null, isStale: false };

  const ageSeconds = (Date.now() - new Date(timestamp).getTime()) / 1000;
  const ageMinutes = ageSeconds / 60;
  const ageText = formatAgo(ageSeconds);

  let nextText = null;
  if (cadenceMinutes) {
    const remaining = cadenceMinutes - ageMinutes;
    nextText = remaining > 0
      ? `next in ~${formatDuration(remaining)}`
      : `overdue by ${formatDuration(-remaining)}`;
  }

  // No cadence/threshold supplied -> never flag stale rather than guess
  // one (see PROMPT_FLOW_UI.md Phase U1: "don't fake a cadence if the
  // caller doesn't supply one").
  const threshold = staleAfterMinutes ?? (cadenceMinutes ? cadenceMinutes * 2 : null);
  const isStale = threshold != null && ageMinutes > threshold;

  return { ageText, nextText, isStale };
}

const ICONS = {
  measured: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  estimated: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="3 3">
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
  stale: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  ),
};

const DEFAULT_LABELS = { measured: "MEASURED", estimated: "ESTIMATED", stale: "STALE" };

/**
 * @param {"measured"|"estimated"} state - the value's real provenance
 * @param {string|Date} timestamp - when the value was produced/observed
 * @param {number} [cadenceMinutes] - expected update interval, if any; enables "next in ~..." and stale detection
 * @param {number} [staleAfterMinutes] - explicit override for the stale threshold instead of deriving from cadenceMinutes
 * @param {string} [label] - short text override for the pill (defaults to the state name)
 */
export default function ConfidenceBadge({ state, timestamp, cadenceMinutes, staleAfterMinutes, label }) {
  const { ageText, nextText, isStale } = useStaleness(timestamp, cadenceMinutes, staleAfterMinutes);
  const effectiveState = isStale ? "stale" : state;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span className={`confidence-badge ${effectiveState}`}>
        <span className="confidence-badge-icon">{ICONS[effectiveState]}</span>
        {label || DEFAULT_LABELS[effectiveState]}
      </span>
      {ageText && (
        <span className="freshness-bar">
          <span className={`freshness-dot${isStale ? " stale" : ""}`} />
          {ageText}{nextText ? ` · ${nextText}` : ""}
        </span>
      )}
    </span>
  );
}
