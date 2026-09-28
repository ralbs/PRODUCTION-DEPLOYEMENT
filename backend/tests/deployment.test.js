const fs = require("fs");
const path = require("path");
const deployment = require("../config/deployment");

// The backend can't read ctm-core at runtime (render.yaml rootDir=backend),
// so config/deployment.js mirrors the city config's UTC offset. This keeps
// the mirror honest.
test("backend UTC offset matches the city config of record", () => {
  const city = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../../ctm-core/cities/live_deployment.json"), "utf8"));
  expect(deployment.utcOffsetHours).toBe(city.utc_offset_hours);
});
