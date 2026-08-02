const mongoose = require("mongoose");

/*
 * Stored as a MongoDB time-series collection (requires MongoDB 5.0+).
 * `timestamp` is the time field, `meta.device_id` is the meta field —
 * Mongo automatically buckets documents by device, which is what makes
 * range queries per-station fast without a hand-rolled index strategy.
 */
const telemetrySchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true },

    meta: {
      device_id: { type: String, required: true, index: true },
      station_id: { type: String, required: true, index: true },
    },

    location: {
      lat: Number,
      lon: Number,
    },

    weather: {
      temperature: Number,
      humidity: Number,
      pressure: Number,
    },

    pollutants: {
      pm1: Number,
      pm2_5: Number,
      pm10: Number,
      co: Number,
      co2: Number,
      no2: Number,
      o3: Number,
      nh3: Number,   // MICS-6814 NH3 channel, µg/m³
      h2s: Number,   // MQ-136, µg/m³
      mq135: Number, // MQ-135 (air-quality index channel), µg/m³
      h2: Number,    // MQ-8, µg/m³
      mq7_co: Number,// MQ-7 CO, µg/m³
      voc_gas_ohm: Number, // BME680 raw gas resistance, Ω
    },

    battery: {
      voltage: Number,
      percent: Number,
    },

    signal: {
      wifi_rssi: Number,
    },

    health: {
      mq_ads1: String,
      mq_ads2: String,
      pms5003: String,
      bme680: String,
    },

    // Raw calibration aid sent by the firmware: per-channel ADC voltages and
    // the stored baselines. Not used for AQI — consumed via /api/telemetry/raw.
    diagnostics: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },

    flags: {
      offline_buffered: Boolean,
      delayed: Boolean,
    },
  },
  {
    timeseries: {
      timeField: "timestamp",
      metaField: "meta",
      granularity: "minutes",
    },
    // time-series collections don't support a default _id index the same
    // way — let Mongo manage it, don't set { autoIndex: false } globally.
  }
);

module.exports = mongoose.model("Telemetry", telemetrySchema);
