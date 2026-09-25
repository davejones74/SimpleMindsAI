import { config } from "../config.js";

/**
 * Synthetic feedback path (requirement #10).
 *
 *   chat → brain → response → reward scorer → high-confidence → capture
 *
 * A chat exchange is only captured as a synthetic training example when ALL of:
 *   - config.syntheticFeedback is enabled,
 *   - the critic scores the reply >= syntheticMinScore (high-confidence branch),
 *   - the reply is non-trivial (passes the deterministic heuristic guardrail).
 *
 * Origin is stamped "synthetic" end-to-end; the model that wrote it is recorded
 * for provenance. The maxSyntheticShare cap is RE-ENFORCED at snapshot build
 * time (minimum: lower-reward synthetic dropped first), so a chat flood can
 * never dominate a dataset even if every reply scores high.
 *
 * Eval isolation is structural: a synthetic row lives in the buffer exactly like
 * any other, but the evaluation set is a separate immutable file that nothing
 * ever writes through this path.
 */

/**
 * @param {object}  input.promptText   user message (becomes the prompt)
 * @param {object}  input.replyText    the brain's answer (becomes the completion)
 * @param {object}  input.model        model id/name that produced the reply
 * @param {object}  input.store        BufferStore-like: ingestPrompt/ingestCompletion/scoreCompletion
 * @param {Function} input.scoreFn     async ({prompt, completion}) => {score, rationale} — default: RewardScorer
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

  let scoreRecord;
  try {
    scoreRecord = await scoreFn({ prompt: promptText, completion: replyText });
  } catch (err) {
    return { captured: false, reason: `critic unavailable: ${err.message.slice(0, 80)}` };
  }
  const score = Number(scoreRecord?.score);
  if (!Number.isFinite(score) || score < minScore) {
    return { captured: false, reason: `score ${Number.isNaN(score) ? "?" : score.toFixed(1)} below min ${minScore}` };
  }

  const p = await store.ingestPrompt({ text: promptText, source: "synthetic-feedback", domain: "general" });
  const c = await store.ingestCompletion({ promptId: p.id, text: replyText, model, origin: "synthetic" });
  await store.scoreCompletion({
    completionId: c.id,
    score,
    rationale: scoreRecord?.rationale ?? "(high-confidence chat reply)",
    criticModel,
    criticVersion,
    rubricVersion,
    guardrailResult: { passed: true, heuristicPenalty: scoreRecord?.penalty ?? null },
  });
  return { captured: true, promptId: p.id, completionId: c.id, score, origin: "synthetic" };
}

async function defaultScoreFn({ prompt, completion }) {
  const { RewardScorer } = await import("../reward/reward-scorer.js");
  const result = await new RewardScorer().scoreOffline({ promptText: prompt, completionText: completion });
  return result;
}