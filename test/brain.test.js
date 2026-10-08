import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Brain } from "../src/brain/brain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

class FakeWorker {
  constructor({ available = true, version = "v001", behavior = "ok" } = {}) {
    this._available = available;
    this.version = version;
    this.behavior = behavior;
  }
  get available() { return this._available; }
  async start() {}
  async load() { return { version: this.version, artifactName: `art-${this.version}` }; }
  async reload() { return { version: this.version, artifactName: `art-${this.version}` }; }
  async generate() {
    if (this.behavior === "throw") throw new Error("worker exploded");
    return { text: "hello world", version: this.version, generatedTokens: 2, artifactName: `art-${this.version}` };
  }
  async shutdown() {}
}

test("respond returns the student's text and version", async () => {
  const brain = new Brain({ worker: new FakeWorker({ version: "v002" }) });
  await brain.start();
  const out = await brain.respond("hi");
  assert.equal(out.reply, "hello world");
  assert.equal(out.version, "v002");
  assert.equal(out.mode, "student");
  assert.equal(typeof out.latencyMs, "number");
});

test("an unavailable worker is an explicit error, never a fallback answer", async () => {
  const brain = new Brain({ worker: new FakeWorker({ available: false }) });
  await assert.rejects(() => brain.respond("hi"), /student brain unavailable/);
});

test("a failing worker surfaces an error instead of a teacher answer", async () => {
  const brain = new Brain({ worker: new FakeWorker({ behavior: "throw" }) });
  await assert.rejects(() => brain.respond("hi"), /student brain failed to answer/);
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
