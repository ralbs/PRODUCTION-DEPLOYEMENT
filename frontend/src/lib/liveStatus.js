// The header's LIVE badge. It used to say "LIVE" unconditionally -- next
// to a hero saying there had been no reading for 19 days. It now uses the
// SAME freshness rule as the hero (STALE_AFTER_MIN), so the two can never
// disagree about whether data is current.
import { STALE_AFTER_MIN } from "./heroModel.js";

// Compact age for the header: "12m ago", "3h ago", "19d ago". Floors, like
// ConfidenceBadge and the hero's fmtAge.
function shortAge(ms) {
  const min = Math.floor(ms / 60e3);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// -> null while there's no reading to judge (loading), else
//    { live: true,  label: "LIVE" } or
//    { live: false, label: "OFFLINE", age: "19d ago" }
export function liveStatus(lastReadingAt, nowMs) {
  const t = Date.parse(lastReadingAt);
  if (!Number.isFinite(t)) return null;
  const ageMs = nowMs - t;
  if (ageMs <= STALE_AFTER_MIN * 60e3) return { live: true, label: "LIVE" };
  return { live: false, label: "OFFLINE", age: shortAge(ageMs) };
}
