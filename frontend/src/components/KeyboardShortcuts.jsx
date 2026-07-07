import { useState, useEffect } from "react";

const SHORTCUTS = [
  { keys: ["?"],       desc: "Toggle this shortcuts panel" },
  { keys: ["F"],       desc: "Toggle app fullscreen" },
  { keys: ["V"],       desc: "Toggle voice alerts" },
  { keys: ["1","2","3","4","5"], desc: "Switch to station 1 – 5" },
  { keys: ["Esc"],     desc: "Close any overlay / fullscreen card" },
  { keys: ["R"],       desc: "Refresh current station data" },
];

export default function KeyboardShortcuts({ stations, selected, onSelect, onVoiceToggle, onRefresh }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "?") { setOpen((v) => !v); return; }
      if (e.key === "Escape") { setOpen(false); return; }

      if (e.key === "f" || e.key === "F") {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        else document.exitFullscreen();
        return;
      }
      if (e.key === "v" || e.key === "V") { onVoiceToggle?.(); return; }
      if (e.key === "r" || e.key === "R") { onRefresh?.(); return; }

      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= stations.length) {
        onSelect?.(stations[idx - 1].station_id);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stations, onSelect, onVoiceToggle, onRefresh]);

  if (!open) return null;

  return (
    <div
      className="fs-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div style={{
        background: "var(--bg-card)", border: "1px solid var(--border-hi)",
        borderRadius: 20, padding: "28px 32px", minWidth: 400,
        boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        animation: "fsSlide 0.18s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Keyboard Shortcuts</div>
          <button className="fs-close-btn" onClick={() => setOpen(false)}>✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {SHORTCUTS.map((s, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 12px", borderRadius: 10, background: "var(--bg-card2)",
            }}>
              <span style={{ fontSize: 13, color: "var(--text-sub)" }}>{s.desc}</span>
              <div style={{ display: "flex", gap: 4 }}>
                {s.keys.map((k) => (
                  <kbd key={k} style={{
                    padding: "2px 8px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: "var(--accent-dim)", border: "1px solid var(--accent-border)",
                    color: "var(--accent)", fontFamily: "var(--font-mono)",
                  }}>{k}</kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Station quick-select */}
        <div style={{ marginTop: 20, padding: "12px", borderRadius: 10, background: "var(--bg-card2)", fontSize: 11, color: "var(--text-dim)" }}>
          <div style={{ marginBottom: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Stations</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {stations.map((s, i) => (
              <button
                key={s.station_id}
                onClick={() => { onSelect?.(s.station_id); setOpen(false); }}
                style={{
                  padding: "4px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer",
                  border: `1px solid ${selected === s.station_id ? "var(--accent)" : "var(--border)"}`,
                  background: selected === s.station_id ? "var(--accent-dim)" : "var(--bg-card)",
                  color: selected === s.station_id ? "var(--accent)" : "var(--text-sub)",
                }}
              >
                <span style={{ opacity: 0.5, marginRight: 4 }}>{i + 1}</span>
                {s.station_id.replace("KSPCB-", "")}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
