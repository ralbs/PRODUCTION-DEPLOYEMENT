/**
 * cleanup-1970.js — delete telemetry rows that were stored with the 1970
 * placeholder timestamp (boot happened before the ESP32's NTP sync completed,
 * so the firmware shipped "1970-01-01T00:00:00Z" as the timestamp).
 *
 * SCOPED to the physical device only (meta.device_id === ESP32-001). The KSPCB
 * reference data is historical (2018–2023) and is NEVER touched — a global
 * "timestamp < 2026" delete would have wiped it.
 *
 * Usage:  node backend/scripts/cleanup-1970.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Telemetry = require("../models/Telemetry");

const CUTOFF = new Date("2026-01-01T00:00:00Z");

async function main() {
  await connectDB();

  const query = { "meta.device_id": "ESP32-001", timestamp: { $lt: CUTOFF } };

  const before = await Telemetry.countDocuments(query);
  const kspcbBefore = await Telemetry.countDocuments({ "meta.station_id": /^KSPCB-/ });

  const res = await Telemetry.deleteMany(query);

  const kspcbAfter = await Telemetry.countDocuments({ "meta.station_id": /^KSPCB-/ });

  console.log(`[cleanup] ESP32-001 rows with timestamp < 2026-01-01: ${before} — deleted ${res.deletedCount}`);
  console.log(`[cleanup] KSPCB reference rows: ${kspcbBefore} → ${kspcbAfter} (must be unchanged)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[cleanup] Fatal:", err.message);
  process.exit(1);
});
