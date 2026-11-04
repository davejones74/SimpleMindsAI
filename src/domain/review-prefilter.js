/**
 * Deterministic pre-review filtering.
 *
 * The teacher critic is the expensive, language-blind stage. Sending it obvious
 * non-prose (titles, navigation blocks, citation lists, tiny fragments) wastes
 * capacity and, historically, let short fragments through with high scores.
 * This prefilter is intentionally narrow: it only rejects material the
 * deterministic completeness assessor already classifies as hard-reject, plus
 * an explicit minimum length/word floor. It never judges relevance or quality.
 *
 * `shadow` (default) records would-be rejections without changing the review
 * outcome, so the filter can be calibrated before enforcement.
 */

import { assessCompleteness } from "./review-gates.js";

export const PREFILTER_MODES = Object.freeze(["off", "shadow", "enforce"]);

export function prefilterReview(text, {
  minChars = 200,
  minWords = 20,
  mode = "shadow",
} = {}) {
  const completeness = assessCompleteness(text);
  const words = completeness.metrics?.words ?? 0;
  const chars = completeness.metrics?.chars ?? 0;
  let decision = "proceed";
  let reason = null;

  if (completeness.decision === "reject") {
    decision = "reject";
    reason = completeness.reason;
  } else if (chars < minChars || words < minWords) {
    decision = "reject";
    reason = `below pre-review floor (${chars} chars, ${words} words; need ${minChars}/${minWords})`;
  } else if (completeness.decision === "quarantine") {
    decision = "quarantine";
    reason = completeness.reason;
  }

  return {
    schema: "sma/review-prefilter@1",
    mode,
    decision,
    wouldReject: decision === "reject",
    wouldQuarantine: decision === "quarantine",
    reason,
    completeness,
  };
}
