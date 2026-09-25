import { RegistryStore } from "../storage/registry-store.js";
import { loadEvaluationSet } from "../dataset/evaluation-set.js";
import { Evaluator, decidePromotion } from "../training/evaluator.js";
import { makeCompletor, modelHandle } from "../training/model-handle.js";
import { defaultEvalSeed } from "./report.js";

/** Shared evaluation plumbing for evaluate/promote CLIs. */
export async function computeDecision({ apply = false } = {}) {
  const registry = await RegistryStore.open();
  const evalSet = await loadEvaluationSet({ seed: defaultEvalSeed });

  const candidates = registry
    .listModels()
    .filter((m) => m.status === "candidate" && m.kind !== "base")
    .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
  const candidate = candidates.at(-1) ?? null;
  if (!candidate) throw new Error("no candidate models to evaluate — run `npm run train` first");

  let baseline = registry.getActiveModel();
  if (!baseline) {
    const bases = registry.listModels().filter((m) => m.kind === "base").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    baseline = bases.at(-1) ?? (await registry.registerModel({ kind: "base", baseModel: candidate.baseModel }));
  }
  baseline = modelHandle(baseline);

  const evaluator = new Evaluator({ complete: makeCompletor(), registry });
  const baselineResult = await evaluator.evaluate({ modelId: baseline.modelId, kind: "baseline", evalSet });
  const candidateResult = await evaluator.evaluate({ modelId: candidate.modelId, kind: "candidate", evalSet });
  const decision = decidePromotion(baselineResult, candidateResult, {
    promoteMinDelta: Number(process.env.PROMOTE_MIN_DELTA ?? 0),
    promoteMinScore: Number(process.env.PROMOTE_MIN_SCORE ?? 0),
  });

  let applied = null;
  if (apply) {
    const status = decision.decision === "promoted" ? "promoted" : "rejected";
    await registry.modelEvent(candidate.modelId, {
      status,
      evaluationScore: candidateResult.score100,
      evalRunId: candidateResult.evalRunId,
      note: `delta ${decision.delta.toFixed(4)} (${decision.base.toFixed(4)} -> ${decision.candidate.toFixed(4)})`,
    });
    if (candidate.trainingRunId) {
      await registry.completeRun(candidate.trainingRunId, {
        status,
        resultModelId: candidate.modelId,
        baselineEvaluation: { evalRunId: baselineResult.evalRunId, score: baselineResult.score, score100: baselineResult.score100 },
        trainedEvaluation: { evalRunId: candidateResult.evalRunId, score: candidateResult.score, score100: candidateResult.score100 },
        evaluationDelta: decision.delta,
        promotionStatus: status,
      });
    }
    applied = status;
  }

  return {
    registry,
    candidate,
    baseline,
    baselineResult,
    candidateResult,
    decision,
    applied,
    evalSet,
  };
}