/**
 * seed-kspcb.js
 * Imports KSPCB ground-station CSV data (2018-2023) into the AQMS MongoDB.
 *
 * Run once:  node backend/scripts/seed-kspcb.js
 * Safe to re-run — skips stations that already have data.
 *
 * Unit conversions (all at 25°C, 1 atm):
 *   CO  : mg/m³  → µg/m³  × 1000
 *   NO2 : µg/m³  (stored as-is)
 *   O3  : µg/m³  (stored as-is)
 *   BP  : mmHg   → hPa  × 1.33322
 *
 * Gases are stored in µg/m³ (the telemetry API units contract). CO uses the
 * mq7_co field so the AQI calculator picks up the real CO measurement.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const fs       = require("fs");
const path     = require("path");
const readline = require("readline");
const mongoose = require("mongoose");

const { connectDB } = require("../config/db");
const Telemetry     = require("../models/Telemetry");

// ── config ────────────────────────────────────────────────────────────────────

const KSPCB_ROOT = "C:\\1CD22CS004\\isro\\KSPCB_results_renamed";

const STATIONS = {
  Hebbal:     { station_id: "KSPCB-Hebbal",     device_id: "KSPCB-HBL-001", lat: 13.0359, lon: 77.5970 },
  Jayanagar:  { station_id: "KSPCB-Jayanagar",  device_id: "KSPCB-JNR-001", lat: 12.9256, lon: 77.5937 },
  Kavika:     { station_id: "KSPCB-Kavika",      device_id: "KSPCB-KVK-001", lat: 13.0282, lon: 77.5197 },
  Nihmans:    { station_id: "KSPCB-Nihmans",    device_id: "KSPCB-NHM-001", lat: 12.9437, lon: 77.5714 },
  Silk_Board: { station_id: "KSPCB-Silk_Board", device_id: "KSPCB-SLK-001", lat: 12.9172, lon: 77.6226 },
};

const CO_MG_TO_UG = 1000;
const MMHG_TO_HPA = 1.33322;

const BATCH_SIZE = 500;

// ── CSV helpers ───────────────────────────────────────────────────────────────

// Minimal RFC-4180 CSV line splitter (handles quoted fields with commas).
function splitCSV(line) {
  const fields = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === "," && !inQ) { fields.push(cur); cur = ""; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

function num(val) {
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// Column indices (0-based) — same layout across all station files:
// 0:Time 1:CO 2:Ozone 3:NO 4:NO2 5:NOx 6:NH3 7:SO2 8:PM2.5 9:PM10
// 10:BEN 11:TOL 12:m,p-XYL 13:o-XYL 14:Et-BEN 15:AT 16:RH 17:WS 18:WD 19:BP
function parseRow(cols, meta) {
  if (cols.length < 17) return null;
  const ts = new Date(cols[0]);
  if (isNaN(ts.getTime())) return null;

  const co_mg  = num(cols[1]);
  const o3_ug  = num(cols[2]);
  const no2_ug = num(cols[4]);
  const pm25   = num(cols[8]);
  const pm10   = num(cols[9]);
  const temp   = num(cols[15]);
  const rh     = num(cols[16]);
  const ws     = num(cols[17]);
  const bp_mmhg = cols[19] != null ? num(cols[19]) : null;

  return {
    timestamp: ts,
    meta: { device_id: meta.device_id, station_id: meta.station_id },
    location: { lat: meta.lat, lon: meta.lon },
    weather: {
      temperature: temp,
      humidity: rh,
      pressure: bp_mmhg != null ? Math.round(bp_mmhg * MMHG_TO_HPA * 10) / 10 : null,
    },
    pollutants: {
      pm2_5: pm25,
      pm10:  pm10,
      mq7_co: co_mg != null ? Math.round(co_mg * CO_MG_TO_UG) : null,
      no2:   no2_ug,
      o3:    o3_ug,
    },
  };
}

async function importCSV(filePath, meta) {
  const docs = [];
  let isHeader = true;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  await new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (isHeader) { isHeader = false; return; }
      if (!line.trim()) return;
      const doc = parseRow(splitCSV(line), meta);
      if (doc) docs.push(doc);
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  return docs;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  await connectDB();

  const years = fs.readdirSync(KSPCB_ROOT)
    .filter((y) => /^\d{4}$/.test(y))
    .sort();

  let grandTotal = 0;

  for (const [folder, meta] of Object.entries(STATIONS)) {
    // Check whether this station already has data (skip if so)
    const sample = await Telemetry.findOne({ "meta.station_id": meta.station_id }).lean();
    if (sample) {
      console.log(`[seed] ${meta.station_id} — already seeded, skipping`);
      continue;
    }

    let stationTotal = 0;

    for (const year of years) {
      const dir = path.join(KSPCB_ROOT, year, folder);
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv"));

      for (const file of files) {
        const docs = await importCSV(path.join(dir, file), meta);
        if (!docs.length) continue;

        // Batch insert
        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
          await Telemetry.insertMany(docs.slice(i, i + BATCH_SIZE), { ordered: false }).catch(() => {});
        }
        stationTotal += docs.length;
        process.stdout.write(`\r[seed] ${meta.station_id}  ${year}/${file}  (${stationTotal} rows)`);
      }
    }

    grandTotal += stationTotal;
    console.log(`\n[seed] ${meta.station_id} done — ${stationTotal} rows`);
  }

  console.log(`\n[seed] Complete — ${grandTotal} total documents inserted`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[seed] Fatal:", err.message);
  process.exit(1);
});
