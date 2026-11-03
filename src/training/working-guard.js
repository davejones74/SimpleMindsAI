import { config } from "../config.js";

/**
 * Working-learning guard.
 *
 * This is deliberately NOT the stable promotion gate. It decides whether a
 * candidate may become the next cumulative-learning checkpoint even when it has
 * not (yet) beaten the stable published model. It must stop cumulative drift and
 * catastrophic per-source regression; it does not move `active.json`.
 *
 * Pure function: all losses and groups are supplied by the caller and recorded
 * with the decision.
 */
export const WORKING_GUARD_VERSION = "working-guard-v1";

function finite(value) {
  return Number.isFinite(Number(value));
}

function groupMap(result) {
  const map = new Map();
  const rows = Array.isArray(result?.groups) ? result.groups : [];
  for (const row of rows) {
    const key = String(row.group ?? row.articleId ?? "unknown");
    const tokens = Number(row.tokens);
    const loss = Number(row.loss);
    if (!finite(loss)) continue;
    map.set(key, { group: key, loss, tokens: finite(tokens) ? tokens : 0 });
  }
  return map;
}

function groupDeltas(parent, candidate, minTokens) {
  const p = groupMap(parent);
  const c = groupMap(candidate);
  const rows = [];
  for (const [key, pv] of p.entries()) {
    const cv = c.get(key);
    if (!cv) continue;
    const tokens = Math.max(pv.tokens, cv.tokens);
    if (!finite(tokens) || tokens < minTokens) continue;
    rows.push({ group: key, tokens, improvement: pv.loss - cv.loss });
  }
  return rows;
}

/**
 * @param {object} args
 * @param {object|null} args.parent - evaluation of the previous working checkpoint
 * @param {object} args.candidate - evaluation of the candidate
 * @param {object|null} args.stable - evaluation of the stable active checkpoint
 * @param {object} [args.thresholds] - override config.workingGuard for tests
 * @returns {{decision:"accepted"|"rejected", reason:string, metrics:object}}
 */
export function decideWorkingAdvancement({
  parent = null,
  candidate = null,
  stable = null,
  thresholds = config.workingGuard,
} = {}) {
  const t = {
    maxRegressionNats: Number(thresholds?.maxRegressionNats ?? 0.05),
    maxGroupRegressionNats: Number(thresholds?.maxGroupRegressionNats ?? 0.15),
    maxDriftNats: Number(thresholds?.maxDriftNats ?? 0.25),
    minGroupTokens: Number(thresholds?.minGroupTokens ?? 100),
    maxRegressedGroupShare: Number(thresholds?.maxRegressedGroupShare ?? 0.75),
    minGroups: Number(thresholds?.minGroups ?? 5),
  };
  const base = {
    version: WORKING_GUARD_VERSION,
    thresholds: t,
    parentLoss: finite(parent?.loss) ? Number(parent.loss) : null,
    candidateLoss: finite(candidate?.loss) ? Number(candidate.loss) : null,
    stableLoss: finite(stable?.loss) ? Number(stable.loss) : null,
    parentVersion: parent?.version ?? null,
    candidateVersion: candidate?.version ?? null,
    stableVersion: stable?.version ?? null,
  };

  if (!candidate || candidate.ok !== true || !finite(candidate.loss)) {
    return { ...base, decision: "rejected", reason: "candidate evaluation is missing or non-finite", metrics: {} };
  }
  if (stable && (stable.ok !== true || !finite(stable.loss))) {
    return { ...base, decision: "rejected", reason: "stable baseline evaluation is missing or non-finite", metrics: {} };
  }

  const reference = parent && parent.ok === true && finite(parent.loss) ? parent : stable;
  if (!reference || !finite(reference.loss)) {
    return { ...base, decision: "rejected", reason: "no finite working or stable reference loss", metrics: {} };
  }

  const candidateLoss = Number(candidate.loss);
  const referenceLoss = Number(reference.loss);
  const stableLoss = finite(stable?.loss) ? Number(stable.loss) : null;
  const regression = candidateLoss - referenceLoss;
  const drift = stableLoss == null ? null : candidateLoss - stableLoss;
  const groups = groupDeltas(reference, candidate, t.minGroupTokens);
  const regressed = groups.filter((row) => row.improvement < -t.maxGroupRegressionNats);
  const regressedShare = groups.length ? regressed.length / groups.length : null;
  const worstGroup = groups.reduce((worst, row) => (!worst || row.improvement < worst.improvement ? row : worst), null);
  const metrics = {
    regression,
    drift,
    groupsCompared: groups.length,
    regressedGroups: regressed.length,
    regressedGroupShare: regressedShare,
    worstGroup: worstGroup ? { group: worstGroup.group, improvement: worstGroup.improvement, tokens: worstGroup.tokens } : null,
  };

  if (stableLoss != null && t.maxDriftNats > 0 && drift > t.maxDriftNats) {
    return { ...base, decision: "rejected", reason: `candidate loss is ${drift.toFixed(4)} nats above the stable baseline (max ${t.maxDriftNats})`, metrics };
  }
  if (t.maxRegressionNats >= 0 && regression > t.maxRegressionNats) {
    return { ...base, decision: "rejected", reason: `candidate loss regressed ${regression.toFixed(4)} nats versus the working reference (max ${t.maxRegressionNats})`, metrics };
  }
  if (groups.length >= t.minGroups && t.maxRegressedGroupShare < 1 && regressedShare > t.maxRegressedGroupShare) {
    return { ...base, decision: "rejected", reason: `${regressed.length}/${groups.length} source groups regressed by more than ${t.maxGroupRegressionNats} nats`, metrics };
  }
  if (groups.length > 0 && regressed.length > 0) {
    return {
      ...base,
      decision: "accepted",
      reason: `working guard accepted: overall ${regression <= 0 ? "improved" : "regressed"} ${Math.abs(regression).toFixed(4)} nats; ${regressed.length} isolated group regression(s) within limit`,
      metrics,
    };
  }
  return {
    ...base,
    decision: "accepted",
    reason: `working guard accepted: overall ${regression <= 0 ? "improved" : "regressed"} ${Math.abs(regression).toFixed(4)} nats; no catastrophic group regression`,
    metrics,
  };
}
