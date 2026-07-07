const express = require("express");
const {
  concentrationAt,
  centerlineProfile,
  estimateStabilityClass,
} = require("../lib/plume");

const router = express.Router();

/*
 * POST /api/plume/estimate
 *
 * Body (all optional except Q, u, H):
 *   Q             – emission rate g/s
 *   u             – wind speed m/s  (must be > 0)
 *   H             – effective source height m
 *   stabilityClass – "A"–"F"; omit to auto-derive from u + isDaytime
 *   isDaytime     – bool, used only when stabilityClass is omitted (default true)
 *   windDir       – compass bearing of the wind direction in degrees (echoed back)
 *   maxDistance   – downwind extent of the grid in metres (default 5000)
 *   grid          – if true, include a normalized 2D concentration grid
 *   xSteps        – grid columns (default 80)
 *   ySteps        – grid rows   (default 60)
 *
 * Response:
 *   cls           – stability class used (A–F)
 *   windDir       – echoed back for canvas annotation
 *   maxC_ugm3     – peak ground-level concentration across the entire 2D grid (µg/m³)
 *   peakX_m       – downwind distance at peak centerline concentration (m)
 *   centerline    – [{x, c_ugm3}] ground-level centerline profile
 *   grid          – [{i, j, t}] only when grid=true
 *                     i = column index (0 = source, xSteps = maxDistance)
 *                     j = row index    (0 = top crosswind edge, ySteps = bottom)
 *                     t = normalised concentration [0, 1]  (1 = peak)
 *   gridMeta      – {xSteps, ySteps, maxDist, halfY}
 */
router.post("/estimate", (req, res) => {
  const {
    Q,
    u,
    H,
    stabilityClass,
    isDaytime = true,
    windDir = 270,
    maxDistance = 5000,
    grid = false,
    xSteps = 80,
    ySteps = 60,
  } = req.body || {};

  if (Q == null || u == null || H == null)
    return res.status(400).json({ error: "Q, u, and H are required" });

  const Qn = Number(Q), un = Number(u), Hn = Number(H);
  const maxDist = Number(maxDistance), xs = Number(xSteps), ys = Number(ySteps);

  if (un <= 0)
    return res.status(400).json({ error: "Wind speed u must be > 0" });
  if (Qn <= 0)
    return res.status(400).json({ error: "Emission rate Q must be > 0" });

  const cls = stabilityClass || estimateStabilityClass(un, { isDaytime });

  // ── Centerline profile (50 steps) ─────────────────────────────────────────
  const profileSteps = 50;
  const distances = Array.from({ length: profileSteps }, (_, k) =>
    Math.round((maxDist / profileSteps) * (k + 1))
  );
  const profile = centerlineProfile({ Q: Qn, u: un, H: Hn, stabilityClass: cls, distances });
  const peakEntry = profile.reduce(
    (best, p) => (p.concentration > best.concentration ? p : best),
    profile[0]
  );

  const response = {
    cls,
    windDir: Number(windDir),
    maxC_ugm3: +(peakEntry.concentration * 1e6).toFixed(3),
    peakX_m: peakEntry.x,
    centerline: profile.map((p) => ({
      x: p.x,
      c_ugm3: +(p.concentration * 1e6).toFixed(4),
    })),
  };

  // ── 2D grid ───────────────────────────────────────────────────────────────
  if (grid) {
    const halfY = maxDist / 3;
    const dx = maxDist / xs;
    const dy = (2 * halfY) / ys;

    // Compute every cell; track global max for normalisation
    const cells = [];
    let gridMaxC = 0;

    for (let i = 0; i <= xs; i++) {
      const x = i * dx;
      if (x <= 0) continue; // skip source column (x=0 → undefined)
      for (let j = 0; j <= ys; j++) {
        const y = -halfY + j * dy;
        const c = concentrationAt({ Q: Qn, u: un, H: Hn, x, y, z: 0, stabilityClass: cls });
        cells.push({ i, j, c });
        if (c > gridMaxC) gridMaxC = c;
      }
    }

    // Normalise and build the response grid (skip near-zero cells to keep payload lean)
    const threshold = gridMaxC * 0.005; // drop anything < 0.5 % of peak
    response.maxC_ugm3 = +(gridMaxC * 1e6).toFixed(3);
    response.grid = cells
      .filter((cell) => cell.c >= threshold)
      .map(({ i, j, c }) => ({
        i,
        j,
        t: +(c / gridMaxC).toFixed(4),
      }));
    response.gridMeta = { xSteps: xs, ySteps: ys, maxDist, halfY };
  }

  res.json(response);
});

module.exports = router;
