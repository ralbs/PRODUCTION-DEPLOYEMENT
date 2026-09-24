// Screening-grade confidence threshold below which a bearing estimate is
// treated as inconclusive rather than shown as a confident arrow/badge.
// Not invented here -- matches the real, disclosed cutoff
// PROMPT_FLOW_INTEGRATION.md's Phase I3 saturation sweep used ("usable
// signal (confidence > 0.1)") against this exact adjoint tracer.
//
// The "86.3% of real hours were fully saturated" figure that sweep
// originally reported is now STALE, not current behavior -- it predates
// commit e1fbe37's boundary-exit-sector fallback, which changed a fully-
// saturated trace from confidence:0.0 to a real (often high) boundary
// confidence. A re-sweep against the current code found confidence<=0.1
// only ~1.7% of the time. The 0.1 CUTOFF VALUE here is unaffected (it's
// the same methodological line the original sweep drew, just no longer
// the common case in practice) -- see PROMPT_FLOW_INTEGRATION.md's
// correction for the real current numbers.
export const INCONCLUSIVE_CONFIDENCE = 0.1;

// `doc` is a SourceDirection document (backend/models/SourceDirection.js)
// or null (no estimate exists yet for this station).
export function isInconclusive(doc) {
  return !doc || doc.confidence <= INCONCLUSIVE_CONFIDENCE;
}
