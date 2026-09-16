import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import { idwInterpolate } from "../lib/idw";
import { aqiToRgb } from "../lib/aqiColor";
import { isInconclusive } from "../lib/sourceDirection";

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

// PROMPT_FLOW_UI.md Phase U3 -- map-overlay-vs-canvas decision, resolved
// here rather than left open: a source-direction bearing is inherently
// geographic (it's FROM a real station's real lat/lon, per
// backend/models/SourceDirection.js's own comment on bearing_deg), so it
// gets a real Leaflet overlay on the map users already orient to, not a
// third, detached canvas widget alongside PlumeVisualizer's dispersion-grid
// canvas (that canvas exists because a dispersion GRID has no natural home
// on a world map at station scale -- that reasoning doesn't apply to a
// single bearing anchored at a real marker).
//
// Real spherical destination-point formula (bearing + distance from a
// lat/lon) -- matches lib/idw.js's real haversine distance rather than a
// flat-earth approximation, same rigor standard for a real geographic
// overlay.
const EARTH_RADIUS_M = 6371000;
function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return [toDeg(phi2), toDeg(lambda2)];
}

const WEDGE_HALF_ANGLE_DEG = 18;
// boundary_sector_fallback carries no real distance_m (see the model's own
// comment: null there, never a fabricated number) -- this is a purely
// visual radius so the sector renders at all, never presented as a real
// distance (the dashed, unfilled rendering below is what actually signals
// "no real distance", not this number).
const FALLBACK_SECTOR_VISUAL_RADIUS_M = 6000;

function buildWedgePoints(centerLat, centerLon, bearingDeg, radiusM, steps = 6) {
  const points = [[centerLat, centerLon]];
  for (let s = 0; s <= steps; s++) {
    const a = bearingDeg - WEDGE_HALF_ANGLE_DEG + (2 * WEDGE_HALF_ANGLE_DEG * s) / steps;
    points.push(destinationPoint(centerLat, centerLon, a, radiusM));
  }
  points.push([centerLat, centerLon]);
  return points;
}

export default function MapPanel({ stations, stationsAQI, selectedStation, onSelect, sourceDirection }) {
  const containerRef = useRef(null);
  const mapRef      = useRef(null);
  const markersRef  = useRef({});
  const heatCanvasRef = useRef(null);
  const bearingLayerRef = useRef([]);
  const dataRef       = useRef({ stations: [], stationsAQI: {}, sourceDirection: null });

  dataRef.current = { stations, stationsAQI, sourceDirection };

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

  // Draws (or clears) the bearing/sector wedge for the currently loaded
  // source-direction estimate. Vector layer, not canvas -- Leaflet
  // reprojects polygons automatically on pan/zoom, unlike the manually
  // repositioned IDW heatmap canvas above, so this never needs a
  // moveend/zoomend redraw hook.
  const drawBearingOverlay = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    bearingLayerRef.current.forEach((layer) => layer.remove());
    bearingLayerRef.current = [];

    const { stations, sourceDirection } = dataRef.current;

    // Inconclusive (or absent) estimates never draw a confident-looking
    // wedge -- same threshold src/lib/sourceDirection.js's isInconclusive()
    // uses for SourceDirectionPanel's own "Direction inconclusive" text.
    // A wedge with no real signal behind it is exactly the anti-pattern
    // PROMPT_FLOW_UI.md Phase U3 was written to avoid.
    if (isInconclusive(sourceDirection)) return;

    const station = stations.find((s) => s.station_id === sourceDirection.station_id);
    if (!station?.location?.lat) return;

    const { lat, lon } = station.location;
    const isInterior = sourceDirection.estimate_tier === "interior";
    const radiusM = isInterior ? sourceDirection.distance_m : FALLBACK_SECTOR_VISUAL_RADIUS_M;
    const points = buildWedgePoints(lat, lon, sourceDirection.bearing_deg, radiusM);

    // Interior tier: solid filled wedge, a real bounded distance behind it.
    // boundary_sector_fallback: outline-only + dashed, no fill -- visually,
    // structurally distinct, never faked into looking like a real distance.
    const wedge = L.polygon(points, {
      pane: "bearingPane",
      color: "#facc15",
      weight: isInterior ? 2 : 1.5,
      opacity: isInterior ? 0.9 : 0.55,
      fillColor: "#facc15",
      fillOpacity: isInterior ? Math.min(0.45, 0.15 + sourceDirection.confidence * 0.4) : 0,
      dashArray: isInterior ? null : "6 6",
    }).addTo(map);

    bearingLayerRef.current = [wedge];
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

    // Bearing/sector overlay — above the IDW heatmap, below station markers,
    // so the wedge never occludes a marker's click target.
    map.createPane("bearingPane");
    map.getPane("bearingPane").style.zIndex = 375;
    map.getPane("bearingPane").style.pointerEvents = "none";

    map.on("moveend zoomend resize", resetHeatmap);

    mapRef.current = map;
    resetHeatmap();

    return () => {
      map.off("moveend zoomend resize", resetHeatmap);
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
      heatCanvasRef.current = null;
      bearingLayerRef.current = [];
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
    drawBearingOverlay();
  }, [stations, stationsAQI, selectedStation, onSelect, drawHeatmap, drawBearingOverlay, sourceDirection]);

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
