#!/usr/bin/env node
// Spike-threshold simulation: how often does the source-direction worker's
// trigger fire on normal-but-noisy 1-minute data, and does it catch real
// plumes? Runs the REAL lib/forecast.js checkSpike() (Telemetry.find is
// stubbed in-process -- no database), plus a verbatim copy of the rule it
// replaced, for comparison.
//
//   node scripts/spike_threshold_sim.js
//
// Deterministic: every series comes from a fixed seed, so the table below
// is reproducible run to run. The noise model is SYNTHETIC -- steady
// PM2.5 + AR(1) jitter (phi 0.5, minute samples aren't independent),
// integer output like the PMS5003, PM10 ~ 1.3x PM2.5. Real sensor noise
// has heavier tails and humidity effects; re-check against real device
// data once a station reports continuously.
//
// Metrics are per WORKER RUN (cron every 15 min, render.yaml), since that
// is what fires an estimate:
//   false triggers  = fraction of runs on plume-free data that trigger
//   plume caught    = fraction of plumes (start swept over all 15 cron
//                     phases x seeds) that trigger >= 1 run while in progress
//                     or within one run after it ends

const Telemetry = require("../models/Telemetry");
const { checkSpike } = require("../lib/forecast");
const { calculateAQI } = require("../lib/aqi");

const CRON_MIN = 15;
const SEEDS = [1, 2, 3, 4];

// mulberry32
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

function series(n, { mean = 45, sd = 4, seed = 1, plume = null, driftPerHour = 0 }) {
  const r = rng(seed); let e = 0; const out = [];
  const t0 = Date.parse("2026-09-10T00:00:00+05:30");
  for (let i = 0; i < n; i++) {
    e = 0.5 * e + Math.sqrt(0.75) * sd * gauss(r);
    let pm = mean + e + (driftPerHour * i) / 60;
    if (plume && i >= plume.start && i < plume.start + plume.len) pm += plume.add * Math.min(1, (i - plume.start + 1) / plume.ramp);
    pm = Math.max(1, Math.round(pm));
    out.push({ timestamp: new Date(t0 + i * 60e3), pollutants: { pm2_5: pm, pm10: Math.round(pm * 1.3) } });
  }
  return out;
}

let visible = [];
Telemetry.find = () => ({ sort: () => ({ limit: (n) => ({ lean: async () => visible.slice(-n).reverse() }) }) });

// The rule checkSpike used before the windowed rule, verbatim in effect:
// one-step Holt-Winters on the last 168 READINGS, +/- 1 "sigma" (RMS
// distance of the last 24 values from the final level, `|| 10`).
function legacyFires(docs) {
  const aqis = docs.slice(-168).map((d) => calculateAQI(d.pollutants)?.aqi).filter((v) => v != null);
  if (aqis.length < 4) return null;
  const actual = aqis[aqis.length - 1], fit = aqis.slice(0, -1);
  let L = fit[0], b = (fit[fit.length - 1] - fit[0]) / (fit.length - 1);
  for (let i = 1; i < fit.length; i++) { const pL = L; L = 0.3 * fit[i] + 0.7 * (L + b); b = 0.1 * (L - pL) + 0.9 * b; }
  const res = fit.slice(-24).map((v) => Math.abs(v - L));
  const sigma = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length) || 10;
  const pred = Math.max(0, Math.round(L + b));
  return actual < Math.max(0, pred - sigma) || actual > pred + sigma;
}

const RULES = {
  "legacy (one-step, +/-1 sigma)": async (docs) => legacyFires(docs),
  "windowed (current checkSpike)": async (docs) => { visible = docs; return (await checkSpike("SIM"))?.is_spike ?? null; },
};

const pct = (a, n) => `${((100 * a) / n).toFixed(1)}%`;

async function main() {
  const rows = [];
  const noise = [
    ["steady PM2.5 45, jitter sd 4", { mean: 45, sd: 4 }],
    ["steady PM2.5 45, jitter sd 6", { mean: 45, sd: 6 }],
    ["steady PM2.5 75, jitter sd 4 (steep AQI band)", { mean: 75, sd: 4 }],
    ["slow drift +10 ug/m3/h (rush hour), sd 4", { mean: 30, sd: 4, driftPerHour: 10 }],
  ];
  for (const [name, opt] of noise) {
    const cells = [];
    for (const [rule, fires] of Object.entries(RULES)) {
      let f = 0, n = 0;
      for (const seed of SEEDS) {
        const docs = series(3200, { ...opt, seed });
        for (let i = 200; i < docs.length; i += CRON_MIN) {
          const r = await fires(docs.slice(0, i + 1));
          if (r == null) continue;
          n++; if (r) f++;
        }
      }
      cells.push(pct(f, n));
    }
    rows.push([`FALSE triggers: ${name}`, ...cells]);
  }

  const plumes = [
    { add: 15, len: 20, ramp: 3 },
    { add: 30, len: 20, ramp: 3 },
    { add: 30, len: 60, ramp: 10 },
    { add: 60, len: 10, ramp: 2 },
  ];
  for (const plume of plumes) {
    const cells = [];
    for (const [, fires] of Object.entries(RULES)) {
      let caught = 0, n = 0;
      for (const seed of SEEDS) {
        for (let phase = 0; phase < CRON_MIN; phase++) {
          const start = 300 + phase;
          const docs = series(start + plume.len + CRON_MIN + 1, { sd: 4, seed, plume: { ...plume, start } });
          let hit = false;
          for (let i = 300; i < start + plume.len + CRON_MIN && i < docs.length; i += CRON_MIN) {
            if (i >= start && await fires(docs.slice(0, i + 1))) { hit = true; break; }
          }
          n++; if (hit) caught++;
        }
      }
      cells.push(pct(caught, n));
    }
    const dAqi = calculateAQI({ pm2_5: 45 + plume.add }).aqi - calculateAQI({ pm2_5: 45 }).aqi;
    rows.push([`plume CAUGHT: +${plume.add} ug/m3 (+${dAqi} AQI) for ${plume.len} min`, ...cells]);
  }

  const head = ["scenario (per 15-min worker run)", ...Object.keys(RULES)];
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
  console.log(`\nseeds ${SEEDS.join(",")}; plume start swept over ${CRON_MIN} cron phases per seed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
