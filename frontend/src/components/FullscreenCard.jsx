import { useState, useEffect } from "react";

export default function FullscreenCard({
  title,
  icon,
  meta,
  children,
  className = "",
  style = {},
  bodyStyle = {},
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => { if (e.key === "Escape") setExpanded(false); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [expanded]);

  const expandIcon = (
    <button
      className="card-action-btn"
      onClick={() => setExpanded(true)}
      title="Maximize (M)"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polyline points="15 3 21 3 21 9"/>
        <polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/>
        <line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
    </button>
  );

  const card = (
    <div className={`card ${className}`} style={style}>
      {(title || icon || meta) && (
        <div className="card-header">
          <div className="card-title-row">
            {icon}
            {title && <span>{title}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {meta && <span className="card-meta">{meta}</span>}
            {expandIcon}
          </div>
        </div>
      )}
      <div style={bodyStyle}>{children}</div>
    </div>
  );

  if (!expanded) return card;

  return (
    <>
      {card}
      {/* Fullscreen overlay */}
      <div
        className="fs-overlay"
        onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false); }}
      >
        <div className="fs-modal">
          <div className="fs-modal-header">
            <div className="fs-modal-title">
              {icon && <span style={{ color: "var(--accent)" }}>{icon}</span>}
              {title}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {meta && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{meta}</span>}
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Press Esc to close</span>
              <button className="fs-close-btn" onClick={() => setExpanded(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="fs-modal-body">{children}</div>
        </div>
      </div>
    </>
  );
}
