import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { initBrain } from "../src/training/init-brain.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-init-")));

function fakeEnv({ versions = [], active = null } = {}) {
  const state = { versions: versions.map((v) => ({ ...v })), active, calls: [] };
  const run = async (args) => {
    state.calls.push([...args]);
    const verb = args[0];
    if (verb === "status") return { ok: true, verb: "status", versions: state.versions };
    if (verb === "active") {
      const setIdx = args.indexOf("--set");
      if (setIdx >= 0) {
        state.active = args[setIdx + 1];
        return { ok: true, verb: "active", activated: { version: state.active } };
      }
      return { ok: true, verb: "active", activeVersion: state.active };
    }
    if (verb === "init") {
      const version = `v${String(state.versions.length + 1).padStart(3, "0")}`;
      state.versions.push({
        version,
        committed: true,
        manifest: { version },
        artifactName: `simpleminds-small-${version}`,
      });
      return { ok: true, verb: "init", version };
    }
    throw new Error(`unexpected verb ${verb}`);
  };
  return { run, state };
}

const goodEntry = (version) => ({ version, committed: true, manifest: { version }, artifactName: `simpleminds-small-${version}` });

test("init creates, commits, activates and registers a fresh baseline", async () => {
  const registry = await RegistryStore.open(tmp());
  const { run, state } = fakeEnv({ versions: [], active: null });
  const out = await initBrain({ store: "C:/store", models: "data/models", sync: false }, { run, registry, log: { log() {} } });

  assert.equal(out.action, "init");
  assert.equal(out.version, "v001");
  assert.equal(state.active, "v001");
  const model = registry.getModel(out.modelId);
  assert.equal(model.status, "promoted");
  assert.equal(model.meta.pythonVersion, "v001");
  await registry.close();
});

test("init refuses when a valid active baseline already exists", async () => {
  const registry = await RegistryStore.open(tmp());
  const { run } = fakeEnv({ versions: [goodEntry("v001")], active: "v001" });
  await assert.rejects(
    initBrain({ store: "C:/store", sync: false }, { run, registry, log: { log() {} } }),
    /already initialised: active=v001/,
  );
  await registry.close();
});

test("init refuses committed versions with no active pointer (requires --adopt)", async () => {
  const registry = await RegistryStore.open(tmp());
  const { run } = fakeEnv({ versions: [goodEntry("v001")], active: null });
  await assert.rejects(
    initBrain({ store: "C:/store", sync: false }, { run, registry, log: { log() {} } }),
    /--adopt <version>/,
  );
  await registry.close();
});

test("adopt validates and activates an existing committed version", async () => {
  const registry = await RegistryStore.open(tmp());
  const { run, state } = fakeEnv({ versions: [goodEntry("v001"), goodEntry("v002")], active: null });
  const out = await initBrain({ store: "C:/store", adopt: "v002", sync: false }, { run, registry, log: { log() {} } });

  assert.equal(out.action, "adopt");
  assert.equal(state.active, "v002");
  assert.equal(registry.getModel(out.modelId).status, "promoted");
  await registry.close();
});

test("adopt refuses an uncommitted version", async () => {
  const registry = await RegistryStore.open(tmp());
  const { run } = fakeEnv({ versions: [{ version: "v001", committed: false }], active: null });
  await assert.rejects(
    initBrain({ store: "C:/store", adopt: "v001", sync: false }, { run, registry, log: { log() {} } }),
    /not committed/,
  );
  await registry.close();
});

test("an unreadable store is a hard error, never an init", async () => {
  const registry = await RegistryStore.open(tmp());
  const run = async () => {
    throw new Error("permission denied");
  };
  await assert.rejects(
    initBrain({ store: "C:/nope", sync: false }, { run, registry, log: { log() {} } }),
    /Refusing to initialise over a store that cannot be inspected/,
  );
  await registry.close();
});
