jest.mock("../models/Telemetry");

const Telemetry = require("../models/Telemetry");
const {
  buildForecast, checkSpike, windowedSpike, holtWinters, hourlyBuckets, contiguousHourlySeries,
  MIN_REAL_HOURS, HW_PHI, AQI_MAX, SPIKE_Z, SPIKE_MIN_JUMP_AQI, SPIKE_MIN_BASELINE_POINTS,
} = require("../lib/forecast");
const { calculateAQI } = require("../lib/aqi");

// Real fixture data. Verified by directly executing lib/aqi.js's
// calculateAQI({pm10: v}) for v in [20,100]: CPCB's pm10 breakpoint band
// [0,50,0,50] (then [51,100,51,100]) makes AQI == pm10 EXACTLY, 1:1, in
// this range -- confirmed by running the real function, not assumed from
// reading the breakpoint table. pm2_5 is deliberately omitted (its
// breakpoints are NOT 1:1) so the only sub-index in play is this clean one.
function docWithAqi(aqi, timestamp) {
  return { timestamp, pollutants: { pm10: aqi }, meta: {} };
}

function mockFind(docsNewestFirst) {
  Telemetry.find.mockReturnValue({
    sort: () => ({
      limit: () => ({
        lean: async () => docsNewestFirst,
      }),
    }),
  });
}

// Seeded synthetic 1-minute PMS5003-like telemetry: steady PM2.5 + AR(1)
// jitter, integer output. Same generator as scripts/spike_threshold_sim.js.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const SPIKE_T0 = new Date("2026-09-10T09:00:00+05:30").getTime();
// `stepAt` minutes in, PM2.5 shifts by `stepUg` for the rest of the series.
function pmSeries(minutes, { mean = 45, sd = 4, seed = 1, stepAt = null, stepUg = 0 } = {}) {
  const r = rng(seed); let e = 0; const out = [];
  for (let i = 0; i < minutes; i++) {
    e = 0.5 * e + Math.sqrt(0.75) * sd * gauss(r);
    let pm = mean + e + (stepAt != null && i >= stepAt ? stepUg : 0);
    pm = Math.max(1, Math.round(pm));
    out.push({ timestamp: new Date(SPIKE_T0 + i * 60000), pollutants: { pm2_5: pm, pm10: Math.round(pm * 1.3) }, meta: {} });
  }
  return out;
}
const aqiJump = (fromUg, toUg) => calculateAQI({ pm2_5: toUg }).aqi - calculateAQI({ pm2_5: fromUg }).aqi;

