import path from "node:path";
import { createHash } from "node:crypto";
import { runPython, REPO_ROOT } from "../brain/python-cli.js";
import { config } from "../config.js";

/**
 * The metric identity of one loss measurement. Two losses are only comparable
 * when EVERY field that can change the number is identical: the frozen set
 * (dataset + tokenizer hash), the packing strategy, the sequence length, the
 * eval micro-batch, the metric itself and the compute dtype used to score it.
 *
 * `decidePromotionByLoss` previously compared `datasetHash` alone, so a
 * candidate evaluated at a different seq-len, micro-batch or tokenizer could be
 * promoted on a number that was not measured the same way as its parent. The
 * signature closes that gap; a missing signature (legacy/no evidence) falls back
 * to the dataset-hash-only comparison so historical behaviour is preserved.
 */
export function metricSignature(evaluationSet, {
  seqLen = null,
  microBatch = null,
  metric = "causal-cross-entropy",
  strategy = null,
  computeDtype = "float32",
} = {}) {
  if (!evaluationSet) return null;
  const datasetHash = evaluationSet.datasetHash ?? null;
  if (!datasetHash) return null;
  const parts = {
    metric,
    strategy: strategy ?? evaluationSet.strategy ?? null,
    datasetHash,
    tokenizerHash: evaluationSet.tokenizerHash ?? null,
    sequenceLength: seqLen ?? evaluationSet.sequenceLength ?? null,
    microBatch: microBatch ?? null,
    computeDtype,
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

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
  staged = false,
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
    // The Python child runs from python/ while evalSetFile is repo-root
    // relative; resolve it so the frozen eval set is found regardless of cwd.
    const evalSet = path.isAbsolute(evalSetFile) ? evalSetFile : path.resolve(REPO_ROOT, evalSetFile);
    const args = [
      "eval",
      "--version", version,
      "--eval-set", evalSet,
      "--seq-len", String(seqLen),
      "--micro-batch", String(microBatch),
      "--device", device,
      "--verify-weights",
    ];
    // A staged candidate has no COMMITTED marker yet; evaluate its `.tmp`
    // directory in place so the promotion decision precedes publication.
    if (staged) args.push("--staged");
    const out = await runPython(args, { store, bin, timeoutMs });
    const loss = out.evalLoss;
    const ok = Number.isFinite(loss);
    const evaluationSet = out.evaluationSet ?? null;
    return {
      version,
      staged,
      loss: ok ? loss : null,
      datasetHash: evaluationSet?.datasetHash ?? null,
      evaluationSet,
      // The measured size of the evaluation, surfaced so the gate can refuse to
      // compare an undersized (noise-dominated) measurement and so a decision is
      // explainable after the fact.
      blockCount: evaluationSet?.blockCount ?? null,
      tokensSeen: evaluationSet?.tokensSeen ?? null,
      documentCount: evaluationSet?.documentCount ?? null,
      metricSignature: metricSignature(evaluationSet, { seqLen, microBatch }),
      lossSignature: out.lossSignature ?? null,
      trainedSteps: out.trainedSteps ?? null,
      ok,
      error: ok ? null : "python eval returned a non-finite loss",
    };
  } catch (err) {
    return { version, staged, loss: null, datasetHash: null, evaluationSet: null, ok: false, error: err.message };
  }
}

/**
 * Decide whether `candidate` should replace `parent`.
 *
 * Lower causal-LM loss is better: improvement = parentLoss - candidateLoss, and
 * the candidate is promoted only when it clears the configured criterion.
 *
 * @returns {{decision, reason, parentLoss, candidateLoss, improvement, datasetHash, metricSignature, comparable, evaluated}}
 */
/** Measured size of an evaluation, or null when the record carries none. */
function evaluationSize(result) {
  const ev = result?.evaluationSet ?? null;
  const blocks = Number.isFinite(result?.blockCount) ? result.blockCount : Number.isFinite(ev?.blockCount) ? ev.blockCount : null;
  const tokens = Number.isFinite(result?.tokensSeen) ? result.tokensSeen : Number.isFinite(ev?.tokensSeen) ? ev.tokensSeen : null;
  return { blocks, tokens };
}

