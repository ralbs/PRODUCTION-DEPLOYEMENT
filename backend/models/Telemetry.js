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
      nh3: Number,   // MICS-6814 NH3 channel, ppm
      h2s: Number,   // MQ-136, ppm
    },

    battery: {
      voltage: Number,
      percent: Number,
    },

    signal: {
      wifi_rssi: Number,
    },

    health: {
      mq135: String,
      pms5003: String,
      dht22: String,
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
