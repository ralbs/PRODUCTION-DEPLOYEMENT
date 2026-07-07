const mongoose = require("mongoose");

/*
 * Optional but recommended once you're past a handful of stations: instead
 * of the DEVICE_KEYS env var, register each device here and check against
 * this collection in middleware/auth.js. Lets you revoke a single station's
 * key without redeploying, and gives you a natural place to track last-seen.
 */
const deviceSchema = new mongoose.Schema(
  {
    device_id: { type: String, required: true, unique: true },
    station_id: { type: String, required: true },
    api_key_hash: { type: String, required: true }, // bcrypt hash, never store plaintext
    active: { type: Boolean, default: true },
    last_seen_at: Date,
    last_seen_ip: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Device", deviceSchema);
