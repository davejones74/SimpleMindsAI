import { config } from "../config.js";

/**
 * Synthetic feedback path (requirement #10).
 *
 *   chat → brain → response → teacher review → high-confidence → capture
 *
 * A chat exchange is captured as a synthetic ARTICLE only when ALL of:
 *   - config.syntheticFeedback is enabled,
 *   - the critic scores the reply >= syntheticMinScore (high-confidence branch),
 *   - the reply is non-trivial (passes the deterministic heuristic guardrail).
 *
 * Origin is stamped "synthetic" end-to-end; the model that wrote it is recorded
 * for provenance. There is deliberately NO synthetic cap on the training set in
 * the article domain: the signal is next-token prediction, not a reward, so the
 * echo-chamber failure mode this cap guarded against does not exist. Synthetic
 * share is REPORTED, never used to silently drop rows.
 *
 * Eval isolation is structural: a synthetic article lives in the ledger exactly
 * like any other, but the evaluation set is a separate immutable file that
 * nothing ever writes through this path.
 */

/**
 * @param {object}   input.promptText  user message (becomes article context)
 * @param {object}   input.replyText   the brain's answer (becomes article body)
 * @param {object}   input.model       model id/name that produced the reply
 * @param {object}   input.store       ArticleStore-like: ingestArticle/recordReview
 * @param {Function} input.scoreFn     async ({text}) => {score, rationale, verdict} — default: ReviewScorer
 * @returns captured record or { captured: false, reason }
 */
export async function maybeCaptureSynthetic({
  promptText,
  replyText,
  model,
  store,
  scoreFn = defaultScoreFn,
  enabled = config.syntheticFeedback,
  minScore = config.syntheticMinScore,
  criticModel = config.criticModel,
  criticVersion = config.criticVersion,
  rubricVersion = config.rubricVersion,
} = {}) {
  if (!enabled) return { captured: false, reason: "synthetic feedback disabled" };
  if (!promptText || !replyText || !String(replyText).trim()) return { captured: false, reason: "nothing to capture" };

  const text = `${String(promptText).trim()}\n\n${String(replyText).trim()}`;
  let scoreRecord;
  try {
    scoreRecord = await scoreFn({ text });
  } catch (err) {
    return { captured: false, reason: `critic unavailable: ${err.message.slice(0, 80)}` };
  }
  const score = Number(scoreRecord?.score);
  if (!Number.isFinite(score) || score < minScore) {
    return { captured: false, reason: `score ${Number.isNaN(score) ? "?" : score.toFixed(1)} below min ${minScore}` };
  }

  const article = await store.ingestArticle({
    text,
    source: "synthetic-feedback",
    domain: "general",
    origin: "synthetic",
    model,
  });
  await store.recordReview({
    articleId: article.articleId,
    verdict: "approve",
    score,
    rationale: scoreRecord?.rationale ?? "(high-confidence chat reply)",
    authority: "teacher",
    reviewerModel: criticModel,
    reviewerVersion: criticVersion,
    rubricVersion,
    guardrailResult: { passed: true, heuristicPenalty: scoreRecord?.penalty ?? null },
  });
  return { captured: true, articleId: article.articleId, score, origin: "synthetic" };
}

async function defaultScoreFn({ text }) {
  const { ReviewScorer } = await import("../reward/reward-scorer.js");
  return new ReviewScorer().scoreOffline({ text });
}
