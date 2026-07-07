/*
 * Gaussian plume dispersion model (Pasquill-Gifford / Briggs rural
 * dispersion coefficients).
 *
 *   C(x,y,z) = Q / (2*pi*u*sy*sz)
 *              * exp(-y^2 / (2*sy^2))
 *              * [ exp(-(z-H)^2 / (2*sz^2)) + exp(-(z+H)^2 / (2*sz^2)) ]
 *
 * This estimates ground/receptor-level concentration downwind of a
 * continuous point source (a stack, a fire, a leak) given emission rate,
 * wind speed, and atmospheric stability. It is a standard screening-level
 * model (the basis for older regulatory tools like ISCST3) — good for
 * "how far does this plume travel and how strong is it downwind", NOT a
 * substitute for a full regulatory model like AERMOD when compliance
 * decisions are on the line, and it assumes flat terrain and steady wind.
 *
 * This board has no wind sensor, so wind speed/direction/stability must
 * come from an external source (weather API, on-site anemometer, or a
 * manual estimate) — the AQMS pollutant readings are the *receptor*
 * measurements you'd compare a plume prediction against, not an input
 * to it.
 */

// Briggs (1973) rural dispersion coefficients, x in meters, sigma in meters.
// Stability classes A (very unstable) through F (very stable).
const BRIGGS_RURAL = {
  A: {
    sy: (x) => 0.22 * x * Math.pow(1 + 0.0001 * x, -0.5),
    sz: (x) => 0.20 * x,
  },
  B: {
    sy: (x) => 0.16 * x * Math.pow(1 + 0.0001 * x, -0.5),
    sz: (x) => 0.12 * x,
  },
  C: {
    sy: (x) => 0.11 * x * Math.pow(1 + 0.0001 * x, -0.5),
    sz: (x) => 0.08 * x * Math.pow(1 + 0.0002 * x, -0.5),
  },
  D: {
    sy: (x) => 0.08 * x * Math.pow(1 + 0.0001 * x, -0.5),
    sz: (x) => 0.06 * x * Math.pow(1 + 0.0015 * x, -0.5),
  },
  E: {
    sy: (x) => 0.06 * x * Math.pow(1 + 0.0001 * x, -0.5),
    sz: (x) => 0.03 * x * Math.pow(1 + 0.0003 * x, -1),
  },
  F: {
    sy: (x) => 0.04 * x * Math.pow(1 + 0.0001 * x, -0.5),
    sz: (x) => 0.016 * x * Math.pow(1 + 0.0003 * x, -1),
  },
};

/**
 * Estimate Pasquill stability class from wind speed and insolation, per
 * the standard Pasquill-Turner lookup. `solarElevation` is a simple
 * day/night + intensity proxy since this board has no pyranometer.
 */
function estimateStabilityClass(windSpeedMs, { isDaytime = true, strongSun = true } = {}) {
  if (isDaytime) {
    if (windSpeedMs < 2) return strongSun ? "A" : "B";
    if (windSpeedMs < 3) return strongSun ? "B" : "C";
    if (windSpeedMs < 5) return "C";
    if (windSpeedMs < 6) return "D";
    return "D";
  }
  if (windSpeedMs < 3) return "F";
  if (windSpeedMs < 5) return "E";
  return "D";
}

function sigmas(stabilityClass, x) {
  const cls = BRIGGS_RURAL[stabilityClass] || BRIGGS_RURAL.D;
  return { sy: cls.sy(x), sz: cls.sz(x) };
}

/**
 * @param Q  emission rate (mass/time, e.g. g/s or µg/s — output units match)
 * @param u  wind speed at stack height (m/s), must be > 0
 * @param H  effective stack/source height (m)
 * @param x  downwind distance along plume centerline (m), must be > 0
 * @param y  crosswind distance from centerline (m), default 0
 * @param z  receptor height above ground (m), default 0 (ground level)
 * @param stabilityClass  "A".."F"
 * @returns concentration in the same mass unit as Q, per m^3
 */
function concentrationAt({ Q, u, H, x, y = 0, z = 0, stabilityClass = "D" }) {
  if (x <= 0) return 0;
  if (u <= 0) throw new Error("Wind speed must be > 0 for a Gaussian plume estimate");

  const { sy, sz } = sigmas(stabilityClass, x);
  if (sy <= 0 || sz <= 0) return 0;

  const crosswindTerm = Math.exp(-(y * y) / (2 * sy * sy));
  const verticalTerm =
    Math.exp(-Math.pow(z - H, 2) / (2 * sz * sz)) +
    Math.exp(-Math.pow(z + H, 2) / (2 * sz * sz));

  return (Q / (2 * Math.PI * u * sy * sz)) * crosswindTerm * verticalTerm;
}

/**
 * Ground-level centerline concentration profile at a series of downwind
 * distances — the common "how does concentration fall off with distance"
 * curve for charting.
 */
function centerlineProfile({ Q, u, H, stabilityClass = "D", distances }) {
  return distances.map((x) => ({
    x,
    concentration: concentrationAt({ Q, u, H, x, y: 0, z: 0, stabilityClass }),
  }));
}

/**
 * 2D ground-level concentration grid for a contour/heatmap plot.
 */
function concentrationGrid({ Q, u, H, stabilityClass = "D", xRange, yRange, xSteps = 30, ySteps = 20 }) {
  const [xMin, xMax] = xRange;
  const [yMin, yMax] = yRange;
  const dx = (xMax - xMin) / xSteps;
  const dy = (yMax - yMin) / ySteps;

  const points = [];
  for (let i = 0; i <= xSteps; i++) {
    const x = xMin + i * dx;
    if (x <= 0) continue;
    for (let j = 0; j <= ySteps; j++) {
      const y = yMin + j * dy;
      points.push({
        x,
        y,
        concentration: concentrationAt({ Q, u, H, x, y, z: 0, stabilityClass }),
      });
    }
  }
  return points;
}

module.exports = {
  concentrationAt,
  centerlineProfile,
  concentrationGrid,
  estimateStabilityClass,
  BRIGGS_RURAL,
};
