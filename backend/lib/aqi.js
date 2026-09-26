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
 * H2S / H2 / MQ135 / VOC ARE NOT PART OF THE AQI. None has an official CPCB
 * breakpoint table. They used to be scored with invented bands and fed into
 * the same max(), so a non-CPCB channel could set the headline number and be
 * reported as the dominant pollutant (NEL-001: 234 "Poor" from voc_gas_ohm,
 * where every real pollutant was <= 33). voc_gas_ohm was also scored
 * backwards -- per Bosch's BME680 datasheet (BST-BME680-DS001-09 s.4.2)
 * resistance FALLS as VOCs rise -- and raw ohms have no fixed scale at all.
 * They are now reported only by informationalReadings(), under a separate
 * API key, never as a sub-index and never as dominant_pollutant.
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
};

/*
 * Physically-plausible ceilings for the AQI's input channels, in the
 * firmware's stored scale (µg/m³). Anything above these is a broken/uncalibrated sensor —
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
  co:     100000,   // µg/m³ (~100 mg/m³ CO; MiCS CO channel is -1/disabled)
  mq7_co: 100000,   // µg/m³ (~100 mg/m³ CO)
};

/**
 * Return a copy of `pollutants` with invalid readings replaced by null:
 *   - null / undefined / NaN
 *   - ≤ 0  (firmware uses -1 as a "sensor fault / disabled" sentinel)
 *   - above the physically-plausible ceiling (broken/uncalibrated channel)
 * Only the six CPCB pollutants (BREAKPOINTS) are eligible for the AQI; the
 * sanity ceilings (not a trust whitelist) are what keep broken readings out.
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

  for (let k = 0; k < table.length; k++) {
    const [bLo, bHi, iLo, iHi] = table[k];
    if (concentration >= bLo && concentration <= bHi) {
      return Math.round(((iHi - iLo) / (bHi - bLo)) * (concentration - bLo) + iLo);
    }
    // The published bands leave a one-unit gap between them (PM2.5 0-30
    // then 31-60; CO 1.0 then 1.1). A reading strictly inside a gap (e.g.
    // PM2.5 30.5) belongs to the LOWER band -- the same result as
    // truncating to the table's precision first. Without this it matched
    // no band, returned null, and silently dropped out of the AQI max().
    const next = table[k + 1];
    if (next && concentration > bHi && concentration < next[0]) return iHi;
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
    // Only the six CPCB pollutants above. The four informational channels
    // are deliberately absent -- see informationalReadings() below.
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

/*
 * Sensor channels this board reports that have NO official CPCB AQI
 * breakpoints. Returned under their own `informational_readings` key, a
 * sibling of `aqi` in every API response -- never inside the AQI object,
 * never scored, never eligible as dominant_pollutant.
 */
const INFORMATIONAL_CHANNELS = {
  h2s:   { unit: "µg/m³", note: "No CPCB AQI breakpoints. Not part of the AQI." },
  h2:    { unit: "µg/m³", note: "No CPCB AQI breakpoints. Not part of the AQI." },
  mq135: { unit: "unitless", note: "MQ-135 multi-gas proxy, not a single pollutant. Not part of the AQI." },
  voc_gas_ohm: {
    unit: "Ω",
    note: "BME680 raw gas resistance, not a concentration. Resistance FALLS as VOCs rise (Bosch BME680 datasheet s.4.2); raw ohms have no fixed scale. Not part of the AQI.",
  },
};

/**
 * @param pollutants - display (calibrated, unfiltered) pollutants.
 * Missing / non-finite / <= 0 (the firmware's -1 fault sentinel) -> null.
 * No AQI sanity ceiling is applied: those exist to stop one bad channel
 * hijacking the AQI max(), which these channels never enter.
 */
function informationalReadings(pollutants) {
  const out = {};
  for (const [key, meta] of Object.entries(INFORMATIONAL_CHANNELS)) {
    const v = pollutants?.[key];
    const value = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    out[key] = { value, ...meta, in_official_aqi: false };
  }
  return out;
}

module.exports = {
  calculateAQI, sanitizePollutants, subIndex, aqiCategory, BREAKPOINTS,
  informationalReadings, INFORMATIONAL_CHANNELS,
};
