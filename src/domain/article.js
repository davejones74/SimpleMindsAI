import { createHash } from "node:crypto";

/**
 * The authoritative Article domain (one record per unit of training material).
 *
 * The training unit is an ARTICLE — continuous prose a causal LM learns to
 * predict — never a {prompt, completion} pair. There is exactly ONE article
 * record. Review verdicts are separate records that reference an article; they
 * never mutate article content, only its review state (and, when a human acts,
 * its operator-controlled importance).
 *
 * Lifecycle status is derived from review events, but stored on the record so
 * reads are cheap:
 *
 *   INGESTED ──selected──▶ PENDING_REVIEW ──approve──▶ REVIEWED ──consume──▶ (consumed)
 *                                      └───reject───▶ REJECTED
 *
 * Consumption is tracked SEPARATELY from status (`consumedAt`), because the
 * question "has this been reviewed?" and the question "has this been trained
 * on?" are different questions. The invariant that matters: only
 * REVIEWED-and-not-consumed articles are trainable.
 */

export const IMPORTANCE = Object.freeze({
  NORMAL: "Normal",
  IMPORTANT: "Important",
  CRITICAL: "Critical",
});
export const IMPORTANCE_LEVELS = Object.freeze([IMPORTANCE.NORMAL, IMPORTANCE.IMPORTANT, IMPORTANCE.CRITICAL]);

/**
 * Provenance of an article's canonical importance.
 *
 *   default    — never classified (the ingest default); eligible for the first
 *                automated classification from a critic suggestion.
 *   teacher    — assigned automatically from a critic/teacher suggestion.
 *   automation — assigned automatically by a non-teacher automated path.
 *   operator   — assigned by a human; ALWAYS wins and is never auto-overwritten.
 *
 * The canonical `article.importance` is the single authoritative classification;
 * `suggestedImportance` remains advisory evidence of the critic's recommendation.
 */
export const IMPORTANCE_SOURCE = Object.freeze({
  DEFAULT: "default",
  TEACHER: "teacher",
  AUTOMATION: "automation",
  OPERATOR: "operator",
});

/** True when an importance value was set by a human operator (never auto-overwritten). */
export function isOperatorImportance(article) {
  return Boolean(article) && (article.importanceSource === IMPORTANCE_SOURCE.OPERATOR || article.importanceDecidedBy === AUTHORITY.HUMAN);
}

/** True when an article has no classification yet (ingest default). */
export function isUnclassifiedImportance(article) {
  return !article || !article.importanceSource || article.importanceSource === IMPORTANCE_SOURCE.DEFAULT;
}

export const STATUS = Object.freeze({
  INGESTED: "INGESTED",
  PENDING_REVIEW: "PENDING_REVIEW",
  REVIEWED: "REVIEWED",
  REJECTED: "REJECTED",
  RETIRED: "RETIRED",
  // A retained review-exhaustion state. Unlike RETIRED it is not a quality or
  // licence verdict: the text is kept for a later review pass, but it is neither
  // trainable nor replay-eligible until resolved. Historical migration uses it
  // for records whose evidence is conflicting or insufficient.
  UNRESOLVED: "UNRESOLVED",
  // A reversible, NON-destructive holding state for material that must never
  // reach training but is not a verdict on the text. Unlike RETIRED (a terminal
  // outcome of bounded review) a quarantine is a separate, independently
  // releasable action with an auditable REASON, so historical junk can be taken
  // out of circulation without deleting it or pretending the teacher judged it.
  QUARANTINED: "QUARANTINED",
});
export const STATUSES = Object.freeze([STATUS.INGESTED, STATUS.PENDING_REVIEW, STATUS.REVIEWED, STATUS.REJECTED, STATUS.RETIRED, STATUS.UNRESOLVED, STATUS.QUARANTINED]);

/**
 * Why an article was quarantined. These are deliberately distinct, closed
 * categories so a later audit can tell an untranslated foreign-prose record
 * from corrupted text, machine-translated material, or a review hot-loop — the
 * remediation differs per category, so collapsing them into one bucket would
 * destroy the audit trail.
 */
export const QUARANTINE_REASON = Object.freeze({
  FOREIGN_PROSE: "foreign-prose", // untranslated non-English text admitted before the language gate
  CORRUPTED_TEXT: "corrupted-text", // encoding damage / mojibake / truncation that survived cleaning
  MACHINE_TRANSLATED: "machine-translated", // low-quality translated material (not merely foreign-sourced)
  REVIEW_HOT_LOOP: "review-hot-loop", // re-scored indefinitely before bounded review was enforced
});
export const QUARANTINE_REASONS = Object.freeze(Object.values(QUARANTINE_REASON));

