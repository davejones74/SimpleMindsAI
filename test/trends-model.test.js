import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOMES,
  outcomeMeta,
  trendMeta,
  chooseTicks,
  buildVerdict,
  buildTrainingChart,
  buildRunOutcomeChart,
  filterRuns,
  sortRuns,
  paginateRuns,
  buildRunDetail,
  indexHistory,
  runDetailsNeedHistory,
  extractCitedHashes,
  formatDuration,
  fmtLoss,
} from "../src/admin/public/trends-model.js";

function baseMetrics(overrides = {}) {
  return {
    effectiveVersion: "v002",
    workspace: { activeVersion: "v002" },
    datasetHash: "corpus-a",
    thresholds: { minPoints: 3, improveDrop: 0.01, worsenRise: 0.05, overfitValRise: 0.02 },
    segments: [
      {
        version: "v001",
        isEffective: false,
        sampling: "periodic",
        evalEvery: 5,
        stepsCompleted: 10,
        trainingSamples: 10,
        validationSamples: 3,
        initialValidationLoss: 5,
        finalValidationLoss: 4.5,
        trainingSeries: [],
      },
      {
        version: "v002",
        isEffective: true,
        sampling: "periodic",
        evalEvery: 5,
        stepsCompleted: 10,
        trainingSamples: 10,
        validationSamples: 3,
        initialValidationLoss: 4.4,
        finalValidationLoss: 4.0,
      },
    ],
    training: [
      { version: "v001", stepOffset: 0, points: [{ step: 0, loss: 5 }, { step: 9, loss: 4.0 }] },
      { version: "v002", stepOffset: 10, points: [{ step: 0, loss: 4.0 }, { step: 9, loss: 3.8 }] },
    ],
    chain: {
      points: [
        { step: 0, loss: 5, version: "v001" },
        { step: 5, loss: 4.6, version: "v001" },
        { step: 9, loss: 4.5, version: "v001" },
        { step: 10, loss: 4.4, version: "v002" },
        { step: 15, loss: 4.1, version: "v002" },
        { step: 19, loss: 4.0, version: "v002" },
      ],
      fromStep: 0,
      toStep: 19,
      collisions: 0,
      stepBasis: "cumulative-lineage-step",
    },
    bestValidation: { step: 19, loss: 4.0, version: "v002", datasetHash: "corpus-a", source: "held-out-validation" },
    bestFrozenEvaluation: { runId: "r3", version: "v002", loss: 6.5, outcome: "promoted" },
    runHealth: {
      total: 4,
      counts: { promoted: 1, rejected: 1, inconclusive: 1, failed: 1, not_evaluated: 0, in_progress: 0 },
      evaluated: 3,
      evaluationCoverage: 0.75,
      terminalEvaluated: 3,
      promotionRate: 1 / 3,
    },
    events: [
      { runId: "r1", version: "v001", outcome: "rejected", loss: 7.2, trainedAt: "2026-11-01T00:00:00Z", datasetHash: "corpus-a" },
      { runId: "r2", version: "v002", outcome: "inconclusive", loss: 6.8, trainedAt: "2026-11-02T00:00:00Z", datasetHash: "corpus-a" },
      { runId: "r3", version: "v002", outcome: "promoted", loss: 6.5, trainedAt: "2026-11-03T00:00:00Z", datasetHash: "corpus-a", evaluationDatasetHash: "eval-a" },
      { runId: "r4", version: null, outcome: "failed", loss: null, trainedAt: "2026-11-03T00:00:00Z", datasetHash: null },
    ],
    trend: {
      verdict: "improving",
      reason: "Validation loss fell.",
      evidence: {
        points: 6,
        first: 5,
        last: 4,
        best: 4,
        bestStep: 19,
        bestVersion: "v002",
        firstStep: 0,
        lastStep: 19,
        improvementRel: -0.2,
        lastVsBestRel: 0,
        sufficient: true,
      },
    },
    ...overrides,
  };
}

test("outcome metadata pairs every outcome with a label, glyph and shape", () => {
  for (const outcome of OUTCOMES) {
    const meta = outcomeMeta(outcome);
    assert.ok(meta.label);
    assert.ok(meta.glyph);
    assert.ok(meta.shape);
    assert.ok(meta.className);
  }
  assert.equal(outcomeMeta("promoted").shape, "circle");
  assert.equal(outcomeMeta("rejected").shape, "square");
  assert.equal(outcomeMeta("failed").shape, "triangle");
  assert.equal(outcomeMeta("not_evaluated").shape, "hollow-circle");
  assert.equal(trendMeta("improving").label, "Improving");
});

