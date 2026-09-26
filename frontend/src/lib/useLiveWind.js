import { useEffect, useState } from "react";
import { api } from "../api";

// Open-Meteo's current conditions update every 15 min (ctm-core/met/live_wind.py).
export const WIND_REFRESH_MIN = 15;

// Live model-nowcast wind for one location, from GET /api/wind -- the same
// shape as SourceDirection's `wind` sub-object. Fetched once in App.jsx and
// shared by every consumer (plume, ambient field, Ventilation Index), so they
// can never disagree about the wind.
//
// { status: "loading" | "ok" | "unavailable", data }
// "unavailable" means there is NO wind value -- consumers must show that,
// never substitute a default.
export function useLiveWind(location) {
  const [wind, setWind] = useState({ status: "loading", data: null });
  const lat = location?.lat, lon = location?.lon;

  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setWind({ status: "unavailable", data: null });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.getWind(lat, lon);
        if (!cancelled) setWind({ status: "ok", data });
      } catch {
        if (!cancelled) setWind({ status: "unavailable", data: null });
      }
    };
    setWind({ status: "loading", data: null });
    load();
    const t = setInterval(load, WIND_REFRESH_MIN * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, [lat, lon]);

  return wind;
}
