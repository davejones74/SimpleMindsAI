import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { pairedSourceGroupBootstrap } from "../src/training/loss-evaluator.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-eval-evidence-"));

function docs(offset) {
  return Array.from({ length: 30 }, (_, i) => ({
    articleId: `art-${i}`,
    group: `https://example.org/source-${i}`,
    tokens: 100 + i,
    loss: 8 + offset + (i % 3) * 0.01,
  }));
}

test("per-document and bootstrap evidence is persisted and independently reproducible", async () => {
  const registry = await RegistryStore.open(tmp());
  const parent = {
    version: "v001",
    datasetHash: "dataset-hash",
    perDocument: docs(0),
    groups: [],
    ok: true,
  };
  const candidate = {
    version: "v002",
    datasetHash: "dataset-hash",
    perDocument: docs(-0.8),
    groups: [],
    ok: true,
  };
  const paired = pairedSourceGroupBootstrap(parent, candidate, { minGroups: 20, samples: 500 });
  assert.equal(paired.ok, true);

  const evidence = {
    schema: "sma/eval-evidence@1",
    evalRunId: "run-1:candidate",
    evaluationSet: { datasetId: "eval-test", datasetVersion: "v1", fileHash: "f".repeat(64), items: [] },
    metricSignature: "signature",
    perDocument: candidate.perDocument,
    groups: candidate.groups,
    comparisonInputs: { parent: { version: parent.version, perDocument: parent.perDocument }, candidate: { version: candidate.version, perDocument: candidate.perDocument } },
    paired,
    bootstrap: {
      method: paired.method,
      methodVersion: paired.methodVersion,
      bootstrapSeed: paired.bootstrapSeed,
      ciLevel: paired.level,
      samples: paired.samples,
      minGroups: 20,
    },
  };
  const stored = await registry.recordEvaluation({
    evalRunId: "run-1:candidate",
    runId: "run-1",
    kind: "candidate",
    version: "v002",
    loss: 7.2,
    ok: true,
    perDocument: candidate.perDocument,
    evidence,
  });
  assert.match(stored.evidenceHash, /^[a-f0-9]{64}$/);
  assert.ok(stored.evidenceFile);

  const saved = JSON.parse(readFileSync(path.join(registry.dir, stored.evidenceFile), "utf8"));
  assert.equal(saved.perDocument.length, 30);
  assert.equal(saved.bootstrap.bootstrapSeed, paired.bootstrapSeed);

  const rebuilt = pairedSourceGroupBootstrap(
    { ...parent, perDocument: saved.comparisonInputs.parent.perDocument },
    { ...candidate, perDocument: saved.comparisonInputs.candidate.perDocument },
    { minGroups: saved.bootstrap.minGroups, ciLevel: saved.bootstrap.ciLevel, samples: saved.bootstrap.samples },
  );
  assert.equal(rebuilt.pointImprovement, paired.pointImprovement);
  assert.equal(rebuilt.ciLow, paired.ciLow);
  assert.equal(rebuilt.ciHigh, paired.ciHigh);
  assert.equal(rebuilt.bootstrapSeed, paired.bootstrapSeed);
  await registry.close();
});
