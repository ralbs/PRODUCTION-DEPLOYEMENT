import { useState, useEffect } from "react";

/* ── Live clock ── */
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="header-time">
      {now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
      &ensp;
      {now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
    </span>
  );
}

/* ── Professional AQMS Logo ── */
function Logo() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00e5a0"/>
          <stop offset="100%" stopColor="#007a57"/>
        </linearGradient>
      </defs>
      {/* Rounded square bg */}
      <rect width="36" height="36" rx="10" fill="url(#logo-g)"/>
      {/* Stylised air-quality waveform */}
      <path
        d="M6 20 Q9 12 12 18 Q15 24 18 14 Q21 6 24 18 Q26 24 30 16"
        stroke="#0b1a13" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"
      />
      {/* Small dot — sensor node */}
      <circle cx="30" cy="16" r="2.2" fill="#0b1a13"/>
    </svg>
  );
}

/* ── App fullscreen toggle ── */
function FullscreenBtn() {
  const [fs, setFs] = useState(false);

  function toggle() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setFs(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setFs(false));
    }
  }

  useEffect(() => {
    const handler = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  return (
    <button className="icon-btn" onClick={toggle} title={fs ? "Exit fullscreen" : "Enter fullscreen (F11)"}>
      {fs ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>
          <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      )}
    </button>
  );
}

export default function Header({ voiceEnabled, onVoiceToggle }) {
  return (
    <header className="header">
      {/* Brand */}
      <div className="header-logo">
        <Logo />
        <div>
          <div className="header-title">AQMS Bangalore</div>
          <div className="header-sub">ISRO · KSPCB Real-time Air Quality Intelligence</div>
        </div>
      </div>

      {/* Right controls */}
      <div className="header-right">
        <div className="live-badge">
          <span className="live-dot" />
          LIVE
        </div>

        <Clock />

        {/* Voice toggle */}
        <button
          className={`icon-btn${voiceEnabled ? " active" : ""}`}
          onClick={onVoiceToggle}
          title={voiceEnabled ? "Voice ON — click to disable" : "Enable voice alerts"}
        >
          {voiceEnabled ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          )}
          {voiceEnabled ? "Voice On" : "Voice"}
        </button>

        {/* App fullscreen */}
        <FullscreenBtn />

        {/* Status badge */}
        <div className="ready-badge">Ready</div>
      </div>
    </header>
  );
}
