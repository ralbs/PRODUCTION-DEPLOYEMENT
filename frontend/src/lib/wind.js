// Wind direction conventions -- the one place the flip happens.
//
// GET /api/wind/live returns `dir_from_deg`: the meteorological FROM-direction
// (where the wind comes from), verified in ctm-core/met/live_wind.py.
// The plume grid wants the opposite: MapPanel places each cell with
// destinationPoint(station, windDir, x), i.e. `windDir` is the bearing the
// plume TRAVELS TOWARD. Passing dir_from straight through would draw the
// plume upwind -- pointing back at where the pollution came from.

export function downwindBearing(dirFromDeg) {
  return (((dirFromDeg + 180) % 360) + 360) % 360;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compassPoint(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
