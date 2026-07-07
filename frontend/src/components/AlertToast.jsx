import { useEffect, useRef } from "react";

const LEVELS = [
  { threshold: 300, label: "Very Poor", color: "#ef4444", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)" },
  { threshold: 200, label: "Poor",      color: "#f97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.3)" },
  { threshold: 100, label: "Moderate",  color: "#facc15", bg: "rgba(250,204,21,0.12)", border: "rgba(250,204,21,0.3)" },
];

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

    // Check if we crossed a threshold upward
    const crossed = LEVELS.find(
      (l) => val >= l.threshold && prev < l.threshold
    );
    if (!crossed) return;

    // Show toast
    const el = toastRef.current;
    if (!el) return;
    el.dataset.level = crossed.label;
    el.style.setProperty("--toast-color",  crossed.color);
    el.style.setProperty("--toast-bg",     crossed.bg);
    el.style.setProperty("--toast-border", crossed.border);
    el.querySelector(".toast-title").textContent = `⚠ AQI crossed ${crossed.threshold} — ${crossed.label}`;
    el.querySelector(".toast-body").textContent  =
      `${station?.replace("KSPCB-", "") ?? "Station"} AQI is now ${val}. Health risk elevated.`;
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
