import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLearningEffectiveness,
  buildWorkingTrajectory,
  renderLearningEffectivenessMarkdown,
  summarizeWorkingTrajectory,
} from "../src/training/learning-effectiveness.js";
import {
  createSealedCohort,
  verifyCohortDisjointness,
  verifySealedCohort,
} from "../src/training/sealed-cohort.js";

const contributions = [
  { runId: "run-1", workingDecision: "accepted", workingVersion: "v2", parentVersion: "v1", stableBaselineVersion: "v1", freshTokensSeen: 1000, replayTokensSeen: 250, at: "2026-01-01T00:00:00Z" },
  { runId: "run-2", workingDecision: "accepted", workingVersion: "v3", parentVersion: "v2", stableBaselineVersion: "v1", freshTokensSeen: 2000, replayTokensSeen: 500, at: "2026-01-02T00:00:00Z" },
  { runId: "run-3", workingDecision: "rejected", workingVersion: "v4", parentVersion: "v3", stableBaselineVersion: "v1", freshTokensSeen: 500, replayTokensSeen: 100, at: "2026-01-03T00:00:00Z" },
];
const evaluations = [
  { runId: "run-1", kind: "baseline", loss: 8.0, ok: true },
  { runId: "run-1", kind: "working-parent", loss: 8.0, ok: true },
  { runId: "run-1", kind: "candidate", loss: 7.99, ok: true },
  { runId: "run-2", kind: "baseline", loss: 8.0, ok: true },
  { runId: "run-2", kind: "working-parent", loss: 7.99, ok: true },
  { runId: "run-2", kind: "candidate", loss: 8.02, ok: true },
];

test("working trajectory measures effect, not just advancement", () => {
  const rows = buildWorkingTrajectory({ contributions, evaluations, stableBaselineVersion: "v1" });
  assert.equal(rows.length, 2, "rejected working runs are not part of the trajectory");
  assert.ok(Math.abs(rows[0].deltaVsStable - -0.01) < 1e-12);
  assert.ok(Math.abs(rows[1].deltaVsStable - 0.02) < 1e-12);
  const summary = summarizeWorkingTrajectory(rows);
  assert.equal(summary.advances, 2);
  assert.equal(summary.measured, 2);
  assert.ok(Math.abs(summary.netDeltaVsStable - 0.02) < 1e-12);
  assert.equal(summary.bestVersion, "v2");
  assert.equal(summary.worstVersion, "v3");
  assert.equal(summary.regressionsVsStable, 1);
  assert.equal(summary.improvementsVsStable, 1);
  assert.equal(summary.totalFreshTokens, 3000);
  assert.equal(summary.totalReplayTokens, 750);
  assert.ok(Math.abs(summary.efficiencyPer1000FreshTokens - (-(0.02 / 3000) * 1000)) < 1e-12);
});

test("learning report distinguishes activity, effect and missing benchmarks", () => {
  const report = buildLearningEffectiveness({
    contributions,
    evaluations,
    modelEvents: [{ status: "promoted" }, { status: "rejected" }, { status: "inconclusive" }],
    stableBaselineVersion: "v1",
    stableLoss: 8.0,
  });
  assert.equal(report.activity.workingAdvances, 2);
  assert.equal(report.activity.stablePromotions, 1);
  assert.equal(report.effect.prospective, null);
  assert.equal(report.effect.retention, null);
  assert.ok(report.limitations.some((line) => /sealed prospective/.test(line)));
  const md = renderLearningEffectivenessMarkdown(report);
  assert.match(md, /Cumulative Learning Effectiveness Report/);
  assert.match(md, /Net Δ vs stable/);
});

test("sealed cohorts are immutable, non-overlapping and leak-checked", () => {
  const prospective = createSealedCohort({
    id: "prospective-v1",
    kind: "prospective",
    rows: [
      { text: "A prospective document about quantum error correction.", sourceUrl: "https://example.org/p1" },
      { text: "A prospective document about ocean circulation.", sourceUrl: "https://example.org/p2" },
    ],
  });
  const retention = createSealedCohort({
    id: "retention-v1",
    kind: "retention",
    rows: [
      { text: "A previously learned document about steam engines.", sourceUrl: "https://example.org/r1" },
    ],
    trainedInVersions: ["v10"],
  });
  assert.equal(prospective.sealed, true);
  assert.equal(prospective.neverTrain, true);
  assert.equal(prospective.datasetHash.length, 64);
  assert.equal(verifyCohortDisjointness(prospective, retention).ok, true);
  assert.equal(verifySealedCohort(prospective, { seenContentHashes: [] }).ok, true);
  const leaked = verifySealedCohort(prospective, {
    seenContentHashes: [prospective.items[0].contentHash],
  });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.reason, "sealed-cohort-leaked");
  assert.equal(leaked.leaks[0].kind, "content-hash");
});

test("overlapping cohorts are rejected", () => {
  const row = { text: "Shared text that must not appear in both cohorts.", sourceUrl: "https://example.org/shared" };
  const a = createSealedCohort({ id: "a", kind: "prospective", rows: [row] });
  const b = createSealedCohort({ id: "b", kind: "retention", rows: [row] });
  const check = verifyCohortDisjointness(a, b);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "cohorts-overlap");
  assert.ok(check.overlaps.length >= 1);
});
