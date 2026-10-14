import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT,
  classifyTrend,
  deriveSeries,
  mergeChain,
  downsample,
  selectEffectiveVersion,
  bestCheckpoint,
  bestCheckpointForHash,
  RUN_OUTCOME,
  resolveRunOutcome,
  deriveRunEvents,
} from "../src/admin/metrics.js";

const DEFAULTS = { minPoints: 3, improveDrop: 0.01, worsenRise: 0.05, overfitValRise: 0.02 };

// ------------------------------------------------------------- classifyTrend

test("classifyTrend: empty observations are insufficient evidence", () => {
  const r = classifyTrend([], null, DEFAULTS);
  assert.equal(r.verdict, VERDICT.INSUFFICIENT_EVIDENCE);
  assert.equal(r.evidence.points, 0);
});

test("classifyTrend: fewer than minPoints finite points is insufficient evidence", () => {
  const r = classifyTrend([{ step: 0, loss: 5 }, { step: 9, loss: 4.9 }], null, DEFAULTS);
  assert.equal(r.verdict, VERDICT.INSUFFICIENT_EVIDENCE);
  assert.match(r.reason, /2 validation samples/);
});

test("classifyTrend: descending noisy series is improving", () => {
  const pts = [5, 4.5, 4.2, 4.0, 3.9].map((loss, i) => ({ step: i, loss }));
  const r = classifyTrend(pts, pts, DEFAULTS);
  assert.equal(r.verdict, VERDICT.IMPROVING);
  assert.match(r.reason, /fell/);
});

test("classifyTrend: rising series is worsening", () => {
  const pts = [4, 4.1, 4.3, 4.5].map((loss, i) => ({ step: i, loss }));
  const r = classifyTrend(pts, pts, DEFAULTS);
  assert.equal(r.verdict, VERDICT.WORSENING);
  assert.match(r.reason, /rose/);
});

test("classifyTrend: tiny drift inside all bands is plateauing", () => {
  const pts = [4.0, 4.004, 4.002, 4.004].map((loss, i) => ({ step: i, loss }));
  const r = classifyTrend(pts, pts, DEFAULTS);
  assert.equal(r.verdict, VERDICT.PLATEAUING);
});

test("classifyTrend: validation degraded from best while training still improving is overfit", () => {
  const val = [5, 4.5, 4.2, 4.0, 5.1].map((loss, i) => ({ step: i, loss }));
  const train = [5, 4.4, 4.0, 3.8, 3.7].map((loss, i) => ({ step: i, loss }));
  const r = classifyTrend(val, train, DEFAULTS);
  assert.equal(r.verdict, VERDICT.POTENTIALLY_OVERFITTING);
});

test("classifyTrend: no overfit flag when training degraded as much as validation", () => {
  const val = [5, 4.8, 5.4].map((loss, i) => ({ step: 0 + i, loss }));
  const train = [5, 5.1, 5.3].map((loss, i) => ({ step: 0 + i, loss }));
  const r = classifyTrend(val, train, DEFAULTS);
  // both degraded, validation clearly up => "worsening", not "overfit"
  assert.equal(r.verdict, VERDICT.WORSENING);
});

test("classifyTrend: ignores non-finite and out-of-order points deterministically", () => {
  const pts = [{ step: 9, loss: 4.05 }, { step: 0, loss: 5 }, { step: 3, loss: null }, { step: 6, loss: 4.5 }, { step: 8, loss: 4.1 }];
  const r = classifyTrend(pts, null, DEFAULTS);
  assert.equal(r.verdict, VERDICT.IMPROVING);
  assert.equal(r.evidence.points, 4);
  assert.equal(r.evidence.first, 5);
  assert.equal(r.evidence.last, 4.05);
  assert.equal(r.evidence.firstStep, 0);
  assert.equal(r.evidence.lastStep, 9);
});

test("classifyTrend: a judgement of a two-point run with minPoints=2 is still ordered", () => {
  const pts = [{ step: 0, loss: 5 }, { step: 1, loss: 5.01 }];
  const r = classifyTrend(pts, null, { ...DEFAULTS, minPoints: 2 });
  // Very small rise: 0.01% => < worsenRise (5%), so plateauing
  assert.equal(r.verdict, VERDICT.PLATEAUING);
});

// -------------------------------------------------------------- deriveSeries

