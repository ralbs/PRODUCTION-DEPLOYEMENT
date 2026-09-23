// Continuous color ramp across the CPCB AQI scale, anchored at the same
// breakpoints/colors used for the discrete category markers (see
// AQI_COLORS in MapPanel.jsx and backend/lib/aqi.js's aqiCategory()).
const STOPS = [
  { aqi: 0,   rgb: [34, 197, 94] },   // Good
  { aqi: 50,  rgb: [34, 197, 94] },   // Good (top of band)
  { aqi: 100, rgb: [132, 204, 22] },  // Satisfactory
  { aqi: 200, rgb: [234, 179, 8] },   // Moderate
  { aqi: 300, rgb: [249, 115, 22] },  // Poor
  { aqi: 400, rgb: [239, 68, 68] },   // Very Poor
  { aqi: 500, rgb: [153, 27, 27] },   // Severe
];

export function aqiToRgb(aqi) {
  if (aqi == null || isNaN(aqi)) return null;
  const v = Math.max(0, Math.min(500, aqi));

  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i].aqi) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const t = b.aqi === a.aqi ? 0 : (v - a.aqi) / (b.aqi - a.aqi);
      return a.rgb.map((c, idx) => Math.round(c + t * (b.rgb[idx] - c)));
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

// Mirrors backend/lib/aqi.js's BREAKPOINTS.pm2_5 + subIndex() exactly.
// frontend/ and backend/ are kept deliberately separate services (root
// CLAUDE.md), so this is a manual mirror, not a shared import -- keep the
// bLo/bHi/iLo/iHi rows in sync if the backend table ever changes.
const PM25_BREAKPOINTS = [
  [0, 30, 0, 50],
  [31, 60, 51, 100],
  [61, 90, 101, 200],
  [91, 120, 201, 300],
  [121, 250, 301, 400],
  [251, 380, 401, 500],
];

// PlumeVisualizer's dispersion grid holds raw µg/m³ PM2.5 concentration, not
// an AQI index -- this converts a grid cell's real concentration to the same
// AQI index space aqiToRgb() expects, so the plume overlay and the AQI
// badges/heatmap agree on what a given color means (PROMPT_FLOW_UI.md
// Phase U4's direction doc).
export function pm25ToAqi(concentration) {
  if (concentration == null || isNaN(concentration) || concentration < 0) return null;
  for (const [bLo, bHi, iLo, iHi] of PM25_BREAKPOINTS) {
    if (concentration >= bLo && concentration <= bHi) {
      return Math.round(((iHi - iLo) / (bHi - bLo)) * (concentration - bLo) + iLo);
    }
  }
  const lastBand = PM25_BREAKPOINTS[PM25_BREAKPOINTS.length - 1];
  if (concentration > lastBand[1]) return 500;
  return null;
}

// PROMPT_FLOW_UI.md Phase U5: shared by PlumeVisualizer.jsx's legend and
// MapPanel.jsx's real map overlay (the dispersion grid moved from a
// standalone canvas onto the map -- see MapPanel.jsx's own comment on why),
// so this conversion lives here once rather than duplicated in both.
export function pm25ToRgb(concentrationUgm3) {
  const aqi = pm25ToAqi(concentrationUgm3);
  return aqiToRgb(aqi) || [61, 74, 94]; // neutral gray, matches --text-dim family
}
