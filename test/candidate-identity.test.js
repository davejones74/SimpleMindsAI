import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCandidateIdentity,
  computeTrainerFingerprint,
  computeParentWeightFingerprint,
} from "../src/training/candidate-identity.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "sma-id-"));
}

function parentStore(root, version = "v001", tensorHash = "a".repeat(64)) {
  const dir = path.join(root, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "init-manifest.json"), JSON.stringify({
    version,
    tensorHashesAfterTraining: {
      tensors: {
        "model.embed_tokens.weight": { dtype: "float32", sha256: tensorHash },
      },
    },
  }));
  writeFileSync(path.join(dir, "tokenizer.json"), JSON.stringify({ version: 1 }));
  return dir;
}

function evalFile(root, content = '{"articleId":"e1","text":"Evaluation text."}\n') {
  const file = path.join(root, "eval.jsonl");
  writeFileSync(file, content);
  return file;
}

test("candidate identity is deterministic and every input invalidates the key", () => {
  const root = tmp();
  const store = path.join(root, "store");
  parentStore(store);
  const evaluationFile = evalFile(root);
  const base = {
    root,
    parentVersion: "v001",
    storeRoot: store,
    corpusFingerprint: "corpus-a",
    evaluationFile,
    tokenizerFile: path.join(store, "v001", "tokenizer.json"),
    trainingConfig: { lr: 1e-4, steps: 10, validationPolicy: "document-source-disjoint" },
    seed: 0,
    splitPolicy: { policyVersion: "document-source-disjoint-v1", clusterVersion: "lexical-minhash-lsh-v1", seed: 0 },
  };
  const first = buildCandidateIdentity(base);
  const second = buildCandidateIdentity(base);
  assert.equal(first.candidateKey, second.candidateKey);
  assert.equal(first.parent.weightFingerprint, computeParentWeightFingerprint(store, "v001"));
  assert.match(first.trainer.fingerprint, /^[a-f0-9]{64}$/);

  for (const patch of [
    { corpusFingerprint: "corpus-b" },
    { seed: 1 },
    { trainingConfig: { ...base.trainingConfig, lr: 2e-4 } },
    { splitPolicy: { ...base.splitPolicy, seed: 1 } },
  ]) {
    const changed = buildCandidateIdentity({ ...base, ...patch });
    assert.notEqual(changed.candidateKey, first.candidateKey, JSON.stringify(patch));
  }

  writeFileSync(evaluationFile, '{"articleId":"e2","text":"Different evaluation."}\n');
  const changedEval = buildCandidateIdentity({ ...base, evaluationFile });
  assert.notEqual(changedEval.candidateKey, first.candidateKey);

  writeFileSync(path.join(store, "v001", "tokenizer.json"), JSON.stringify({ version: 2 }));
  const changedTokenizer = buildCandidateIdentity({ ...base, tokenizerFile: path.join(store, "v001", "tokenizer.json") });
  assert.notEqual(changedTokenizer.candidateKey, first.candidateKey);
});

test("the trainer fingerprint is content-derived, not a version label", () => {
  const root = tmp();
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "python", "sma"), { recursive: true });
  writeFileSync(path.join(root, "src", "config.js"), "export const x = 1;\n");
  writeFileSync(path.join(root, "python", "sma", "train.py"), "x = 1\n");
  const first = computeTrainerFingerprint(root);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  writeFileSync(path.join(root, "python", "sma", "train.py"), "x = 2\n");
  const second = computeTrainerFingerprint(root);
  assert.notEqual(second.digest, first.digest);
});

test("parent weight fingerprint changes with parent tensor bytes", () => {
  const root = tmp();
  const store = path.join(root, "store");
  parentStore(store, "v001", "a".repeat(64));
  const first = computeParentWeightFingerprint(store, "v001");
  parentStore(store, "v001", "b".repeat(64));
  const second = computeParentWeightFingerprint(store, "v001");
  assert.notEqual(first, second);
});

test("candidate identity includes evaluation manifest identity when supplied", () => {
  const root = tmp();
  const store = path.join(root, "store");
  parentStore(store);
  const evaluationFile = evalFile(root);
  const manifest = path.join(root, "eval.manifest.json");
  writeFileSync(manifest, JSON.stringify({ datasetVersion: "v1" }));
  const base = {
    root,
    parentVersion: "v001",
    storeRoot: store,
    corpusFingerprint: "corpus-a",
    evaluationFile,
    evaluationManifestFile: manifest,
    tokenizerFile: path.join(store, "v001", "tokenizer.json"),
    trainingConfig: {},
    seed: 0,
  };
  const first = buildCandidateIdentity(base);
  assert.equal(first.evaluation.datasetVersion, "v1");
  writeFileSync(manifest, JSON.stringify({ datasetVersion: "v2" }));
  const second = buildCandidateIdentity(base);
  assert.notEqual(first.candidateKey, second.candidateKey);
});