export const VERDICT = Object.freeze({
  APPROVE: "approve",
  REJECT: "reject",
  UNCERTAIN: "uncertain",
});
export const VERDICTS = Object.freeze([VERDICT.APPROVE, VERDICT.REJECT, VERDICT.UNCERTAIN]);

export const AUTHORITY = Object.freeze({
  TEACHER: "teacher",
  HUMAN: "human",
  AUTOMATION: "automation",
});

/** Content hash — the identity of an article's bytes and the replay anchor. */
export function contentHash(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function isImportance(v) {
  return IMPORTANCE_LEVELS.includes(v);
}
export function isStatus(v) {
  return STATUSES.includes(v);
}
export function isVerdict(v) {
  return VERDICTS.includes(v);
}
export function isAuthority(v) {
  return Object.values(AUTHORITY).includes(v);
}
export function isQuarantineReason(v) {
  return QUARANTINE_REASONS.includes(v);
}

/**
 * True while an article is deferred after a rejected training run and its
 * cooldown has not yet elapsed. Deferral is a *delay*, not a verdict: once the
 * deadline passes the article is eligible again.
 */
export function inDeferralCooldown(article, now = Date.now()) {
  if (!article?.deferredUntil) return false;
  const until = Date.parse(article.deferredUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * The single trainability predicate. Nothing else may decide this. Pending,
 * rejected, ingested, and already-consumed articles are all excluded, as are
 * articles whose rejected-run cooldown has not elapsed and articles whose fresh
 * retries are exhausted (`replayOnly` — they remain learnable via replay, never
 * deleted, but are no longer treated as the fresh delta).
 */
export function isTrainable(article, now = Date.now()) {
  return Boolean(article) && article.status === STATUS.REVIEWED && !article.consumedAt && article.status !== STATUS.RETIRED && article.replayOnly !== true && !inDeferralCooldown(article, now);
}

/**
 * Integrity check for replay: the stored training text must be present. The
 * content hash is verified by the migration/audit path; the hot replay predicate
 * only rejects empty/missing text so it stays cheap.
 */
export function hasReplayText(article) {
  return Boolean(article) && typeof article.text === "string" && article.text.trim().length > 0;
}

/**
 * Eligibility for replay, independent of the review terminal status.
 *
 * `replayEligible` is the durable authority when it is present. Legacy records
 * without it fall back to the historical REVIEWED rule. This is deliberately
 * NOT `status === REVIEWED`: an article retired from further review can remain
 * valid source knowledge and stay available for replay. Explicitly rejected,
 * quarantined, unresolved, corrupt or licence/quality-excluded material is never
 * eligible, even if it was consumed historically.
 */
export function isReplayEligible(article) {
  if (!hasReplayText(article)) return false;
  if (article.status === STATUS.REJECTED || article.status === STATUS.QUARANTINED || article.status === STATUS.UNRESOLVED) return false;
  if (article.quarantined === true) return false;
  if (article.excludedReason) return false;
  if (article.replayEligible === true) return true;
  if (article.replayEligible === false) return false;
  // Legacy fallback: only REVIEWED material was implicitly replayable. A legacy
  // RETIRED record is not made replayable without an explicit migration event.
  return article.status === STATUS.REVIEWED;
}

/**
 * Membership of the historical replay reservoir. A fresh (unconsumed) REVIEWED
 * article is eligible for future replay, but is not yet part of the reservoir;
 * it becomes a reservoir row after it is consumed or moved to replayOnly. A
 * retired article with explicit replay eligibility is included.
 */
export function isReplayPool(article) {
  if (!isReplayEligible(article)) return false;
  return Boolean(article.consumedAt) || article.replayOnly === true || article.status === STATUS.RETIRED;
}

/** True when an explicit/inferred exclusion keeps this article out of replay. */
export function isReplayExcluded(article) {
  return Boolean(article) && !isReplayEligible(article) && (article.replayEligible === false || article.status === STATUS.REJECTED || article.status === STATUS.QUARANTINED || article.status === STATUS.UNRESOLVED || Boolean(article.excludedReason) || Boolean(article.quarantined) || !hasReplayText(article));
}

/** Normalise an importance value, defaulting to Normal (never throws on read). */
export function normalizeImportance(v) {
  return isImportance(v) ? v : IMPORTANCE.NORMAL;
}
