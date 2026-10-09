import { createHash } from "node:crypto";
import { config } from "../config.js";
import { AUTHORITY, IMPORTANCE, STATUS, VERDICT, isTrainable, normalizeImportance } from "./article.js";

/**
 * Review selection and state-transition policy.
 *
 * This module is the ONLY place that decides (a) which articles are queued for
 * teacher review, and (b) what a review verdict does to an article. It is
 * deterministic and pure: given the same article + policy it always makes the
 * same decision, which is what makes sampling auditable and testable.
 *
 * Authority rules, stated once so they can never be confused:
 *   - AUTOMATION selects (never approves/rejects).
 *   - The TEACHER may recommend, but it cannot mutate authoritative article
 *     state beyond an eligibility-checked transition, and it can never touch
 *     operator-controlled importance.
 *   - A HUMAN decision is final. Once `decidedBy === "human"`, a later teacher
 *     verdict is ignored.
 */

/**
 * The single source of truth for policy VALUES is `config.review`, so the values
 * used for autonomous selection and verdict gating can never drift from the
 * values an operator configures via env. This function is the ONLY translation
 * between the two shapes.
 */
export function policyFromConfig(review = config.review) {
  return Object.freeze({
    sampleRate: Number(review.sampleRate),
    approveMinScore: Number(review.minScore),
    uncertaintyThreshold: Number(review.uncertaintyThreshold),
    missionRelevanceThreshold: Number(review.missionRelevanceThreshold),
    salt: String(review.salt),
  });
}

export const DEFAULT_POLICY = policyFromConfig();

/** Deterministic [0,1) sample from an article id — reproducible, not random. */
export function sampleUnit(articleId, salt = DEFAULT_POLICY.salt) {
  const h = createHash("sha256").update(`${articleId}\u0000${salt}`, "utf8").digest("hex");
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

/**
 * Decide whether an article should enter teacher review.
 * @returns {{selected: boolean, reasons: string[], sample: number}}
 */
export function selectionDecision(article, policy = DEFAULT_POLICY) {
  const reasons = [];
  if (article?.reviewRequested) reasons.push("human-requested");

  const importance = normalizeImportance(article?.importance);
  if (importance === IMPORTANCE.IMPORTANT || importance === IMPORTANCE.CRITICAL) reasons.push("important");

  const relevance = Number(article?.missionRelevance);
  if (Number.isFinite(relevance) && relevance >= policy.missionRelevanceThreshold) reasons.push("mission-relevance");

  const uncertainty = Number(article?.uncertainty);
  if (Number.isFinite(uncertainty) && uncertainty >= policy.uncertaintyThreshold) reasons.push("uncertainty");

  const sample = sampleUnit(String(article?.articleId ?? ""), policy.salt);
  if (reasons.length === 0 && sample < policy.sampleRate) reasons.push("sampled");

  return { selected: reasons.length > 0, reasons, sample };
}

/**
 * Compute the target review state for a verdict WITHOUT mutating anything.
 * @returns {{apply: boolean, status: string, decidedBy: string|null, reason: string}}
 */
export function evaluateVerdict(article, { verdict, score, authority = AUTHORITY.TEACHER }, policy = DEFAULT_POLICY) {
  const current = article?.status;
  const decidedBy = article?.decidedBy ?? null;

  if (authority === AUTHORITY.HUMAN) {
    const status =
      verdict === VERDICT.APPROVE ? STATUS.REVIEWED
        : verdict === VERDICT.REJECT ? STATUS.REJECTED
          : STATUS.PENDING_REVIEW;
    return { apply: true, status, decidedBy: AUTHORITY.HUMAN, reason: `human ${verdict}` };
  }

  // Teacher (or any non-human) recommendation.
  if (decidedBy === AUTHORITY.HUMAN) {
    return { apply: false, status: current, decidedBy, reason: "a human decision is already authoritative" };
  }

  if (verdict === VERDICT.REJECT) {
    return { apply: true, status: STATUS.REJECTED, decidedBy: AUTHORITY.TEACHER, reason: "teacher rejected" };
  }
  if (verdict === VERDICT.APPROVE) {
    const s = Number(score);
    if (Number.isFinite(s) && s >= policy.approveMinScore) {
      return { apply: true, status: STATUS.REVIEWED, decidedBy: AUTHORITY.TEACHER, reason: `teacher approved (score ${s})` };
    }
    return { apply: false, status: STATUS.PENDING_REVIEW, decidedBy, reason: `approve ignored: score ${score ?? "?"} below ${policy.approveMinScore}` };
  }
  // uncertain
  return { apply: false, status: STATUS.PENDING_REVIEW, decidedBy, reason: "teacher uncertain — stays pending" };
}

export { isTrainable };
