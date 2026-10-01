// Static checks on the real CSS/markup (no DOM needed): the voice control
// survives on phones.
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
