/**
 * wipe-kspcb.js — delete all KSPCB reference rows so scripts/seed-kspcb.js can
 * re-import them with the current units contract (mq7_co µg/m³, no2/o3 µg/m³,
 * weather). Only touches meta.station_id matching /^KSPCB-/ — never device rows.
 *
 * Usage:  node backend/scripts/wipe-kspcb.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Telemetry = require("../models/Telemetry");

async function main() {
  await connectDB();

  const query = { "meta.station_id": /^KSPCB-/ };
  const before = await Telemetry.countDocuments(query);
  console.log(`[wipe] KSPCB rows to delete: ${before}`);

  const res = await Telemetry.deleteMany(query);

  const after = await Telemetry.countDocuments(query);
  console.log(`[wipe] deleted ${res.deletedCount}, remaining KSPCB rows: ${after}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[wipe] Fatal:", err.message);
  process.exit(1);
});