describe("checkSpike -- windowed rule (rises only)", () => {
  afterEach(() => jest.clearAllMocks());

  test("steady noisy 1-minute data -> no trigger, across seeds, levels and every cron phase", async () => {
    // PM2.5 75 sits in the steep 61-90 band (~3.4 AQI per ug/m3), so the
    // same jitter is ~2x larger in AQI there -- the z gate has to hold too.
    for (const [seed, mean] of [[1, 45], [2, 45], [3, 45], [4, 75], [5, 75]]) {
      const docs = pmSeries(240, { seed, sd: 4, mean });
      for (let end = 80; end <= 240; end += 5) {
        mockFind(docs.slice(0, end).reverse());
        const r = await checkSpike("TEST-STATION");
        expect(r.is_spike).toBe(false);
      }
    }
  });

  test.each([
    ["+25 AQI", 15],
    ["+74 AQI", 30],
  ])("%s step (PM2.5 45 -> 45+%i ug/m3) inside the recent window -> trigger", async (label, stepUg) => {
    expect(aqiJump(45, 45 + stepUg)).toBe(label === "+25 AQI" ? 25 : 74); // label is the real AQI jump
    for (const seed of [1, 2, 3]) {
      const docs = pmSeries(90, { seed, stepAt: 80, stepUg }); // step 10 min before the run
      mockFind([...docs].reverse());
      const r = await checkSpike("TEST-STATION");
      expect(r.is_spike).toBe(true);
      expect(r.z).toBeGreaterThanOrEqual(SPIKE_Z);
      expect(r.jump_aqi).toBeGreaterThanOrEqual(SPIKE_MIN_JUMP_AQI);
      // payload fields the worker forwards (SourceDirection requires all five)
      for (const k of ["actual_aqi", "predicted_aqi", "predicted_low", "predicted_high", "sigma"]) {
        expect(Number.isFinite(r[k])).toBe(true);
      }
      expect(r.actual_aqi).toBeGreaterThanOrEqual(r.predicted_high);
    }
  });

  test("a plume that already ended before the run is still caught (peak rolling mean, not the latest reading)", async () => {
    const docs = pmSeries(90, { seed: 2, stepAt: 78, stepUg: 30 });
    for (let i = 85; i < 90; i++) docs[i].pollutants = { pm2_5: 45, pm10: 58 }; // back to baseline
    mockFind([...docs].reverse());
    const r = await checkSpike("TEST-STATION");
    expect(r.is_spike).toBe(true);
    expect(Date.parse(r.timestamp)).toBeLessThan(docs[89].timestamp.getTime());
  });

  test("the same size step DOWNWARD -> no trigger", async () => {
    for (const seed of [1, 2, 3]) {
      // Step before the recent window opens, so the whole window is post-drop.
      const docs = pmSeries(90, { mean: 75, seed, stepAt: 74, stepUg: -30 });
      mockFind([...docs].reverse());
      const r = await checkSpike("TEST-STATION");
      expect(r.is_spike).toBe(false);
      expect(r.jump_aqi).toBeLessThan(0);
    }
  });

  test("too few baseline points -> null (the worker records a skip)", async () => {
    // 25 minutes of data: 10 baseline points, below SPIKE_MIN_BASELINE_POINTS.
    const docs = pmSeries(25, { stepAt: 20, stepUg: 60 });
    mockFind([...docs].reverse());
    expect(SPIKE_MIN_BASELINE_POINTS).toBeGreaterThan(10);
    expect(await checkSpike("TEST-STATION")).toBeNull();
  });

  test("no telemetry at all -> null", async () => {
    mockFind([]);
    expect(await checkSpike("TEST-STATION")).toBeNull();
  });

  test("jump alone isn't enough when the baseline itself is that noisy (z gate)", () => {
    // Baseline alternating 40/80 (spread ~30 AQI); recent mean 85 is +25 over the median, z < 3.
    const pts = [];
    for (let i = 0; i < 60; i++) pts.push({ t: i * 60000, aqi: i % 2 ? 80 : 40 });
    for (let i = 60; i < 75; i++) pts.push({ t: i * 60000, aqi: 85 });
    const r = windowedSpike(pts);
    expect(r.jump).toBeGreaterThanOrEqual(SPIKE_MIN_JUMP_AQI);
    expect(r.z).toBeLessThan(SPIKE_Z);
    expect(r.is_spike).toBe(false);
  });
});

describe("buildForecast history_aqi", () => {
  afterEach(() => jest.clearAllMocks());

  // Regression: with fewer than 24 readings the old code indexed
  // orderedDocs[length - 24 + i] (negative -> undefined -> Invalid Date),
  // and toISOString() threw, 500-ing GET /api/forecast for young stations.
  test.each([6, 10, 23, 24, 30])("%i readings -> history timestamps match each reading", async (n) => {
    const start = new Date("2026-09-10T00:00:00+05:30").getTime();
    const docsOldestFirst = Array.from({ length: n }, (_, i) =>
      docWithAqi(50 + i, new Date(start + i * 3600 * 1000))
    );
    mockFind([...docsOldestFirst].reverse());

    const result = await buildForecast("TEST-STATION");

    const expected = docsOldestFirst.slice(-24);
    expect(result.history_aqi).toHaveLength(expected.length);
    result.history_aqi.forEach((h, i) => {
      expect(h.timestamp).toBe(expected[i].timestamp.toISOString());
      expect(h.aqi).toBe(expected[i].pollutants.pm10); // pm10 -> AQI is 1:1 in this band
    });
  });
});

