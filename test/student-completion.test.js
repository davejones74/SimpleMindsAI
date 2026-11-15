import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStudentCompletor, makeStudentScorer } from "../src/training/student-completion.js";

test("student completion pins version and uses deterministic generation settings", async () => {
  const calls = [];
  const worker = {
    async generate(prompt, opts) {
      calls.push({ prompt, opts });
      return { text: "answer", version: opts.version, artifactName: "artifact", integrity: "verified", promptTokens: 4, generatedTokens: 1 };
    },
  };
  const complete = makeStudentCompletor({ worker, version: "v787", maxNewTokens: 12 });
  const out = await complete("task prompt");
  assert.equal(out.text, "answer");
  assert.equal(out.version, "v787");
  assert.deepEqual(calls[0], {
    prompt: "task prompt",
    opts: {
      version: "v787", verify: true, maxNewTokens: 12, temperature: 0, topP: 1,
      seed: 0, repetitionPenalty: 1, noRepeatNgramSize: 0,
    },
  });
});


test("student scorer pins version and forwards conditional scoring", async () => {
  const calls = [];
  const worker = { async score(prompt, continuation, opts) { calls.push({ prompt, continuation, opts }); return { loss: 0.5, tokens: 2 }; } };
  const score = makeStudentScorer({ worker, version: "v787" });
  const out = await score("prompt", "answer");
  assert.equal(out.loss, 0.5);
  assert.deepEqual(calls[0], { prompt: "prompt", continuation: "answer", opts: { version: "v787", verify: true } });
});
