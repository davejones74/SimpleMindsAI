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
});
export const STATUSES = Object.freeze([STATUS.INGESTED, STATUS.PENDING_REVIEW, STATUS.REVIEWED, STATUS.REJECTED]);

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

/**
 * The single trainability predicate. Nothing else may decide this. Pending,
 * rejected, ingested, and already-consumed articles are all excluded.
 */
export function isTrainable(article) {
  return Boolean(article) && article.status === STATUS.REVIEWED && !article.consumedAt;
}

/** Normalise an importance value, defaulting to Normal (never throws on read). */
export function normalizeImportance(v) {
  return isImportance(v) ? v : IMPORTANCE.NORMAL;
}
