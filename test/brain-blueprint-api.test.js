import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { GovernanceStore } from "../src/admin/governance-store.js";
import { ChangeFeed } from "../src/admin/change-feed.js";
import { attachAdmin } from "../src/admin/routes.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-blueprint-api-")));

const stubChat = {
  identity: () => ({ available: false, mode: "stub", version: null }),
  respond: async (message) => ({ reply: `echo:${message}`, version: null }),
  isUnavailable: () => false,
};

function tinyBlueprint() {
  return {
    schema: "sma/brain-blueprint@1",
    exportedAt: "2026-10-20T00:00:00Z",
    source: {
      activePointer: "active.json",
      activeVersion: "v001",
      artifactName: "simpleminds-test",
      weightsInspected: "safetensors-header",
      weightsLoaded: false,
      weightFiles: [],
    },
    model: {
      id: "simpleminds-test",
      version: "v001",
      architecture: "SmolLM3ForCausalLM",
      configName: "small",
      initialisation: { pretrainedWeightsUsed: false },
      counts: { layers: 0 },
    },
    parameterAccounting: {
      totalParameters: 10,
      uniqueTrainable: 10,
      tensorElements: 10,
      verification: { status: "verified", exact: true, checks: [], discrepancies: [] },
    },
    components: [
      { id: "model", name: "model", type: "model", parentId: null, blockIndex: null, dimensions: {}, tensors: [], parameters: {}, metadata: {} },
      { id: "model.embed_tokens", name: "embedding", type: "embedding", parentId: "model", blockIndex: null, dimensions: { in: 10, out: 4 }, tensors: [], parameters: {}, metadata: {} },
      { id: "model.lm_head", name: "head", type: "output_head", parentId: "model", blockIndex: null, dimensions: { in: 4, out: 10 }, tensors: [], parameters: {}, metadata: {} },
    ],
    connections: [
      { id: "c1", from: "model.embed_tokens", to: "model.lm_head", type: "dataflow", explicit: true, inferred: false, dimensions: { width: 4 }, note: null },
    ],
    warnings: [],
    counts: { components: 3, connections: 1, layers: 0 },
  };
}

async function harness(blueprintPath, { supervisor = null } = {}) {
  const root = tmp();
  const store = await ArticleStore.open(root);
  const registry = await RegistryStore.open(tmp());
  const governance = await GovernanceStore.open(tmp());
  const changeFeed = new ChangeFeed();
  const app = express();
  app.use(express.json());
  attachAdmin({
    app,
    store,
    registry,
    governance,
    chat: stubChat,
    changeFeed,
    pythonStorePath: path.join(tmp(), "empty-store"),
    blueprintPath,
    supervisor,
    logger: { log() {} },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await store.close();
      await registry.close();
      await governance.close();
    },
  };
}

test("live telemetry is unavailable without a supervisor and is a bounded snapshot with one", async () => {
  const without = await harness(path.join(tmp(), "missing.json"));
  try {
    const response = await fetch(`${without.base}/api/admin/training/telemetry`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /supervisor/);
  } finally {
    await without.close();
  }

  const snapshot = {
    schema: "sma/training-telemetry@1",
    available: true,
    status: "running",
    jobId: "job-1",
    sessionId: "run-1",
    step: 4,
    totalSteps: 20,
    trainLoss: 1.9,
    history: { training: [{ step: 4, loss: 1.9 }], evaluation: [] },
  };
  const withSupervisor = await harness(path.join(tmp(), "missing.json"), {
    supervisor: { telemetrySnapshot: () => snapshot },
  });
  try {
    const response = await fetch(`${withSupervisor.base}/api/admin/training/telemetry`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schema, "sma/training-telemetry@1");
    assert.equal(body.jobId, "job-1");
    assert.equal(body.history.training.length, 1);
    assert.ok(Number.isInteger(body.changeSeq), "the snapshot carries the SSE resume point");
  } finally {
    await withSupervisor.close();
  }
});

test("blueprint endpoint reports a missing export without inventing one", async () => {
  const blueprintPath = path.join(tmp(), "missing.json");
  const h = await harness(blueprintPath);
  try {
    const response = await fetch(`${h.base}/api/admin/brain/blueprint`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /npm run blueprint/);
  } finally {
    await h.close();
  }
});

test("blueprint endpoint serves a valid export without exposing store paths", async () => {
  const root = tmp();
  const blueprintPath = path.join(root, "blueprint.json");
  writeFileSync(blueprintPath, JSON.stringify(tinyBlueprint()), "utf8");
  const h = await harness(blueprintPath);
  try {
    const response = await fetch(`${h.base}/api/admin/brain/blueprint`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.available, true);
    assert.equal(body.activeVersion, "v001");
    assert.equal(body.blueprint.schema, "sma/brain-blueprint@1");
    assert.equal(body.blueprint.source.weightsLoaded, false);
    assert.ok(!("path" in body));
    assert.ok(!JSON.stringify(body).includes(root));
    assert.match(response.headers.get("content-type"), /application\/json/);
  } finally {
    await h.close();
  }
});

test("blueprint endpoint rejects malformed JSON and invalid schemas", async () => {
  const blueprintPath = path.join(tmp(), "blueprint.json");
  writeFileSync(blueprintPath, "{not json", "utf8");
  const h = await harness(blueprintPath);
  try {
    const malformed = await fetch(`${h.base}/api/admin/brain/blueprint`);
    assert.equal(malformed.status, 422);
    assert.equal((await malformed.json()).available, false);

    writeFileSync(blueprintPath, JSON.stringify({ schema: "wrong" }), "utf8");
    const invalid = await fetch(`${h.base}/api/admin/brain/blueprint`);
    assert.equal(invalid.status, 422);
    const body = await invalid.json();
    assert.equal(body.available, false);
    assert.ok(Array.isArray(body.errors));
    assert.ok(body.errors.length > 0);
  } finally {
    await h.close();
  }
});

test("the standalone brain page is served at /admin/brain", async () => {
  const blueprintPath = path.join(tmp(), "blueprint.json");
  writeFileSync(blueprintPath, JSON.stringify(tinyBlueprint()), "utf8");
  const h = await harness(blueprintPath);
  try {
    const response = await fetch(`${h.base}/admin/brain`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Brain Visualiser/);
    assert.match(html, /importmap/);
    assert.match(html, /\/admin\/brain\/brain\.js/);

    const three = await fetch(`${h.base}/admin/vendor/three/three.module.js`);
    assert.equal(three.status, 200);
    assert.match(three.headers.get("content-type"), /javascript/);
    const controls = await fetch(`${h.base}/admin/vendor/three-addons/controls/OrbitControls.js`);
    assert.equal(controls.status, 200);
    assert.match(controls.headers.get("content-type"), /javascript/);
  } finally {
    await h.close();
  }
});
