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
