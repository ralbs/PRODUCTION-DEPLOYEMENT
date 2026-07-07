const https = require("https");

// Field mapping for AQMS ThingSpeak channel:
//   field1 = PM2.5   field2 = PM10   field3 = NO2    field4 = O3
//   field5 = CO      field6 = AQI    field7 = Temp   field8 = Humidity

function forwardToThingSpeak(pollutants, weather, aqi) {
  const key = process.env.THINGSPEAK_WRITE_KEY;
  if (!key) return;

  const params = new URLSearchParams({
    api_key: key,
    ...(pollutants?.pm2_5  != null && { field1: pollutants.pm2_5 }),
    ...(pollutants?.pm10   != null && { field2: pollutants.pm10 }),
    ...(pollutants?.no2    != null && { field3: pollutants.no2 }),
    ...(pollutants?.o3     != null && { field4: pollutants.o3 }),
    ...(pollutants?.co     != null && { field5: pollutants.co }),
    ...(aqi                != null && { field6: aqi }),
    ...(weather?.temperature != null && { field7: weather.temperature }),
    ...(weather?.humidity    != null && { field8: weather.humidity }),
  });

  const body = params.toString();
  const req = https.request(
    {
      hostname: "api.thingspeak.com",
      path: "/update",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[thingspeak] unexpected status ${res.statusCode}`);
      }
    }
  );

  req.on("error", (err) => console.warn("[thingspeak] forward failed:", err.message));
  req.write(body);
  req.end();
}

module.exports = { forwardToThingSpeak };
