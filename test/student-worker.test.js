import assert from "node:assert/strict";
import test from "node:test";
import { StudentWorker } from "../src/brain/student-worker.js";
import { REAL_STORE, committedVersions, pythonReady } from "../test-support/python.js";

const versions = committedVersions();
const ready = await pythonReady();
const skip = !ready || !versions.includes("v001")
  ? "needs a working Python compute plane with committed v001"
  : false;

function makeWorker(extra = {}) {
  return new StudentWorker({
    store: REAL_STORE,
    device: "cpu",
    requestTimeoutMs: 300_000,
    log: () => {},
    ...extra,
  });
}

test("loads a committed version and answers a framed generate request", { skip }, async (t) => {
  const worker = makeWorker();
  t.after(() => worker.shutdown());

  await worker.start();
  const pong = await worker.ping();
  assert.equal(pong.pong, true);

  const loaded = await worker.load("v001");
  assert.equal(loaded.version, "v001");
  assert.equal(loaded.parameters, 61_839_744);

  const gen = await worker.generate("Hello", { maxNewTokens: 4, seed: 0 });
  assert.equal(gen.version, "v001");
  assert.equal(typeof gen.text, "string");
  assert.equal(gen.generatedTokens, 4);

  const current = await worker.currentVersion();
  assert.equal(current.loaded, true);
  assert.equal(current.version, "v001");
});

test("a malformed op is an error response, not a crash", { skip }, async (t) => {
  const worker = makeWorker();
  t.after(() => worker.shutdown());
  await worker.start();

  await assert.rejects(() => worker._send("nonsense"), /unknown op/);
  assert.equal(worker.available, true);
  assert.equal((await worker.ping()).pong, true);
});

test("generate before any load fails explicitly", { skip }, async (t) => {
  const worker = makeWorker();
  t.after(() => worker.shutdown());
  await worker.start();

  await assert.rejects(() => worker.generate("Hello"), /no version loaded/);
  assert.equal(worker.available, true);
});

test("calling a worker that was never started rejects without a teacher fallback", async () => {
  const worker = makeWorker();
  await assert.rejects(() => worker.generate("Hello"), /not running/);
});
