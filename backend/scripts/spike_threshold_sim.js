#!/usr/bin/env node
// Spike-threshold simulation: how often does the source-direction worker's
// trigger fire on normal-but-noisy 1-minute data, and does it catch real
// plumes? Runs the REAL lib/forecast.js checkSpike() (Telemetry.find is
// stubbed in-process -- no database), plus verbatim copies of the two
// rules it replaced, for comparison.
//
//   node scripts/spike_threshold_sim.js
//
// Deterministic: every series comes from a fixed seed.
//
// The noise model is SYNTHETIC and says so. Per channel, a steady level +
// AR(1) jitter (phi 0.5: minute samples aren't independent):
//   pm2_5  PMS5003, integer ug/m3                  sd 4 (or 6)
//   pm10   ~1.3 x pm2_5 plus its own jitter, int   sd 3
//   no2    MiCS, ug/m3                             sd 6
//   nh3    MiCS, ug/m3                             sd 5
//   mq7_co MQ-7, ug/m3 (-> mg/m3 for CPCB)         sd 80
// The gas sd values are ASSUMPTIONS -- no device has reported long enough
// to measure them. Real low-cost gas sensors drift with temperature and
// humidity and have heavier tails; re-run with real noise once NEL-001
// reports continuously.
//
// Metrics are per WORKER RUN (cron every 15 min, render.yaml -> 96/day):
//   false triggers  = fraction of runs on plume-free data that trigger,
//                     and the same as expected triggers per day
//   plume caught    = fraction of plumes (start swept over all 15 cron
//                     phases x seeds) that trigger >= 1 run while in
//                     progress or within one run after it ends

const Telemetry = require("../models/Telemetry");
const { checkSpike } = require("../lib/forecast");
const { calculateAQI } = require("../lib/aqi");

const CRON_MIN = 15;
const RUNS_PER_DAY = (24 * 60) / CRON_MIN;
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

// plume: { start, len, ramp, add: { pm2_5?, no2?, ... } } (added to the level)
function series(n, { pm = 45, pmSd = 4, no2 = 40, nh3 = 30, co = 800, seed = 1, plume = null, pmDriftPerHour = 0 }) {
  const r = rng(seed);
  const e = { pm: 0, pm10: 0, no2: 0, nh3: 0, co: 0 };
  const ar = (k, sd) => { e[k] = 0.5 * e[k] + Math.sqrt(0.75) * sd * gauss(r); return e[k]; };
  const out = [];
  const t0 = Date.parse("2026-09-10T00:00:00+05:30");
  for (let i = 0; i < n; i++) {
    const k = plume && i >= plume.start && i < plume.start + plume.len ? Math.min(1, (i - plume.start + 1) / plume.ramp) : 0;
    const add = (name) => (plume?.add?.[name] ?? 0) * k;
    const pm25 = Math.max(1, Math.round(pm + (pmDriftPerHour * i) / 60 + ar("pm", pmSd) + add("pm2_5")));
    out.push({
      timestamp: new Date(t0 + i * 60e3),
      pollutants: {
        pm2_5: pm25,
        pm10: Math.max(1, Math.round(pm25 * 1.3 + ar("pm10", 3) + add("pm10"))),
        no2: Math.max(0.1, no2 + ar("no2", 6) + add("no2")),
        nh3: Math.max(0.1, nh3 + ar("nh3", 5) + add("nh3")),
        mq7_co: Math.max(1, co + ar("co", 80) + add("mq7_co")),
      },
    });
  }
  return out;
}

let visible = [];
Telemetry.find = () => ({ sort: () => ({ limit: (n) => ({ lean: async () => visible.slice(-n).reverse() }) }) });

// Rule 1 (original): one-step Holt-Winters on the last 168 READINGS' AQI,
// +/- 1 "sigma" (RMS distance of the last 24 values from the final level).
function legacyFires(docs) {
  const aqis = docs.slice(-168).map((d) => calculateAQI(d.pollutants)?.aqi).filter((v) => v != null);
  if (aqis.length < 4) return null;
  const actual = aqis[aqis.length - 1], fit = aqis.slice(0, -1);
  let L = fit[0], b = (fit[fit.length - 1] - fit[0]) / (fit.length - 1);
  for (let i = 1; i < fit.length; i++) { const pL = L; L = 0.3 * fit[i] + 0.7 * (L + b); b = 0.1 * (L - pL) + 0.9 * b; }
  const res = fit.slice(-24).map((v) => Math.abs(v - L));
  const sigma = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length) || 10;
  const pred = Math.max(0, Math.round(L + b));
  return actual < Math.max(0, pred - sigma) || actual > pred + sigma;
}

