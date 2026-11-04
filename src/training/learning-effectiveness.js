/**
 * Cumulative learning-effectiveness reporting.
 *
 * The project already records per-run losses, working-guard decisions and
 * training contributions. What it lacked was a single, explicit answer to:
 * "did the working lineage improve on a stable reference, and at what material
 * cost?" This module is pure: callers supply durable registry records, so the
 * same inputs always produce the same report.
 *
 * It deliberately distinguishes:
 *   - acquisition/consumption activity (tokens, articles, runs);
 *   - working-checkpoint advancement (a checkpoint moved);
 *   - demonstrated effect (loss change on a frozen/sealed cohort).
 *
 * A working advancement is NOT evidence of learning; only the effect fields are.
 */

export const LEARNING_EFFECTIVENESS_SCHEMA = "sma/learning-effectiveness@1";

function finite(value) {
  return Number.isFinite(Number(value));
}

function byRun(evaluations = []) {
  const map = new Map();
  for (const record of evaluations) {
    if (!record?.runId) continue;
    const entry = map.get(record.runId) ?? {};
    entry[record.kind] = record;
    map.set(record.runId, entry);
  }
  return map;
}

function num(value) {
  return finite(value) ? Number(value) : null;
}

export function buildWorkingTrajectory({ contributions = [], evaluations = [], stableBaselineVersion = null } = {}) {
  const evalByRun = byRun(evaluations);
  const accepted = contributions
    .filter((c) => c?.workingDecision === "accepted" && c?.workingVersion)
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));

  const rows = [];
  let previous = null;
  for (const c of accepted) {
    const e = evalByRun.get(c.runId) ?? {};
    const candidateLoss = num(e.candidate?.loss);
    const stableLoss = num(e.baseline?.loss);
    const parentLoss = num(e["working-parent"]?.loss) ?? previous?.candidateLoss ?? null;
    const replayTokens = num(c.replayTokensSeen) ?? null;
    const trainingTokens = num(c.trainTokensSeen) ?? num(c.trainingTokens) ?? null;
    const freshTokens = num(c.freshTokensSeen) ?? (trainingTokens != null && replayTokens != null ? trainingTokens - replayTokens : null);
    const validationTokens = num(c.validationTokensSeen) ?? null;
    rows.push({
      runId: c.runId,
      version: c.workingVersion,
      parentVersion: c.parentVersion ?? null,
      stableBaselineVersion: c.stableBaselineVersion ?? stableBaselineVersion,
      candidateLoss,
      stableLoss,
      parentLoss,
      deltaVsStable: candidateLoss != null && stableLoss != null ? candidateLoss - stableLoss : null,
      deltaVsParent: candidateLoss != null && parentLoss != null ? candidateLoss - parentLoss : null,
      freshTokens,
      replayTokens,
      validationTokens,
      trainingTokens,
      replayShare: trainingTokens ? replayTokens / trainingTokens : null,
      at: c.at ?? null,
    });
    previous = rows.at(-1);
  }
  return rows;
}

export function summarizeWorkingTrajectory(rows = []) {
  const usable = rows.filter((row) => finite(row.deltaVsStable));
  if (!usable.length) {
    return {
      advances: rows.length,
      measured: 0,
      firstVersion: rows[0]?.version ?? null,
      lastVersion: rows.at(-1)?.version ?? null,
      netDeltaVsStable: null,
      bestDeltaVsStable: null,
      bestVersion: null,
      worstDeltaVsStable: null,
      worstVersion: null,
      meanDeltaVsStable: null,
      regressionsVsStable: null,
      improvementsVsStable: null,
      cumulativeDrift: null,
      driftVelocity: null,
      totalFreshTokens: rows.reduce((sum, row) => sum + (row.freshTokens ?? 0), 0),
      totalReplayTokens: rows.reduce((sum, row) => sum + (row.replayTokens ?? 0), 0),
      totalTrainingTokens: rows.reduce((sum, row) => sum + (row.trainingTokens ?? 0), 0),
      efficiencyPer1000FreshTokens: null,
    };
  }

  const deltas = usable.map((row) => row.deltaVsStable);
  const best = usable.reduce((a, b) => (b.deltaVsStable < a.deltaVsStable ? b : a));
  const worst = usable.reduce((a, b) => (b.deltaVsStable > a.deltaVsStable ? b : a));
  const net = deltas.at(-1);
  const totalFresh = usable.reduce((sum, row) => sum + (row.freshTokens ?? 0), 0);
  const totalReplay = usable.reduce((sum, row) => sum + (row.replayTokens ?? 0), 0);
  const totalTraining = usable.reduce((sum, row) => sum + (row.trainingTokens ?? 0), 0);

  return {
    advances: rows.length,
    measured: usable.length,
    firstVersion: usable[0].version,
    lastVersion: usable.at(-1).version,
    netDeltaVsStable: net,
    bestDeltaVsStable: best.deltaVsStable,
    bestVersion: best.version,
    worstDeltaVsStable: worst.deltaVsStable,
    worstVersion: worst.version,
    meanDeltaVsStable: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    regressionsVsStable: deltas.filter((d) => d > 0).length,
    improvementsVsStable: deltas.filter((d) => d < 0).length,
    cumulativeDrift: net,
    driftVelocity: usable.length > 1 ? net / (usable.length - 1) : null,
    totalFreshTokens: totalFresh,
    totalReplayTokens: totalReplay,
    totalTrainingTokens: totalTraining,
    // Positive efficiency is a reduction in nats per 1,000 fresh tokens.
    efficiencyPer1000FreshTokens: totalFresh > 0 && net != null ? (-net / totalFresh) * 1000 : null,
  };
}

