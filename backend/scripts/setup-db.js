/**
 * setup-db.js
 * One-time database setup for the AQMS backend:
 *   - connects to MongoDB (MONGO_URI)
 *   - ensures the telemetry time-series collection exists
 *   - ensures the (device_id, timestamp) lookup index exists
 *
 * Run:  node backend/scripts/setup-db.js
 * Idempotent — safe to re-run after deploy.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Telemetry = require("../models/Telemetry");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;

  // The time-series collection is created lazily by Mongoose on first insert,
  // but ensure it exists so ingestion never races against collection creation.
  try {
    await db.createCollection("telemetries", {
      timeseries: {
        timeField: "timestamp",
        metaField: "meta",
        granularity: "minutes",
      },
    });
    console.log("[setup-db] time-series collection 'telemetries' ensured");
  } catch (err) {
    if (err.codeName === "NamespaceExists") {
      console.log("[setup-db] collection already exists — OK");
    } else if (err.codeName === "AlreadyExists" || /already exists/i.test(err.message)) {
      console.log("[setup-db] collection already exists — OK");
    } else {
      // createCollection on an existing non-timeseries collection is a fail — surface it.
      throw err;
    }
  }

  // (device_id, timestamp) compound index — the primary read pattern is
  // "latest/history for one device", and the meta field is already indexed.
  await Telemetry.collection.createIndex({ "meta.device_id": 1, timestamp: -1 });
  console.log("[setup-db] index (meta.device_id, timestamp) ensured");

  const counts = {
    devices: (await Telemetry.distinct("meta.device_id")).length,
    stations: (await Telemetry.distinct("meta.station_id")).length,
    telemetry: await Telemetry.estimatedDocumentCount(),
  };
  console.log("[setup-db] summary:", counts);

  await mongoose.disconnect();
  console.log("[setup-db] done");
}

main().catch((err) => {
  console.error("[setup-db] Fatal:", err);
  process.exit(1);
});
