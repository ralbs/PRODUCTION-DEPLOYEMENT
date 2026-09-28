// No-login personalisation: the viewer's own alert level, kept in this
// browser's localStorage only (there is no auth system, by design).
//
// The threshold applies to the CPCB AQI the hero leads with (HERO_SPEC.md
// s.1). The presets are not invented numbers -- each is the lower edge of
// the first CPCB category whose published impact (National AQI report,
// 2014, p.38; strings in heroModel.js CPCB) names that group:
//   sensitive -> Satisfactory (51): "...minor breathing discomfort to
//                sensitive people"
//   general   -> Poor (201): "...breathing discomfort to people on
//                prolonged exposure" -- the first not limited to a group
export const PRESETS = {
  general:   { label: "General public",   threshold: 201 },
  sensitive: { label: "Sensitive groups", threshold: 51 },
};
export const DEFAULT_PREF = { kind: "general" };
const KEY = "aqms.sensitivity.v1";

// Anything malformed (hand-edited storage, an old shape) falls back to the
// default rather than producing a nonsense threshold.
export function resolveSensitivity(pref) {
  if (pref?.kind === "custom") {
    const t = Number(pref.threshold);
    if (Number.isInteger(t) && t >= 1 && t <= 500) {
      return { kind: "custom", label: "Your own threshold", threshold: t };
    }
  }
  const kind = pref?.kind in PRESETS ? pref.kind : DEFAULT_PREF.kind;
  return { kind, ...PRESETS[kind] };
}

// localStorage can be missing or throw (private mode, blocked storage);
// the hero must still render, so every access is guarded.
export function loadSensitivity(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    return resolveSensitivity(raw ? JSON.parse(raw) : DEFAULT_PREF);
  } catch {
    return resolveSensitivity(DEFAULT_PREF);
  }
}

export function saveSensitivity(pref, storage = globalThis.localStorage) {
  const s = resolveSensitivity(pref);
  try {
    storage?.setItem(KEY, JSON.stringify(s.kind === "custom" ? { kind: "custom", threshold: s.threshold } : { kind: s.kind }));
  } catch { /* not persisted; still applies for this page view */ }
  return s;
}

// The personal sentence. It states only a comparison against the level the
// viewer chose -- no health actions (CPCB publishes impacts, not actions).
// Past tense when the reading is stale: it's about that reading, not now.
export function personalLine(aqi, mode, sens) {
  if (aqi == null || (mode !== "current" && mode !== "stale")) return null;
  const above = aqi >= sens.threshold;
  const level = `your alert level (AQI ${sens.threshold}+, ${sens.label.toLowerCase()})`;
  const subject = mode === "current" ? "This is" : "That reading was";
  return { above, text: `${subject} ${above ? "at or above" : "below"} ${level}.` };
}