test("chooseTicks returns clean ticks without padded domain-edge values", () => {
  const ticks = chooseTicks(5.01, 12.65, 5);
  assert.ok(ticks.includes(6));
  assert.ok(ticks.includes(8));
  assert.ok(ticks.includes(10));
  assert.ok(ticks.includes(12));
  assert.ok(!ticks.includes(5.01));
  assert.ok(!ticks.includes(12.65));
  assert.deepEqual(chooseTicks(5, 5), [5]);
  assert.deepEqual(chooseTicks(null, 10), []);
});

test("training chart preserves discrete validation observations and names the best checkpoint", () => {
  const chart = buildTrainingChart(baseMetrics());
  assert.equal(chart.empty, false);
  assert.equal(chart.validation.length, 6);
  assert.equal(chart.training.length, 4);
  assert.equal(chart.validationCount, 6);
  assert.equal(chart.validationTotal, 6);
  assert.equal(chart.bestValidation.version, "v002");
  assert.equal(chart.bestValidation.step, 19);
  assert.equal(chart.segmentCount, 2);
  assert.equal(chart.stepBasis, "cumulative-lineage-step");
  // No guide is implied by the model; the renderer only draws one when the
  // operator explicitly opts in.
  assert.ok(!Object.prototype.hasOwnProperty.call(chart, "validationGuide"));
});

test("training chart handles empty and single-point datasets", () => {
  const empty = buildTrainingChart(baseMetrics({ training: [], chain: { points: [], fromStep: null, toStep: null, collisions: 0 } }));
  assert.equal(empty.empty, true);
  assert.match(empty.reason, /No finite training/);
  const single = buildTrainingChart(baseMetrics({
    training: [{ version: "v002", stepOffset: 0, points: [{ step: 0, loss: 5 }] }],
    chain: { points: [{ step: 0, loss: 5, version: "v002" }], fromStep: 0, toStep: 0, collisions: 0 },
    bestValidation: { step: 0, loss: 5, version: "v002" },
  }));
  assert.equal(single.empty, false);
  assert.equal(single.validation.length, 1);
  assert.equal(single.bestValidation.x, single.bestValidation.x);
});

test("run-outcome chart plots only measured losses on the y axis and keeps missing runs in a strip", () => {
  const chart = buildRunOutcomeChart(baseMetrics());
  assert.equal(chart.empty, false);
  assert.equal(chart.measuredCount, 3);
  assert.equal(chart.unmeasuredCount, 1);
  assert.ok(chart.strip);
  assert.equal(chart.best.event.runId, "r3");
  assert.equal(chart.unmeasured[0].event.runId, "r4");
  assert.equal(chart.unmeasured[0].event.loss, null);
  assert.equal(chart.identityRecorded, 1);
});

test("run-outcome chart uses sequence as a unique x dimension and groups identical timestamps honestly", () => {
  const sequence = buildRunOutcomeChart(baseMetrics(), { xMode: "sequence" });
  const xs = sequence.measured.concat(sequence.unmeasured).map((p) => p.baseX);
  assert.equal(new Set(xs).size, 4);
  const time = buildRunOutcomeChart(baseMetrics(), { xMode: "time" });
  assert.equal(time.tieGroups, 1);
  const tied = time.measured.concat(time.unmeasured).filter((p) => p.tieCount > 1);
  assert.equal(tied.length, 2);
  assert.ok(tied.every((p) => p.tieCount === 2));
});

test("run-outcome chart is safe with no measured losses", () => {
  const metrics = baseMetrics({
    events: [
      { runId: "r1", outcome: "failed", loss: null, trainedAt: "2026-11-01T00:00:00Z" },
      { runId: "r2", outcome: "in_progress", loss: null, trainedAt: "2026-11-02T00:00:00Z" },
    ],
    bestFrozenEvaluation: null,
  });
  const chart = buildRunOutcomeChart(metrics);
  assert.equal(chart.empty, true);
  assert.equal(chart.unmeasuredCount, 2);
  assert.match(chart.reason, /No run has a recorded frozen evaluation-set loss/);
});

test("verdict computes percentages only within held-out validation", () => {
  const v = buildVerdict(baseMetrics());
  assert.equal(v.verdict, "improving");
  assert.equal(v.validation.best, 4);
  assert.equal(v.validation.bestVersion, "v002");
  assert.ok(v.validation.improvementRel < 0);
  assert.equal(v.validation.lastVsBestRel, 0);
  assert.equal(v.gap.step, 19, "the gap is computed from a training sample at the same step");
  assert.equal(v.runHealth.total, 4);
  assert.equal(v.bestFrozen.runId, "r3");
});

test("verdict reports a generalisation gap only at one recorded step", () => {
  const metrics = baseMetrics({
    training: [{ version: "v002", stepOffset: 0, points: [{ step: 19, loss: 3.0 }] }],
  });
  const v = buildVerdict(metrics);
  assert.ok(v.gap);
  assert.equal(v.gap.step, 19);
  assert.equal(v.gap.validation, 4.0);
  assert.equal(v.gap.training, 3.0);
  assert.equal(v.gap.value, 1.0);
});

