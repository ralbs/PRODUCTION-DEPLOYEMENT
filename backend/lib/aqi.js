/*
 * India CPCB National AQI — subindex calculation.
 *
 * Breakpoints below are the published CPCB AQI breakpoint table for the
 * pollutants this board actually measures (PM2.5, PM10, NO2, O3, CO).
 * CPCB also defines SO2, NH3, and Pb breakpoints, but this board has no
 * sensors for those, so they're intentionally left out rather than faked.
 *
 * Units contract (per the telemetry API spec):
 *   - PM1 / PM2.5 / PM10           : µg/m³
 *   - NO2, O3, NH3, H2S, H2, mq135 : µg/m³
 *   - mq7_co (CO)                  : µg/m³   (CPCB breakpoints use mg/m³ — see conversion below)
 *   - voc_gas_ohm                  : Ω (BME680 raw gas resistance, informational)
 *   - `-1` / `null` / `NaN`        : sensor fault or disabled sensor → treated as missing
 *
 * AQI subindex formula (linear interpolation within a breakpoint band):
 *   Ip = ((IHi - ILo) / (BHi - BLo)) * (Cp - BLo) + ILo
 * Overall AQI = max(available subindices); the pollutant that produced
 * the max is reported as the "dominant pollutant".
 *
 * CPCB AQI is bounded 0..500. Concentrations beyond the top band are capped
 * at 500 rather than extrapolated, and readings that are physically
 * impossible (a broken/uncalibrated sensor) are rejected entirely so one bad
 * channel can't poison the whole index.
 */

const BREAKPOINTS = {
  pm2_5: [ // µg/m3, 24-hr avg
    [0, 30, 0, 50],
    [31, 60, 51, 100],
    [61, 90, 101, 200],
    [91, 120, 201, 300],
    [121, 250, 301, 400],
    [251, 380, 401, 500],
  ],
  pm10: [ // µg/m3, 24-hr avg
    [0, 50, 0, 50],
    [51, 100, 51, 100],
    [101, 250, 101, 200],
    [251, 350, 201, 300],
    [351, 430, 301, 400],
    [431, 550, 401, 500],
  ],
  no2: [ // µg/m3, 24-hr avg
    [0, 40, 0, 50],
    [41, 80, 51, 100],
    [81, 180, 101, 200],
    [181, 280, 201, 300],
    [281, 400, 301, 400],
    [401, 500, 401, 500],
  ],
  o3: [ // µg/m3, 8-hr avg
    [0, 50, 0, 50],
    [51, 100, 51, 100],
    [101, 168, 101, 200],
    [169, 208, 201, 300],
    [209, 748, 301, 400],
    [749, 1000, 401, 500],
  ],
  co: [ // mg/m3, 8-hr avg
    [0, 1.0, 0, 50],
    [1.1, 2.0, 51, 100],
    [2.1, 10, 101, 200],
    [10.1, 17, 201, 300],
    [17.1, 34, 301, 400],
    [34.1, 50, 401, 500],
  ],
};

/*
 * Physically-plausible ceilings per pollutant (µg/m³ for gases, mg/m³ for
 * co, µg/m³ for PM). Anything above these is a broken/uncalibrated sensor,
 * not a real reading — a single bad channel must not hijack the AQI.
 * CO: MQ-7 can legitimately read high near combustion, so allow up to
 * 100 mg/m³ (CPCB "Severe" band tops out at 50 mg/m³; this still rejects
 * the ppm-scale garbage seen from uncalibrated firmware).
 */
const SANITY_MAX = {
  pm1:     2000,    // µg/m³
  pm2_5:   1000,    // µg/m³
  pm10:    2000,    // µg/m³
  no2:     2000,    // µg/m³
  o3:      1000,    // µg/m³
  nh3:     3000,    // µg/m³
  h2s:     2000,    // µg/m³
  h2:      5000,    // µg/m³
  mq135:  10000,    // µg/m³ (generic air-quality proxy — generous)
  co:     100000,   // µg/m³ (~100 mg/m³ CO; MiCS CO channel is -1/disabled)
  mq7_co: 100000,   // µg/m³ (~100 mg/m³ CO)
};

