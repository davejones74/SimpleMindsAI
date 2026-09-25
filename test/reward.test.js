import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OllamaClient } from "../src/services/ollama-client.js";
import { RewardScorer, heuristicPenalty } from "../src/reward/reward-scorer.js";
import { BufferStore } from "../src/storage/buffer-store.js";

test("heuristicPenalty guardrail catches degenerate repetition", () => {
  assert.equal(heuristicPenalty(""), 0);
  const degen = "yes yes yes yes yes".repeat(3);
  const healthy = "The steam engine was developed in Britain during the eighteenth century.";
  assert.ok(heuristicPenalty(healthy) > heuristicPenalty(degen));
});

test("scoreOffline: deterministic guardrail result + critic/rubric provenance (fixture critic)", async () => {
  const scorer = new RewardScorer({ ollama: new OllamaClient({ fixture: true }) });
  const r = await scorer.scoreOffline({
    promptText: "Summarize the steam engine.",
    completionText: "The steam engine was developed in Britain during the eighteenth century. Thomas Newcomen built the first practical engine in 1712.",
  });
  assert.ok(r.score >= 0 && r.score <= 10);
  assert.ok(Number.isFinite(r.rawScore));
  assert.ok(r.guardrailResult.passed === true || r.guardrailResult.passed === false);
  assert.equal(r.criticVersion, "critic-v1");
  assert.equal(r.rubricVersion, "rubric-v1");
  assert.equal(r.criticModel, "deepseek-r1:latest");
  assert.match(r.rationale, /heuristicPenalty=/);
});

test("buffer scoreCompletion persists criticVersion/rubricVersion/guardrailResult", async () => {
  const store = await BufferStore.open(path.join(mkdtempSync(path.join(tmpdir(), "sma-"))));
  const p = await store.ingestPrompt({ text: "q?", domain: "howto" });
  const c = await store.ingestCompletion({ promptId: p.id, text: "a", model: "test" });
  await store.scoreCompletion({
    completionId: c.id,
    score: 8.5,
    criticModel: "deepseek-r1:latest",
    criticVersion: "critic-v1",
    rubricVersion: "rubric-v1",
    guardrailResult: { passed: true, heuristicPenalty: 0.92 },
  });
  const saved = store.completionRecord(c.id);
  assert.equal(saved.rewardScore, 8.5);
  const rewards = store.rewards.get(c.id);
  assert.equal(rewards[0].criticVersion, "critic-v1");
  assert.equal(rewards[0].rubricVersion, "rubric-v1");
  assert.deepEqual(rewards[0].guardrailResult, { passed: true, heuristicPenalty: 0.92 });
  await store.close();
});