import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Evaluator, tokenF1, decidePromotion } from "../src/training/evaluator.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { loadEvaluationSet } from "../src/dataset/evaluation-set.js";

test("tokenF1 is deterministic and order-insensitive", () => {
  assert.equal(tokenF1("hello world", "hello world"), 1);
  assert.ok(Math.abs(tokenF1("hello world", "hello") - 2 / 3) < 1e-6); // P=0.5 R=1 -> harmonic mean
  assert.equal(tokenF1("b a", "a b"), 1);
  assert.equal(tokenF1("a b c", "d e f"), 0);
  assert.equal(tokenF1("", ""), 1);
});

test("evaluate returns + records a structured result on the immutable set", async () => {
  const reg = await RegistryStore.open(path.join(mkdtempSync(path.join(tmpdir(), "sma-"))));
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "sma-")));
  const evalSet = await loadEvaluationSet({
    dir,
    seed: () => [
      { promptId: "q1", prompt: "Capital of France?", completion: "Paris" },
      { promptId: "q2", prompt: "What is 2+2?", completion: "four" },
    ],
  });

  // deterministically perfect model
  const perfect = new Evaluator({
    registry: reg,
    complete: async (p) => {
      const it = evalSet.items.find((i) => i.prompt === p);
      return { text: it ? it.completion : "" };
    },
  });
  const res = await perfect.evaluate({ modelId: "model-1", kind: "candidate", evalSet });
  assert.equal(res.score, 1);
  assert.equal(res.score100, 100);
  assert.equal(res.perExample.length, 2);
  assert.equal(reg.listEvaluations().length, 1);
  assert.equal(reg.getEvaluation(res.evalRunId).kind, "candidate");
  await reg.close();
});

test("decidePromotion: rule is pure + never auto-promotes", () => {
  assert.equal(decidePromotion({ score: 0.5 }, { score: 0.5 }).decision, "promoted"); // delta 0 >= 0
  assert.equal(decidePromotion({ score: 0.6 }, { score: 0.5 }).decision, "rejected"); // regression
  // absolut floor
  assert.equal(decidePromotion({ score: 0.1 }, { score: 0.2 }, { promoteMinScore: 0.9 }).decision, "rejected");
  assert.equal(decidePromotion({ score: 0.2 }, { score: 0.4 }, { promoteMinDelta: 0.3 }).decision, "rejected");
  assert.equal(decidePromotion(null, { score: 0.5 }).decision, "not_evaluated");
  assert.equal(decidePromotion({ score: 0.5 }, null).decision, "not_evaluated");
  assert.equal(decidePromotion(null, { score: 0.5 }).delta, null); // always an object
});