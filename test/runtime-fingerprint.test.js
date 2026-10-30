import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeRuntimeFingerprint } from "../src/training/runtime-fingerprint.js";
import { buildCandidateIdentity } from "../src/training/candidate-identity.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "sma-runtime-"));
}

function probe(overrides = {}) {
  return {
    python: "3.14.4",
    implementation: "CPython",
    executable: "/venv/bin/python",
    torch: "2.12.0+rocm7.14.0",
    transformers: "5.17.0",
    tokenizers: "0.23.2",
    numpy: "2.5.4",
    safetensors: "0.8.0",
    accelerate: "1.15.0",
    huggingface_hub: "1.33.0",
    platform: {
      backend: "rocm",
      buildBackend: "rocm",
      backendVersion: "7.14.0",
      archString: "gfx1150",
      deviceName: "Radeon 890M",
      totalMemoryBytes: 1024,
      memorySharedWithHost: true,
    },
    ...overrides,
  };
}

function writeLocks(root) {
  mkdirSync(path.join(root, "python"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n');
  writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(root, "python", "requirements.txt"), "torch==2.12\n");
  writeFileSync(path.join(root, "python", "requirements-cuda.txt"), "");
  writeFileSync(path.join(root, "python", "requirements-rocm.txt"), "");
}

test("runtime fingerprint is deterministic and invalidates on material runtime changes", () => {
  const root = tmp();
  writeLocks(root);
  const base = computeRuntimeFingerprint({ root, pythonProbe: probe(), nodeVersion: "v22.22.1" });
  const again = computeRuntimeFingerprint({ root, pythonProbe: probe(), nodeVersion: "v22.22.1" });
  assert.equal(base.digest, again.digest);

  const changedTorch = computeRuntimeFingerprint({ root, pythonProbe: probe({ torch: "2.14.1+cpu" }), nodeVersion: "v22.22.1" });
  assert.notEqual(changedTorch.digest, base.digest);
  const changedTokenizers = computeRuntimeFingerprint({ root, pythonProbe: probe({ tokenizers: "0.23.3" }), nodeVersion: "v22.22.1" });
  assert.notEqual(changedTokenizers.digest, base.digest);
  const changedBackend = computeRuntimeFingerprint({ root, pythonProbe: probe({ platform: { ...probe().platform, backend: "cpu", archString: null } }), nodeVersion: "v22.22.1" });
  assert.notEqual(changedBackend.digest, base.digest);
  const changedNode = computeRuntimeFingerprint({ root, pythonProbe: probe(), nodeVersion: "v24.0.0" });
  assert.notEqual(changedNode.digest, base.digest);

  writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
  const changedLock = computeRuntimeFingerprint({ root, pythonProbe: probe(), nodeVersion: "v22.22.1" });
  assert.notEqual(changedLock.digest, base.digest);
});

test("device name and memory are metadata, not identity inputs", () => {
  const root = tmp();
  writeLocks(root);
  const base = computeRuntimeFingerprint({ root, pythonProbe: probe(), nodeVersion: "v22.22.1" });
  const metadataChanged = computeRuntimeFingerprint({
    root,
    pythonProbe: probe({ platform: { ...probe().platform, deviceName: "Other GPU", totalMemoryBytes: 999 } }),
    nodeVersion: "v22.22.1",
  });
  assert.equal(metadataChanged.digest, base.digest);
  assert.equal(metadataChanged.metadata.deviceName, "Other GPU");
});

test("candidate identity changes when the runtime identity changes", () => {
  const root = tmp();
  writeLocks(root);
  const store = path.join(root, "store");
  const parent = path.join(store, "v001");
  mkdirSync(parent, { recursive: true });
  writeFileSync(path.join(parent, "init-manifest.json"), JSON.stringify({
    tensorHashesAfterTraining: { tensors: { "w": { dtype: "float32", sha256: "a".repeat(64) } } },
  }));
  writeFileSync(path.join(parent, "tokenizer.json"), "{}");
  const evalFile = path.join(root, "eval.jsonl");
  writeFileSync(evalFile, "{}\n");
  const base = computeRuntimeFingerprint({ root, pythonProbe: probe(), nodeVersion: "v22.22.1" });
  const changed = computeRuntimeFingerprint({ root, pythonProbe: probe({ torch: "9.9.9" }), nodeVersion: "v22.22.1" });
  const common = {
    root,
    parentVersion: "v001",
    storeRoot: store,
    corpusFingerprint: "corpus",
    evaluationFile: evalFile,
    tokenizerFile: path.join(parent, "tokenizer.json"),
    trainingConfig: {},
    seed: 0,
    splitPolicy: {},
  };
  const first = buildCandidateIdentity({ ...common, environmentFingerprint: base });
  const second = buildCandidateIdentity({ ...common, environmentFingerprint: changed });
  assert.notEqual(first.candidateKey, second.candidateKey);
  assert.equal(first.runtimeMetadata.deviceName, "Radeon 890M");
});
