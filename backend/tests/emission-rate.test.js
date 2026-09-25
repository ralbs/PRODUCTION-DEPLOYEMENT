process.env.DEVICE_KEYS = "WORKER-EMISSION-RATE:test-worker-key-456,ESP32-001:AQMI-DEVICE-01";

jest.mock("../models/EmissionRate");

const express = require("express");
const request = require("supertest");
const EmissionRate = require("../models/EmissionRate");
const emissionRateRouter = require("../routes/emission-rate");

const app = express();
app.use(express.json());
app.use("/api/emission-rate", emissionRateRouter);

const VALID_BODY = {
  timestamp: "2025-08-01T02:00:00Z",
  station_id: "NEL-001",
  species: "pm25",
  zone: { name: "test-zone", lat: 14.4364, lon: 79.9684, distance_from_sensor_m: 2900 },
  observations: [
    { time_index: 59, timestamp: "2025-08-01T01:00:00Z", enhancement: 12.3 },
    { time_index: 119, timestamp: "2025-08-01T02:00:00Z", enhancement: 15.1 },
  ],
  x_hat: 0.042,
  marginal_std: 0.011,
  chi2_per_obs: 0.8,
  fit_residuals: [0.3, -0.2],
  species_advisory: { quasi_conservative: true, half_life_s: 999999, transit_time_s: 7200, message: "pm25 is quasi-conservative here" },
};

describe("POST /api/emission-rate/ingest", () => {
  afterEach(() => jest.clearAllMocks());

  test("rejects with 401 when auth headers are missing", async () => {
    const res = await request(app).post("/api/emission-rate/ingest").send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(EmissionRate.create).not.toHaveBeenCalled();
  });

  test("rejects station_id used as device_id -- never a valid credential", async () => {
    const res = await request(app)
      .post("/api/emission-rate/ingest")
      .set("X-Device-Id", "NEL-001")
      .set("X-Device-Key", "test-worker-key-456")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  test("rejects a missing marginal_std with 400 -- an uncertainty-free estimate is never accepted", async () => {
    const { marginal_std, ...missingStd } = VALID_BODY;
    const res = await request(app)
      .post("/api/emission-rate/ingest")
      .set("X-Device-Id", "WORKER-EMISSION-RATE")
      .set("X-Device-Key", "test-worker-key-456")
      .send(missingStd);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/marginal_std/);
    expect(EmissionRate.create).not.toHaveBeenCalled();
  });

  test("accepts a real device_id + key, stores device_id from auth (not body), never lets body set label", async () => {
    const fakeStoredDoc = { _id: "xyz789", label: "estimated single-zone emission rate -- screening only, not a validated emission-inventory number" };
    EmissionRate.create.mockResolvedValue(fakeStoredDoc);

    const res = await request(app)
      .post("/api/emission-rate/ingest")
      .set("X-Device-Id", "WORKER-EMISSION-RATE")
      .set("X-Device-Key", "test-worker-key-456")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "success", id: "xyz789", label: fakeStoredDoc.label });

    const createArg = EmissionRate.create.mock.calls[0][0];
    expect(createArg.device_id).toBe("WORKER-EMISSION-RATE");
    expect(createArg.station_id).toBe("NEL-001");
    expect(createArg.x_hat).toBe(0.042);
    expect(createArg.marginal_std).toBe(0.011);
    expect(createArg.label).toBeUndefined(); // schema default enforces it, route never sets it
  });
});
