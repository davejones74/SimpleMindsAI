import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(".");
const CRASH_CHILD = path.join(ROOT, "test-support", "working-crash-child.mjs");
const RECOVERY_CHILD = path.join(ROOT, "test-support", "working-recovery-child.mjs");
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-crash-subprocess-")));
const json = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2)); };
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function setup() {
  const root = tmp();
  for (const version of ["v100", "v200"]) {
    mkdirSync(path.join(root, version), { recursive: true });
    writeFileSync(path.join(root, version, "model.safetensors"), "weights");
    writeFileSync(path.join(root, version, "COMMITTED"), "{}");
  }
  json(path.join(root, "active.json"), { schema: "sma/active@1", version: "v100" });
  json(path.join(root, "working.json"), { schema: "sma/working@1", version: "v200", lastGoodVersion: "v100" });
  json(path.join(root, "working-last-good.json"), { schema: "sma/working@1", version: "v100" });
  mkdirSync(path.join(root, "snapshots"), { recursive: true });
  return root;
}

function crash(root, point) {
  const result = spawnSync(process.execPath, [CRASH_CHILD], {
    env: { ...process.env, CRASH_ROOT: root, CRASH_POINT: point },
    encoding: "utf8",
  });
  assert.equal(result.signal, "SIGKILL", `${point} must actually terminate the subprocess (status ${result.status}, stderr ${result.stderr})`);
}

function recover(root) {
  const result = spawnSync(process.execPath, [RECOVERY_CHILD], {
    env: { ...process.env, CRASH_ROOT: root },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `recovery failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

function consumption(root) {
  const file = path.join(root, "consumption.ndjson");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}

function assertNoCommittedCandidate(root) {
  assert.equal(existsSync(path.join(root, "v201", "COMMITTED")), false);
  assert.equal(readJson(path.join(root, "working.json")).version, "v200");
  assert.equal(readJson(path.join(root, "active.json")).version, "v100");
}

test("subprocess crash during candidate checkpoint creation leaves no committed candidate", () => {
  const root = setup();
  crash(root, "during-checkpoint");
  assertNoCommittedCandidate(root);
  assert.equal(existsSync(path.join(root, "_runs", "v201.train-state.pt")), false);
  assert.equal(consumption(root).length, 0);
});

test("subprocess crash after weights but before optimizer state leaves no committed pair", () => {
  const root = setup();
  crash(root, "after-weights");
  assertNoCommittedCandidate(root);
  assert.equal(existsSync(path.join(root, "v201.tmp", "model.safetensors")), true);
  assert.equal(existsSync(path.join(root, "_runs", "v201.train-state.pt")), false);
  assert.equal(consumption(root).length, 0);
});

test("subprocess crash after weights+optimizer but before commit leaves the staged pair unpublished", () => {
  const root = setup();
  crash(root, "after-optimizer");
  assertNoCommittedCandidate(root);
  assert.equal(existsSync(path.join(root, "v201.tmp", "model.safetensors")), true);
  assert.equal(existsSync(path.join(root, "_runs", "v201.train-state.pt")), true);
  assert.equal(existsSync(path.join(root, "v201", "COMMITTED")), false);
  assert.equal(consumption(root).length, 0);
});

test("subprocess crash during pointer write leaves the previous pointer authoritative", () => {
  const root = setup();
  crash(root, "during-pointer");
  assert.equal(existsSync(path.join(root, "v201", "COMMITTED")), true, "candidate was committed before the pointer write");
  assert.equal(readJson(path.join(root, "working.json")).version, "v200");
  assert.equal(readJson(path.join(root, "active.json")).version, "v100");
  assert.equal(existsSync(path.join(root, "v201", "model.safetensors")), true);
  assert.equal(existsSync(path.join(root, "_runs", "v201.train-state.pt")), true);
  assert.equal(consumption(root).length, 0);
  assert.equal(existsSync(path.join(root, "working.json")), true);
  assert.equal(readJson(path.join(root, "working.json")).version, "v200", "temp pointer is not authoritative");
});

test("crash after pointer advancement before consumption is recovered exactly once without moving active", () => {
  const root = setup();
  crash(root, "after-pointer-before-consume");
  assert.equal(readJson(path.join(root, "working.json")).version, "v201");
  assert.equal(readJson(path.join(root, "active.json")).version, "v100");
  assert.equal(consumption(root).length, 0);
  assert.equal(existsSync(path.join(root, "v201", "model.safetensors")), true);
  assert.equal(existsSync(path.join(root, "_runs", "v201.train-state.pt")), true);

  recover(root);
  assert.deepEqual(consumption(root).map((r) => r.articleId).sort(), ["a1", "a2"]);
  assert.equal(readJson(path.join(root, "working.json")).version, "v201");
  assert.equal(readJson(path.join(root, "active.json")).version, "v100");

  recover(root);
  assert.deepEqual(consumption(root).map((r) => r.articleId).sort(), ["a1", "a2"], "recovery is idempotent");
});

test("crash during consumption recovery is resumed without duplicate consumption", () => {
  const root = setup();
  crash(root, "during-consumption");
  assert.equal(readJson(path.join(root, "working.json")).version, "v201");
  assert.deepEqual(consumption(root).map((r) => r.articleId), ["a1"]);
  recover(root);
  assert.deepEqual(consumption(root).map((r) => r.articleId).sort(), ["a1", "a2"]);
  recover(root);
  assert.deepEqual(consumption(root).map((r) => r.articleId).sort(), ["a1", "a2"], "retry does not duplicate a1");
  assert.equal(readJson(path.join(root, "active.json")).version, "v100");
});
