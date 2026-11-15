import { test } from "node:test";
import assert from "node:assert/strict";
import { guardShadowDecision, compareGuardThresholds } from "../src/training/guard-shadow.js";

const records = [
  { runId: "r1", workingGuard: { metrics: { regression: 0.01, drift: 0.01, worstGroup: { improvement: -0.05 }, regressedGroupShare: 0.1 } } },
  { runId: "r2", workingGuard: { metrics: { regression: 0.04, drift: 0.04, worstGroup: { improvement: -0.18 }, regressedGroupShare: 0.5 } } },
  { runId: "r3", workingGuard: { metrics: { regression: 0.08, drift: 0.08, worstGroup: { improvement: -0.25 }, regressedGroupShare: 0.9 } } },
];

test("offline guard comparison reports which historical runs would pass", () => {
  assert.equal(guardShadowDecision(records[0], { maxRegressionNats: 0.02, maxDriftNats: 0.02, maxGroupRegressionNats: 0.15 }).accepted, true);
  assert.equal(guardShadowDecision(records[1], { maxRegressionNats: 0.02, maxDriftNats: 0.02, maxGroupRegressionNats: 0.15 }).accepted, false);
  const out = compareGuardThresholds(records, [
    { maxRegressionNats: 0.02, maxDriftNats: 0.02, maxGroupRegressionNats: 0.15 },
    { maxRegressionNats: 0.05, maxDriftNats: 0.05, maxGroupRegressionNats: 0.20 },
  ]);
  assert.equal(out[0].accepted, 1);
  assert.equal(out[1].accepted, 2);
  assert.deepEqual(out[1].acceptedRunIds, ["r1", "r2"]);
});
