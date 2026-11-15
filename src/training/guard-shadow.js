/**
 * Offline working-guard comparison over historical run manifests.
 *
 * This never trains or changes pointers. It answers a narrow, auditable
 * question: under a proposed threshold set, which already-observed candidate
 * evidence would have advanced the working checkpoint? Actual model weights are
 * not recoverable for discarded candidates, so this is a policy comparison, not
 * a claim that the candidate would still be desirable after the data-quality
 * changes.
 */
export const GUARD_SHADOW_POLICY_VERSION = "working-guard-shadow-v1";

export function guardShadowDecision(record, thresholds = {}) {
  const metrics = record?.workingGuard?.metrics ?? record?.metrics ?? {};
  const regression = Number(metrics.regression ?? record?.regression);
  const drift = Number(metrics.drift ?? record?.drift);
  const maxRegressionNats = Number(thresholds.maxRegressionNats ?? 0.02);
  const maxDriftNats = Number(thresholds.maxDriftNats ?? 0.02);
  const maxGroupRegressionNats = Number(thresholds.maxGroupRegressionNats ?? 0.15);
  const maxRegressedGroupShare = Number(thresholds.maxRegressedGroupShare ?? 0.75);
  const reasons = [];
  if (!Number.isFinite(regression)) reasons.push("missing-regression");
  if (Number.isFinite(drift) && maxDriftNats >= 0 && drift > maxDriftNats) reasons.push("drift");
  if (Number.isFinite(regression) && maxRegressionNats >= 0 && regression > maxRegressionNats) reasons.push("regression");
  const worst = Number(metrics.worstGroup?.improvement ?? 0);
  if (Number.isFinite(worst) && maxGroupRegressionNats >= 0 && worst < -maxGroupRegressionNats) reasons.push("group-regression");
  const share = Number(metrics.regressedGroupShare);
  if (Number.isFinite(share) && share > maxRegressedGroupShare) reasons.push("regressed-group-share");
  return {
    version: GUARD_SHADOW_POLICY_VERSION,
    accepted: reasons.length === 0,
    reasons,
    regression: Number.isFinite(regression) ? regression : null,
    drift: Number.isFinite(drift) ? drift : null,
    worstGroupRegression: Number.isFinite(worst) ? worst : null,
    regressedGroupShare: Number.isFinite(share) ? share : null,
  };
}

export function compareGuardThresholds(records, thresholdSets = []) {
  return thresholdSets.map((thresholds) => {
    const decisions = (records ?? []).map((record) => ({
      runId: record.runId,
      ...guardShadowDecision(record, thresholds),
    }));
    return {
      thresholds,
      observed: decisions.length,
      accepted: decisions.filter((d) => d.accepted).length,
      rejected: decisions.filter((d) => !d.accepted).length,
      acceptedRunIds: decisions.filter((d) => d.accepted).map((d) => d.runId),
      reasons: decisions.filter((d) => !d.accepted).reduce((acc, d) => {
        for (const reason of d.reasons) acc[reason] = (acc[reason] ?? 0) + 1;
        return acc;
      }, {}),
    };
  });
}
