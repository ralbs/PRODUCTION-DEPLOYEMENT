// Worker <-> backend version-skew check, BACKEND half. Not part of any
// default suite: check-worker-backend-compat.sh copies this into a
// backend's tests/ for one run and deletes it afterwards. It uses that
// backend's REAL routes; only the Mongo models are mocked.
//
//   COMPAT_MODE=respond  -> GET spike-check for each scenario, exactly as
//                           the worker calls it; write the responses
//   COMPAT_MODE=accept   -> POST a worker's captured ingest payloads and
//                           run records; write the status codes
process.env.DEVICE_KEYS = "WORKER-SOURCE-DIRECTION:compat-key";
jest.mock("../models/Telemetry");
jest.mock("../models/SourceDirection");
jest.mock("../models/WorkerRun", () => {
  const m = { findOneAndUpdate: jest.fn(), findOne: jest.fn() };
  m.OUTCOMES = ["ingested", "skipped", "error"];
  return m;
});
const fs = require("fs");
const express = require("express");
const request = require("supertest");
const Telemetry = require("../models/Telemetry");
const SourceDirection = require("../models/SourceDirection");
const WorkerRun = require("../models/WorkerRun");

const app = express();
app.use(express.json());
app.use("/api/forecast", require("../routes/forecast"));
app.use("/api/source-direction", require("../routes/source-direction"));
const AUTH = { "X-Device-Id": "WORKER-SOURCE-DIRECTION", "X-Device-Key": "compat-key" };

// 90 one-minute readings ending now (newest first, as Telemetry.find
// returns them); `add` is applied from minute `from` on.
function docs(add = {}, from = 80, n = 90) {
  const T = Date.now() - 60e3, out = [];
  for (let i = 0; i < n; i++) {
    const p = { pm2_5: 45 + ((i * 7) % 5) - 2, pm10: 60 + ((i * 3) % 5) - 2, no2: 40 + ((i * 5) % 5) - 2 };
    if (i >= from) for (const [k, v] of Object.entries(add)) p[k] += v;
    out.push({ timestamp: new Date(T - (n - 1 - i) * 60e3), pollutants: p, meta: {} });
  }
  return out.reverse();
}
// Chosen so each rule version fires at least once: the per-pollutant
// windowed rule on the plumes, the original one-step rule on the last
// reading's jump.
const SCENARIOS = {
  steady: () => docs(),
  pm25_plume: () => docs({ pm2_5: 60 }),
  no2_plume: () => docs({ no2: 90 }),
  last_reading_jump: () => docs({ pm2_5: 60 }, 89),
  too_little_data: () => docs().slice(0, 10),
};

test("compat", async () => {
  const out = {};
  if (process.env.COMPAT_MODE === "respond") {
    for (const [name, make] of Object.entries(SCENARIOS)) {
      const d = make();
      Telemetry.find.mockReturnValue({ sort: () => ({ limit: (n) => ({ lean: async () => d.slice(0, n) }) }) });
      const r = await request(app).get("/api/forecast/spike-check").query({ station_id: "NEL-001", lookback: 168 });
      out[name] = { status: r.status, body: r.body };
    }
  } else {
    SourceDirection.findOneAndUpdate.mockResolvedValue({ _id: "sd", toObject: () => ({}) });
    WorkerRun.findOneAndUpdate.mockResolvedValue({ _id: "wr" });
    const captured = JSON.parse(fs.readFileSync(process.env.COMPAT_IN, "utf8"));
    for (const [name, c] of Object.entries(captured)) {
      out[name] = { ingest: [], runs: null };
      for (const p of c.ingest) {
        const r = await request(app).post("/api/source-direction/ingest").set(AUTH).send(p);
        out[name].ingest.push({ status: r.status, error: r.body?.error ?? null });
      }
      if (c.run) {
        const r = await request(app).post("/api/source-direction/runs").set(AUTH).send(c.run);
        out[name].runs = { status: r.status, error: r.body?.error ?? null };
      }
    }
  }
  fs.writeFileSync(process.env.COMPAT_OUT, JSON.stringify(out, null, 1));
});
