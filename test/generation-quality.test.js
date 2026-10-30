import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGenerationQuality, generationQualityRegression } from "../src/training/generation-quality.js";

test("generationQualityRegression flags low unique-token ratio and long single-token runs", () => {
  const ok = generationQualityRegression([
    { version: "v1", aggregate: { meanRep1: 0.8, maxRun: 3 } },
    { version: "v2", aggregate: { meanRep1: 0.7, maxRun: 4 } },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.degenerate.length, 0);
  assert.equal(ok.measured, 2);

  const degenerate = generationQualityRegression([
    { version: "v1", aggregate: { meanRep1: 0.8, maxRun: 3 } },
    { version: "v2", aggregate: { meanRep1: 0.3, maxRun: 12 } },
  ]);
  assert.equal(degenerate.ok, false);
  assert.equal(degenerate.degenerate.length, 1);
  assert.equal(degenerate.degenerate[0].version, "v2");
});

test("generationQualityRegression tolerates missing aggregates", () => {
  const r = generationQualityRegression([{ version: "v1" }, { version: "v2", aggregate: null }]);
  assert.equal(r.ok, true);
  assert.equal(r.measured, 0);
});

test("evaluateGenerationQuality maps the python payload and fails closed on error", async () => {
  const good = await evaluateGenerationQuality({
    version: "v9",
    run: async () => ({
      ok: true,
      aggregate: { meanRep1: 0.75, maxRun: 2 },
      samples: [{ promptId: "quality-v1-01", prompt: "p", text: "x", tokens: 1, rep1: 1, maxRun: 1 }],
      promptCount: 1,
      promptBankVersion: "quality-prompts-v1",
      promptIds: ["quality-v1-01"],
      decoding: { temperature: 0, maxNewTokens: 32, seed: 0 },
      modelFingerprint: "artifact-fingerprint",
    }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.aggregate.meanRep1, 0.75);
  assert.equal(good.samples[0].promptId, "quality-v1-01");
  assert.equal(good.promptBankVersion, "quality-prompts-v1");
  assert.deepEqual(good.promptIds, ["quality-v1-01"]);
  assert.equal(good.decoding.maxNewTokens, 32);
  assert.equal(good.modelFingerprint, "artifact-fingerprint");

  const bad = await evaluateGenerationQuality({
    version: "v9",
    run: async () => { throw new Error("boom"); },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);

  const missing = await evaluateGenerationQuality({ version: null });
  assert.equal(missing.ok, false);
});
