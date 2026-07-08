import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import { idwInterpolate } from "../lib/idw";
import { aqiToRgb } from "../lib/aqiColor";

// IDW dispersion layer tuning — see drawHeatmap() below.
const HEAT_CELL_PX  = 8;    // grid resolution (larger = faster, blockier)
const HEAT_MAX_ALPHA = 0.5; // opacity directly over a station
const HEAT_DECAY_KM  = 6;   // how far the glow/interpolation extends before fading

const AQI_COLORS = {
  Good: "#22c55e",
  Satisfactory: "#84cc16",
  Moderate: "#eab308",
  Poor: "#f97316",
  "Very Poor": "#ef4444",
  Severe: "#991b1b",
};

function aqiColor(category) {
  return AQI_COLORS[category] || "#4f8ef7";
}

export default function MapPanel({ stations, stationsAQI, selectedStation, onSelect }) {
  const containerRef = useRef(null);
  const mapRef      = useRef(null);
  const markersRef  = useRef({});
  const heatCanvasRef = useRef(null);
  const dataRef       = useRef({ stations: [], stationsAQI: {} });

  dataRef.current = { stations, stationsAQI };

  // Spatial dispersion around each station, IDW-interpolated in between.
  // Draws directly onto the heatmap canvas — cheap enough to redraw on every
  // pan/zoom/data update since there are only a handful of stations.
  const drawHeatmap = useCallback(() => {
    const map = mapRef.current;
    const canvas = heatCanvasRef.current;
    if (!map || !canvas) return;

    const { stations, stationsAQI } = dataRef.current;
    const points = stations
      .filter((s) => s.location?.lat != null && stationsAQI?.[s.station_id]?.aqi != null)
      .map((s) => ({
        lat: s.location.lat,
        lon: s.location.lon,
        value: stationsAQI[s.station_id].aqi,
      }));

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!points.length) return;

    for (let px = 0; px < canvas.width; px += HEAT_CELL_PX) {
      for (let py = 0; py < canvas.height; py += HEAT_CELL_PX) {
        const { lat, lng } = map.containerPointToLatLng([px + HEAT_CELL_PX / 2, py + HEAT_CELL_PX / 2]);
        const result = idwInterpolate(points, lat, lng);
        if (!result) continue;

        const alpha = HEAT_MAX_ALPHA * Math.exp(-result.minDist / HEAT_DECAY_KM);
        if (alpha < 0.02) continue;

        const rgb = aqiToRgb(result.value);
        if (!rgb) continue;

        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
        ctx.fillRect(px, py, HEAT_CELL_PX, HEAT_CELL_PX);
      }
    }
  }, []);

  // Resize/reposition the heatmap canvas to match the current viewport, then
  // redraw. Panes are children of Leaflet's transformed map root, so the
  // canvas has to be re-pinned to the container's top-left on every
  // move/zoom or its content drifts out of alignment with the basemap.
  const resetHeatmap = useCallback(() => {
    const map = mapRef.current;
    const canvas = heatCanvasRef.current;
    if (!map || !canvas) return;

    const size = map.getSize();
    canvas.width = size.x;
    canvas.height = size.y;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    drawHeatmap();
  }, [drawHeatmap]);

  // Initialise map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [12.972, 77.595],
      zoom: 12,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    // Small credit
    L.control.attribution({ position: "bottomleft", prefix: false })
      .addAttribution('<span style="color:#3d5078;font-size:9px">© OSM · CARTO</span>')
      .addTo(map);

    // Dispersion layer — sits above the basemap, below the station markers
    // (which render as circleMarkers in the default overlayPane, z-index 400).
    map.createPane("idwPane");
    map.getPane("idwPane").style.zIndex = 350;
    map.getPane("idwPane").style.pointerEvents = "none";
    const heatCanvas = L.DomUtil.create("canvas", "idw-heatmap-canvas", map.getPane("idwPane"));
    heatCanvasRef.current = heatCanvas;

    map.on("moveend zoomend resize", resetHeatmap);

    mapRef.current = map;
    resetHeatmap();

    return () => {
      map.off("moveend zoomend resize", resetHeatmap);
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
      heatCanvasRef.current = null;
    };
  }, [resetHeatmap]);

  // Redraw markers whenever data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove old markers
    Object.values(markersRef.current).forEach((m) => m.remove());
    markersRef.current = {};

    stations.forEach((s) => {
      if (!s.location?.lat) return;

      const aqiInfo   = stationsAQI?.[s.station_id];
      const color     = aqiColor(aqiInfo?.category);
      const isSelected = s.station_id === selectedStation;
      const name      = s.station_id.replace("KSPCB-", "");

      const marker = L.circleMarker([s.location.lat, s.location.lon], {
        radius:      isSelected ? 14 : 10,
        color:       isSelected ? "#ffffff" : color,
        weight:      isSelected ? 2.5 : 1.5,
        fillColor:   color,
        fillOpacity: 0.85,
      });

      const popupHtml = `
        <div style="min-width:140px;font-family:'Inter',sans-serif">
          <div style="font-weight:700;font-size:13px;color:${color};margin-bottom:5px">${name}</div>
          ${aqiInfo
            ? `<div style="font-size:24px;font-weight:700;font-family:'JetBrains Mono',monospace;color:#f8fafc">
                 ${aqiInfo.aqi ?? "–"}
                 <span style="font-size:10px;font-weight:400;color:#94a3b8;margin-left:4px">${aqiInfo.category || ""}</span>
               </div>
               <div style="font-size:11px;color:#64748b;margin-top:2px">
                 PM2.5: ${aqiInfo.pm2_5 != null ? aqiInfo.pm2_5.toFixed(1) : "–"} µg/m³
               </div>`
            : `<div style="font-size:11px;color:#64748b">Loading…</div>`}
          <div style="font-size:9px;color:#334155;margin-top:6px">
            ${s.location.lat.toFixed(4)}°N, ${s.location.lon.toFixed(4)}°E
          </div>
        </div>`;

      marker.bindPopup(popupHtml, { className: "dark-popup", closeButton: false });
      marker.on("click", () => onSelect(s.station_id));
      marker.addTo(map);
      markersRef.current[s.station_id] = marker;
    });

    drawHeatmap();
  }, [stations, stationsAQI, selectedStation, onSelect, drawHeatmap]);

  return (
    <div className="map-section">
      <div ref={containerRef} style={{ height: "100%", width: "100%", minHeight: 300 }} />

      <div style={{
        position: "absolute", top: 10, left: 10, zIndex: 900,
        background: "rgba(6,9,15,0.80)", backdropFilter: "blur(8px)",
        border: "1px solid rgba(65,100,175,0.25)", borderRadius: 8,
        padding: "5px 10px", fontSize: 10, fontWeight: 600,
        letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)",
        pointerEvents: "none",
      }}>
        Station Network · Bangalore
      </div>
    </div>
  );
}