export function buildLearningEffectiveness({
  contributions = [],
  evaluations = [],
  modelEvents = [],
  stableBaselineVersion = null,
  stableLoss = null,
  pointers = {},
  corpus = null,
  sealed = null,
  retention = null,
  at = null,
} = {}) {
  const trajectory = buildWorkingTrajectory({ contributions, evaluations, stableBaselineVersion });
  const summary = summarizeWorkingTrajectory(trajectory);
  const promotions = modelEvents.filter((e) => e?.status === "promoted");
  const rejected = modelEvents.filter((e) => e?.status === "rejected");
  const inconclusive = modelEvents.filter((e) => e?.status === "inconclusive");

  return {
    schema: LEARNING_EFFECTIVENESS_SCHEMA,
    at: at ?? new Date().toISOString(),
    references: {
      stableBaselineVersion: stableBaselineVersion ?? pointers?.active?.version ?? null,
      stableLoss: num(stableLoss) ?? num(pointers?.active?.evalLoss) ?? null,
    },
    activity: {
      modelEvents: modelEvents.length,
      stablePromotions: promotions.length,
      stableRejections: rejected.length,
      stableInconclusive: inconclusive.length,
      workingAdvances: summary.advances,
      freshTokens: summary.totalFreshTokens,
      replayTokens: summary.totalReplayTokens,
      trainingTokens: summary.totalTrainingTokens,
      corpus,
    },
    effect: {
      trajectory,
      summary,
      // These are supplied by a sealed prospective benchmark and a separate
      // retention probe. They are null until those cohorts have been scored.
      prospective: sealed ?? null,
      retention: retention ?? null,
    },
    limitations: [
      "Working advancement is not a learning result; only frozen/sealed effect measurements are.",
      "A trajectory with no sealed prospective benchmark cannot demonstrate generalisation to unseen knowledge.",
      "A trajectory with no fixed retention probe cannot demonstrate retention of previously learned knowledge.",
    ],
  };
}

export function renderLearningEffectivenessMarkdown(report) {
  const s = report?.effect?.summary ?? {};
  const ref = report?.references ?? {};
  const activity = report?.activity ?? {};
  const lines = [];
  lines.push("# Cumulative Learning Effectiveness Report");
  lines.push("");
  lines.push(`Generated: ${report?.at ?? "unknown"}`);
  lines.push(`Stable reference: ${ref.stableBaselineVersion ?? "unknown"} loss ${ref.stableLoss ?? "unavailable"}`);
  lines.push("");
  lines.push("## Working trajectory");
  lines.push("");
  lines.push("| Run | Version | Candidate loss | Δ vs stable | Fresh tokens | Replay tokens | Replay share |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const row of report?.effect?.trajectory ?? []) {
    const delta = finite(row.deltaVsStable) ? Number(row.deltaVsStable).toFixed(6) : "n/a";
    const share = finite(row.replayShare) ? `${(Number(row.replayShare) * 100).toFixed(1)}%` : "n/a";
    lines.push(`| ${row.runId} | ${row.version} | ${row.candidateLoss ?? "n/a"} | ${delta} | ${row.freshTokens ?? "n/a"} | ${row.replayTokens ?? "n/a"} | ${share} |`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Working advances: ${s.advances ?? 0}`);
  lines.push(`- Measured advances: ${s.measured ?? 0}`);
  lines.push(`- Net Δ vs stable: ${s.netDeltaVsStable ?? "unavailable"} nats (positive = worse)`);
  lines.push(`- Best Δ vs stable: ${s.bestDeltaVsStable ?? "unavailable"} (${s.bestVersion ?? "n/a"})`);
  lines.push(`- Worst Δ vs stable: ${s.worstDeltaVsStable ?? "unavailable"} (${s.worstVersion ?? "n/a"})`);
  lines.push(`- Regressions vs stable: ${s.regressionsVsStable ?? "unavailable"} / ${s.measured ?? 0}`);
  lines.push(`- Cumulative drift: ${s.cumulativeDrift ?? "unavailable"} nats`);
  lines.push(`- Drift velocity: ${s.driftVelocity ?? "unavailable"} nats/advance`);
  lines.push(`- Efficiency: ${s.efficiencyPer1000FreshTokens ?? "unavailable"} nats improvement per 1,000 fresh tokens`);
  lines.push(`- Activity: ${activity.stablePromotions ?? 0} stable promotions, ${activity.stableRejections ?? 0} rejections, ${activity.stableInconclusive ?? 0} inconclusive`);
  lines.push(`- Sealed prospective benchmark: ${report?.effect?.prospective ? "present" : "not configured"}`);
  lines.push(`- Retention probe: ${report?.effect?.retention ? "present" : "not configured"}`);
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const limitation of report?.limitations ?? []) lines.push(`- ${limitation}`);
  lines.push("");
  return lines.join("\n");
}
