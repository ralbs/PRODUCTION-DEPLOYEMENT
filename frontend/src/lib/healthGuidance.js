// THE ONLY PLACE HEALTH GUIDANCE TEXT LIVES. Every health statement the
// dashboard shows or speaks -- hero, advisory card, voice summary, alert
// toast -- is built here from published wording. healthGuidance.test.js
// scans the rest of src/ and fails if any other file carries advice.
//
// Why so strict: the dashboard used to invent actions ("Wear N95 mask
// outdoors", "Seal windows & doors", "Sensitive groups should stay
// indoors", "Evacuate outdoor spaces immediately"). CPCB publishes the
// HEALTH IMPACT of each AQI category, not actions; nothing here goes
// beyond what it publishes.

// SOURCE (impacts): Central Pollution Control Board, "National Air Quality
// Index" report (Oct 2014), p.38, table "AQI -- Associated Health Impacts".
// Quoted VERBATIM, including CPCB's own grammar -- do not edit these strings.
// https://cpcb.gov.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvRklOQUwtUkVQT1JUX0FRSV8ucGRm
// Category edges: same report's AQI table (and backend/lib/aqi.js aqiCategory()).
export const CPCB_IMPACT_SOURCE = "CPCB, National Air Quality Index (2014), p.38";

export const CPCB_BANDS = [
  { min: 0, max: 50, category: "Good", headline: "Air quality is Good.",
    impact: "Minimal Impact" },
  { min: 51, max: 100, category: "Satisfactory", headline: "Air quality is Satisfactory.",
    impact: "May cause minor breathing discomfort to sensitive people" },
  { min: 101, max: 200, category: "Moderately polluted", headline: "Air is moderately polluted.",
    impact: "May cause breathing discomfort to the people with lung disease such as asthma and discomfort to people with heart disease, children and older adults" },
  { min: 201, max: 300, category: "Poor", headline: "Air quality is Poor.",
    impact: "May cause breathing discomfort to people on prolonged exposure and discomfort to people with heart disease with short exposure" },
  { min: 301, max: 400, category: "Very Poor", headline: "Air quality is Very Poor.",
    impact: "May cause respiratory illness to the people on prolonged exposure. Effect may be more pronounced in people with lung and heart diseases" },
  { min: 401, max: Infinity, category: "Severe", headline: "Air quality is Severe.",
    impact: "May cause respiratory effects even on healthy people and serious health impacts on people with lung/heart diseases. The health impacts may be experienced even during light physical activity" },
];

export function cpcbBand(aqi) {
  return CPCB_BANDS.find((b) => aqi <= b.max);
}

// SOURCE (standards): National Ambient Air Quality Standards, CPCB
// notification, Gazette of India, 18 Nov 2009 (B-29016/20/90/PCI-I).
// Residential/industrial/rural column. Only the averaging period the
// dashboard names is listed. These are STANDARDS, not "safe limits" --
// the old card called them that, and mislabelled NO2 80 as annual (it's
// 24-hour; annual is 40) and CO 4 mg/m3 as 8-hour (it's 1-hour; 8-hour is 2).
export const NAAQS_SOURCE = "CPCB, National Ambient Air Quality Standards (2009)";
export const NAAQS = {
  pm2_5: { name: "PM2.5", standard: "60 µg/m³", period: "24-hour" },
  pm10:  { name: "PM10",  standard: "100 µg/m³", period: "24-hour" },
  no2:   { name: "NO₂",   standard: "80 µg/m³", period: "24-hour" },
  o3:    { name: "O₃",    standard: "100 µg/m³", period: "8-hour" },
  co:    { name: "CO",    standard: "2 mg/m³", period: "8-hour" },
  nh3:   { name: "NH₃",   standard: "400 µg/m³", period: "24-hour" },
};

// The advisory card's content. Impact only -- no actions, no invented
// per-group advice: CPCB's impact text already names the groups it means.
export function advisory(aqi, dominantPollutant) {
  if (aqi == null || !Number.isFinite(aqi)) return null;
  const band = cpcbBand(aqi);
  const std = dominantPollutant ? NAAQS[dominantPollutant] ?? null : null;
  return {
    category: band.category, headline: band.headline, impact: band.impact,
    source: CPCB_IMPACT_SOURCE,
    dominant: std && { ...std, source: NAAQS_SOURCE },
  };
}

// What the voice button says. Facts + CPCB's impact for the CURRENT
// reading; the trend is described as an extrapolation, and nothing is
// predicted about health. A stale reading is spoken in the past tense with
// its age, and gets no impact line and no trend -- same rule as the hero.
export function voiceSummary({ station, aqi, stale = false, age, trend, horizonHours, peak, peakTime }) {
  if (aqi == null || !Number.isFinite(aqi)) return null;
  const band = cpcbBand(aqi);
  if (stale) {
    return `No current reading from ${station ?? "this"} station. ` +
      `The last reading${age ? `, ${age},` : ""} was AQI ${aqi}, ${band.category}.`;
  }
  let text = `Air quality at ${station ?? "this"} station is AQI ${aqi}, ${band.category}. ` +
    `CPCB's health impact for this category: ${band.impact}.`;
  if (trend && horizonHours) text += ` Extrapolating the recent trend, the next ${horizonHours} hours look ${trend}.`;
  if (peak != null && peak > aqi && peakTime) text += ` The extrapolated peak is AQI ${peak} around ${peakTime}.`;
  return text;
}

// Upward crossing into a worse CPCB category -> the alert toast's text.
// Uses the real category edges (101, 201, 301, 401), not round numbers.
export function crossingAlert(prevAqi, aqi, station) {
  if (prevAqi == null || aqi == null) return null;
  const from = cpcbBand(prevAqi), to = cpcbBand(aqi);
  if (to.min <= from.min) return null;
  return {
    category: to.category,
    title: `AQI crossed ${to.min} — ${to.category}`,
    body: `${station ?? "Station"} AQI is now ${aqi}. CPCB: ${to.impact}.`,
  };
}