/*
 * Gas channels are only trusted after the firmware's estimatePPM() model is
 * properly calibrated. Instead of a single global on/off switch, trust is
 * granted PER CHANNEL via the TRUSTED_GAS_CHANNELS env var (comma-separated).
 * This lets a genuinely calibrated channel (e.g. MQ-7 CO after a KSPCB fit)
 * enter the AQI while the un-calibratable channels stay permanently nulled:
 * NO₂ / NH₃ have their signal buried in ±10% noise, O₃ is a hardware fault,
 * and H₂S / H₂ / MQ-135 have no reference to fit against.
 * Example: TRUSTED_GAS_CHANNELS=mq7_co
 */
const GAS_POLLUTANTS = ["no2", "o3", "nh3", "h2s", "h2", "mq135", "co", "mq7_co"];
const TRUSTED_GAS_CHANNELS = new Set(
  (process.env.TRUSTED_GAS_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * Return a copy of `pollutants` with invalid readings replaced by null:
 *   - null / undefined / NaN
 *   - ≤ 0  (firmware uses -1 as a "sensor fault / disabled" sentinel)
 *   - above the physically-plausible ceiling (broken/uncalibrated channel)
 * Unknown keys are left untouched. Raw stored data is never mutated.
 */
function sanitizePollutants(pollutants) {
  if (!pollutants || typeof pollutants !== "object") return pollutants || {};
  const clean = { ...pollutants };

  for (const key of Object.keys(clean)) {
    if (GAS_POLLUTANTS.includes(key) && !TRUSTED_GAS_CHANNELS.has(key)) {
      clean[key] = null;
      continue;
    }
    const v = clean[key];
    if (v == null || (typeof v === "number" && isNaN(v))) {
      clean[key] = null;
      continue;
    }
    const max = SANITY_MAX[key];
    if (typeof v === "number" && max != null && (v <= 0 || v > max)) {
      clean[key] = null;
    }
  }
  return clean;
}

function subIndex(pollutant, concentration) {
  if (concentration == null || isNaN(concentration) || concentration < 0) return null;
  const table = BREAKPOINTS[pollutant];
  if (!table) return null;

  for (const [bLo, bHi, iLo, iHi] of table) {
    if (concentration >= bLo && concentration <= bHi) {
      return Math.round(((iHi - iLo) / (bHi - bLo)) * (concentration - bLo) + iLo);
    }
  }
  // Above the top published band — cap at the CPCB AQI maximum of 500 rather
  // than extrapolating unbounded (which let a garbage reading produce AQI ~30M).
  if (concentration > table[table.length - 1][1]) return 500;
  return null;
}

function aqiCategory(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Satisfactory";
  if (aqi <= 200) return "Moderate";
  if (aqi <= 300) return "Poor";
  if (aqi <= 400) return "Very Poor";
  return "Severe";
}

/**
 * @param pollutants - the `pollutants` object from a telemetry document.
 *   All gas channels are already in µg/m³ (see units contract at top).
 */
function calculateAQI(pollutants) {
  if (!pollutants) return null;

  const clean = sanitizePollutants(pollutants);

  // CPCB breakpoints for CO are in mg/m³; the MQ-7 channel arrives in µg/m³.
  const coSource = clean.mq7_co != null ? clean.mq7_co : clean.co;
  const concentrations = {
    pm2_5: clean.pm2_5,
    pm10:  clean.pm10,
    no2:   clean.no2,   // already µg/m³
    o3:    clean.o3,    // already µg/m³
    co:    coSource != null ? coSource / 1000 : null, // µg/m³ -> mg/m³
  };

  const subIndices = {};
  let dominant = null;
  let maxAqi = -1;

  for (const [pollutant, conc] of Object.entries(concentrations)) {
    const idx = subIndex(pollutant, conc);
    subIndices[pollutant] = idx;
    if (idx != null && idx > maxAqi) {
      maxAqi = idx;
      dominant = pollutant;
    }
  }

  if (maxAqi < 0) return null;

  return {
    aqi: maxAqi,
    category: aqiCategory(maxAqi),
    dominant_pollutant: dominant,
    sub_indices: subIndices,
  };
}

module.exports = { calculateAQI, sanitizePollutants, subIndex, aqiCategory, BREAKPOINTS };
