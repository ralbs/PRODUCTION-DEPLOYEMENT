// Screening-grade confidence threshold below which a bearing estimate is
// treated as inconclusive rather than shown as a confident arrow/badge.
// Not invented here -- matches the real, disclosed cutoff
// PROMPT_FLOW_INTEGRATION.md's Phase I3 saturation sweep used ("usable
// signal (confidence > 0.1)") against this exact adjoint tracer, at the
// exact domain size currently shipped (86.3% of real hours were fully
// saturated, confidence == 0.0, at that sweep).
export const INCONCLUSIVE_CONFIDENCE = 0.1;

// `doc` is a SourceDirection document (backend/models/SourceDirection.js)
// or null (no estimate exists yet for this station).
export function isInconclusive(doc) {
  return !doc || doc.confidence <= INCONCLUSIVE_CONFIDENCE;
}
