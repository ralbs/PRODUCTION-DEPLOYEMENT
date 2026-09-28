import { advisory } from "../lib/healthGuidance";
import { aqiToRgb } from "../lib/aqiColor";

// The advisory card. All wording comes from lib/healthGuidance.js: CPCB's
// published health impact for the category (verbatim), and the NAAQS
// standard for the dominant pollutant. It used to carry invented actions
// ("Wear N95 mask outdoors", "Seal windows & doors") and per-group advice
// CPCB doesn't publish; those are gone, not reworded.
export default function HealthAdvisory({ aqi }) {
  const adv = advisory(aqi?.aqi, aqi?.dominant_pollutant);
  if (!adv) {
    return (
      <div style={{ padding: "14px 0", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
        Awaiting data…
      </div>
    );
  }

  const [r, g, b] = aqiToRgb(aqi.aqi) || [148, 163, 184];
  return (
    <div data-testid="health-advisory" style={{
      marginTop: 18, padding: "14px 16px", borderRadius: 12,
      background: `rgba(${r},${g},${b},0.08)`, border: `1px solid rgba(${r},${g},${b},0.3)`,
      borderLeft: `4px solid rgb(${r},${g},${b})`,
    }}>
      <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", lineHeight: 1.5, margin: "0 0 6px" }}>
        {adv.headline}
      </p>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 3 }}>
        Health impact (CPCB)
      </div>
      <p style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.55, margin: 0 }}>{adv.impact}</p>

      {adv.dominant && (
        <div style={{
          marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)",
          fontSize: 11, color: "var(--text-sub)", display: "flex", gap: 16, flexWrap: "wrap",
        }}>
          <span>Dominant pollutant: <strong style={{ color: "var(--text)" }}>{adv.dominant.name}</strong></span>
          <span>CPCB standard: <strong style={{ color: "var(--text)" }}>{adv.dominant.standard}</strong> ({adv.dominant.period} average)</span>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
        Sources: {adv.source}{adv.dominant ? `; ${adv.dominant.source}` : ""}
      </div>
    </div>
  );
}