describe("buildForecast history_aqi -- real-world irregularities", () => {
  afterEach(() => jest.clearAllMocks());

  test("uneven real gaps (+1h,+3h,+4h, then +9h..+14h) -> each history hour is the reading's own, not a constant step", async () => {
    const t0 = new Date("2026-09-10T00:00:00+05:30").getTime();
    const H = 3600 * 1000;
    // gaps of 2h, 1h, 5h, then hourly. The 5h gap is too long to bridge, so
    // the fit runs on hours 9-14 only (asserted below); history keeps them all.
    const offsetsH = [1, 3, 4, 9, 10, 11, 12, 13, 14];
    const docsOldestFirst = offsetsH.map((h, i) => docWithAqi(50 + i, new Date(t0 + h * H)));
    mockFind([...docsOldestFirst].reverse());

    const result = await buildForecast("TEST-STATION");
    const actual = result.history_aqi.map((h) => Date.parse(h.timestamp));

    expect(actual).toEqual(offsetsH.map((h) => t0 + h * H));

    // Discrimination: every constant-dt-per-index reconstruction differs
    // from the real timestamps somewhere, so none could pass the check above.
    const n = offsetsH.length, first = actual[0], last = actual[n - 1];
    const constantDt = {
      "first + i*1h": offsetsH.map((_, i) => first + i * H),
      "last - (n-1-i)*1h": offsetsH.map((_, i) => last - (n - 1 - i) * H),
      "evenly spaced first..last": offsetsH.map((_, i) => first + (i * (last - first)) / (n - 1)),
    };
    for (const xs of Object.values(constantDt)) expect(actual).not.toEqual(xs);

    expect(result.fit_hours).toBe(6);
    expect(result.interpolated_hours).toBe(0);
  });

  test("blank reading inside an hour -> ignored by that hour's mean, not zeroed", async () => {
    const start = new Date("2026-09-10T00:00:00+05:30").getTime();
    const H = 3600 * 1000;
    const docsOldestFirst = [50, 52, 54, 56, 58, 60].map((v, i) => docWithAqi(v, new Date(start + i * H)));
    // A real reading with no AQI-bearing pollutants, in hour 1 alongside a real one.
    const blank = { timestamp: new Date(start + 1.5 * H), pollutants: {}, meta: {} };
    docsOldestFirst.splice(2, 0, blank);
    mockFind([...docsOldestFirst].reverse());

    const result = await buildForecast("TEST-STATION");

    expect(result.history_aqi.map((h) => h.aqi)).toEqual([50, 52, 54, 56, 58, 60]);
    const skipped = holtWinters([50, 52, 54, 56, 58, 60]).forecast;
    const zeroed = holtWinters([50, 52, 0, 54, 56, 58, 60]).forecast;
    expect(skipped).not.toEqual(zeroed); // guard: the two outcomes are distinguishable
    expect(result.predictions.map((p) => p.aqi)).toEqual(skipped);
  });

  test("an hour with only blank readings -> aqi:null in history, bridged (interpolated) in the fit", async () => {
    const start = new Date("2026-09-10T00:00:00+05:30").getTime();
    const H = 3600 * 1000;
    const docs = [docWithAqi(50, new Date(start)), docWithAqi(52, new Date(start + H)),
      { timestamp: new Date(start + 2 * H), pollutants: {}, meta: {} },
      ...[56, 58, 60, 62].map((v, i) => docWithAqi(v, new Date(start + (3 + i) * H)))];
    mockFind([...docs].reverse());

    const result = await buildForecast("TEST-STATION");

    expect(result.history_aqi[2]).toEqual({ timestamp: new Date(start + 2 * H).toISOString(), aqi: null });
    expect(result.fit_hours).toBe(7);
    expect(result.real_hours).toBe(6);
    expect(result.interpolated_hours).toBe(1);
    expect(result.predictions.map((p) => p.aqi)).toEqual(holtWinters([50, 52, 54, 56, 58, 60, 62]).forecast);
  });
});

