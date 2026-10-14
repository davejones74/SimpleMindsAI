import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Brain } from "../src/brain/brain.js";
import { readActiveVersion } from "../src/brain/python-cli.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const tmpStore = (version) => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "sma-brain-")));
  if (version)
    writeFileSync(
      path.join(dir, "active.json"),
      JSON.stringify({ version, artifactName: `art-${version}` }),
      "utf8",
    );
  return dir;
};

/** Fake student worker: load/reload re-read active.json like the real one. */
class FakeWorker {
  constructor({ available = true, behavior = "ok", store } = {}) {
    this._available = available;
    this.behavior = behavior;
    this.store = store;
    this.version = null;
    this.reloadCount = 0;
  }
  get available() {
    return this._available;
  }
  async start() {}
  async load(version, opts = {}) {
    this.loadOpts = opts;
    const v = readActiveVersion(this.store);
    if (v) this.version = v;
    return { version: this.version, artifactName: `art-${this.version}` };
  }
  async reload(opts = {}) {
    this.reloadCount += 1;
    this.reloadOpts = opts;
    const v = readActiveVersion(this.store);
    if (v) this.version = v;
    return { version: this.version, artifactName: `art-${this.version}` };
  }
  async generate() {
    if (this.behavior === "throw") throw new Error("worker exploded");
    return { text: "hello world", version: this.version, generatedTokens: 2, artifactName: `art-${this.version}` };
  }
  async shutdown() {}
}

test("respond returns the student's text and version", async () => {
  const brain = new Brain({ worker: new FakeWorker({ store: tmpStore("v002") }) });
  await brain.start();
  const out = await brain.respond("hi");
  assert.equal(out.reply, "hello world");
  assert.equal(out.version, "v002");
  assert.equal(out.mode, "student");
  assert.equal(typeof out.latencyMs, "number");
});

test("an unavailable worker is an explicit error, never a fallback answer", async () => {
  const brain = new Brain({ worker: new FakeWorker({ available: false, store: tmpStore("v002") }) });
  await assert.rejects(() => brain.respond("hi"), /student brain unavailable/);
});

test("a failing worker surfaces an error instead of a teacher answer", async () => {
  const brain = new Brain({ worker: new FakeWorker({ behavior: "throw", store: tmpStore("v002") }) });
  await assert.rejects(() => brain.respond("hi"), /student brain failed to answer/);
});

test("a moved active pointer is picked up on the next turn without a restart", async () => {
  const store = tmpStore("v001");
  const worker = new FakeWorker({ store });
  const brain = new Brain({ worker });
  await brain.start();
  const first = await brain.respond("hi");
  assert.equal(first.version, "v001");
  assert.equal(worker.reloadCount, 0);

  // an external promotion (npm run train / perpetual) moves the pointer
  writeFileSync(
    path.join(store, "active.json"),
    JSON.stringify({ version: "v003", artifactName: "art-v003" }),
    "utf8",
  );

  const out = await brain.respond("hi");
  assert.equal(out.version, "v003");
  assert.equal(worker.reloadCount, 1);
  assert.equal(brain.version, "v003");

  // unchanged pointer -> no extra reload on the following turn
  await brain.respond("hi");
  assert.equal(worker.reloadCount, 1);
});

test("the resident version is loaded and re-verified, never served with a skipped integrity check", async () => {
  const store = tmpStore("v001");
  const worker = new FakeWorker({ store });
  const brain = new Brain({ worker });
  await brain.start();
  assert.equal(worker.loadOpts?.verify, true, "startup load must request integrity verification");

  writeFileSync(
    path.join(store, "active.json"),
    JSON.stringify({ version: "v005", artifactName: "art-v005" }),
    "utf8",
  );
  await brain.respond("hi");
  assert.equal(worker.reloadOpts?.verify, true, "a pointer move must request integrity verification");
});

test("an unreadable pointer leaves the resident brain untouched", async () => {
  const store = tmpStore("v001");
  const worker = new FakeWorker({ store });
  const brain = new Brain({ worker });
  await brain.start();
  rmSync(path.join(store, "active.json"));
  const out = await brain.respond("hi");
  assert.equal(out.version, "v001");
  assert.equal(worker.reloadCount, 0);
});

test("the brain source contains no Ollama/DeepSeek fallback path", () => {
  const raw = readFileSync(path.join(HERE, "..", "src", "brain", "brain.js"), "utf8");
  // Strip comments: the file explains *why* there is no fallback, which is not
  // the same as containing one.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .toLowerCase();
  assert.ok(!code.includes("ollama"), "brain.js must not reference ollama");
  assert.ok(!code.includes("deepseek"), "brain.js must not reference deepseek");
});