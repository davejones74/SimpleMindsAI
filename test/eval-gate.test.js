import { test } from "node:test";
import assert from "node:assert/strict";
import { metricSignature, decidePromotionByLoss } from "../src/training/loss-evaluator.js";

/**
 * The promotion gate must never promote on a number that was not measured the
 * same way as its parent. `datasetHash` alone was too weak: the same frozen file
 * scored at a different sequence length, micro-batch, tokenizer or metric
 * produces a different number. These are isolated unit tests of the gate and the
 * metric identity — no Python, no training.
 */

const SET = { datasetHash: "abc123", tokenizerHash: "tok1", strategy: "tail-heldout", sequenceLength: 32 };

const ok = (loss, extra = {}) => ({ ok: true, loss, datasetHash: "abc123", metricSignature: metricSignature(SET, { seqLen: 32, microBatch: 1 }), ...extra });

test("metricSignature: deterministic, and every measurement-affecting field changes it", () => {
  const base = metricSignature(SET, { seqLen: 32, microBatch: 1 });
  assert.equal(base, metricSignature(SET, { seqLen: 32, microBatch: 1 }), "same inputs => same signature");
  assert.match(base, /^[0-9a-f]{16}$/);

  assert.notEqual(base, metricSignature(SET, { seqLen: 64, microBatch: 1 }), "seq len must matter");
  assert.notEqual(base, metricSignature(SET, { seqLen: 32, microBatch: 2 }), "micro-batch must matter");
  assert.notEqual(base, metricSignature({ ...SET, tokenizerHash: "tok2" }, { seqLen: 32, microBatch: 1 }), "tokenizer must matter");
  assert.notEqual(base, metricSignature({ ...SET, datasetHash: "other" }, { seqLen: 32, microBatch: 1 }), "dataset must matter");
  assert.notEqual(base, metricSignature(SET, { seqLen: 32, microBatch: 1, metric: "perplexity" }), "metric must matter");
  assert.notEqual(base, metricSignature(SET, { seqLen: 32, microBatch: 1, computeDtype: "bfloat16" }), "compute dtype must matter");

  assert.equal(metricSignature(null, { seqLen: 32 }), null);
  assert.equal(metricSignature({ tokenizerHash: "x" }, { seqLen: 32 }), null, "no dataset hash => no signature");
});

test("decidePromotionByLoss: promotes a real improvement on an identical metric", () => {
  const parent = ok(2.0);
  const candidate = ok(1.5);
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1 });
  assert.equal(d.decision, "promoted");
  assert.equal(d.comparable, true);
  assert.ok(Math.abs(d.improvement - 0.5) < 1e-9);
});

test("decidePromotionByLoss: rejects an improvement measured with a DIFFERENT metric signature", () => {
  const parent = ok(2.0);
  // Same dataset hash, but the candidate was scored at a different seq len:
  // the numbers are not comparable, so this must NOT be promoted even though
  // the candidate's number is lower.
  const candidate = { ok: true, loss: 1.2, datasetHash: "abc123", metricSignature: metricSignature(SET, { seqLen: 64, microBatch: 1 }) };
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1 });
  assert.equal(d.decision, "not_evaluated");
  assert.equal(d.comparable, false);
  assert.match(d.reason, /metric signatures differ/);
});

test("decidePromotionByLoss: falls back to dataset-hash comparison when neither side carries a signature", () => {
  // Legacy records: no signature on either side. Behaviour must be unchanged.
  const parent = { ok: true, loss: 2.0, datasetHash: "abc123" };
  const candidate = { ok: true, loss: 1.5, datasetHash: "abc123" };
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1 });
  assert.equal(d.decision, "promoted");
  assert.equal(d.comparable, true);
});

test("decidePromotionByLoss: a one-sided signature falls back to the hash comparison", () => {
  const parent = { ok: true, loss: 2.0, datasetHash: "abc123", metricSignature: metricSignature(SET, { seqLen: 32, microBatch: 1 }) };
  const candidate = { ok: true, loss: 1.5, datasetHash: "abc123" }; // no signature
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1 });
  // The signature is only enforceable when BOTH sides carry one, so a legacy
  // one-sided record keeps the historical dataset-hash-only decision.
  assert.equal(d.decision, "promoted");
  assert.equal(d.comparable, true);
});

test("decidePromotionByLoss: different dataset hash => not comparable", () => {
  const parent = ok(2.0);
  const candidate = { ...ok(1.0), datasetHash: "different" };
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1 });
  assert.equal(d.decision, "not_evaluated");
  assert.equal(d.comparable, false);
});

test("decidePromotionByLoss: non-finite / failed evaluation fails closed", () => {
  assert.equal(decidePromotionByLoss(ok(2.0), { ok: false, error: "boom" }).decision, "not_evaluated");
  assert.equal(decidePromotionByLoss({ ok: true, loss: NaN, datasetHash: "abc123" }, ok(1.0)).decision, "not_evaluated");
});