// P0-a (docs/HERO_SPEC.md): the device posts every 60 s, and the forecast
// used to treat each reading as one hour.
describe("buildForecast -- hourly resampling of 1-minute telemetry", () => {
  afterEach(() => jest.clearAllMocks());
  const H = 3600 * 1000, MIN = 60 * 1000;
  const t0 = new Date("2026-09-10T00:00:00+05:30").getTime();
  const perMinute = (minutes, aqiAt) =>
    Array.from({ length: minutes }, (_, i) => docWithAqi(aqiAt(i), new Date(t0 + i * MIN)));

  test("~6h of 1-minute input -> 24 hourly predictions, exactly 1 h apart, after the last hour", async () => {
    const docs = perMinute(6 * 60, (i) => 50 + Math.floor(i / 60) * 2); // 50,52,..,60 per hour
    mockFind([...docs].reverse());

    const result = await buildForecast("TEST-STATION");

    expect(result.resolution_minutes).toBe(60);
    expect(result.fit_hours).toBe(6);
    expect(result.predictions).toHaveLength(24);
    const ts = result.predictions.map((p) => Date.parse(p.timestamp));
    ts.slice(1).forEach((t, i) => expect(t - ts[i]).toBe(H));
    expect(ts[0]).toBe(t0 + 6 * H); // first step = the hour after the last (5:00) bucket
    expect(ts[23] - ts[0]).toBe(23 * H); // 24 real hours, not 24 minutes
    // Fitted on the six hourly means, not 360 raw points.
    expect(result.predictions.map((p) => p.aqi)).toEqual(holtWinters([50, 52, 54, 56, 58, 60]).forecast);
    expect(result.trend).toBe("rapidly rising"); // +2 AQI/hour > trendLabel's 1.5/hour
    expect(result.history_aqi).toHaveLength(6);
  });

  test("the same series read per-reading would have been 'stable' -- per-minute slope is tiny", () => {
    const raw = Array.from({ length: 360 }, (_, i) => 50 + Math.floor(i / 60) * 2);
    expect(Math.abs(holtWinters(raw).trend)).toBeLessThan(0.5); // why the old labels were wrong
  });

  test("lookback is hours of wall-clock time, not a reading count", async () => {
    const docs = perMinute(10 * 60, () => 50);
    mockFind([...docs].reverse());
    const result = await buildForecast("TEST-STATION", 7);
    expect(result.fit_hours).toBe(7);
    expect(Date.parse(result.history_aqi[0].timestamp)).toBe(t0 + 3 * H);
  });

  test("hour mean is over sanitised concentrations; a garbage value can't poison the hour", () => {
    const docs = [
      { timestamp: new Date(t0), pollutants: { pm10: 40 } },
      { timestamp: new Date(t0 + 10 * MIN), pollutants: { pm10: 60 } },
      { timestamp: new Date(t0 + 20 * MIN), pollutants: { pm10: 99999 } }, // above SANITY_MAX
    ];
    expect(hourlyBuckets(docs)).toEqual([{ start: t0, readings: 3, aqi: 50 }]);
  });

  test("gaps: <=3h bridged by interpolation, longer gap ends the fit", () => {
    const b = (h, aqi) => ({ start: t0 + h * H, aqi });
    const s = contiguousHourlySeries([b(0, 10), b(5, 20), b(6, 30), b(9, 60)]);
    expect(s.map((x) => [(x.start - t0) / H, x.aqi, !!x.interpolated])).toEqual([
      [5, 20, false], [6, 30, false], [7, 40, true], [8, 50, true], [9, 60, false],
    ]);
  });
});

