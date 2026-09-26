// Header caption for the Pollution Dispersion card. It used to be the fixed
// string "Auto-calculated from live data", shown even when no live wind
// existed and no plume was drawn -- a label contradicting the honest empty
// state below it (same bug class as the old "CPCB daily average" table label).
//
// Mirrors PlumeVisualizer's own gating exactly: a plume is only computed with
// live wind > 0 m/s AND a sensor reading. When one IS drawn, the caption says
// what it's really built from: LIVE wind, but the station's LATEST reading
// (which can be old -- NEL-001's is from 2026-09-08), not "live data".
export function plumeCardMeta(wind, latest) {
  if (wind?.status === "loading") return "Loading live wind…";
  if (wind?.status !== "ok") return "Not calculated — no live wind";
  if (!(wind.data?.speed_m_s > 0)) return "Not calculated — calm air";
  if (!latest?.pollutants) return "Not calculated — no sensor reading";
  return "From live wind + latest reading";
}
