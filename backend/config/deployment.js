// Where the live sensors are, for the backend. The city config of record
// is ctm-core/cities/live_deployment.json; the backend deploys with
// rootDir=backend (render.yaml) and can't read that file at runtime, so
// the one value it needs is mirrored here -- and tests/deployment.test.js
// fails if the two ever disagree.
module.exports = {
  city: "Nellore",
  region: "Andhra Pradesh",
  // India Standard Time, no DST: always +5:30 (live_deployment.json
  // utc_offset_hours). Fractional -- never approximate it as +5.
  utcOffsetHours: 5.5,
};
