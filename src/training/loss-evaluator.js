import { runPython } from "../brain/python-cli.js";
import { config } from "../config.js";

/**
 * The authoritative promotion signal: causal-LM cross-entropy loss from the
 * Python compute plane, measured on a frozen evaluation set.
 *
 * Token-F1 over short completions was never a brain-quality signal; a model
 * could improve its loss while the F1 heuristic stayed flat, and the legacy
 * gate would happily promote on a zero default. This module replaces the gate
 * for the real brain: both parent and candidate are scored by the same Python
 * code on the SAME immutable eval-set file, and a promotion needs a finite,
 * comparable, configured improvement.
 *
 * Everything here can fail closed. A missing worker, a non-finite loss, a
 * mismatched evaluation set, or a candidate worse than its parent all produce a
 * decision that is not "promoted".
 */

/**
 * Score one committed version with `sma.brain eval`.
 * @returns {Promise<{version, loss, datasetHash, evaluationSet, lossSignature, ok, error?}>}
 */
export async function evaluateVersionLoss({
  version,
  evalSetFile,
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  device = config.studentDevice,
  seqLen = config.promoteEvalSeqLen,
  microBatch = config.promoteEvalMicroBatch,
  timeoutMs = 600_000,
  error = null,
} = {}) {
  if (error) {
    return { version, loss: null, datasetHash: null, evaluationSet: null, ok: false, error };
  }
  if (!evalSetFile) {
    return { version, loss: null, datasetHash: null, evaluationSet: null, ok: false, error: "no frozen evaluation set provided" };
  }
  try {
    const out = await runPython(
      [
        "eval",
        "--version", version,
        "--eval-set", evalSetFile,
        "--seq-len", String(seqLen),
        "--micro-batch", String(microBatch),
        "--device", device,
        "--verify-weights",
      ],
      { store, bin, timeoutMs },
    );
    const loss = out.evalLoss;
    const ok = Number.isFinite(loss);
    return {
      version,
      loss: ok ? loss : null,
      datasetHash: out.evaluationSet?.datasetHash ?? null,
      evaluationSet: out.evaluationSet ?? null,
      lossSignature: out.lossSignature ?? null,
      trainedSteps: out.trainedSteps ?? null,
      ok,
      error: ok ? null : "python eval returned a non-finite loss",
    };
  } catch (err) {
    return { version, loss: null, datasetHash: null, evaluationSet: null, ok: false, error: err.message };
  }
}

/**
 * Decide whether `candidate` should replace `parent`.
 *
 * Lower causal-LM loss is better: improvement = parentLoss - candidateLoss, and
 * the candidate is promoted only when it clears the configured criterion.
 *
 * @returns {{decision, reason, parentLoss, candidateLoss, improvement, datasetHash, comparable, evaluated}}
 */
export function decidePromotionByLoss(parent, candidate, {
  minImprovement = config.promoteMinLossDelta,
  maxLoss = config.promoteMaxLoss,
  requireFinite = config.promoteRequireFinite,
  requireSameEvalSet = true,
} = {}) {
  const base = {
    parentLoss: parent?.loss ?? null,
    candidateLoss: candidate?.loss ?? null,
    improvement: null,
    datasetHash: null,
    comparable: false,
    evaluated: false,
    criterion: { minImprovement, maxLoss, requireFinite, requireSameEvalSet },
  };

  if (!parent?.ok || !candidate?.ok) {
    return { ...base, decision: "not_evaluated", reason: `invalid evaluation (parent: ${parent?.error ?? "ok"}, candidate: ${candidate?.error ?? "ok"})` };
  }
  if (requireFinite && (!Number.isFinite(parent.loss) || !Number.isFinite(candidate.loss))) {
    return { ...base, decision: "not_evaluated", reason: "non-finite loss" };
  }
  const comparable = parent.datasetHash != null && parent.datasetHash === candidate.datasetHash;
  const improvement = parent.loss - candidate.loss;
  const withEval = { ...base, improvement, datasetHash: parent.datasetHash, comparable, evaluated: true };

  if (requireSameEvalSet && !comparable) {
    return { ...withEval, decision: "not_evaluated", reason: "parent and candidate were not scored on the same frozen evaluation set" };
  }
  if (improvement < minImprovement) {
    return { ...withEval, decision: "rejected", reason: `improvement ${improvement.toFixed(4)} below required ${minImprovement}` };
  }
  if (candidate.loss > maxLoss) {
    return { ...withEval, decision: "rejected", reason: `candidate loss ${candidate.loss.toFixed(4)} exceeds ceiling ${maxLoss}` };
  }
  return { ...withEval, decision: "promoted", reason: `loss improved by ${improvement.toFixed(4)} on ${parent.datasetHash}` };
}
