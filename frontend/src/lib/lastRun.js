// What the Source Direction panel says when there is no current estimate,
// from the worker's last-run record (GET /api/source-direction/last-run,
// backend/models/WorkerRun.js).
//
// The gap this closes: with no record, "no spike this hour" and "spike
// detected, but the wind fetch failed (provider_http_429)" rendered as the
// SAME generic "no estimate yet" text -- the centerpiece feature could fail
// silently. Each case below has its own `kind` and its own words, and a
// spike that produced no estimate is a `warning`, never the calm style.

export const SOURCE_DIRECTION_CADENCE_MIN = 15; // render.yaml: cron "*/15 * * * *"

const WIND_REASON_TEXT = {
  provider_http_429: "the wind provider is rate-limiting this server (HTTP 429)",
  "window has no coverage": "the wind archive has no data for that time",
  timeout: "the wind provider didn't respond in time",
  provider_non_json: "the wind provider sent an unreadable response",
  payload_missing_fields: "the wind provider's response was missing wind fields",
  no_valid_rows_in_window: "the wind provider had no usable reading for that hour",
};

export function explainWindReason(code) {
  if (!code) return "wind data was unavailable";
  if (WIND_REASON_TEXT[code]) return WIND_REASON_TEXT[code];
  const http = /^provider_http_(\d{3})$/.exec(code);
  if (http) return `the wind provider returned HTTP ${http[1]}`;
  if (code.startsWith("network_error_")) return "the wind provider couldn't be reached";
  return "wind data was unavailable";
}

/**
 * @param lastRun { status: "idle"|"loading"|"ok"|"not_found"|"error", doc }
 * @returns { kind, tone: "neutral"|"warning"|"error", title, detail, code, ranAt }
 */
export function describeLastRun(lastRun) {
  const status = lastRun?.status;
  if (status === "idle" || status === "loading") {
    return { kind: "loading", tone: "neutral", title: "Checking the screening worker's last run…", detail: null, code: null, ranAt: null };
  }
  if (status === "error") {
    return { kind: "status_unavailable", tone: "neutral", title: "No directional estimate, and the worker's last-run status couldn't be loaded.", detail: null, code: null, ranAt: null };
  }
  if (status !== "ok" || !lastRun.doc) {
    return {
      kind: "never_ran", tone: "neutral",
      title: "No directional estimate, and the screening worker hasn't reported a run for this station yet.",
      detail: "If this persists, the scheduled worker may not be running.", code: null, ranAt: null,
    };
  }

  const d = lastRun.doc;
  const ranAt = d.ran_at;
  if (d.outcome === "error") {
    return { kind: "run_failed", tone: "error", title: "The screening worker's last run failed.", detail: d.reason || null, code: d.reason || null, ranAt };
  }
  if (d.outcome === "ingested") {
    // A stored estimate exists but /latest found none -- say so rather than guess.
    return { kind: "ingested_not_found", tone: "neutral", title: "The last run stored an estimate, but it couldn't be loaded.", detail: null, code: null, ranAt };
  }
  if (d.spike_detected === true) {
    if (d.wind_failure_reason) {
      return {
        kind: "spike_no_wind", tone: "warning",
        title: "Spike detected, but no direction estimate: no wind data.",
        detail: `The spike was real, but ${explainWindReason(d.wind_failure_reason)}, so the backward trace couldn't run.`,
        code: d.wind_failure_reason, ranAt, spikeAt: d.spike_timestamp,
      };
    }
    return {
      kind: "spike_no_estimate", tone: "warning",
      title: "Spike detected, but no direction estimate.",
      detail: d.reason || null, code: null, ranAt, spikeAt: d.spike_timestamp,
    };
  }
  if (d.spike_detected === false) {
    return {
      kind: "no_spike", tone: "neutral",
      title: "No spike on the last check — nothing to estimate.",
      detail: "This feature only runs when a real statistical spike appears in the readings; most checks find none.",
      code: null, ranAt,
    };
  }
  // spike_detected null: the spike check itself couldn't run.
  return {
    kind: "spike_check_unavailable", tone: "neutral",
    title: "The last check couldn't test for a spike.",
    detail: d.reason === "not enough data for a spike check"
      ? "Not enough readings from this station yet to test for one."
      : (d.reason || null),
    code: null, ranAt,
  };
}
