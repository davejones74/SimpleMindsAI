import { config } from "../config.js";

/**
 * Deterministic evaluator (requirement #4 + #5).
 *
 * We do NOT pretend an LLM judge is ground truth. Evaluation here is a cheap,
 * repeatable token-F1 overlap between a reference completion and the candidate
 * model's output — the SAME immutable evaluation set, BEFORE and AFTER training.
 * Deliberately not a learned metric: it must produce identical numbers on any
 * machine, which is what makes PROMOTE/REJECT auditable.
 *
 * (A future phase can layer an LLM/embedding judge on top, but the promotion
 * gate stays a deterministic compare — never "trust smell".)
 *
 * Open architecture for reward provenance: the evaluator shares the critic
 * model/version spine so a run records exactly which evaluator version scored it.
 */

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .match(/[a-z0-9']+/g) ?? [];
}

/** Standard multi-set F1 over normalized tokens. 1.0 = identical, 0 = no overlap. */
export function tokenF1(expected, actual) {
  const exp = tokenize(expected);
  const act = tokenize(actual);
  if (!exp.length && !act.length) return 1; // both empty => trivially identical
  if (!exp.length || !act.length) return 0;
  const a = [...exp].sort();
  const b = [...act].sort();
  let i = 0, j = 0, overlap = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) i++;
    else if (a[i] > b[j]) j++;
    else { overlap++; i++; j++; }
  }
  const precision = overlap / a.length;
  const recall = overlap / b.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

export class Evaluator {
  /**
   * @param {Function} complete async (promptText) => { text }  — model adapter.
   */
  constructor({ complete, version = config.evaluatorVersion, registry = null } = {}) {
    if (typeof complete !== "function") throw new Error("Evaluator requires a complete() adapter");
    this.complete = complete;
    this.version = version;
    this.registry = registry;
  }

  /**
   * Score a model against the immutable evaluation set. Returns + records the
   * aggregate; per-example detail stays on disk for regression digging.
   */
  async evaluate({ modelId, kind = "candidate", evalSet, statusLog = null }) {
    const perExample = [];
    let sum = 0;
    const t0 = performance.now();
    for (const item of evalSet.items) {
      let score = 0;
      let note = null;
      try {
        const out = await this.complete(item.prompt);
        score = tokenF1(item.completion, out.text);
      } catch (err) {
        note = `completion error: ${err.message.slice(0, 120)}`;
      }
      sum += score;
      perExample.push({ promptId: item.promptId, promptHash: undefined, score: +score.toFixed(4), note });
    }
    const score = evalSet.size ? sum / evalSet.size : 0;

    const record = {
      evalRunId: this.registry ? this.registry.nextEvalId() : `eval-local-${modelId}`,
      modelId,
      kind,
      datasetId: evalSet.datasetId,
      datasetVersion: evalSet.datasetVersion,
      evaluatorVersion: this.version,
      score: +score.toFixed(4),
      score100: +(score * 100).toFixed(2),
      perExample,
      durationMs: Math.round(performance.now() - t0),
      createdAt: new Date().toISOString(),
    };
    if (this.registry) await this.registry.recordEvaluation(record);
    if (statusLog) await statusLog();
    return record;
  }
}

/**
 * The ONLY promotion rule. Deterministic:
 *   promote when  candidate.score >= promoteMinScore  AND
 *                 delta = candidate.score - baseline.score >= promoteMinDelta
 * With defaults (0 / 0) that means "no regression and non-zero absolute score".
 * There is no auto-promotion path that skips an evaluation — callers must pass
 * both result records.
 */
export function decidePromotion(baselineResult, candidateResult, { promoteMinDelta = config.promoteMinDelta, promoteMinScore = config.promoteMinScore } = {}) {
  const notEvaluated = { decision: "not_evaluated", delta: null, base: null, candidate: null };
  if (!baselineResult || !candidateResult) return notEvaluated;
  const base = Number(baselineResult.score);
  const cand = Number(candidateResult.score);
  if (!Number.isFinite(base) || !Number.isFinite(cand)) return notEvaluated;
  const delta = cand - base;
  const decision = cand >= promoteMinScore && delta >= promoteMinDelta ? "promoted" : "rejected";
  return { decision, delta, base, candidate: cand };
}