// Where this dashboard's sensors actually are -- one place, not scattered
// through components. The labels used to say "Bangalore, Karnataka" / "KSPCB"
// from the pre-migration deployment; the live station (NEL-001, 14.442 N
// 79.986 E) is in Nellore. Change it here if the deployment moves.
export const DEPLOYMENT = {
  city: "Nellore",
  region: "Andhra Pradesh",
  // The station the dashboard opens on (lib/stations.js pickDefaultStation).
  defaultStation: "NEL-001",
};