export function decidePromotionByLoss(parent, candidate, {
  minImprovement = config.promoteMinLossDelta,
  maxLoss = config.promoteMaxLoss,
  requireFinite = config.promoteRequireFinite,
  requireSameEvalSet = true,
  requireSameMetric = true,
  minBlocks = config.promoteEvalMinBlocks,
  minTokens = config.promoteEvalMinTokens,
} = {}) {
  const base = {
    parentLoss: parent?.loss ?? null,
    candidateLoss: candidate?.loss ?? null,
    improvement: null,
    datasetHash: null,
    metricSignature: null,
    comparable: false,
    evaluated: false,
    criterion: { minImprovement, maxLoss, requireFinite, requireSameEvalSet, requireSameMetric, minBlocks, minTokens },
  };

  if (!parent?.ok || !candidate?.ok) {
    return { ...base, decision: "not_evaluated", reason: `invalid evaluation (parent: ${parent?.error ?? "ok"}, candidate: ${candidate?.error ?? "ok"})` };
  }
  if (requireFinite && (!Number.isFinite(parent.loss) || !Number.isFinite(candidate.loss))) {
    return { ...base, decision: "not_evaluated", reason: "non-finite loss" };
  }

  // Evaluation fitness: a loss on a one-block (or few-token) set is dominated by
  // sampling noise, so a "promotion" or "rejection" on it is a coin flip. This
  // is enforced only when BOTH sides report a measured size, so legacy or
  // synthetic records (no size metadata) keep today's behaviour.
  const pSize = evaluationSize(parent);
  const cSize = evaluationSize(candidate);
  const sizesPresent = pSize.blocks != null && cSize.blocks != null;
  const fitness = {
    parent: pSize,
    candidate: cSize,
    minBlocks,
    minTokens,
    enforced: sizesPresent,
    ok: true,
    reason: null,
  };
  if (sizesPresent) {
    const minSeenBlocks = Math.min(pSize.blocks, cSize.blocks);
    const minSeenTokens = [pSize.tokens, cSize.tokens].filter((t) => t != null).length ? Math.min(...[pSize.tokens, cSize.tokens].filter((t) => t != null)) : null;
    if (minBlocks > 0 && minSeenBlocks < minBlocks) {
      fitness.ok = false;
      fitness.reason = `evaluation set too small: ${minSeenBlocks} block(s) < required ${minBlocks}; loss on so few blocks is sampling noise, not evidence`;
    } else if (minTokens > 0 && minSeenTokens != null && minSeenTokens < minTokens) {
      fitness.ok = false;
      fitness.reason = `evaluation set too small: ${minSeenTokens} token(s) < required ${minTokens}; loss on so few tokens is sampling noise, not evidence`;
    }
  }
  if (!fitness.ok) {
    return { ...base, evalFitness: fitness, decision: "not_evaluated", reason: fitness.reason };
  }

  const sameHash = parent.datasetHash != null && parent.datasetHash === candidate.datasetHash;
  // A signature is only enforceable when BOTH sides carry one. When neither does
  // (legacy records), fall back to the dataset-hash comparison so historical
  // behaviour is unchanged; when both do, they MUST match.
  const parentSig = parent.metricSignature ?? null;
  const candidateSig = candidate.metricSignature ?? null;
  const signaturesPresent = parentSig != null && candidateSig != null;
  const sameMetric = !signaturesPresent || parentSig === candidateSig;
  const comparable = sameHash && (!requireSameMetric || sameMetric);
  const improvement = parent.loss - candidate.loss;
  const withEval = {
    ...base,
    improvement,
    datasetHash: parent.datasetHash,
    metricSignature: parentSig,
    evalFitness: fitness,
    comparable,
    evaluated: true,
  };

  if (requireSameMetric && sameHash && !sameMetric) {
    return {
      ...withEval,
      decision: "not_evaluated",
      reason: `parent and candidate metric signatures differ (${parentSig} != ${candidateSig}): the losses were not measured comparably`,
    };
  }
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
