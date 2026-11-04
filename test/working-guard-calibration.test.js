import { test } from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.js";
import { decideWorkingAdvancement } from "../src/training/working-guard.js";

function result(version, loss, groups) {
  return { ok: true, version, loss, groups };
}

function groupsWith(n, base, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({ group: `g${i}`, loss: overrides[i] ?? base, tokens: 200 }));
}

test("effective default guard thresholds are the documented conservative values", () => {
  assert.equal(config.workingGuard.maxRegressionNats, 0.05);
  assert.equal(config.workingGuard.maxGroupRegressionNats, 0.15);
  assert.equal(config.workingGuard.maxDriftNats, 0.10);
  assert.equal(config.workingGuard.minGroupTokens, 100);
  assert.equal(config.workingGuard.maxRegressedGroupShare, 0.75);
  assert.equal(config.workingGuard.minGroups, 5);
});

test("Scenario A discrepancy: 0.0613 regression fails defaults, passes the pilot's widened 0.10", () => {
  const stableLoss = 8.027781088301476;
  const overrides = {};
  for (let i = 0; i < 30; i += 1) overrides[i] = stableLoss + 0.0613;
  overrides[30] = stableLoss + 0.146;
  const parent = result("v001", stableLoss, groupsWith(60, stableLoss));
  const candidate = result("v002", stableLoss + 0.0613, groupsWith(60, stableLoss, overrides));
  const defaults = decideWorkingAdvancement({ parent, candidate, stable: parent, thresholds: config.workingGuard });
  assert.equal(defaults.decision, "rejected");
  assert.match(defaults.reason, /0\.0613.*max 0\.05/);
  const wide = decideWorkingAdvancement({ parent, candidate, stable: parent, thresholds: { ...config.workingGuard, maxRegressionNats: 0.10, maxGroupRegressionNats: 0.20 } });
  assert.equal(wide.decision, "accepted");
});

test("a real default-passing candidate: 0.0472 regression is accepted", () => {
  const stableLoss = 8.037700767212726;
  const candidateLoss = 8.084907047292019;
  const overrides = {};
  for (let i = 0; i < 30; i += 1) overrides[i] = candidateLoss;
  overrides[30] = stableLoss + 0.142;
  const parent = result("v389", stableLoss, groupsWith(60, stableLoss));
  const candidate = result("v001", candidateLoss, groupsWith(60, stableLoss, overrides));
  const out = decideWorkingAdvancement({ parent, candidate, stable: parent, thresholds: config.workingGuard });
  assert.equal(out.decision, "accepted");
  assert.ok(out.metrics.drift <= config.workingGuard.maxDriftNats);
});

test("successive small regressions are bounded by the cumulative drift cap", () => {
  const stableLoss = 10;
  const stable = result("stable", stableLoss, groupsWith(20, stableLoss));
  const mk = (version, loss, lossForChanged) => {
    const overrides = {};
    for (let i = 0; i < 12; i += 1) overrides[i] = lossForChanged;
    return result(version, loss, groupsWith(20, stableLoss, overrides));
  };
  const step1 = mk("w1", 10.04, 10.04);
  const step2 = mk("w2", 10.08, 10.08);
  const step3 = mk("w3", 10.12, 10.12);
  assert.equal(decideWorkingAdvancement({ parent: stable, candidate: step1, stable, thresholds: config.workingGuard }).decision, "accepted");
  assert.equal(decideWorkingAdvancement({ parent: step1, candidate: step2, stable, thresholds: config.workingGuard }).decision, "accepted");
  const third = decideWorkingAdvancement({ parent: step2, candidate: step3, stable, thresholds: config.workingGuard });
  assert.equal(third.decision, "rejected");
  assert.match(third.reason, /stable baseline/);
});

test("isolated group regression is accepted; catastrophic and broad regressions are rejected", () => {
  const stableLoss = 10;
  const stable = result("stable", stableLoss, groupsWith(20, stableLoss));
  const mixed = groupsWith(20, stableLoss, { 0: 10.12, 1: 9.92 });
  const mixedDecision = decideWorkingAdvancement({ parent: stable, candidate: result("mixed", 10.005, mixed), stable, thresholds: config.workingGuard });
  assert.equal(mixedDecision.decision, "accepted");

  const catastrophic = groupsWith(20, stableLoss, { 0: 10.40 });
  const catDecision = decideWorkingAdvancement({ parent: stable, candidate: result("cat", 10.02, catastrophic), stable, thresholds: config.workingGuard });
  assert.equal(catDecision.decision, "rejected");
  assert.match(catDecision.reason, /source group/);

  const broadOverrides = {};
  for (let i = 0; i < 16; i += 1) broadOverrides[i] = 10.10;
  const broad = groupsWith(20, stableLoss, broadOverrides);
  const broadDecision = decideWorkingAdvancement({ parent: stable, candidate: result("broad", 10.08, broad), stable, thresholds: config.workingGuard });
  assert.equal(broadDecision.decision, "rejected");
  assert.match(broadDecision.reason, /regressed|source groups/);
});
