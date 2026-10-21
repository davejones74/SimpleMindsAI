import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrainingBudget, checkMinimumTrainingData, computeEvaluationCadence } from "../src/training/budget.js";
import { estimateTokenCount, selectReplayRows, selectValidationRows } from "../src/dataset/snapshot.js";

test("budget derives steps from training blocks and rounds up to a whole step", () => {
  const b = computeTrainingBudget({
    trainBlockCount: 263,
    targetEpochs: 2,
    maxSteps: 400,
    microBatch: 2,
    gradAccum: 2,
  });
  assert.equal(b.effectiveBatchSize, 4);
  assert.equal(b.requestedSteps, 132);
  assert.equal(b.steps, 132);
  assert.equal(b.capped, false);
  assert.ok(Math.abs(b.effectiveEpochs - 2.0076) < 0.0001);
});

test("budget hard-caps a small corpus instead of repeating it indefinitely", () => {
  const b = computeTrainingBudget({
    trainBlockCount: 2,
    targetEpochs: 120,
    maxSteps: 40,
    microBatch: 1,
    gradAccum: 1,
  });
  assert.equal(b.steps, 40);
  assert.equal(b.capped, true);
  assert.match(b.capReason, /TRAIN_MAX_STEPS=40/);
  assert.equal(b.effectiveEpochs, 20);
});

test("budget always runs at least one step", () => {
  const b = computeTrainingBudget({
    trainBlockCount: 200,
    targetEpochs: 0.001,
    maxSteps: 400,
    microBatch: 2,
    gradAccum: 2,
  });
  assert.equal(b.steps, 1);
});

test("budget rejects invalid dimensions instead of guessing", () => {
  assert.throws(() => computeTrainingBudget({ trainBlockCount: 0, targetEpochs: 2, maxSteps: 1, microBatch: 1, gradAccum: 1 }), /block count/);
  assert.throws(() => computeTrainingBudget({ trainBlockCount: 1, targetEpochs: 0, maxSteps: 1, microBatch: 1, gradAccum: 1 }), /TRAIN_TARGET_EPOCHS/);
  assert.throws(() => computeTrainingBudget({ trainBlockCount: 1, targetEpochs: 1, maxSteps: 0, microBatch: 1, gradAccum: 1 }), /TRAIN_MAX_STEPS/);
  assert.throws(() => computeTrainingBudget({ trainBlockCount: 1, targetEpochs: 1, maxSteps: 1, microBatch: 0, gradAccum: 1 }), /micro-batch/);
});

test("minimum-data gate enforces the floor only when a token count is available", () => {
  assert.equal(checkMinimumTrainingData({ trainTokensSeen: 1699, minUniqueTokens: 1700 }).ok, false);
  assert.equal(checkMinimumTrainingData({ trainTokensSeen: 1700, minUniqueTokens: 1700 }).ok, true);
  const legacy = checkMinimumTrainingData({ trainTokensSeen: null, minUniqueTokens: 1700 });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.enforced, false);
  assert.equal(checkMinimumTrainingData({ trainTokensSeen: 10, minUniqueTokens: 0 }).ok, true);
});

test("replay selection is deterministic and token-share sized", () => {
  const fresh = [
    { articleId: "f1", contentHash: "f1", text: "x".repeat(400) },
    { articleId: "f2", contentHash: "f2", text: "x".repeat(400) },
  ];
  const pool = [
    { articleId: "r1", contentHash: "r1", text: "y".repeat(100) },
    { articleId: "r2", contentHash: "r2", text: "y".repeat(100) },
    { articleId: "r3", contentHash: "r3", text: "y".repeat(100) },
  ];
  const a = selectReplayRows(fresh, pool, { replayPercent: 20, maxRows: 10 });
  const b = selectReplayRows(fresh, pool, { replayPercent: 20, maxRows: 10 });
  assert.deepEqual(a.map((r) => r.articleId), b.map((r) => r.articleId));
  assert.equal(a.length, 2);
  assert.ok(a.reduce((n, r) => n + estimateTokenCount(r.text), 0) <= 200);
});

test("validation selection excludes replay rows and targets whole blocks", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    articleId: `v${i}`,
    contentHash: `v${i}`,
    text: "z".repeat(2000),
  }));
  const picked = selectValidationRows(rows, {
    validationBlocks: 32,
    seqLen: 128,
    excludeIds: new Set(["v0"]),
  });
  assert.ok(picked.length > 0);
  assert.equal(picked.some((r) => r.articleId === "v0"), false);
  assert.ok(picked.reduce((n, r) => n + r.text.length, 0) >= 32 * 128 * 5);
});

// ------------------------------------------------- evaluation cadence
// The fixed TRAIN_EVAL_EVERY was sized for 60-step runs. Once the step budget
// became data-derived, a 7-10 step run recorded only the opening and closing
// validation points. The configured value is now a CAP and the effective cadence
// tightens with the actual budget; 0 still disables periodic validation.

test("cadence: a short run samples more often than the configured cap", () => {
  assert.equal(computeEvaluationCadence({ steps: 8, configuredEvalEvery: 10 }), 2);
  assert.equal(computeEvaluationCadence({ steps: 7, configuredEvalEvery: 10 }), 1);
  assert.equal(computeEvaluationCadence({ steps: 12, configuredEvalEvery: 10 }), 3);
});

test("cadence: a 60-step run keeps the configured cadence", () => {
  assert.equal(computeEvaluationCadence({ steps: 60, configuredEvalEvery: 10 }), 10);
});

test("cadence: 0 or invalid configured cadence stays disabled", () => {
  assert.equal(computeEvaluationCadence({ steps: 8, configuredEvalEvery: 0 }), 0);
  assert.equal(computeEvaluationCadence({ steps: 8, configuredEvalEvery: -1 }), 0);
});

test("cadence: every effective cadence yields at least three finite observations", () => {
  for (let steps = 1; steps <= 40; steps += 1) {
    const evalEvery = computeEvaluationCadence({ steps, configuredEvalEvery: 10 });
    if (evalEvery <= 0) continue;
    const points = new Set([0, steps - 1]);
    for (let step = 0; step < steps; step += 1) if ((step + 1) % evalEvery === 0) points.add(step);
    if (steps >= 3) assert.ok(points.size >= 3, `steps=${steps} evalEvery=${evalEvery} -> ${points.size} points`);
  }
});
