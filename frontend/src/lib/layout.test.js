// Static checks on the real CSS/markup (no DOM needed): the voice control
// survives on phones, and the Air Quality card stacks below 600 px.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
const hero = fs.readFileSync(path.join(SRC, "components", "HeroSection.jsx"), "utf8");
const app = fs.readFileSync(path.join(SRC, "App.jsx"), "utf8");

// Every selector hidden by a `display: none` rule inside a max-width media query.
function hiddenOnNarrow() {
  const out = [];
  for (const m of css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)) {
    const body = m[2].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const r of body.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)) {
      out.push(...r[1].split(",").map((s) => s.trim()));
    }
  }
  return out;
}

test("voice toggle lives in the hero, with an accessible name and toggle state", () => {
  const btn = hero.match(/<button[^>]*className=\{`hero2-voice[\s\S]*?>/)?.[0];
  assert.ok(btn, "hero must render the voice button");
  assert.match(btn, /aria-label="Voice alerts"/);
  assert.match(btn, /aria-pressed=\{!!voiceEnabled\}/);
  assert.match(app, /<HeroSection[\s\S]*?onVoiceToggle=/);
  for (const sel of [".hero2-voice", ".hero2-controls", "button"]) {
    assert.ok(!hiddenOnNarrow().includes(sel), `${sel} must not be hidden on phones`);
  }
});

test("Air Quality card grid is a class (overridable) and stacks below 600px", () => {
  assert.ok(!/gridTemplateColumns:\s*"200px 1fr"/.test(app), "inline 200px 1fr can't be overridden by a media query");
  assert.match(app, /className="aq-card-grid"/);
  const narrow = css.match(/@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(narrow, /\.aq-card-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
});

const health = fs.readFileSync(path.join(SRC, "components", "HealthIntelligencePanel.jsx"), "utf8");

test("Health card grids are classes (overridable) and stack below 600px (readings: 2 columns)", () => {
  assert.ok(!/gridTemplateColumns/.test(health), "no inline grid columns: a media query can't override them");
  const classes = ["health-hero-banner", "health-metric-grid", "health-detail-grid", "health-exposure-grid", "health-pollutant-grid"];
  for (const c of classes) assert.match(health, new RegExp(`className="${c}"`), `${c} must be used`);
  const narrow = [...css.matchAll(/@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  for (const c of ["health-metric-grid", "health-detail-grid", "health-exposure-grid"]) {
    assert.match(narrow, new RegExp(String.raw`\.${c}[^{]*\{[^}]*grid-template-columns:\s*1fr\s*;`), `${c} must collapse to one column`);
  }
  // Reading tiles: two columns on phones (verified clip-free at 360 and 390 px).
  assert.match(narrow, /\.health-pollutant-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*1fr\)\s*;/, "reading tiles must be two columns below 600px");
  assert.match(narrow, /\.health-hero-banner\s*\{[^}]*flex-direction:\s*column/, "risk banner must stack");
});

const plume = fs.readFileSync(path.join(SRC, "components", "PlumeVisualizer.jsx"), "utf8");

test("Pollution Dispersion card grids are classes and stack below 600px", () => {
  assert.ok(!/gridTemplateColumns/.test(plume), "no inline grid columns: a media query can't override them");
  for (const c of ["plume-split", "plume-split-explain", "plume-params"]) assert.match(plume, new RegExp(`className="${c}"`));
  const narrow = [...css.matchAll(/@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  assert.match(narrow, /\.plume-split\s*\{[^}]*grid-template-columns:\s*1fr\s*;/);
  assert.match(narrow, /\.plume-split-explain\s*\{[^}]*border-right:\s*none/);
  // Wind value + confidence pill get the full row; half a column wrapped the pill.
  assert.match(plume, /className="plume-param-wind"/);
  assert.match(narrow, /\.plume-param-wind\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test("edge-to-edge cards keep their header inset", () => {
  // style={{ padding: 0 }} on a FullscreenCard took the header's padding
  // with it: title flush on the card border. .card-flush pads the header.
  assert.ok(!/<FullscreenCard[^>]*style=\{\{\s*padding:\s*0\s*\}\}/.test(app), "use className=\"card-flush\", not an inline padding: 0");
  assert.match(css, /\.card-flush\s*>\s*\.card-header\s*\{[^}]*padding:\s*20px 22px 0/);
});

test("every full-width section uses the same 16px phone gutter", () => {
  // Health Intelligence and Pollution Dispersion wrappers are .section-pad,
  // not an inline 28px that the phone rule can't reach.
  assert.ok(!/padding:\s*"0 28px/.test(app), "no inline 28px section padding");
  const m768 = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(m768, /\.section-pad\s*\{[^}]*padding-left:\s*16px;\s*padding-right:\s*16px/);
  assert.match(m768, /\.content-grid,\s*\.charts-band,\s*\.station-table-wrap\s*\{\s*padding:\s*0 16px/);
});
