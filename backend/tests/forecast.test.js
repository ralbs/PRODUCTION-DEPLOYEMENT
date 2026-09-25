jest.mock("../models/Telemetry");

const Telemetry = require("../models/Telemetry");
const { buildForecast, checkSpike } = require("../lib/forecast");

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
