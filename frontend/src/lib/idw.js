const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Inverse distance weighting: estimates a value at (lat, lon) from a set of
 * known station readings, weighted by 1/distance^power. Points closer to the
 * target dominate the estimate — this is what makes the result read as
 * "the station's own value" right at a station and a blend of nearby
 * stations everywhere else.
 *
 * @param points   [{ lat, lon, value }] known station readings
 * @param nearestN if set, only the N closest points are used
 * @returns { value, minDist } or null if no points have a usable value
 */
export function idwInterpolate(points, lat, lon, { power = 2, nearestN = null } = {}) {
  if (!points.length) return null;

  let candidates = points.map((p) => ({ ...p, dist: haversineKm(lat, lon, p.lat, p.lon) }));

  // Within ~10m of a station, just report its reading directly rather than
  // letting 1/dist^power blow up.
  const exact = candidates.find((p) => p.dist < 0.01 && p.value != null);
  if (exact) return { value: exact.value, minDist: 0 };

  if (nearestN) {
    candidates = candidates.sort((a, b) => a.dist - b.dist).slice(0, nearestN);
  }

  let weightedSum = 0;
  let weightTotal = 0;
  let minDist = Infinity;

  for (const p of candidates) {
    if (p.value == null) continue;
    const w = 1 / Math.pow(p.dist, power);
    weightedSum += w * p.value;
    weightTotal += w;
    if (p.dist < minDist) minDist = p.dist;
  }

  if (weightTotal === 0) return null;
  return { value: weightedSum / weightTotal, minDist };
}
