import { test } from "node:test";
import assert from "node:assert/strict";
import { metricSignature, decidePromotionByLoss, pairedSourceGroupBootstrap } from "../src/training/loss-evaluator.js";

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
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1, uncertaintyMode: "off" });
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
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1, uncertaintyMode: "off" });
  assert.equal(d.decision, "not_evaluated");
  assert.equal(d.comparable, false);
  assert.match(d.reason, /metric signatures differ/);
});

test("decidePromotionByLoss: falls back to dataset-hash comparison when neither side carries a signature", () => {
  // Legacy records: no signature on either side. Behaviour must be unchanged.
  const parent = { ok: true, loss: 2.0, datasetHash: "abc123" };
  const candidate = { ok: true, loss: 1.5, datasetHash: "abc123" };
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1, uncertaintyMode: "off" });
  assert.equal(d.decision, "promoted");
  assert.equal(d.comparable, true);
});

test("decidePromotionByLoss: a one-sided signature falls back to the hash comparison", () => {
  const parent = { ok: true, loss: 2.0, datasetHash: "abc123", metricSignature: metricSignature(SET, { seqLen: 32, microBatch: 1 }) };
  const candidate = { ok: true, loss: 1.5, datasetHash: "abc123" }; // no signature
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1, uncertaintyMode: "off" });
  // The signature is only enforceable when BOTH sides carry one, so a legacy
  // one-sided record keeps the historical dataset-hash-only decision.
  assert.equal(d.decision, "promoted");
  assert.equal(d.comparable, true);
});

test("decidePromotionByLoss: different dataset hash => not comparable", () => {
  const parent = ok(2.0);
  const candidate = { ...ok(1.0), datasetHash: "different" };
  const d = decidePromotionByLoss(parent, candidate, { minImprovement: 0.1, uncertaintyMode: "off" });
  assert.equal(d.decision, "not_evaluated");
  assert.equal(d.comparable, false);
});

test("decidePromotionByLoss: non-finite / failed evaluation fails closed", () => {
  assert.equal(decidePromotionByLoss(ok(2.0), { ok: false, error: "boom" }).decision, "not_evaluated");
  assert.equal(decidePromotionByLoss({ ok: true, loss: NaN, datasetHash: "abc123" }, ok(1.0)).decision, "not_evaluated");
});

// A loss on a one-block (or few-token) set is dominated by sampling noise, so
// promoting on it is a coin flip. The gate must refuse — not decide — on it.
const sized = (loss, blocks, tokens = null) => ({
  ...ok(loss),
  blockCount: blocks,
  tokensSeen: tokens,
  evaluationSet: { datasetHash: "abc123", blockCount: blocks, tokensSeen: tokens },
});

test("decidePromotionByLoss: refuses to compare an undersized (noise-dominated) evaluation", () => {
  const d = decidePromotionByLoss(sized(2.0, 1), sized(1.0, 1), { minImprovement: 0.1, minBlocks: 8, uncertaintyMode: "off" });
  assert.equal(d.decision, "not_evaluated");
  assert.equal(d.evalFitness.enforced, true);
  assert.equal(d.evalFitness.ok, false);
  assert.match(d.reason, /too small/);
});

test("decidePromotionByLoss: evaluates normally when the set is adequate", () => {
  const d = decidePromotionByLoss(sized(2.0, 459), sized(1.0, 459), { minImprovement: 0.1, minBlocks: 8, uncertaintyMode: "off" });
  assert.equal(d.decision, "promoted");
  assert.equal(d.evalFitness.ok, true);
});

test("decidePromotionByLoss: the token floor is enforced when configured", () => {
  const d = decidePromotionByLoss(sized(2.0, 459, 100), sized(1.0, 459, 100), { minImprovement: 0.1, minBlocks: 8, minTokens: 1024, uncertaintyMode: "off" });
  assert.equal(d.decision, "not_evaluated");
  assert.match(d.reason, /token/);
});