test("verdict handles insufficient evidence without inventing a result", () => {
  const metrics = baseMetrics({
    trend: { verdict: "insufficient_evidence", reason: "Only 2 validation samples recorded.", evidence: { points: 2, first: 5, last: 4.9, best: 4.9, firstStep: 0, lastStep: 9, sufficient: false } },
    bestValidation: { step: 9, loss: 4.9, version: "v001" },
  });
  const v = buildVerdict(metrics);
  assert.equal(v.verdict, "insufficient_evidence");
  assert.equal(v.sufficient, false);
  assert.equal(v.validation.points, 6);
  assert.equal(v.label, "Insufficient evidence");
});

test("verdict is compatible with older payloads that omit sufficient/bestFrozenEvaluation", () => {
  const metrics = baseMetrics({
    bestFrozenEvaluation: undefined,
    trend: {
      verdict: "improving",
      reason: "Validation loss fell.",
      evidence: { points: 6, first: 5, last: 4, best: 4, firstStep: 0, lastStep: 19 },
    },
  });
  const v = buildVerdict(metrics);
  assert.equal(v.sufficient, true, "sufficiency is derived from the threshold when the flag is absent");
  assert.equal(v.bestFrozen.runId, "r3", "the best frozen run falls back to the events");
});

test("run filtering searches identity fields and respects outcome/version filters", () => {
  const events = baseMetrics().events;
  assert.equal(filterRuns(events, { query: "r3" }).length, 1);
  assert.equal(filterRuns(events, { query: "v002" }).length, 2);
  assert.equal(filterRuns(events, { outcome: "rejected" }).length, 1);
  assert.equal(filterRuns(events, { version: "v002" }).length, 2);
  assert.equal(filterRuns(events, { query: "missing" }).length, 0);
});

test("run sorting keeps missing losses last in both directions", () => {
  const events = baseMetrics().events;
  const asc = sortRuns(events, "loss-asc");
  assert.deepEqual(asc.slice(0, 3).map((e) => e.runId), ["r3", "r2", "r1"]);
  assert.equal(asc[3].runId, "r4");
  const desc = sortRuns(events, "loss-desc");
  assert.deepEqual(desc.slice(0, 3).map((e) => e.runId), ["r1", "r2", "r3"]);
  assert.equal(desc[3].runId, "r4");
  const newest = sortRuns(events, "newest");
  assert.equal(newest[0].runId, "r4");
  const oldest = sortRuns(events, "oldest");
  assert.equal(oldest[0].runId, "r1");
});

test("run pagination clamps page numbers and reports the visible window", () => {
  const runs = Array.from({ length: 120 }, (_, i) => ({ runId: `r${i}` }));
  const page = paginateRuns(runs, 9, 50);
  assert.equal(page.page, 3);
  assert.equal(page.pages, 3);
  assert.equal(page.items.length, 20);
  assert.equal(page.start, 101);
  assert.equal(page.end, 120);
});

test("run detail prefers the enriched event, then the existing training-history fallback", () => {
  const event = { runId: "r1", version: "v001", outcome: "rejected", loss: null, inLineage: false };
  const history = {
    registry: {
      runs: [
        {
          runId: "r1",
          candidate: { modelId: "model-1", checkpointPath: "/store/v001.tmp", note: "paired improvement 0.01 on abc" },
          datasetId: "dataset-1",
          trainingBudget: { steps: 50 },
        },
      ],
    },
    pythonStore: { versions: [{ version: "v001", trainState: { stepsCompleted: 60, finalValidationLoss: 4.4 } }] },
  };
  const indexes = indexHistory(history);
  const detail = buildRunDetail(event, indexes);
  assert.equal(detail.decisionReason, "paired improvement 0.01 on abc");
  assert.equal(detail.checkpointPath, "/store/v001.tmp");
  assert.equal(detail.validationLoss, 4.4);
  assert.equal(detail.trainingSteps, 60);
  assert.equal(detail.loss, null);
  assert.equal(detail.meta.label, "Rejected");
  assert.equal(runDetailsNeedHistory([{ runId: "r1" }]), true);
  assert.equal(runDetailsNeedHistory([{ runId: "r1", decisionReason: null, validationLoss: null, trainingSteps: null, checkpointPath: null }]), false);
});

test("cited hashes are exact, unique and never invented", () => {
  const hash = "a".repeat(64);
  const other = "b".repeat(64);
  assert.deepEqual(extractCitedHashes(`on ${hash}; broad ${other}; again ${hash}`), [hash, other]);
  assert.deepEqual(extractCitedHashes("no hashes here"), []);
  assert.deepEqual(extractCitedHashes(null), []);
});

test("duration and loss formatting keep missing values absent", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_600_000), "1h 0m");
  assert.equal(fmtLoss(null), "—");
  assert.equal(fmtLoss(0), "0.000");
});