test("deriveSeries: periodic validation history is used and labelled periodic", () => {
  const s = deriveSeries({
    config: { evalEvery: 2 },
    stepsCompleted: 6,
    validationHistory: [{ step: 0, loss: 5 }, { step: 1, loss: 4.8 }, { step: 3, loss: 4.5 }, { step: 5, loss: 4.3 }],
  });
  assert.equal(s.sampling, "periodic");
  assert.equal(s.validationSeries.length, 4);
  assert.deepEqual(s.validationSeries.map((p) => p.step), [0, 1, 3, 5]);
});

test("deriveSeries: no validationHistory falls back to two recorded endpoints", () => {
  const s = deriveSeries({
    stepsCompleted: 4,
    initialValidationLoss: 5,
    finalValidationLoss: 4.2,
  });
  assert.equal(s.sampling, "endpoints");
  assert.deepEqual(s.validationSeries.map((p) => p.step), [0, 3]);
  assert.deepEqual(s.validationSeries.map((p) => p.loss), [5, 4.2]);
});

test("deriveSeries: nothing recorded and no endpoints is an empty series", () => {
  const s = deriveSeries({ stepsCompleted: 4 });
  assert.equal(s.sampling, "none");
  assert.equal(s.validationSeries.length, 0);
});

test("deriveSeries: missing final endpoint leaves only the opening point", () => {
  const s = deriveSeries({ initialValidationLoss: 5 });
  assert.equal(s.sampling, "none");
  assert.equal(s.validationSeries.length, 0);
});

test("deriveSeries: training history losses are carried as the training series", () => {
  const s = deriveSeries({ history: [{ step: 0, loss: 5 }, { step: 1, loss: 4.8 }] });
  assert.deepEqual(s.trainingSeries.map((p) => p.loss), [5, 4.8]);
});

// ----------------------------------------------------------------- mergeChain

test("mergeChain: unions segments sorted by step, later segment wins on ties", () => {
  const chain = mergeChain([
    { version: "v001", series: [{ step: 0, loss: 5 }, { step: 1, loss: 4.8 }, { step: 2, loss: 4.6 }] },
    { version: "v002", series: [{ step: 2, loss: 4.5 }] },
  ]);
  assert.deepEqual(chain.points.map((p) => p.step), [0, 1, 2]);
  assert.equal(chain.points[2].loss, 4.5);
  assert.equal(chain.points[2].version, "v002");
  assert.equal(chain.from, 0);
  assert.equal(chain.to, 2);
});

test("mergeChain: resets the map so two chains do not cross-contaminate steps", () => {
  const a = mergeChain([{ version: "v001", series: [{ step: 0, loss: 5 }] }]);
  const b = mergeChain([{ version: "v001", series: [{ step: 0, loss: 5 }, { step: 1, loss: 4 }] }]);
  assert.equal(a.points.length, 1);
  assert.equal(b.points.length, 2);
});

test("downsample: keeps first and last, and caps length", () => {
  const pts = Array.from({ length: 100 }, (_, i) => ({ step: i, loss: 5 - i / 100 }));
  const d = downsample(pts, 10);
  assert.ok(d.length <= 10);
  assert.equal(d[0].step, 0);
  assert.equal(d[d.length - 1].step, 99);
});

test("downsample: no-op when under the cap", () => {
  const pts = [{ step: 0, loss: 5 }, { step: 1, loss: 4 }];
  assert.equal(downsample(pts, 10), pts);
});

// -------------------------------------------------------- selectEffectiveVersion

test("selectEffectiveVersion: explicit request wins", () => {
  const v = [
    { version: "v001", committed: true },
    { version: "v002", committed: true, trainState: { stepsCompleted: 60 } },
  ];
  assert.deepEqual(selectEffectiveVersion(v, { requested: "v001", active: "v002" }), { requested: "v001", effective: "v001", default: false });
});

test("selectEffectiveVersion: unknown explicit request throws", () => {
  const v = [{ version: "v001", committed: true }];
  assert.throws(() => selectEffectiveVersion(v, { requested: "v099" }), /unknown version/);
});

test("selectEffectiveVersion: active committed version is the default", () => {
  const v = [
    { version: "v001", committed: true, trainState: { stepsCompleted: 60 } },
    { version: "v002", committed: false },
    { version: "v003", committed: true, trainState: { stepsCompleted: 60 } },
  ];
  assert.deepEqual(selectEffectiveVersion(v, { active: "v003" }), { requested: null, effective: "v003", default: true });
});