describe("forecast honesty -- MIN_REAL_HOURS, residual band, damping, local hours", () => {
  afterEach(() => jest.clearAllMocks());
  const H = 3600 * 1000;
  const t0 = new Date("2026-09-10T00:00:00+05:30").getTime();
  const hourly = (vals, start = t0) => vals.map((v, i) => docWithAqi(v, new Date(start + i * H)));

  test("MIN_REAL_HOURS is 6", () => expect(MIN_REAL_HOURS).toBe(6));

  test("below MIN_REAL_HOURS -> no forecast at all (no line, no band, no trend)", async () => {
    mockFind(hourly([50, 52, 54, 56, 58]).reverse());
    expect(await buildForecast("TEST-STATION")).toBeNull();
  });

  test("at MIN_REAL_HOURS -> line, band and trend are present", async () => {
    mockFind(hourly([50, 52, 54, 56, 58, 60]).reverse());
    const r = await buildForecast("TEST-STATION");
    expect(r.real_hours).toBe(6);
    expect(r.predictions).toHaveLength(24);
    expect(r.predictions.every((p) => p.aqi_low <= p.aqi && p.aqi <= p.aqi_high)).toBe(true);
    expect(typeof r.trend).toBe("string");
    expect(r.method.kind).toBe("extrapolation");
  });

  test("interpolated hours don't count toward MIN_REAL_HOURS", async () => {
    // 5 real hours + 1 bridged gap = a 6-hour fit, but only 5 are real.
    const docs = [...hourly([50, 52]), ...hourly([56, 58, 60], t0 + 3 * H)];
    mockFind(docs.reverse());
    expect(await buildForecast("TEST-STATION")).toBeNull();
  });

  test("sigma = RMS of in-sample one-step residuals; band uses it (not spread around the final level)", () => {
    const series = [50, 55, 48, 60, 52, 58, 51];
    // Independent re-derivation of the one-step misses, straight from the recursion.
    let L = series[0], b = (series[6] - series[0]) / 6; const res = [];
    for (let i = 1; i < series.length; i++) {
      const pred = L + b; res.push(series[i] - pred);
      const pL = L; L = 0.3 * series[i] + 0.7 * pred; b = 0.1 * (L - pL) + 0.9 * b;
    }
    const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
    const hw = holtWinters(series);
    expect(hw.sigma).toBeCloseTo(rms, 10);
    expect(hw.sd[0]).toBeCloseTo(rms, 10); // 1-step SD is sigma itself
    for (let h = 1; h < 24; h++) expect(hw.sd[h]).toBeGreaterThan(hw.sd[h - 1]); // widens with horizon
    // ...and differs from the old definition, which measured the wrong thing.
    const oldSigma = Math.sqrt(series.slice(-24).reduce((s, v) => s + (v - hw.level) ** 2, 0) / series.length);
    expect(Math.abs(hw.sigma - oldSigma)).toBeGreaterThan(0.5);
  });

  test("buildForecast's band is exactly +/- round(sd[h])", async () => {
    const vals = [50, 55, 48, 60, 52, 58, 51];
    mockFind(hourly(vals).reverse());
    const r = await buildForecast("TEST-STATION");
    const hw = holtWinters(vals);
    r.predictions.forEach((p, i) => {
      expect(p.aqi_high - p.aqi).toBe(Math.round(hw.sd[i]));
      expect(p.aqi - p.aqi_low).toBe(Math.min(p.aqi, Math.round(hw.sd[i])));
    });
  });

  test("a steady real trend is estimated at its true slope (damping is not inside the fit)", () => {
    const hw = holtWinters([50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72]);
    expect(hw.trend).toBeCloseTo(2, 6);
  });

  test("24-step extrapolation from 6 steep points can't run away: damped and capped at 500", () => {
    const steep = [50, 80, 110, 140, 170, 200]; // +30 AQI/hour
    const damped = holtWinters(steep);
    const undamped = holtWinters(steep, 0.3, 0.1, 24, 1);
    expect(undamped.forecast[23]).toBe(AQI_MAX); // what it used to do: run into the ceiling
    // Damped: the slope's total future contribution is bounded by phi/(1-phi) steps.
    const bound = damped.level + (HW_PHI / (1 - HW_PHI)) * Math.abs(damped.trend);
    expect(damped.forecast[23]).toBeLessThanOrEqual(Math.ceil(bound));
    expect(damped.forecast[23]).toBeLessThan(AQI_MAX);
    // Later steps add less and less.
    const inc = damped.forecast.slice(1).map((v, i) => v - damped.forecast[i]);
    expect(inc[22]).toBeLessThan(inc[0]);
  });

  test("predictions and band never leave [0, 500]", () => {
    for (const s of [[480, 490, 495, 499, 500, 500], [30, 20, 12, 6, 2, 1]]) {
      const hw = holtWinters(s);
      hw.forecast.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(AQI_MAX); });
    }
  });

  test("IST deployment: hourly buckets and prediction times fall on whole local hours", async () => {
    // 6h of 1-minute data starting at 00:17 IST -- deliberately off the hour.
    const start = new Date("2026-09-10T00:17:00+05:30").getTime();
    const docs = Array.from({ length: 7 * 60 }, (_, i) => docWithAqi(50 + Math.floor(i / 60), new Date(start + i * 60000)));
    mockFind([...docs].reverse());
    const r = await buildForecast("TEST-STATION");
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    const stamps = [...r.history_aqi, ...r.predictions].map((x) => Date.parse(x.timestamp));
    for (const t of stamps) expect(fmt.format(new Date(t))).toMatch(/:00$/);
    expect(fmt.format(new Date(Date.parse(r.history_aqi[0].timestamp)))).toBe("00:00");
    // The spoken peak time is local too, not the server's timezone.
    expect(r.peak_time).toMatch(/:00 (am|pm)$/i);
  });

  test("UTC-hour bucketing would have put IST labels on :30 (why local hours matter)", () => {
    const docs = [docWithAqi(50, new Date("2026-09-10T10:10:00+05:30"))];
    const utc = hourlyBuckets(docs, 0)[0].start, ist = hourlyBuckets(docs, 5.5)[0].start;
    const fmt = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
    expect(fmt(utc)).toBe("09:30");
    expect(fmt(ist)).toBe("10:00");
  });
});
