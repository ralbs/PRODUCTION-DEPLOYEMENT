/*
 * India CPCB National AQI — subindex calculation.
 *
 * Breakpoints below are the published CPCB AQI breakpoint table for the
 * pollutants this board actually measures (PM2.5, PM10, NO2, O3, CO).
 * CPCB also defines SO2, NH3, and Pb breakpoints, but this board has no
 * sensors for those, so they're intentionally left out rather than faked.
 *
 * AQI subindex formula (linear interpolation within a breakpoint band):
 *   Ip = ((IHi - ILo) / (BHi - BLo)) * (Cp - BLo) + ILo
 * Overall AQI = max(available subindices); the pollutant that produced
 * the max is reported as the "dominant pollutant".
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

// Sensor readings come out as ppm/µg mixes from estimatePPM() in the
// firmware; CPCB breakpoints are defined in µg/m3 (mg/m3 for CO). Convert
// at 25°C / 1 atm using the standard ppm→mass concentration formula:
//   mass_conc = ppm * (molecular_weight / 24.45)
const PPM_TO_UGM3 = {
  no2: 46.0055 * 1000 / 24.45, // -> µg/m3 per ppm
  o3: 48.0 * 1000 / 24.45,     // -> µg/m3 per ppm
  co: 28.01 / 24.45,           // -> mg/m3 per ppm
};

function subIndex(pollutant, concentration) {
  if (concentration == null || isNaN(concentration) || concentration < 0) return null;
  const table = BREAKPOINTS[pollutant];
  if (!table) return null;

  for (const [bLo, bHi, iLo, iHi] of table) {
    if (concentration >= bLo && concentration <= bHi) {
      return Math.round(((iHi - iLo) / (bHi - bLo)) * (concentration - bLo) + iLo);
    }
  }
  // Above the top published band — CPCB treats this as "severe", extrapolate
  // linearly past the last band rather than returning nothing.
  const [, bHi, , iHi] = table[table.length - 1];
  if (concentration > bHi) return Math.round(iHi + (concentration - bHi));
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
 * @param pollutants - the `pollutants` object from a telemetry document:
 *   { pm1, pm2_5, pm10, co, co2, no2, o3 }  (co/no2/o3 in ppm, PM in µg/m3)
 */
function calculateAQI(pollutants) {
  if (!pollutants) return null;

  const concentrations = {
    pm2_5: pollutants.pm2_5,
    pm10: pollutants.pm10,
    no2: pollutants.no2 != null ? pollutants.no2 * PPM_TO_UGM3.no2 : null,
    o3: pollutants.o3 != null ? pollutants.o3 * PPM_TO_UGM3.o3 : null,
    co: pollutants.co != null ? pollutants.co * PPM_TO_UGM3.co : null,
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

module.exports = { calculateAQI, subIndex, aqiCategory, BREAKPOINTS };
