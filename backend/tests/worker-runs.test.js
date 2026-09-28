// authenticateDevice reads DEVICE_KEYS once at module load -- set it first.
process.env.DEVICE_KEYS = "WORKER-SOURCE-DIRECTION:test-worker-key-123,ESP32-001:AQMI-DEVICE-01";

jest.mock("../models/SourceDirection");
jest.mock("../models/WorkerRun", () => {
  const m = { findOneAndUpdate: jest.fn(), findOne: jest.fn() };
  m.OUTCOMES = ["ingested", "skipped", "error"];
  return m;
});

const express = require("express");
const request = require("supertest");
const WorkerRun = require("../models/WorkerRun");

const app = express();
app.use(express.json());
app.use("/api/source-direction", require("../routes/source-direction"));

const AUTH = { "X-Device-Id": "WORKER-SOURCE-DIRECTION", "X-Device-Key": "test-worker-key-123" };
const RATE_LIMITED = {
  station_id: "NEL-001", outcome: "skipped",
  reason: "no real wind data: provider_http_429 -- 1h window ending 2026-09-27T12:00:00+00:00 (live feed)",
  wind_failure_reason: "provider_http_429", spike_detected: true,
  spike_timestamp: "2026-09-27T11:45:00.000Z", ran_at: "2026-09-27T12:00:03.000Z",
  spike_z: 4.52, spike_jump_aqi: 31.4,
};

afterEach(() => jest.clearAllMocks());

describe("POST /api/source-direction/runs", () => {
  test("401 without worker credentials -- run status can't be forged", async () => {
    const res = await request(app).post("/api/source-direction/runs").send(RATE_LIMITED);
    expect(res.status).toBe(401);
    expect(WorkerRun.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("stores one record per (worker, station), device_id from auth never the body", async () => {
    WorkerRun.findOneAndUpdate.mockResolvedValue({ _id: "r1" });
    const res = await request(app).post("/api/source-direction/runs").set(AUTH)
      .send({ ...RATE_LIMITED, device_id: "SPOOFED" });
    expect(res.status).toBe(201);
    const [filter, update, opts] = WorkerRun.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ worker: "source-direction", station_id: "NEL-001" });
    expect(update.$set).toMatchObject({
      device_id: "WORKER-SOURCE-DIRECTION", outcome: "skipped",
      wind_failure_reason: "provider_http_429", spike_detected: true,
      spike_z: 4.52, spike_jump_aqi: 31.4,
    });
    expect(update.$set.ran_at).toEqual(new Date("2026-09-27T12:00:03.000Z"));
    expect(opts).toMatchObject({ upsert: true });
  });

  test("a 'no spike' skip stores null wind reason, not a borrowed one", async () => {
    WorkerRun.findOneAndUpdate.mockResolvedValue({ _id: "r2" });
    await request(app).post("/api/source-direction/runs").set(AUTH)
      .send({ station_id: "NEL-001", outcome: "skipped", reason: "no spike", spike_detected: false, ran_at: "2026-09-27T12:15:00Z" });
    const $set = WorkerRun.findOneAndUpdate.mock.calls[0][1].$set;
    expect($set).toMatchObject({ reason: "no spike", wind_failure_reason: null, spike_detected: false, spike_timestamp: null });
  });

  test.each([
    ["bad outcome", { outcome: "maybe" }],
    ["missing station", { station_id: "" }],
    ["bad ran_at", { ran_at: "not-a-date" }],
    ["oversized reason", { reason: "x".repeat(501) }],
    ["non-boolean spike flag", { spike_detected: "yes" }],
    ["non-numeric z", { spike_z: "4.5" }],
    ["string jump", { spike_jump_aqi: "NaN" }], // a real NaN can't travel in JSON (-> null)
  ])("400 on %s", async (_l, patch) => {
    const res = await request(app).post("/api/source-direction/runs").set(AUTH).send({ ...RATE_LIMITED, ...patch });
    expect(res.status).toBe(400);
    expect(WorkerRun.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/source-direction/last-run", () => {
  test("auth-free read of the last record", async () => {
    WorkerRun.findOne.mockReturnValue({ lean: async () => ({ ...RATE_LIMITED, worker: "source-direction" }) });
    const res = await request(app).get("/api/source-direction/last-run?station_id=NEL-001");
    expect(res.status).toBe(200);
    expect(res.body.wind_failure_reason).toBe("provider_http_429");
    expect(WorkerRun.findOne).toHaveBeenCalledWith({ worker: "source-direction", station_id: "NEL-001" });
  });

  test("404 when the worker has never reported this station", async () => {
    WorkerRun.findOne.mockReturnValue({ lean: async () => null });
    const res = await request(app).get("/api/source-direction/last-run?station_id=NEL-001");
    expect(res.status).toBe(404);
  });

  test("400 without station_id; 500 (not a hang) on a DB error", async () => {
    expect((await request(app).get("/api/source-direction/last-run")).status).toBe(400);
    WorkerRun.findOne.mockReturnValue({ lean: () => Promise.reject(new Error("db down")) });
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).get("/api/source-direction/last-run?station_id=NEL-001").timeout(1000);
    expect(res.status).toBe(500);
    console.error.mockRestore();
  });
});
