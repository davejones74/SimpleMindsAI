import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/**
 * Four DIFFERENT things get called "a brain" in conversation. Conflating them is
 * what makes the version count look wrong, so each state is reported on its own:
 *
 *   published  - a committed, immutable, servable checkpoint version
 *   staged     - `vNNN.tmp`, built by `train --stage-only`, not published yet
 *   run        - an orchestration event (never a version; lives in the registry)
 *   pruned     - weights deliberately removed; the record survives in git
 */
test("python store reader separates published, staged and pruned versions", () => {
  const root = tmp();
  for (const version of ["v001", "v002", "v003"]) {
    const v = path.join(root, version);
    mkdirSync(v, { recursive: true });
    writeFileSync(path.join(v, "COMMITTED"), JSON.stringify({ committedAt: new Date().toISOString() }));
    writeJson(
      path.join(v, "init-manifest.json"),
      { artifactName: `brain-${version}`, sizes: { parametersUniqueByStorage: 1234 }, createdAt: new Date().toISOString() },
    );
    writeJson(
      path.join(v, "train-state.json"),
      { stepsCompleted: 60, tokensSeen: 4242, finalValidationLoss: 2.5, packing: { datasetHash: "deadbeef" } },
    );
  }

  // A staged candidate: a real directory, deliberately NOT a version.
  const staged = path.join(root, "v004.tmp");
  mkdirSync(staged, { recursive: true });
  writeFileSync(path.join(staged, "init-manifest.json"), JSON.stringify({ version: "v004" }));

  // A pruning tombstone for a version whose weights are gone.
  const prunedDir = path.join(root, "_pruned");
  mkdirSync(prunedDir, { recursive: true });
  writeJson(path.join(prunedDir, "v000.json"), {
    schema: "sma/pruned@1",
    version: "v000",
    prunedAt: new Date().toISOString(),
    reason: "older than the retained window",
    weightBytes: 1_000_000,
    recordFiles: { "init-manifest.json": { sha256: "a".repeat(64), bytes: 100 } },
    mirror: "retained in git",
  });

  writeJson(path.join(root, "active.json"), { version: "v003" });

  const store = readPythonStore(root);
  assert.equal(store.available, true);

  // `versions` holds ONLY the published ones: the staged candidate must NOT be
  // offered as a selectable, servable version.
  assert.deepEqual(
    store.versions.map((v) => v.version),
    ["v001", "v002", "v003"],
  );
  assert.equal(store.activeVersion, "v003");

  assert.equal(store.counts.published, 3);
  assert.equal(store.counts.uncommitted, 0);
  assert.equal(store.counts.staged, 1);
  assert.equal(store.counts.pruned, 1);

  assert.deepEqual(
    store.staged.map((s) => s.version),
    ["v004"],
  );
  assert.equal(store.staged[0].hasManifest, true);

  assert.equal(store.pruned[0].version, "v000");
  assert.equal(store.pruned[0].reason, "older than the retained window");
  assert.equal(store.pruned[0].mirrorRetained, true);
});

test("a staged candidate is never counted as a published version", () => {
  const root = tmp();
  const v1 = path.join(root, "v001");
  mkdirSync(v1, { recursive: true });
  writeFileSync(path.join(v1, "COMMITTED"), "");
  writeJson(path.join(v1, "init-manifest.json"), { artifactName: "brain-v001", createdAt: new Date().toISOString() });
  // Incomplete staging debris (no manifest) must be reported as incomplete, not
  // silently ignored and definitely not as a version.
  mkdirSync(path.join(root, "v002.tmp"), { recursive: true });
  writeJson(path.join(root, "active.json"), { version: "v001" });

  const store = readPythonStore(root);
  assert.deepEqual(store.versions.map((v) => v.version), ["v001"]);
  assert.equal(store.counts.staged, 1);
  assert.equal(store.staged[0].hasManifest, false);
});

test("an empty store reports zeros rather than fabricating versions", () => {
  const root = tmp();
  const store = readPythonStore(root);
  assert.equal(store.available, true);
  assert.deepEqual(store.versions, []);
  assert.equal(store.activeVersion, null);
  assert.deepEqual(store.staged, []);
  assert.deepEqual(store.pruned, []);
  assert.equal(store.counts.published, 0);
  assert.match(store.reason, /active\.json missing/);
});

test("a missing store reports no counts, not zeros", () => {
  // An unreadable store must not look like an empty one: counts are the absence
  // of evidence dressed up as measurement.
  const store = readPythonStore(path.join(tmp(), "does-not-exist"));
  assert.equal(store.available, false);
  assert.equal(store.counts, undefined);
});
