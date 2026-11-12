import { test } from "node:test";
import assert from "node:assert/strict";

import { decideBroadNonInferiority } from "../src/training/loss-evaluator.js";

const evalResult = (loss, datasetHash = "broad-hash") => ({ ok: true, loss, datasetHash });

test("broad non-inferiority accepts a small regression within the margin", () => {
  const d = decideBroadNonInferiority(evalResult(6.7687), evalResult(6.7812), { maxRegressionNats: 0.02 });
  assert.equal(d.decision, "accepted");
  assert.ok(Math.abs(d.regression - 0.0125) < 1e-9);
});

test("broad non-inferiority accepts an improvement", () => {
  const d = decideBroadNonInferiority(evalResult(6.7687), evalResult(6.7642), { maxRegressionNats: 0.02 });
  assert.equal(d.decision, "accepted");
  assert.ok(d.regression < 0);
});

test("broad non-inferiority rejects a material regression", () => {
  const d = decideBroadNonInferiority(evalResult(6.7), evalResult(6.75), { maxRegressionNats: 0.02 });
  assert.equal(d.decision, "rejected");
  assert.match(d.reason, /exceeds/);
});

test("broad non-inferiority fails closed on mismatched or invalid evaluations", () => {
  assert.equal(decideBroadNonInferiority(evalResult(6.7, "a"), evalResult(6.7, "b")).decision, "not_evaluated");
  assert.equal(decideBroadNonInferiority({ ok: false }, evalResult(6.7)).decision, "not_evaluated");
});
