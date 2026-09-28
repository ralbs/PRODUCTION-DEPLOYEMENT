// GET /api/forecast/spike-check as the DEPLOYED cron worker calls it,
// so a backend deploy can't break a worker that hasn't redeployed yet
// (and vice versa -- see ctm-core/tests/scripts/test_source_direction_worker.py).
jest.mock("../models/Telemetry");

const express = require("express");
const request = require("supertest");
const Telemetry = require("../models/Telemetry");

const app = express();
app.use("/api/forecast", require("../routes/forecast"));

function mockFind(docsNewestFirst) {
  Telemetry.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => docsNewestFirst }) }) });
}
const T0 = new Date("2026-09-10T09:00:00+05:30").getTime();
const steady = (n, pm = 45) => Array.from({ length: n }, (_, i) =>
  ({ timestamp: new Date(T0 + i * 60000), pollutants: { pm2_5: pm + (i % 3) - 1, pm10: 58 + (i % 3) } }));

// Everything the worker reads without .get(): a KeyError on any of these
// would crash its run. Must exist in every backend version.
const WORKER_REQUIRED = ["is_spike", "timestamp", "actual_aqi", "predicted_aqi", "predicted_low", "predicted_high", "sigma"];

describe("spike-check route -- worker compatibility across the deploy window", () => {
  afterEach(() => jest.clearAllMocks());

  test("old worker's request (with lookback=168) -> 200 with every field the worker requires", async () => {
    mockFind(steady(90).reverse());
    const res = await request(app).get("/api/forecast/spike-check").query({ station_id: "NEL-001", lookback: 168 });
    expect(res.status).toBe(200);
    for (const k of WORKER_REQUIRED) expect(res.body).toHaveProperty(k);
    for (const k of WORKER_REQUIRED.slice(2)) expect(typeof res.body[k]).toBe("number");
    expect(typeof res.body.is_spike).toBe("boolean");
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    // New fields are additive; old workers ignore them.
    expect(typeof res.body.z).toBe("number");
    expect(typeof res.body.jump_aqi).toBe("number");
  });

  test("not enough data -> 404, which every worker version treats as a skip", async () => {
    mockFind(steady(10).reverse());
    const res = await request(app).get("/api/forecast/spike-check").query({ station_id: "NEL-001", lookback: 168 });
    expect(res.status).toBe(404);
  });

  test("missing station_id -> 400 (unchanged)", async () => {
    const res = await request(app).get("/api/forecast/spike-check");
    expect(res.status).toBe(400);
  });
});
