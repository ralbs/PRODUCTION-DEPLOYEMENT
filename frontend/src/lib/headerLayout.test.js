// The voice control must stay usable on phones: icon-only, not hidden.
// Static checks on the real CSS/markup (no DOM needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
const header = fs.readFileSync(path.join(SRC, "components", "Header.jsx"), "utf8");

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

test("phones hide the voice LABEL, never the voice button", () => {
  const hidden = hiddenOnNarrow();
  assert.ok(hidden.includes(".icon-btn-label"), "label should be hidden on phones");
  for (const sel of [".icon-btn", "button", ".header-right"]) assert.ok(!hidden.includes(sel), `${sel} must not be hidden`);
});

test("voice button keeps an accessible name and toggle state when the label is hidden", () => {
  const btn = header.match(/<button\s+className=\{`icon-btn\$\{voiceEnabled[\s\S]*?>/)[0];
  assert.match(btn, /aria-label="Voice alerts"/);
  assert.match(btn, /aria-pressed=\{voiceEnabled\}/);
  assert.match(header, /<span className="icon-btn-label">/);
});
