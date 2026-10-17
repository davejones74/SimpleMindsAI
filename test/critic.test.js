import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaClient } from "../src/services/ollama-client.js";
import { ReviewScorer } from "../src/reward/reward-scorer.js";
import { config } from "../src/config.js";

/**
 * The critic is the teacher, and its score decides verdicts. Two defects are
 * pinned here:
 *   1. The fixture critic was detected by a phrase ("reward model") that is NOT
 *      in CRITIC_PROMPT, so it returned a generic echo with no `score`, which
 *      silently became a neutral 5 and lost every article to `uncertain`.
 *   2. A missing score must STAY missing and fail closed — never a fabricated
 *      middling value that reads as a real judgement.
 */

const ARTICLE = "The steam engine was developed in Britain during the eighteenth century. Thomas Newcomen built the first practical engine in 1712.";

test("fixture critic is actually detected and returns a real, finite score", async () => {
  const scorer = new ReviewScorer({ ollama: new OllamaClient({ fixture: true }) });
  const r = await scorer.scoreOffline({ text: ARTICLE, domain: "history" });
  assert.equal(r.criticResponded, true, "the fixture must recognise the critic prompt");
  assert.equal(r.criticScoreMissing, false);
  assert.ok(Number.isFinite(r.rawScore), "rawScore must be the critic's real score, not a fabricated 5");
  assert.equal(r.rawScore, 6.5);
  assert.notEqual(r.verdict, "uncertain", "a healthy article must not be lost to uncertain by a fixture bug");
});

test("provenance records the critic prompt version and temperature", async () => {
  const scorer = new ReviewScorer({ ollama: new OllamaClient({ fixture: true, temperature: 0.3 }) });
  const r = await scorer.scoreOffline({ text: ARTICLE, domain: "history" });
  assert.equal(r.criticPromptVersion, config.criticPromptVersion);
  assert.equal(r.criticTemperature, 0.3);
  assert.equal(r.criticModel, "deepseek-r1:latest");
  assert.match(r.rationale, /heuristicPenalty=/);
});

test("a non-JSON critic response is recorded as MISSING and fails closed to uncertain", async () => {
  const badOllama = { model: "x", defaultOptions: { temperature: 0.1 }, chat: async () => ({ text: "I think this is fine." }) };
  const scorer = new ReviewScorer({ ollama: badOllama });
  const r = await scorer.scoreOffline({ text: ARTICLE, domain: "history" });
  assert.equal(r.criticScoreMissing, true);
  assert.equal(r.rawScore, null, "a missing score must not be coerced to a number");
  assert.equal(r.verdict, "uncertain");
  assert.match(r.criticError, /no JSON object/);
});

test("a critic that throws is recorded and fails closed to uncertain at score 0", async () => {
  const throwingOllama = { model: "x", defaultOptions: {}, chat: async () => { throw new Error("connection refused"); } };
  const scorer = new ReviewScorer({ ollama: throwingOllama });
  const r = await scorer.scoreOffline({ text: ARTICLE, domain: "history" });
  assert.equal(r.criticResponded, false);
  assert.equal(r.criticScoreMissing, true);
  assert.equal(r.score, 0);
  assert.equal(r.verdict, "uncertain");
  assert.match(r.criticError, /critic unavailable/);
});

test("a JSON object without a numeric score is treated as missing, not a default", async () => {
  const noScore = { model: "x", defaultOptions: {}, chat: async () => ({ text: JSON.stringify({ rationale: "meh" }) }) };
  const scorer = new ReviewScorer({ ollama: noScore });
  const r = await scorer.scoreOffline({ text: ARTICLE, domain: "history" });
  assert.equal(r.criticScoreMissing, true);
  assert.equal(r.rawScore, null);
  assert.equal(r.verdict, "uncertain");
  assert.match(r.rationale, /no finite score/);
});

test("the critic token cap reaches the actual Ollama request", async () => {
  let seen = null;
  const ollama = {
    model: "x",
    defaultOptions: { temperature: 0.1 },
    chat: async (args) => { seen = args; return { text: JSON.stringify({ score: 7 }) }; },
  };
  const r = await new ReviewScorer({ ollama }).scoreOffline({ text: ARTICLE, domain: "history" });
  assert.equal(seen.maxTokens, config.criticMaxTokens, "num_predict must be capped, not unlimited");
  assert.equal(seen.format, "json");
  assert.equal(r.rawScore, 7);
});

test("a transient critic failure is retried; a deterministic request error is not", async () => {
  let calls = 0;
  const flaky = {
    model: "x",
    defaultOptions: {},
    chat: async () => {
      calls++;
      if (calls === 1) throw new Error("fetch failed: ECONNREFUSED");
      return { text: JSON.stringify({ score: 8 }) };
    },
  };
  const r = await new ReviewScorer({ ollama: flaky }).scoreOffline({ text: ARTICLE });
  assert.equal(calls, 2, "a network failure must be retried once");
  assert.equal(r.criticScoreMissing, false);

  let badCalls = 0;
  const deterministic = {
    model: "x",
    defaultOptions: {},
    chat: async () => {
      badCalls++;
      throw new Error("ollama /api/chat 400: invalid request");
    },
  };
  const r2 = await new ReviewScorer({ ollama: deterministic }).scoreOffline({ text: ARTICLE });
  assert.equal(badCalls, 1, "an invalid-request error is deterministic and must not be retried");
  assert.equal(r2.criticScoreMissing, true);
});

test("a degenerate/repetitive critic response is retried once with a repeat penalty", async () => {
  let calls = 0;
  let secondArgs = null;
  const ollama = {
    model: "x",
    defaultOptions: {},
    chat: async (args) => {
      calls++;
      if (calls === 1) return { text: "the ".repeat(40) }; // degenerate loop, no JSON
      secondArgs = args;
      return { text: JSON.stringify({ score: 6 }) };
    },
  };
  const r = await new ReviewScorer({ ollama }).scoreOffline({ text: ARTICLE });
  assert.equal(calls, 2, "a degenerate response earns exactly one retry");
  assert.equal(secondArgs.repeatPenalty, config.criticRepeatPenalty);
  assert.equal(r.rawScore, 6);
});
