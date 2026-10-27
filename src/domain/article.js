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

export const STATUS = Object.freeze({
  INGESTED: "INGESTED",
  PENDING_REVIEW: "PENDING_REVIEW",
  REVIEWED: "REVIEWED",
  REJECTED: "REJECTED",
  RETIRED: "RETIRED",
  // A reversible, NON-destructive holding state for material that must never
  // reach training but is not a verdict on the text. Unlike RETIRED (a terminal
  // outcome of bounded review) a quarantine is a separate, independently
  // releasable action with an auditable REASON, so historical junk can be taken
  // out of circulation without deleting it or pretending the teacher judged it.
  QUARANTINED: "QUARANTINED",
});
export const STATUSES = Object.freeze([STATUS.INGESTED, STATUS.PENDING_REVIEW, STATUS.REVIEWED, STATUS.REJECTED, STATUS.RETIRED, STATUS.QUARANTINED]);

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
 * Membership of the replay pool: REVIEWED material that has either already been
 * consumed by a promoted model, or exhausted its fresh retries (`replayOnly`).
 * Retired and quarantined material is excluded. This is the historical-training
 * reservoir a run samples from to retain earlier learning alongside new input.
 */
export function isReplayPool(article) {
  return Boolean(article) && article.status === STATUS.REVIEWED && article.status !== STATUS.RETIRED && (Boolean(article.consumedAt) || article.replayOnly === true);
}

/** Normalise an importance value, defaulting to Normal (never throws on read). */
export function normalizeImportance(v) {
  return isImportance(v) ? v : IMPORTANCE.NORMAL;
}
