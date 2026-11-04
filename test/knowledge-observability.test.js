import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderKnowledge } from "../src/admin/public/brain/knowledge.js";

const fixture = {
  schema: "sma/knowledge-accumulation-observability@1",
  at: "2026-11-04T18:54:43.677Z",
  pointers: {
    active: { version: "v493" },
    working: { version: "v500" },
    lastGood: { version: "v499" },
  },
  stable: {
    version: "v493",
    artifactName: "simpleminds-62m-20261018-edf63f7283b3",
    activatedAt: "2026-11-04T04:53:21Z",
    promotionHistory: [],
    promotionCount: 0,
  },
  working: {
    version: "v500",
    artifactName: "simpleminds-62m-20261018-3529eea41e4a",
    parentVersion: "v499",
    drift: 0.011532278771096749,
    updatedAt: "2026-11-04T15:48:54Z",
    runId: "run-425",
    lastGoodVersion: "v499",
    advancementCount: 6,
    rejectionCount: 0,
    advancementHistory: [{
      runId: "run-425",
      workingDecision: "accepted",
      workingVersion: "v500",
      parentVersion: "v499",
      at: "2026-11-04T15:48:54.103Z",
      optimizerMode: "carried",
    }],
  },
  optimizer: {
    version: "v500",
    parentVersion: "v499",
    mode: "carried",
    carryOptimizerFrom: "v499",
    stepsCompleted: 12,
    stateFile: "/var/lib/simpleminds/store/_runs/v500.train-state.pt",
    stateBytes: 494800711,
    stateModifiedAt: "2026-11-04T15:48:31.050Z",
    statePresent: true,
  },
  corpus: {
    runId: "run-425",
    configuredReplayPercent: 20,
    fresh: { documents: 36, tokens: 1909 },
    replay: { documents: 26, tokens: 1105 },
    validation: { documents: 5, tokens: 212 },
    training: { tokens: 3014, presentedTokens: 3226 },
    replayShare: 0.3666224286662243,
    prePartitionEstimate: 0.20042194092827004,
  },
  training: {
    runId: "run-425",
    status: "inconclusive",
    steps: 12,
    plannedSteps: 12,
    tokensPresented: 3226,
    uniqueTokens: null,
    wallSeconds: 6.249,
    tokensPerSecond: 516.24,
    optimizerMode: "carried",
    carryOptimizerFrom: "v499",
  },
  groupEvaluation: {
    runId: "run-425",
    version: "working-guard-v2",
    decision: "accepted",
    reason: "working guard accepted: overall regressed 0.0092 nats; no catastrophic group regression",
    metrics: {
      groupsCompared: 60,
      negativeGroups: 40,
      regressedGroups: 0,
      groupsOverTolerance: 4,
      worstGroup: { group: "https://en.wikipedia.org/wiki/Internet", improvement: -0.06859132167343773, tokens: 751 },
    },
  },
  drift: { current: 0.011532278771096749, max: 0.1, rollback: null, status: "within-budget" },
  validation: {
    available: true,
    waiting: false,
    prospectiveClusters: 2,
    validationArticleCount: 3,
    validationClusterCount: 2,
    requiredClusters: 1,
    requiredTokensForOneBlock: 128,
    largestProspectiveClusterTokens: null,
    error: null,
  },
  lifecycle: {
    trainingJob: { jobId: "job-60", status: "waiting", phase: "waiting-for-validation" },
    learningJob: { jobId: "job-59", status: "running", phase: "harvest" },
    waitingReason: "insufficient-validation-material",
    waitingNote: "validation documents could not form a block; refusing to fall back to tail splitting",
  },
  stableDecision: {
    runId: "run-425",
    decision: "inconclusive",
    delta: null,
    noiseBand: null,
    explanation: "paired improvement -0.0131 (95% CI -0.0262..0.0009) includes zero",
  },
  counts: { runs: 425, workingAdvances: 6, workingRejections: 0, stablePromotions: 2, stableRejections: 3, stableInconclusive: 3 },
};

test("knowledge view renders stable, working, optimizer and measured replay evidence", () => {
  const html = renderKnowledge(fixture);
  assert.match(html, /Knowledge accumulation/);
  assert.match(html, /v493/);
  assert.match(html, /v500/);
  assert.match(html, /v499/);
  assert.match(html, /carried/);
  assert.match(html, /36\.7%/);
  assert.match(html, /Measured replay share/);
  assert.match(html, /insufficient-validation-material/);
  assert.match(html, /Inconclusive|inconclusive/i);
  assert.match(html, /working guard accepted/);
  assert.doesNotMatch(html, /undefined/);
});

test("knowledge view is a pull view, not a long-lived SSE or timer client", () => {
  const source = readFileSync(new URL("../src/admin/public/brain/knowledge.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /EventSource/);
  assert.doesNotMatch(source, /setInterval/);
});

test("knowledge view leaves missing telemetry visibly unavailable instead of inventing values", () => {
  const html = renderKnowledge({ at: "2026-11-04T00:00:00Z" });
  assert.match(html, /No knowledge-accumulation telemetry|—/);
  assert.doesNotMatch(html, /fake|fabricated|0\.0%/);
});
