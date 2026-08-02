/*
 * Simple shared-secret auth: each ESP32 sends its device_id and api_key,
 * checked against DEVICE_KEYS in .env ("device_id:key,device_id:key").
 *
 * Swap this for the Device model + bcrypt.compare() once you have more
 * than a handful of stations — the ESP32-side header contract doesn't
 * need to change either way.
 */
function loadDeviceKeys() {
  const raw = process.env.DEVICE_KEYS || "";
  const map = {};
  raw.split(",").forEach((pair) => {
    const [id, key] = pair.split(":");
    if (id && key) map[id.trim()] = key.trim();
  });
  return map;
}

const deviceKeys = loadDeviceKeys();

function authenticateDevice(req, res, next) {
  const deviceId = req.header("X-Device-Id") || req.body?.device_id;
  const apiKey = req.header("X-Device-Key");

  if (!deviceId || !apiKey) {
    return res.status(401).json({ error: "Missing X-Device-Id or X-Device-Key header" });
  }

  const expected = deviceKeys[deviceId];
  if (!expected || expected !== apiKey) {
    return res.status(401).json({ error: "Invalid device credentials" });
  }

  req.deviceId = deviceId;
  next();
}

module.exports = { authenticateDevice };
