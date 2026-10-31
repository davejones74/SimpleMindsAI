import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildPythonTrainArgs } from "../src/training/python-trainer.js";
import { REPO_ROOT, PYTHON_DIR } from "../src/brain/python-cli.js";

const PYTHON = existsSync(path.join(REPO_ROOT, "python/.venv_test/bin/python"))
  ? path.join(REPO_ROOT, "python/.venv_test/bin/python")
  : "python3";

function exactArgs() {
  return buildPythonTrainArgs({
    parentVersion: "v001",
    corpusFile: "/tmp/snapshot.jsonl",
    learningRate: 1e-4,
    steps: 2,
    seqLen: 128,
    microBatch: 2,
    gradAccum: 2,
    warmup: 200,
    valBlocks: 32,
    evalEvery: 100,
    documentBoundary: "separator",
    validationPolicy: "document-source-disjoint",
    requireProspective: true,
    seed: 17,
    minSteps: 1000,
    computeDtype: "float32",
    device: "cpu",
    selectBest: true,
    runId: "run-1",
    stageOnly: true,
  });
}

test("Node train arguments place every option after the train subcommand", () => {
  const args = exactArgs();
  assert.equal(args[0], "train");
  assert.ok(args.indexOf("--parent") > 0);
  assert.ok(args.indexOf("--validation-policy") > 0);
  assert.equal(args[args.indexOf("--validation-policy") + 1], "document-source-disjoint");
  assert.ok(args.indexOf("--require-prospective-validation") > args.indexOf("--validation-policy"));
  assert.ok(args.indexOf("--require-prospective-validation") < args.indexOf("--seed"));
  assert.equal(args[args.indexOf("--seed") + 1], "17");
  assert.equal(args[args.indexOf("--run-id") + 1], "run-1");
  assert.ok(args.includes("--stage-only"));
});

test("the real Python CLI accepts the exact Node-generated train arguments", () => {
  const args = exactArgs();
  const result = spawnSync(PYTHON, ["-m", "sma.brain", ...args, "--help"], {
    cwd: PYTHON_DIR,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /--validation-policy/);
  assert.match(result.stdout, /--require-prospective-validation/);
  assert.match(result.stdout, /--seed/);
});
