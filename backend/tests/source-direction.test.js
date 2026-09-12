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
  trigger: { actual_aqi: 180, predicted_aqi: 90, predicted_low: 70, predicted_high: 110, sigma: 20 },
  wind: { speed_m_s: 4.2, dir_from_deg: 270, station_id: "43245", as_of: "2025-08-15T11:00:00Z" },
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
    expect(SourceDirection.create).not.toHaveBeenCalled();
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
    SourceDirection.create.mockResolvedValue(fakeStoredDoc);

    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "success", id: "abc123", label: fakeStoredDoc.label });

    expect(SourceDirection.create).toHaveBeenCalledTimes(1);
    const createArg = SourceDirection.create.mock.calls[0][0];
    expect(createArg.device_id).toBe("WORKER-SOURCE-DIRECTION"); // from auth, not body
    expect(createArg.station_id).toBe("NEL-001"); // grouping only
    expect(createArg.bearing_deg).toBe(271.0);
    expect(createArg.estimate_tier).toBe("interior");
    expect(createArg.label).toBeUndefined(); // route never passes a label -- schema default enforces it
  });

  test("accepts a boundary_sector_fallback estimate with a null distance_m", async () => {
    const fakeStoredDoc = { _id: "def456", label: "estimated upwind direction -- screening only, not confirmed source attribution" };
    SourceDirection.create.mockResolvedValue(fakeStoredDoc);

    const fallbackBody = { ...VALID_BODY, distance_m: null, estimate_tier: "boundary_sector_fallback" };
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(fallbackBody);

    expect(res.status).toBe(201);
    const createArg = SourceDirection.create.mock.calls[0][0];
    expect(createArg.distance_m).toBeNull();
    expect(createArg.estimate_tier).toBe("boundary_sector_fallback");
  });

  test("rejects a payload missing a required field with 400, before touching the DB", async () => {
    const { bearing_deg, ...missingBearing } = VALID_BODY;
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(missingBearing);

    expect(res.status).toBe(400);
    expect(SourceDirection.create).not.toHaveBeenCalled();
  });

  test("rejects a payload missing estimate_tier with 400, before touching the DB", async () => {
    const { estimate_tier, ...missingTier } = VALID_BODY;
    const res = await request(app)
      .post("/api/source-direction/ingest")
      .set("X-Device-Id", "WORKER-SOURCE-DIRECTION")
      .set("X-Device-Key", "test-worker-key-123")
      .send(missingTier);

    expect(res.status).toBe(400);
    expect(SourceDirection.create).not.toHaveBeenCalled();
  });
});
