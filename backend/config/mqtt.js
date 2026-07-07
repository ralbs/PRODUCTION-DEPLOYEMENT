const mqtt = require("mqtt");

/*
 * Optional. If MQTT_BROKER_URL isn't set, this is a no-op — REST ingest
 * and the DB write still work fine without it. When it is set, every
 * stored reading is also republished to `aqms/<station_id>/telemetry`
 * so a dashboard can subscribe for live updates instead of polling the
 * history endpoint.
 */
function setupMqtt() {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    console.log("[MQTT] MQTT_BROKER_URL not set — live republish disabled");
    return () => {};
  }

  const client = mqtt.connect(brokerUrl, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
  });

  client.on("connect", () => console.log(`[MQTT] Connected to ${brokerUrl}`));
  client.on("error", (err) => console.error("[MQTT] Error:", err.message));

  return function publish(stationId, payload) {
    if (!client.connected) return;
    const topic = `aqms/${stationId}/telemetry`;
    client.publish(topic, JSON.stringify(payload), { qos: 0 });
  };
}

module.exports = { setupMqtt };
