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
  timeoutMs = config.promoteEvalTimeoutMs,
  perDocument = config.promotePerDocument,
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
    // Paired (per-document) evidence is what makes a confidence interval
    // possible; the packed aggregate alone cannot define a standard error.
    if (perDocument) args.push("--per-document");
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
      // Paired evidence: one row per document with its source group and token
      // count, plus a group-level rollup. Empty when not requested/available.
      perDocument: Array.isArray(out.perDocument) ? out.perDocument : [],
      groups: Array.isArray(out.groups) ? out.groups : [],
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

/** Deterministic 32-bit PRNG so a bootstrap run is reproducible in tests. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smallHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Linear-interpolated quantile of a sorted ascending array. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Paired source-group bootstrap over per-document losses.
 *
 * Parent and candidate are scored on the SAME documents, so the right unit is
 * the per-document difference, resampled by independent source group (documents
 * from one source are not independent). `improvement` is defined as
 * parentLoss - candidateLoss, so a positive value favours the candidate.
 *
 * @returns {{ok, reason?, method?, groupCount?, pairedDocuments?, tokens?,
 *   pointImprovement?, ciLow?, ciHigh?, level?, samples?}}
 */
export function pairedSourceGroupBootstrap(parent, candidate, {
  minGroups = config.promoteMinGroups,
  ciLevel = config.promoteCiLevel,
  samples = config.promoteBootstrapSamples,
} = {}) {
  const parentDocs = Array.isArray(parent?.perDocument) ? parent.perDocument : [];
  const candidateDocs = Array.isArray(candidate?.perDocument) ? candidate.perDocument : [];
  if (!parentDocs.length || !candidateDocs.length) {
    return { ok: false, reason: "no per-document evaluation recorded for parent and candidate" };
  }
  const candById = new Map(candidateDocs.map((d) => [String(d.articleId), d]));
  const byGroup = new Map();
  let pairs = 0;
  for (const p of parentDocs) {
    const c = candById.get(String(p.articleId));
    if (!c) continue;
    const pl = Number(p.loss);
    const cl = Number(c.loss);
    if (!Number.isFinite(pl) || !Number.isFinite(cl)) continue;
    const pt = Number(p.tokens);
    const ct = Number(c.tokens);
    const tokens = Number.isFinite(pt) && pt > 0 ? pt : Number.isFinite(ct) && ct > 0 ? ct : 0;
    if (tokens <= 0) continue;
    const group = String(p.group ?? p.articleId ?? "unknown");
    const g = byGroup.get(group) ?? { group, tokens: 0, weighted: 0, documents: 0 };
    g.tokens += tokens;
    g.weighted += (pl - cl) * tokens;
    g.documents += 1;
    byGroup.set(group, g);
    pairs += 1;
  }
  const groups = [...byGroup.values()];
  if (pairs === 0) {
    return { ok: false, reason: "no documents were scored for both parent and candidate" };
  }
  const required = Math.max(1, Number(minGroups) || 1);
  if (groups.length < required) {
    return {
      ok: false,
      reason: `only ${groups.length} independent source group(s); ${required} required for a paired interval`,
      groupCount: groups.length,
      pairedDocuments: pairs,
    };
  }
  const totalTokens = groups.reduce((n, g) => n + g.tokens, 0);
  const pointImprovement = totalTokens ? groups.reduce((n, g) => n + g.weighted, 0) / totalTokens : null;
  const resamples = Math.max(200, Math.floor(Number(samples) || 0) || 0);
  const bootstrapSeed = smallHash(`${parent?.datasetHash ?? ""}:${parent?.version ?? ""}:${candidate?.version ?? ""}:${groups.length}`);
  const rng = mulberry32(bootstrapSeed);
  const means = [];
  for (let i = 0; i < resamples; i += 1) {
    let w = 0;
    let s = 0;
    for (let j = 0; j < groups.length; j += 1) {
      const g = groups[Math.floor(rng() * groups.length)];
      w += g.tokens;
      s += g.weighted;
    }
    means.push(w ? s / w : 0);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - (Number(ciLevel) || 0.95)) / 2;
  return {
    ok: true,
    method: "paired-source-group-bootstrap",
    methodVersion: "paired-source-group-bootstrap-v1",
    bootstrapSeed,
    groupCount: groups.length,
    pairedDocuments: pairs,
    tokens: totalTokens,
    pointImprovement,
    ciLow: quantile(means, alpha),
    ciHigh: quantile(means, 1 - alpha),
    level: Number(ciLevel) || 0.95,
    samples: resamples,
    groups: groups.map((g) => ({ group: g.group, tokens: g.tokens, documents: g.documents })),
  };
}

