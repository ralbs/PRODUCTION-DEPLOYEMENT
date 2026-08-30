/*
 * India CPCB National AQI — subindex calculation.
 *
 * Breakpoints below are the published CPCB AQI breakpoint table for the
 * pollutants this board actually measures (PM2.5, PM10, NO2, O3, CO, NH3).
 * CPCB also defines SO2 and Pb breakpoints, but this board has no sensors for
 * those, so they're intentionally left out rather than faked.
 *
 * Units contract (per the telemetry API spec):
 *   - PM1 / PM2.5 / PM10           : µg/m³
 *   - NO2, O3, NH3, H2S, H2        : µg/m³
 *   - mq7_co (CO) / co             : µg/m³   (CPCB breakpoints use mg/m³ — see conversion below)
 *   - mq135                        : UNITLESS air-quality proxy (no single species)
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
 * impossible (a broken/uncalibrated sensor) are rejected by the sanity
 * ceilings so one bad channel can't poison the whole index.
 *
 * NOTE ON H2S / H2 / MQ135 / VOC: these four have NO official CPCB AQI
 * breakpoints. They are included in the index with INVENTED, non-standard
 * thresholds (band ranges tuned to each channel's typical sensor scale) per
 * operator request. Treat them as informational — they are NOT a standard
 * CPCB AQI contribution.
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
  nh3: [ // µg/m3, 24-hr avg — official CPCB
    [0, 200, 0, 50],
    [201, 400, 51, 100],
    [401, 800, 101, 200],
    [801, 1200, 201, 300],
    [1201, 1800, 301, 400],
    [1801, 5000, 401, 500],
  ],
  /* ---- INVENTED / NON-CPCB breakpoints (operator-requested) ---- */
  /*
   * Bands are tuned to each channel's observed firmware output scale so that
   * routine (noisy, uncalibrated) baseline readings land in Good/Satisfactory
   * and only genuinely elevated readings push the index higher. They do NOT
   * reflect any regulatory standard — informational only.
   */
  h2s: [ // µg/m3 (no CPCB AQI table — informational only)
    [0, 300, 0, 50],
    [301, 600, 51, 100],
    [601, 1200, 101, 200],
    [1201, 2500, 201, 300],
    [2501, 5000, 301, 400],
    [5001, 10000, 401, 500],
  ],
  h2: [ // µg/m3 (no CPCB AQI table — informational only)
    [0, 200, 0, 50],
    [201, 500, 51, 100],
    [501, 1500, 101, 200],
    [1501, 3000, 201, 300],
    [3001, 8000, 301, 400],
    [8001, 20000, 401, 500],
  ],
  mq135: [ // unitless proxy (no CPCB AQI table — informational only)
    [0, 1.0, 0, 50],
    [1.1, 2.0, 51, 100],
    [2.1, 3.0, 101, 200],
    [3.1, 4.0, 201, 300],
    [4.1, 5.0, 301, 400],
    [5.1, 10, 401, 500],
  ],
  voc_gas_ohm: [ // Ω (no CPCB AQI table — informational only)
    [0, 25000, 0, 50],
    [25001, 35000, 51, 100],
    [35001, 45000, 101, 200],
    [45001, 60000, 201, 300],
    [60001, 80000, 301, 400],
    [80001, 100000, 401, 500],
  ],
};

/*
 * Physically-plausible ceilings per channel. Gases/mq135/voc are all already
 * in the firmware's stored scale (µg/m³ for gases; mq135 is a unitless proxy;
 * voc_gas_ohm in Ω). Anything above these is a broken/uncalibrated sensor —
 * a single bad channel must not hijack the AQI. Note: values here must not
 * be lower than the top breakpoint band, or the top band would be unreachable.
 */
const SANITY_MAX = {
  pm1:     2000,    // µg/m³
  pm2_5:   1000,    // µg/m³
  pm10:    2000,    // µg/m³
  no2:     2000,    // µg/m³
  o3:      1000,    // µg/m³
  nh3:     5000,    // µg/m³ (matches top NH3 breakpoint)
  h2s:    10000,    // µg/m³ (matches top H2S breakpoint)
  h2:     20000,    // µg/m³ (matches top H2 breakpoint)
  mq135:     10,    // unitless proxy (matches top MQ135 breakpoint)
  co:     100000,   // µg/m³ (~100 mg/m³ CO; MiCS CO channel is -1/disabled)
  mq7_co: 100000,   // µg/m³ (~100 mg/m³ CO)
  voc_gas_ohm: 100000, // Ω (matches top VOC breakpoint)
};

/**
 * Return a copy of `pollutants` with invalid readings replaced by null:
 *   - null / undefined / NaN
 *   - ≤ 0  (firmware uses -1 as a "sensor fault / disabled" sentinel)
 *   - above the physically-plausible ceiling (broken/uncalibrated channel)
 * Every channel with a BREAKPOINTS entry is eligible for the AQI; the sanity
 * ceilings (not a trust whitelist) are what keep broken readings out.
 * Unknown keys are left untouched. Raw stored data is never mutated.
 */
function sanitizePollutants(pollutants) {
  if (!pollutants || typeof pollutants !== "object") return pollutants || {};
  const clean = { ...pollutants };

  for (const key of Object.keys(clean)) {
    clean[key] = sanitizeValue(clean[key], SANITY_MAX[key]);
  }
  return clean;
}

function sanitizeValue(v, max) {
  if (v == null || (typeof v === "number" && isNaN(v))) return null;
  if (typeof v === "number" && max != null && (v <= 0 || v > max)) return null;
  return v;
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
 *   All gas channels are already stored in µg/m³ (see units contract at top);
 *   mq135 is a unitless proxy and voc_gas_ohm is in Ω.
 */
function calculateAQI(pollutants) {
  if (!pollutants) return null;

  const clean = sanitizePollutants(pollutants);

  // CPCB breakpoints for CO are in mg/m³; the MQ-7 channel arrives in µg/m³.
  const coSource = clean.mq7_co != null ? clean.mq7_co : clean.co;
  const concentrations = {
    pm2_5: clean.pm2_5,
    pm10:  clean.pm10,
    no2:   clean.no2,   // µg/m³
    o3:    clean.o3,    // µg/m³
    co:    coSource != null ? coSource / 1000 : null, // µg/m³ -> mg/m³
    nh3:   clean.nh3,   // µg/m³
    h2s:   clean.h2s,   // µg/m³ (invented breakpoints)
    h2:    clean.h2,    // µg/m³ (invented breakpoints)
    mq135: clean.mq135, // unitless proxy (invented breakpoints)
    voc_gas_ohm: clean.voc_gas_ohm, // Ω (invented breakpoints)
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
