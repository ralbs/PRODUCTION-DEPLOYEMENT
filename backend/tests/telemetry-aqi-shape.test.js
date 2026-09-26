// Route-level check that the informational channels are STRUCTURALLY separate
// from the AQI in the real API responses -- a sibling key, never inside `aqi`.
process.env.DEVICE_KEYS = "ESP32-001:test-key";

jest.mock("../models/Telemetry");
jest.mock("../lib/gasCal", () => ({ applyCalibration: async (p) => ({ ...p }) }));
jest.mock("../lib/thingspeak", () => ({ forwardToThingSpeak: () => {} }));

const express = require("express");
const request = require("supertest");
const Telemetry = require("../models/Telemetry");

const app = express();
app.use(express.json());
app.use("/api/telemetry", require("../routes/telemetry"));
app.use("/api/aqi", require("../routes/aqi"));

// NEL-001's real stored document (live, 2026-09-08T20:45Z).
const DOC = {
  timestamp: new Date("2026-09-08T20:45:00Z"),
  meta: { station_id: "NEL-001", device_id: "ESP32-001" },
  pollutants: {
    pm1: 10, pm2_5: 20, pm10: 33, co: -1, no2: 15, o3: -1, nh3: 8,
    h2s: 2.5, mq135: 130, h2: 2, mq7_co: 190, voc_gas_ohm: 50000,
  },
};
const INVENTED = ["h2s", "h2", "mq135", "voc_gas_ohm"];

beforeEach(() => {
  Telemetry.findOne.mockReturnValue({ sort: () => ({ lean: async () => DOC }) });
});

function expectSeparated(aqiObj, info) {
  expect(aqiObj.aqi).toBe(33);
  expect(aqiObj.category).toBe("Good");
  expect(aqiObj.dominant_pollutant).toBe("pm2_5");
  for (const ch of INVENTED) {
    expect(aqiObj.sub_indices).not.toHaveProperty(ch);
    expect(aqiObj).not.toHaveProperty(ch);
    expect(info[ch].in_official_aqi).toBe(false);
  }
  expect(info.voc_gas_ohm.value).toBe(50000);
}

test("GET /api/telemetry/latest: official AQI 33, informational_readings is a sibling of aqi", async () => {
  const res = await request(app).get("/api/telemetry/latest?station_id=NEL-001");
  expect(res.status).toBe(200);
  expectSeparated(res.body.aqi, res.body.informational_readings);
  expect(res.body.aqi).not.toHaveProperty("informational_readings");
});

test("GET /api/aqi/latest: spread AQI fields exclude every invented channel", async () => {
  const res = await request(app).get("/api/aqi/latest?station_id=NEL-001");
  expect(res.status).toBe(200);
  expectSeparated(res.body, res.body.informational_readings);
});
