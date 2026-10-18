import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { StudentWorker } from "../src/brain/student-worker.js";
import { REPO_ROOT, runPython } from "../src/brain/python-cli.js";
import { evaluateVersionLoss, decidePromotionByLoss } from "../src/training/loss-evaluator.js";
import { promotePythonCandidate, setActiveVersion } from "../src/training/python-promotion.js";
import { committedVersions, makeIsolatedStore, pythonReady, removeIsolatedStore } from "../test-support/python.js";

// The frozen, ADEQUATE baseline. eval-001 (the legacy 5-row seed) cannot form a
// single 128-token block, so a loss measured on it is sampling noise — the
// promotion gate refuses it. eval-002 is the bundled domain-stratified corpus.
const EVAL_SET = path.join(REPO_ROOT, "data", "evaluation", "eval-002.jsonl");
const versions = committedVersions();
const ready = await pythonReady();
const haveBoth = versions.includes("v001") && versions.includes("v002");
const skip = !ready || !haveBoth || !fs.existsSync(EVAL_SET)
  ? "needs Python, committed v001+v002, and the frozen eval set"
  : false;

let iso = null;
if (!skip) iso = makeIsolatedStore(["v001", "v002"]);
after(() => { if (iso) removeIsolatedStore(iso.dir); });

async function activeVersionOf(store) {
  const out = await runPython(["active", "--models", path.join(store, "mirror")], { store });
  return out.activeVersion ?? null;
}

test("parent and candidate are scored on the same frozen evaluation set", { skip }, async () => {
  const parent = await evaluateVersionLoss({ version: "v001", evalSetFile: EVAL_SET, store: iso.dir, device: "cpu" });
  const candidate = await evaluateVersionLoss({ version: "v002", evalSetFile: EVAL_SET, store: iso.dir, device: "cpu" });

  assert.equal(parent.ok, true, parent.error);
  assert.equal(candidate.ok, true, candidate.error);
  assert.equal(parent.datasetHash, candidate.datasetHash, "both versions must be comparable");
  assert.ok(Number.isFinite(parent.loss) && Number.isFinite(candidate.loss));
  assert.ok(parent.blockCount >= 8, `the frozen set must yield a meaningful number of blocks, got ${parent.blockCount}`);

  const decision = decidePromotionByLoss(parent, candidate, { minImprovement: 0 });
  assert.equal(decision.comparable, true);
  assert.equal(decision.evaluated, true);
  assert.equal(decision.evalFitness.enforced, true);
  assert.equal(decision.evalFitness.ok, true, decision.evalFitness.reason);
  assert.equal(decision.decision, "promoted");
  assert.ok(decision.improvement > 0);
});

test("a worse candidate is rejected and the active brain does not move", { skip }, async () => {
  await setActiveVersion("v002", { store: iso.dir, models: iso.mirror });
  assert.equal(await activeVersionOf(iso.dir), "v002");

  const result = await promotePythonCandidate({
    parentVersion: "v002",
    candidateVersion: "v001",
    evalSetFile: EVAL_SET,
    store: iso.dir,
    models: iso.mirror,
    device: "cpu",
  });

  assert.equal(result.decision, "rejected", result.reason);
  assert.equal(result.activated, null);
  assert.equal(await activeVersionOf(iso.dir), "v002", "rejected candidate must not replace the active brain");
});

test("a better candidate is promoted and the student worker serves it", { skip }, async (t) => {
  await setActiveVersion("v001", { store: iso.dir, models: iso.mirror });

  const worker = new StudentWorker({ store: iso.dir, device: "cpu", requestTimeoutMs: 300_000, log: () => {} });
  t.after(() => worker.shutdown());
  await worker.start();
  const before = await worker.load();
  assert.equal(before.version, "v001");

  const result = await promotePythonCandidate({
    parentVersion: "v001",
    candidateVersion: "v002",
    evalSetFile: EVAL_SET,
    store: iso.dir,
    models: iso.mirror,
    device: "cpu",
    worker,
  });

  assert.equal(result.decision, "promoted", result.reason);
  assert.equal(result.activated.version, "v002");
  assert.equal(result.workerReloaded, true);
  assert.equal(await activeVersionOf(iso.dir), "v002");

  const current = await worker.currentVersion();
  assert.equal(current.version, "v002", "worker must serve the promoted version");
  const gen = await worker.generate("Hello", { maxNewTokens: 2 });
  assert.equal(gen.version, "v002");
});

test("an unevaluable candidate cannot be promoted", { skip }, async () => {
  await setActiveVersion("v002", { store: iso.dir, models: iso.mirror });

  const result = await promotePythonCandidate({
    parentVersion: "v002",
    candidateVersion: "v999",
    evalSetFile: EVAL_SET,
    store: iso.dir,
    models: iso.mirror,
    device: "cpu",
  });

  assert.equal(result.decision, "not_evaluated", result.reason);
  assert.equal(result.activated, null);
  assert.equal(await activeVersionOf(iso.dir), "v002");
});