test("selectEffectiveVersion: no active but a trained committed version exists", () => {
  const v = [
    { version: "v001", committed: true, trainState: { stepsCompleted: 0 } },
    { version: "v002", committed: true, trainState: { stepsCompleted: 60 } },
  ];
  assert.deepEqual(selectEffectiveVersion(v, { active: null }), { requested: null, effective: "v002", default: true });
});

test("selectEffectiveVersion: empty store is null, not a crash", () => {
  assert.equal(selectEffectiveVersion([], { active: null }), null);
  assert.equal(selectEffectiveVersion(null, { active: null }), null);
});

// -------------------------------------------------------------- bestCheckpoint

test("bestCheckpoint: keeps the lowest loss per dataset hash only", () => {
  const entries = [
    { version: "v001", loss: 5, datasetHash: "corpus-a" },
    { version: "v002", loss: 4, datasetHash: "corpus-a" },
    { version: "v003", loss: 9, datasetHash: "eval-set-1" },
    { version: "v004", loss: 1.5, datasetHash: "eval-set-1" },
    { version: "v005", loss: 12, datasetHash: null }, // unkeyed => never compared
  ];
  const best = bestCheckpoint(entries);
  assert.equal(best.length, 2);
  assert.equal(best.find((b) => b.datasetHash === "corpus-a").version, "v002");
  assert.equal(best.find((b) => b.datasetHash === "eval-set-1").version, "v004");
});

test("bestCheckpoint: ignores non-finite losses", () => {
  assert.deepEqual(bestCheckpoint([{ version: "v001", loss: null, datasetHash: "x" }]), []);
});

// --------------------------------------------------- bestCheckpointForHash
//
// A card labelled "Best checkpoint" has to be ONE checkpoint. `bestCheckpoint`
// is a per-dataset summary, so on a store where every version trained on a
// different corpus it returns every version — a disguised inventory.

test("bestCheckpointForHash: returns a single winner, not one per corpus", () => {
  const entries = [
    { version: "v001", loss: 5, datasetHash: "corpus-a" },
    { version: "v002", loss: 4, datasetHash: "corpus-b" },
    { version: "v003", loss: 9, datasetHash: "corpus-a" },
    { version: "v004", loss: 1.5, datasetHash: "corpus-c" },
  ];
  // The per-hash list is legitimately one per corpus...
  assert.equal(bestCheckpoint(entries).length, 3);
  // ...but the best FOR this lineage is a single entry.
  const best = bestCheckpointForHash(entries, "corpus-a");
  assert.equal(best.version, "v001");
  assert.equal(best.loss, 5);
});

test("bestCheckpointForHash: a multi-corpus store does not list every version", () => {
  // Every version on its own corpus: the per-hash result is all of them, which
  // is exactly the "displaying all the checkpoints" bug.
  const entries = Array.from({ length: 12 }, (_, i) => ({
    version: `v${String(i + 1).padStart(3, "0")}`,
    loss: 10 - i / 10,
    datasetHash: `unique-corpus-${i}`,
  }));
  assert.equal(bestCheckpoint(entries).length, 12);
  assert.equal(bestCheckpointForHash(entries, "unique-corpus-7").version, "v008");
});

test("bestCheckpointForHash: ignores non-finite and foreign-corpus entries", () => {
  const entries = [
    { version: "v001", loss: null, datasetHash: "a" },
    { version: "v002", loss: Number.NaN, datasetHash: "a" },
    { version: "v003", loss: 3, datasetHash: "other" },
  ];
  assert.equal(bestCheckpointForHash(entries, "a"), null);
});

test("bestCheckpointForHash: no hash means nothing is comparable", () => {
  assert.equal(bestCheckpointForHash([{ version: "v001", loss: 1, datasetHash: null }], null), null);
  assert.equal(bestCheckpointForHash([], "a"), null);
  assert.equal(bestCheckpointForHash(null, "a"), null);
});

test("bestCheckpointForHash: does not alias the entry it returns", () => {
  const entry = { version: "v001", loss: 4, datasetHash: "a" };
  const best = bestCheckpointForHash([entry], "a");
  best.version = "mutated";
  assert.equal(entry.version, "v001", "the returned object must be a copy");
});

