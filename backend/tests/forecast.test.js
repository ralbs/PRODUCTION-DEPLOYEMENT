jest.mock("../models/Telemetry");

const Telemetry = require("../models/Telemetry");
const { buildForecast, checkSpike, holtWinters, hourlyBuckets, contiguousHourlySeries } = require("../lib/forecast");

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

describe("checkSpike", () => {
  afterEach(() => jest.clearAllMocks());

  test("flat series + wildly higher last reading -> spike, exact predicted/band values", async () => {
    // 4 flat readings (AQI=50 each) to fit on, then a 5th real reading of
    // AQI=100 to test. Independently verified via direct node execution:
    // holtWinters([50,50,50,50], 0.3, 0.1, 1) => level=50, trend=0,
    // forecast=[50], sigma=10 (the `sigma || 10` fallback fires on exactly
    // zero residual variance -- a real quirk of the EXISTING function,
    // reused verbatim here, not reimplemented).
    const now = new Date("2026-09-10T00:00:00Z");
    const docsOldestFirst = [50, 50, 50, 50, 100].map(
      (v, i) => docWithAqi(v, new Date(now.getTime() + i * 3600 * 1000))
    );
    mockFind([...docsOldestFirst].reverse()); // Telemetry.find sorts desc; checkSpike reverses it back

    const result = await checkSpike("TEST-STATION", 168);

    expect(result.station_id).toBe("TEST-STATION");
    expect(result.actual_aqi).toBe(100);
    expect(result.predicted_aqi).toBe(50);
    expect(result.sigma).toBe(10);
    expect(result.predicted_low).toBe(40);
    expect(result.predicted_high).toBe(60);
    expect(result.is_spike).toBe(true); // 100 is outside [40, 60]
  });

  test("flat series + last reading within band -> not a spike", async () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const docsOldestFirst = [50, 50, 50, 50, 55].map(
      (v, i) => docWithAqi(v, new Date(now.getTime() + i * 3600 * 1000))
    );
    mockFind([...docsOldestFirst].reverse());

    const result = await checkSpike("TEST-STATION", 168);

    expect(result.actual_aqi).toBe(55);
    expect(result.predicted_low).toBe(40);
    expect(result.predicted_high).toBe(60);
    expect(result.is_spike).toBe(false); // 55 is inside [40, 60]
  });

  test("fewer than 4 usable AQI points -> null (not enough to fit + hold one out)", async () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const docsOldestFirst = [50, 50, 50].map(
      (v, i) => docWithAqi(v, new Date(now.getTime() + i * 3600 * 1000))
    );
    mockFind([...docsOldestFirst].reverse());

    const result = await checkSpike("TEST-STATION", 168);
    expect(result).toBeNull();
  });

  test("no telemetry at all -> null", async () => {
    mockFind([]);
    const result = await checkSpike("TEST-STATION", 168);
    expect(result).toBeNull();
  });
});

describe("buildForecast history_aqi", () => {
  afterEach(() => jest.clearAllMocks());

  // Regression: with fewer than 24 readings the old code indexed
  // orderedDocs[length - 24 + i] (negative -> undefined -> Invalid Date),
  // and toISOString() threw, 500-ing GET /api/forecast for young stations.
  test.each([3, 10, 23, 24, 30])("%i readings -> history timestamps match each reading", async (n) => {
    const start = new Date("2026-09-10T00:00:00Z").getTime();
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

  test("uneven real gaps (+1h,+3h,+4h,+9h,+10h,+11h) -> each history hour is the reading's own, not a constant step", async () => {
    const t0 = new Date("2026-09-10T00:00:00Z").getTime();
    const H = 3600 * 1000;
    // gaps of 2h, 1h, 5h, 1h, 1h. The 5h gap is too long to bridge, so the
    // fit runs on hours 9-11 only (asserted below); history keeps them all.
    const offsetsH = [1, 3, 4, 9, 10, 11];
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

    expect(result.fit_hours).toBe(3);
    expect(result.interpolated_hours).toBe(0);
  });

  test("blank reading inside an hour -> ignored by that hour's mean, not zeroed", async () => {
    const start = new Date("2026-09-10T00:00:00Z").getTime();
    const H = 3600 * 1000;
    const docsOldestFirst = [50, 52, 54, 56].map((v, i) => docWithAqi(v, new Date(start + i * H)));
    // A real reading with no AQI-bearing pollutants, in hour 1 alongside a real one.
    const blank = { timestamp: new Date(start + 1.5 * H), pollutants: {}, meta: {} };
    docsOldestFirst.splice(2, 0, blank);
    mockFind([...docsOldestFirst].reverse());

    const result = await buildForecast("TEST-STATION");

    expect(result.history_aqi.map((h) => h.aqi)).toEqual([50, 52, 54, 56]);
    const skipped = holtWinters([50, 52, 54, 56]).forecast;
    const zeroed = holtWinters([50, 52, 0, 54, 56]).forecast;
    expect(skipped).not.toEqual(zeroed); // guard: the two outcomes are distinguishable
    expect(result.predictions.map((p) => p.aqi)).toEqual(skipped);
  });

  test("an hour with only blank readings -> aqi:null in history, bridged (interpolated) in the fit", async () => {
    const start = new Date("2026-09-10T00:00:00Z").getTime();
    const H = 3600 * 1000;
    const docs = [docWithAqi(50, new Date(start)), docWithAqi(52, new Date(start + H)),
      { timestamp: new Date(start + 2 * H), pollutants: {}, meta: {} },
      docWithAqi(56, new Date(start + 3 * H))];
    mockFind([...docs].reverse());

    const result = await buildForecast("TEST-STATION");

    expect(result.history_aqi[2]).toEqual({ timestamp: new Date(start + 2 * H).toISOString(), aqi: null });
    expect(result.fit_hours).toBe(4);
    expect(result.interpolated_hours).toBe(1);
    expect(result.predictions.map((p) => p.aqi)).toEqual(holtWinters([50, 52, 54, 56]).forecast);
  });
});

// P0-a (docs/HERO_SPEC.md): the device posts every 60 s, and the forecast
// used to treat each reading as one hour.
describe("buildForecast -- hourly resampling of 1-minute telemetry", () => {
  afterEach(() => jest.clearAllMocks());
  const H = 3600 * 1000, MIN = 60 * 1000;
  const t0 = new Date("2026-09-10T00:00:00Z").getTime();
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
    const result = await buildForecast("TEST-STATION", 4);
    expect(result.fit_hours).toBe(4);
    expect(Date.parse(result.history_aqi[0].timestamp)).toBe(t0 + 6 * H);
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
