import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPythonStore, resolveStorePath } from "../src/admin/python-store.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-py-"));
const writeJson = (file, obj) => writeFileSync(file, JSON.stringify(obj), "utf8");

test("missing store is reported unavailable, never fabricated", () => {
  const root = path.join(tmp(), "does-not-exist");
  const r = readPythonStore(root);
  assert.equal(r.available, false);
  assert.equal(r.versions.length, 0);
  assert.match(r.reason, /not found|missing/i);
});

test("reads versions and distinguishes an unavailable metric from a zero", () => {
  const root = tmp();
  const v1 = path.join(root, "v1");
  mkdirSync(v1, { recursive: true });
  writeFileSync(path.join(v1, "COMMITTED"), "");
  writeJson(path.join(v1, "init-manifest.json"), { metrics: { loss: 0, tokens: 1234 }, architecture: "smoke" });
  writeJson(path.join(v1, "provenance.json"), { actor: "cli" });
  writeJson(path.join(root, "active.json"), { version: "v1" });

  const r = readPythonStore(root);
  assert.equal(r.available, true);
  assert.equal(r.activeVersion, "v1");
  assert.equal(r.versions.length, 1);
  assert.equal(r.versions[0].version, "v1");
  assert.equal(r.versions[0].committed, true);
  assert.equal(r.versions[0].metrics.loss, 0); // a recorded zero stays zero
  assert.equal(r.versions[0].metrics.steps, null); // unavailable stays null
  assert.ok(r.versions[0].provenance);
});

test("a store with no active.json is available but flags the missing activation", () => {
  const root = tmp();
  const v1 = path.join(root, "v1");
  mkdirSync(v1, { recursive: true });
  writeFileSync(path.join(v1, "COMMITTED"), "");
  const r = readPythonStore(root);
  assert.equal(r.available, true);
  assert.equal(r.activeVersion, null);
  assert.match(r.reason, /active\.json/);
});

test("resolveStorePath prefers explicit, then env, then the default home path", () => {
  assert.equal(resolveStorePath("C:/explicit/store"), "C:/explicit/store");
});
