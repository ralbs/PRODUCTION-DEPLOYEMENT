// Which station the dashboard opens on. It used to be `list[0]` -- whatever
// order Mongo's distinct() happened to return -- which put TEST-STATION-001
// (a bench device, not a real sensor) in the hero on some loads.
import { DEPLOYMENT } from "./deployment.js";

// Test/stub stations are named as such (TEST-STATION-001 / TEST-DEVICE-001);
// match a whole test-ish token in either the station or device id.
const TEST_TOKEN = /(^|[-_\s])(test|stub|mock|demo|fake|dummy|sim)([-_\s\d]|$)/i;

export function isTestStation(s) {
  return TEST_TOKEN.test(s?.station_id ?? "") || TEST_TOKEN.test(s?.device_id ?? "");
}

// The deployment's own station if it has ever reported; else the most
// recently seen real station; else null -- the caller shows "no real station
// reporting yet" rather than falling back to a test one.
export function pickDefaultStation(list, preferred = DEPLOYMENT.defaultStation) {
  const real = (list || []).filter((s) => s?.station_id && !isTestStation(s) && s.last_seen);
  if (!real.length) return null;
  const pref = real.find((s) => s.station_id === preferred);
  if (pref) return pref.station_id;
  return real.reduce((a, b) => (Date.parse(b.last_seen) > Date.parse(a.last_seen) ? b : a)).station_id;
}
