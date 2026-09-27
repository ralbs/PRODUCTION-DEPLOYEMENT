import { test } from "node:test";
import assert from "node:assert/strict";
import { describeLastRun, explainWindReason } from "./lastRun.js";

const ok = (doc) => ({ status: "ok", doc: { ran_at: "2026-09-27T12:00:03Z", ...doc } });

// The worker's real reason strings (ctm-core/scripts/source_direction_worker.py).
const NO_SPIKE = ok({ outcome: "skipped", reason: "no spike", spike_detected: false, wind_failure_reason: null });
const RATE_LIMITED = ok({
  outcome: "skipped", spike_detected: true, spike_timestamp: "2026-09-27T11:45:00Z",
  reason: "no real wind data: provider_http_429 -- 1h window ending ... (live feed)",
  wind_failure_reason: "provider_http_429",
});
const NO_COVERAGE = ok({
  outcome: "skipped", spike_detected: true, spike_timestamp: "2030-01-01T11:45:00Z",
  reason: "no real wind data: window has no coverage -- 1h window ending ... (archive)",
  wind_failure_reason: "window has no coverage",
});

test("the three skip reasons produce three different kinds, titles and details", () => {
  const out = [NO_SPIKE, RATE_LIMITED, NO_COVERAGE].map(describeLastRun);
  assert.deepEqual(out.map((o) => o.kind), ["no_spike", "spike_no_wind", "spike_no_wind"]);
  // Same kind for both wind failures is fine -- but what they SAY must differ.
  assert.equal(new Set(out.map((o) => `${o.title}|${o.detail}`)).size, 3);
});

test("'no spike' is calm and never mentions wind", () => {
  const d = describeLastRun(NO_SPIKE);
  assert.equal(d.tone, "neutral");
  assert.match(d.title, /No spike/);
  assert.doesNotMatch(`${d.title} ${d.detail}`, /wind/i);
});

test("spike + rate limit is a warning that names the real cause and keeps the raw code", () => {
  const d = describeLastRun(RATE_LIMITED);
  assert.equal(d.tone, "warning");
  assert.match(d.title, /Spike detected, but no direction estimate/);
  assert.match(d.detail, /rate-limiting this server \(HTTP 429\)/);
  assert.equal(d.code, "provider_http_429");
  assert.equal(d.spikeAt, "2026-09-27T11:45:00Z");
});

test("spike + archive gap says coverage, not rate limit", () => {
  const d = describeLastRun(NO_COVERAGE);
  assert.equal(d.tone, "warning");
  assert.match(d.detail, /archive has no data/);
  assert.doesNotMatch(d.detail, /429|rate/);
});

test("check couldn't run, never reported, and run failed are each their own state", () => {
  assert.equal(describeLastRun(ok({ outcome: "skipped", reason: "not enough data for a spike check", spike_detected: null })).kind, "spike_check_unavailable");
  assert.equal(describeLastRun({ status: "not_found", doc: null }).kind, "never_ran");
  const failed = describeLastRun(ok({ outcome: "error", reason: "post_failed: HTTP 500" }));
  assert.equal(failed.kind, "run_failed");
  assert.equal(failed.tone, "error");
});

test("unknown HTTP and network codes still read as a wind-provider problem", () => {
  assert.match(explainWindReason("provider_http_503"), /HTTP 503/);
  assert.match(explainWindReason("network_error_ConnectionError"), /couldn't be reached/);
});
