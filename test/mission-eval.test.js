import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMissionTasks, compareMissionTasks, scoreTaskAnswer, wilsonInterval } from "../src/dataset/mission-eval.js";

const set = {
  datasetId: "eval-language-tasks-test",
  datasetVersion: "v1",
  items: [
    { taskId: "t1", prompt: "Choose: A complete sentence needs a subject and a verb.", answer: "yes", scoring: "exact" },
    { taskId: "t2", prompt: "Which is a clause?", answer: "because it rained", scoring: "exact" },
    { taskId: "t3", prompt: "Is this grammatical? She go home.", answer: "no", scoring: "exact" },
  ],
};

test("deterministic task scoring", () => {
  assert.equal(scoreTaskAnswer(set.items[0], " YES "), 1);
  assert.equal(scoreTaskAnswer(set.items[1], "because it rained."), 1);
  assert.equal(scoreTaskAnswer(set.items[2], "yes"), 0);
});

test("mission task evaluation produces accuracy, CI and per-task evidence", async () => {
  const responses = { t1: "yes", t2: "because it rained", t3: "yes" };
  const out = await evaluateMissionTasks({
    evalSet: set,
    complete: async (prompt) => ({ text: responses[Object.keys(responses)[set.items.findIndex((t) => t.prompt === prompt)]] }),
  });
  assert.equal(out.total, 3);
  assert.equal(out.successes, 2);
  assert.ok(out.accuracy > 0.66 && out.accuracy < 0.67);
  assert.ok(out.ciLow <= out.accuracy && out.ciHigh >= out.accuracy);
  assert.equal(out.perTask.length, 3);
  assert.equal(out.perTask[0].prompt, set.items[0].prompt);
  assert.equal(out.perTask[0].expectedAnswer, set.items[0].answer);
  assert.ok(out.perTask[0].promptHash);
});

test("paired task comparison reports wins and losses", () => {
  const baseline = { perTask: [{ taskId: "t1", score: 1 }, { taskId: "t2", score: 0 }] };
  const candidate = { perTask: [{ taskId: "t1", score: 1 }, { taskId: "t2", score: 1 }] };
  const out = compareMissionTasks(baseline, candidate);
  assert.equal(out.ok, true);
  assert.equal(out.improvement, 0.5);
  assert.equal(out.wins, 1);
  assert.equal(out.losses, 0);
});

test("wilson interval is bounded", () => {
  const ci = wilsonInterval(8, 10);
  assert.ok(ci.low >= 0 && ci.high <= 1);
  assert.ok(ci.low < ci.point && ci.point < ci.high);
});


test("likelihood-based choice scoring selects the lowest-loss answer and records alternatives", async () => {
  const choiceSet = {
    datasetId: "eval-language-tasks-choice-test",
    datasetVersion: "v1",
    items: [{
      taskId: "c1",
      prompt: "Choose the correct past tense of bring.",
      choices: ["bringed", "brought", "brang"],
      answer: "brought",
      scoring: "choice",
      domain: "morphology",
    }],
  };
  const out = await evaluateMissionTasks({
    evalSet: choiceSet,
    complete: async () => ({ text: "unused" }),
    scoreContinuation: async (prompt, choice) => ({ loss: choice === "brought" ? 0.2 : 1.5, tokens: 2 }),
  });
  assert.equal(out.successes, 1);
  assert.equal(out.perTask[0].answer, "brought");
  assert.equal(out.perTask[0].choiceScores.length, 3);
  assert.equal(out.perTask[0].choiceScores[0].choice, "brought");
});