test("decidePromotionByLoss: records with no size metadata keep the legacy behaviour", () => {
  // No blockCount/evaluationSet => fitness is not enforced, so the historical
  // dataset-hash decision stands (this is the pre-Python / synthetic case).
  const d = decidePromotionByLoss(ok(2.0), ok(1.5), { minImprovement: 0.1, minBlocks: 8, uncertaintyMode: "off" });
  assert.equal(d.evalFitness.enforced, false);
  assert.equal(d.decision, "promoted");
});

// ------------------------------------------------------- paired uncertainty

/** Build N synthetic source groups, each with one document, at a fixed delta. */
function paired(loss, { groups = 30, tokens = 500, delta = 0 } = {}) {
  const perDocument = [];
  for (let i = 0; i < groups; i += 1) {
    perDocument.push({ articleId: `a${i}`, group: `g${i}`, tokens, loss: loss - delta });
  }
  return { ...ok(loss), perDocument, blockCount: 459, tokensSeen: groups * tokens, evaluationSet: { datasetHash: "abc123", blockCount: 459, tokensSeen: groups * tokens } };
}

test("pairedSourceGroupBootstrap: consistent gain has a CI above zero", () => {
  const parent = paired(2.0, { delta: 0 });
  const candidate = paired(1.9, { delta: 0 });
  const b = pairedSourceGroupBootstrap(parent, candidate, { minGroups: 20, samples: 500 });
  assert.equal(b.ok, true);
  assert.ok(b.ciLow > 0, `CI should exclude zero, got ${JSON.stringify(b)}`);
  assert.ok(b.pointImprovement > 0);
});

test("decidePromotionByLoss (enforce): promotes only when the paired CI excludes zero", () => {
  const d = decidePromotionByLoss(paired(2.0), paired(1.9), {
    minImprovement: 0.05, uncertaintyMode: "enforce", minGroups: 20, bootstrapSamples: 500,
  });
  assert.equal(d.decision, "promoted");
  assert.ok(d.paired.ok);
});

test("decidePromotionByLoss (enforce): a zero-delta candidate is inconclusive, never promoted", () => {
  const d = decidePromotionByLoss(paired(2.0), paired(2.0), {
    minImprovement: 0, uncertaintyMode: "enforce", minGroups: 20, bootstrapSamples: 500,
  });
  assert.equal(d.decision, "inconclusive");
});

test("decidePromotionByLoss (enforce): missing per-document evidence is inconclusive", () => {
  const d = decidePromotionByLoss(ok(2.0), ok(1.5), { minImprovement: 0.1, uncertaintyMode: "enforce" });
  assert.equal(d.decision, "inconclusive");
  assert.match(d.reason, /paired/i);
});

test("decidePromotionByLoss (enforce): too few source groups is inconclusive", () => {
  const d = decidePromotionByLoss(paired(2.0, { groups: 3 }), paired(1.9, { groups: 3 }), {
    minImprovement: 0.05, uncertaintyMode: "enforce", minGroups: 20, bootstrapSamples: 500,
  });
  assert.equal(d.decision, "inconclusive");
});

test("decidePromotionByLoss (enforce): an established regression is rejected, not inconclusive", () => {
  const d = decidePromotionByLoss(paired(2.0), paired(2.2), {
    minImprovement: 0, uncertaintyMode: "enforce", minGroups: 20, bootstrapSamples: 500,
  });
  assert.equal(d.decision, "rejected");
  assert.match(d.reason, /regression/i);
});

test("decidePromotionByLoss (enforce): an established but immaterial gain is inconclusive", () => {
  const d = decidePromotionByLoss(paired(2.0), paired(1.999), {
    minImprovement: 0.05, uncertaintyMode: "enforce", minGroups: 20, bootstrapSamples: 500,
  });
  // With 30 tight groups the CI excludes zero, but the gain is below the
  // material threshold, so the gate must NOT activate the candidate.
  assert.equal(d.decision, "inconclusive");
  assert.match(d.reason, /material/i);
});

test("decidePromotionByLoss (enforce): a failed or missing evaluation stays not_evaluated", () => {
  assert.equal(decidePromotionByLoss(paired(2.0), { ok: false, error: "boom" }).decision, "not_evaluated");
  assert.equal(decidePromotionByLoss({ ok: true, loss: NaN, datasetHash: "abc123" }, paired(1.0)).decision, "not_evaluated");
});
