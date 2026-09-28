import { useEffect, useRef } from "react";

import { crossingAlert } from "../lib/healthGuidance";
import { aqiToRgb } from "../lib/aqiColor";

// Fires when the AQI crosses UP into a worse CPCB category. Text comes from
// lib/healthGuidance.js: real category edges (101/201/301/401 -- it used to
// call 300 "Very Poor" and 100 "Moderate") and CPCB's impact wording, not
// the old unsourced "Health risk elevated."
export default function AlertToast({ aqi, station }) {
  const toastRef    = useRef(null);
  const prevAQI     = useRef(null);
  const timerRef    = useRef(null);

  useEffect(() => {
    const val = aqi?.aqi;
    if (val == null) return;
    const prev = prevAQI.current;
    prevAQI.current = val;
    if (prev == null) return;  // first load — don't alert

    const alert = crossingAlert(prev, val, station?.replace("KSPCB-", ""));
    if (!alert) return;

    // Show toast
    const el = toastRef.current;
    if (!el) return;
    const [r, g, b] = aqiToRgb(val) || [239, 68, 68];
    el.dataset.level = alert.category;
    el.style.setProperty("--toast-color",  `rgb(${r},${g},${b})`);
    el.style.setProperty("--toast-bg",     `rgba(${r},${g},${b},0.12)`);
    el.style.setProperty("--toast-border", `rgba(${r},${g},${b},0.3)`);
    el.querySelector(".toast-title").textContent = `⚠ ${alert.title}`;
    el.querySelector(".toast-body").textContent  = alert.body;
    el.classList.add("toast-visible");

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => el.classList.remove("toast-visible"), 6000);

    return () => clearTimeout(timerRef.current);
  }, [aqi?.aqi]);

  return (
    <div ref={toastRef} className="alert-toast">
      <div className="toast-title" />
      <div className="toast-body" />
      <button
        className="toast-close"
        onClick={() => toastRef.current?.classList.remove("toast-visible")}
      >
        ✕
      </button>
    </div>
  );
}