// Rule 2 (previous commit): the same windowed test, but on the AQI series.
function windowedAqiFires(docs) {
  const pts = docs.map((d) => ({ t: d.timestamp.getTime(), v: calculateAQI(d.pollutants)?.aqi })).filter((p) => p.v != null);
  const T = pts[pts.length - 1].t, rs = T - 15 * 60e3, bs = rs - 60 * 60e3;
  const recent = pts.filter((p) => p.t > rs), base = pts.filter((p) => p.t > bs && p.t <= rs).map((p) => p.v);
  if (base.length < 30) return null;
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  let peak = -Infinity;
  for (const p of recent) {
    const w = recent.filter((q) => q.t > p.t - 5 * 60e3 && q.t <= p.t);
    if (w.length >= 3) peak = Math.max(peak, w.reduce((s, q) => s + q.v, 0) / w.length);
  }
  if (peak === -Infinity) return null;
  const m = med(base), spread = Math.max(1, 1.4826 * med(base.map((x) => Math.abs(x - m))));
  return peak - m >= 20 && (peak - m) / spread >= 3;
}

const RULES = {
  "legacy one-step AQI": async (docs) => legacyFires(docs),
  "windowed AQI (prev.)": async (docs) => windowedAqiFires(docs),
  "per-pollutant (current)": async (docs) => { visible = docs; return (await checkSpike("SIM"))?.is_spike ?? null; },
};

const pct = (a, n) => `${((100 * a) / n).toFixed(1)}%`;

async function main() {
  const rows = [];
  const noise = [
    ["steady, PM2.5 45 sd 4", { pm: 45, pmSd: 4 }],
    ["steady, PM2.5 45 sd 6", { pm: 45, pmSd: 6 }],
    ["steady, PM2.5 75 sd 4 (steep AQI band)", { pm: 75, pmSd: 4 }],
    ["steady, NO2 near a breakpoint (78)", { pm: 20, no2: 78 }],
    ["slow PM drift +10 ug/m3/h (rush hour)", { pm: 30, pmDriftPerHour: 10 }],
  ];
  for (const [name, opt] of noise) {
    const cells = [];
    for (const fires of Object.values(RULES)) {
      let f = 0, n = 0;
      for (const seed of SEEDS) {
        const docs = series(3200, { ...opt, seed });
        for (let i = 200; i < docs.length; i += CRON_MIN) {
          const r = await fires(docs.slice(0, i + 1));
          if (r == null) continue;
          n++; if (r) f++;
        }
      }
      cells.push(`${pct(f, n)} (${((f / n) * RUNS_PER_DAY).toFixed(1)}/day)`);
    }
    rows.push([`FALSE: ${name}`, ...cells]);
  }

  const plumes = [
    ["PM2.5 +15 ug/m3 (+25 AQI), 20 min", { add: { pm2_5: 15 }, len: 20, ramp: 3 }],
    ["PM2.5 +30 ug/m3 (+74 AQI), 20 min", { add: { pm2_5: 30 }, len: 20, ramp: 3 }],
    ["PM2.5 +60 ug/m3 (+174 AQI), 10 min", { add: { pm2_5: 60 }, len: 10, ramp: 2 }],
    ["NO2 +80 ug/m3 under PM2.5 75 (AQI ~flat), 20 min", { add: { no2: 80 }, len: 20, ramp: 3, base: { pm: 75 } }],
    ["PM10 +80 ug/m3 overtakes PM2.5, 20 min", { add: { pm10: 80 }, len: 20, ramp: 3, base: { pm: 40 } }],
  ];
  for (const [name, plume] of plumes) {
    const cells = [];
    for (const fires of Object.values(RULES)) {
      let caught = 0, n = 0;
      for (const seed of SEEDS) {
        for (let phase = 0; phase < CRON_MIN; phase++) {
          const start = 300 + phase;
          const docs = series(start + plume.len + CRON_MIN + 1, { ...(plume.base || {}), seed, plume: { ...plume, start } });
          let hit = false;
          for (let i = 300; i < start + plume.len + CRON_MIN && i < docs.length; i += CRON_MIN) {
            if (i >= start && await fires(docs.slice(0, i + 1))) { hit = true; break; }
          }
          n++; if (hit) caught++;
        }
      }
      cells.push(pct(caught, n));
    }
    rows.push([`CAUGHT: ${name}`, ...cells]);
  }

  const head = ["scenario (per 15-min worker run)", ...Object.keys(RULES)];
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
  console.log(`\nseeds ${SEEDS.join(",")}; ${RUNS_PER_DAY} worker runs/day; plume start swept over ${CRON_MIN} cron phases per seed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