/**
 * Decide whether `candidate` should replace `parent`.
 *
 * Lower causal-LM loss is better: improvement = parentLoss - candidateLoss, and
 * the candidate is promoted only when it clears the configured criterion.
 *
 * In `enforce` mode the decision also requires paired per-document evidence and
 * a source-group bootstrap interval excluding zero. `inconclusive` means "no
 * defensible basis to activate"; it is distinct from `rejected` (a measured
 * regression) and `not_evaluated` (evidence could not be obtained).
 *
 * @returns {{decision, reason, parentLoss, candidateLoss, improvement, datasetHash, metricSignature, comparable, evaluated, paired?}}
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
  uncertaintyMode = config.promoteUncertaintyMode,
  minGroups = config.promoteMinGroups,
  ciLevel = config.promoteCiLevel,
  bootstrapSamples = config.promoteBootstrapSamples,
} = {}) {
  const base = {
    parentLoss: parent?.loss ?? null,
    candidateLoss: candidate?.loss ?? null,
    improvement: null,
    datasetHash: null,
    metricSignature: null,
    comparable: false,
    evaluated: false,
    criterion: {
      minImprovement, maxLoss, requireFinite, requireSameEvalSet, requireSameMetric,
      minBlocks, minTokens, uncertaintyMode, minGroups, ciLevel, bootstrapSamples,
    },
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
  const mode = String(uncertaintyMode ?? "off").toLowerCase();
  const paired = mode === "off"
    ? null
    : pairedSourceGroupBootstrap(parent, candidate, { minGroups, ciLevel, samples: bootstrapSamples });
  const withEval = {
    ...base,
    improvement,
    datasetHash: parent.datasetHash,
    metricSignature: parentSig,
    evalFitness: fitness,
    comparable,
    evaluated: true,
    paired,
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
  if (candidate.loss > maxLoss) {
    return { ...withEval, decision: "rejected", reason: `candidate loss ${candidate.loss.toFixed(4)} exceeds ceiling ${maxLoss}` };
  }

  if (mode === "enforce") {
    if (!paired?.ok) {
      return {
        ...withEval,
        decision: "inconclusive",
        reason: `no defensible paired evidence: ${paired?.reason ?? "paired evaluation unavailable"}`,
      };
    }
    if (paired.ciHigh != null && paired.ciHigh < 0) {
      return {
        ...withEval,
        decision: "rejected",
        reason: `regression established: paired improvement ${paired.pointImprovement.toFixed(4)} (95% CI ${paired.ciLow.toFixed(4)}..${paired.ciHigh.toFixed(4)}) is below zero`,
      };
    }
    if (paired.ciLow == null || paired.ciLow <= 0) {
      return {
        ...withEval,
        decision: "inconclusive",
        reason: `paired improvement ${paired.pointImprovement.toFixed(4)} (95% CI ${fmtCI(paired)}) includes zero`,
      };
    }
    if (improvement < minImprovement) {
      return {
        ...withEval,
        decision: "inconclusive",
        reason: `paired improvement ${improvement.toFixed(4)} is established but below the material threshold ${minImprovement}`,
      };
    }
    return {
      ...withEval,
      decision: "promoted",
      reason: `paired improvement ${paired.pointImprovement.toFixed(4)} (95% CI ${fmtCI(paired)}) exceeds ${minImprovement} on ${parent.datasetHash}`,
    };
  }

  // `report` / legacy: compute the interval but keep the aggregate decision.
  if (improvement < minImprovement) {
    return { ...withEval, decision: "rejected", reason: `improvement ${improvement.toFixed(4)} below required ${minImprovement}` };
  }
  return { ...withEval, decision: "promoted", reason: `loss improved by ${improvement.toFixed(4)} on ${parent.datasetHash}` };
}

function fmtCI(paired) {
  const lo = Number.isFinite(paired?.ciLow) ? paired.ciLow.toFixed(4) : "?";
  const hi = Number.isFinite(paired?.ciHigh) ? paired.ciHigh.toFixed(4) : "?";
  return `${lo}..${hi}`;
}
