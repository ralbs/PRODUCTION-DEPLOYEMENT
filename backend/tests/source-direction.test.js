// authenticateDevice reads process.env.DEVICE_KEYS ONCE at module load time
// (see middleware/auth.js's module-level `const deviceKeys = loadDeviceKeys()`)
// -- must be set before any require() of auth.js or anything that requires it.
process.env.DEVICE_KEYS = "WORKER-SOURCE-DIRECTION:test-worker-key-123,ESP32-001:AQMI-DEVICE-01";

jest.mock("../models/SourceDirection");

const express = require("express");
const request = require("supertest");
const SourceDirection = require("../models/SourceDirection");
const sourceDirectionRouter = require("../routes/source-direction");

const app = express();
app.use(express.json());
app.use("/api/source-direction", sourceDirectionRouter);

const VALID_BODY = {
  timestamp: "2025-08-15T12:00:00Z",
  station_id: "NEL-001",
  idempotency_key: "nel-001|2025-08-15t12:00:00z",
  trigger: { actual_aqi: 180, predicted_aqi: 90, predicted_low: 70, predicted_high: 110, sigma: 20 },
  wind: {
    speed_m_s: 4.2, dir_from_deg: 270, station_id: "43245", as_of: "2025-08-15T11:00:00Z",
    source_tier: "historical_ground_station",
  },
  bearing_deg: 271.0,
  distance_m: 3200,
  confidence: 0.82,
  boundary_inflow_fraction: 0.18,
  estimate_tier: "interior",
  n_particles: 2000,
  seed: 0,
};

describe("POST /api/source-direction/ingest", () => {
  afterEach(() => jest.clearAllMocks());

  test("rejects with 401 when auth headers are missing", async () => {
    const res = await request(app).post("/api/source-direction/ingest").send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(SourceDirection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("rejects with 401 when device key is wrong", async () => {
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "wrong-key")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  test("rejects station_id auth attempt -- station_id is never a valid device identity", async () => {
    // NEL-001 is a real station_id, NOT a device_id key in DEVICE_KEYS above
    // for this exact purpose -- proves station_id can never be used to
    // authenticate, only device_id can (per the explicit auth requirement).
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "NEL-001")
      .set("X-Device-Key", "test-worker-key-123")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  test("accepts a real device_id + key, stores with device_id from auth (not body), forces the label", async () => {
    const fakeStoredDoc = { _id: "abc123", label: "estimated upwind direction -- screening only, not confirmed source attribution" };
    SourceDirection.findOneAndUpdate.mockResolvedValue(fakeStoredDoc);

    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "success", id: "abc123", label: fakeStoredDoc.label });

    expect(SourceDirection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filterArg, updateArg, optionsArg] = SourceDirection.findOneAndUpdate.mock.calls[0];
    expect(filterArg).toEqual({ idempotency_key: VALID_BODY.idempotency_key });
    expect(optionsArg).toMatchObject({ upsert: true });
    const setArg = updateArg.$set;
    expect(setArg.device_id).toBe("WORKER-SOURCE-DIRECTION"); // from auth, not body
    expect(setArg.station_id).toBe("NEL-001"); // grouping only
    expect(setArg.bearing_deg).toBe(271.0);
    expect(setArg.estimate_tier).toBe("interior");
    expect(setArg.label).toBeUndefined(); // route never passes a label -- schema default enforces it
  });

  test("accepts a boundary_sector_fallback estimate with a null distance_m", async () => {
    const fakeStoredDoc = { _id: "def456", label: "estimated upwind direction -- screening only, not confirmed source attribution" };
    SourceDirection.findOneAndUpdate.mockResolvedValue(fakeStoredDoc);

    const fallbackBody = { ...VALID_BODY, distance_m: null, estimate_tier: "boundary_sector_fallback" };
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(fallbackBody);

    expect(res.status).toBe(201);
    const setArg = SourceDirection.findOneAndUpdate.mock.calls[0][1].$set;
    expect(setArg.distance_m).toBeNull();
    expect(setArg.estimate_tier).toBe("boundary_sector_fallback");
  });

  test("rejects a payload missing a required field with 400, before touching the DB", async () => {
    const { bearing_deg, ...missingBearing } = VALID_BODY;
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(missingBearing);

    expect(res.status).toBe(400);
    expect(SourceDirection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("rejects a payload missing estimate_tier with 400, before touching the DB", async () => {
    const { estimate_tier, ...missingTier } = VALID_BODY;
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(missingTier);

    expect(res.status).toBe(400);
    expect(SourceDirection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("rejects a payload missing idempotency_key with 400, before touching the DB", async () => {
    const { idempotency_key, ...missingKey } = VALID_BODY;
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(missingKey);

    expect(res.status).toBe(400);
    expect(SourceDirection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("a retried POST with the same idempotency_key (simulating a timeout-then-retry) stores exactly one document, not two", async () => {
    // Stand-in for Mongo's real upsert semantics: a single fake collection
    // keyed on idempotency_key, so two upserts with the same key overwrite
    // the same slot instead of adding a second one -- this is the actual
    // invariant the unique index + upsert combo in the real route/model
    // guarantees, made observable here without a real MongoDB.
    const fakeCollection = new Map();
    SourceDirection.findOneAndUpdate.mockImplementation(async (filter, update) => {
      const key = filter.idempotency_key;
      const existing = fakeCollection.get(key);
      const doc = {
        _id: existing?._id ?? `generated-id-${fakeCollection.size + 1}`,
        label: "estimated upwind direction -- screening only, not confirmed source attribution",
        ...update.$set,
      };
      fakeCollection.set(key, doc);
      return doc;
    });

    const send = () =>
      request(app)
        .post("/api/source-direction/ingest")
        .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
        .set("X-Device-Key", "test-worker-key-123")
        .send(VALID_BODY);

    const firstRes = await send(); // the original POST, whose response the worker never saw (simulated timeout)
    const secondRes = await send(); // the worker's retry with the exact same idempotency_key

    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);
    expect(firstRes.body.id).toBe(secondRes.body.id); // same document both times, not a new one
    expect(fakeCollection.size).toBe(1); // exactly one document exists afterward, not two
    expect(SourceDirection.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});