// --------------------------------------------------------------- run events
//
// A diamond is a run/event, not a published model version. These tests pin the
// two rules that matter: every recorded run produces an event, and a missing
// metric stays missing.

test("resolveRunOutcome: prefers the promotion decision over the run status", () => {
  assert.equal(resolveRunOutcome({ status: "rejected", promotionStatus: "not_evaluated" }), RUN_OUTCOME.NOT_EVALUATED);
  assert.equal(resolveRunOutcome({ status: "promoted", promotionStatus: "promoted" }), RUN_OUTCOME.PROMOTED);
});

test("resolveRunOutcome: a terminal failure outranks a promotion decision", () => {
  assert.equal(resolveRunOutcome({ status: "failed", promotionStatus: "promoted" }), RUN_OUTCOME.FAILED);
});

test("resolveRunOutcome: falls back to the durable run status, then in-progress", () => {
  assert.equal(resolveRunOutcome({ status: "rejected" }), RUN_OUTCOME.REJECTED);
  assert.equal(resolveRunOutcome({ status: "running" }), RUN_OUTCOME.IN_PROGRESS);
  assert.equal(resolveRunOutcome({ status: "created" }), RUN_OUTCOME.IN_PROGRESS);
  assert.equal(resolveRunOutcome({}), RUN_OUTCOME.IN_PROGRESS);
  assert.equal(resolveRunOutcome(null), RUN_OUTCOME.IN_PROGRESS);
});

test("deriveRunEvents: emits an event for every run, measured or not", () => {
  const runs = [
    { runId: "r1", status: "promoted", promotionStatus: "promoted", startedAt: "2026-10-13T10:00:00Z", trainedEvaluation: { loss: 10.5, version: "v002" }, runLinkage: { pythonVersion: "v002", datasetHash: "h" }, evaluationDelta: 0.5 },
    { runId: "r2", status: "rejected", promotionStatus: "rejected", startedAt: "2026-10-13T11:00:00Z" },
    { runId: "r3", status: "failed", startedAt: "2026-10-13T12:00:00Z" },
    { runId: "r4", status: "running", startedAt: "2026-10-13T13:00:00Z" },
  ];
  const events = deriveRunEvents(runs, []);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.outcome), ["in_progress", "failed", "rejected", "promoted"]);
  assert.equal(events.find((e) => e.outcome === "promoted").loss, 10.5);
});

test("deriveRunEvents: a missing loss is null, never zero", () => {
  const events = deriveRunEvents([
    { runId: "r1", status: "rejected" },
    { runId: "r2", status: "failed", trainedEvaluation: { loss: null } },
    { runId: "r3", status: "failed", trainedEvaluation: { loss: Number.NaN } },
  ]);
  for (const e of events) {
    assert.equal(e.loss, null);
    assert.equal(e.lossSource, null);
  }
});

test("deriveRunEvents: takes the candidate loss from the durable model event", () => {
  const events = deriveRunEvents(
    [{ runId: "r1", status: "promoted", runLinkage: { pythonVersion: "v004", datasetHash: "h" } }],
    [{ modelId: "m1", trainingRunId: "r1", status: "promoted", evaluationScore: 11.38, meta: { pythonVersion: "v004", datasetHash: "h", tokensSeen: 30720 } }],
  );
  assert.equal(events[0].loss, 11.38);
  assert.equal(events[0].lossSource, "modelEvent.evaluationScore");
  assert.equal(events[0].tokensSeen, 30720);
  assert.equal(events[0].version, "v004");
});

test("deriveRunEvents: never falls back to the baseline (parent) loss", () => {
  const events = deriveRunEvents([
    { runId: "r1", status: "rejected", baselineEvaluation: { loss: 11.8 }, trainedEvaluation: { loss: null } },
  ]);
  assert.equal(events[0].loss, null);
});

test("deriveRunEvents: a run with no version still reports one", () => {
  const events = deriveRunEvents([{ runId: "r1", status: "running" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].version, null);
  assert.equal(events[0].promoted, false);
});

test("deriveRunEvents: empty or malformed input is empty, not a crash", () => {
  assert.deepEqual(deriveRunEvents([], []), []);
  assert.deepEqual(deriveRunEvents(null), []);
  assert.deepEqual(deriveRunEvents([null, {}, { status: "running" }], null), []);
});