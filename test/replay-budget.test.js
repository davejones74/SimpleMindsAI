import { test } from "node:test";
import assert from "node:assert/strict";

import {
  replayBudget,
  replayShareWithinTolerance,
  selectReplayWithinBudget,
} from "../src/training/replay-budget.js";

const rows = (...ids) => ids.map((articleId) => ({ articleId }));

test("20% budget and 2-point tolerance are computed from actual fresh tokens", () => {
  const b = replayBudget({ freshTokens: 4000, replayPercent: 20, tolerancePoints: 2 });
  assert.equal(b.targetTokens, 1000);
  assert.ok(Math.abs(b.upperTokens - 1128.2051282051282) < 1e-9);
});

test("replay selection removes over-budget rows and reports actual share", () => {
  const replay = rows("r1", "r2", "r3", "r4");
  const tokens = new Map([["r1", 300], ["r2", 300], ["r3", 300], ["r4", 300]]);
  const selected = selectReplayWithinBudget({
    replayRows: replay,
    tokenById: tokens,
    freshTokens: 4000,
    replayPercent: 20,
  });
  assert.deepEqual(selected.keptRows.map((r) => r.articleId), ["r1", "r2", "r3"]);
  assert.equal(selected.replayTokens, 900);
  assert.ok(selected.replayShare <= 0.2 + 1e-9);
  assert.equal(selected.removedRows, 1);
});

test("a single very large replay row is skipped, not forced into the budget", () => {
  const selected = selectReplayWithinBudget({
    replayRows: rows("huge", "small"),
    tokenById: new Map([["huge", 5000], ["small", 100]]),
    freshTokens: 1000,
    replayPercent: 20,
  });
  assert.deepEqual(selected.keptRows.map((r) => r.articleId), ["small"]);
  assert.ok(selected.replayTokens <= selected.targetTokens);
});

test("short rows can fill the budget when they fit", () => {
  const selected = selectReplayWithinBudget({
    replayRows: rows("a", "b", "c"),
    tokenById: new Map([["a", 40], ["b", 40], ["c", 40]]),
    freshTokens: 400,
    replayPercent: 20,
  });
  assert.equal(selected.keptRows.length, 2);
  assert.ok(selected.replayShare <= 0.2 + 1e-9);
});

test("tolerance accepts 22% but rejects 23%", () => {
  assert.equal(replayShareWithinTolerance({ freshTokens: 7800, replayTokens: 2200, replayPercent: 20, tolerancePoints: 2 }).withinTolerance, true);
  assert.equal(replayShareWithinTolerance({ freshTokens: 7700, replayTokens: 2300, replayPercent: 20, tolerancePoints: 2 }).withinTolerance, false);
});

test("no replay is kept if every row is larger than the target", () => {
  const selected = selectReplayWithinBudget({
    replayRows: rows("x"),
    tokenById: new Map([["x", 10_000]]),
    freshTokens: 100,
    replayPercent: 20,
  });
  assert.equal(selected.keptRows.length, 0);
  assert.equal(selected.replayTokens, 0);
});
