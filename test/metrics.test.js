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

test("classifyTrend: ignorcs non-finite and out-of-order points deterministically", () => {
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