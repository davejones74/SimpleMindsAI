import { test } from "node:test";
import assert from "node:assert/strict";
import { pythonEnv } from "../src/brain/python-cli.js";
import { config } from "../src/config.js";

/**
 * Python compute-plane env. The eval timeout must be operator-tunable (a fixed
 * 600s cap failed the gate closed on slow hardware), and thread pinning must be
 * opt-in so PyTorch's default does not oversubscribe a many-thread box.
 */

test("promoteEvalTimeoutMs is a finite positive number (operator-tunable)", () => {
  assert.equal(typeof config.promoteEvalTimeoutMs, "number");
  assert.ok(Number.isFinite(config.promoteEvalTimeoutMs) && config.promoteEvalTimeoutMs > 0);
});

test("pythonEnv leaves thread env vars untouched when SMA_THREADS is unset", () => {
  const prev = process.env.SMA_THREADS;
  try {
    delete process.env.SMA_THREADS;
    const env = pythonEnv("/store");
    assert.equal(env.OMP_NUM_THREADS, undefined);
    assert.equal(env.MKL_NUM_THREADS, undefined);
    assert.equal(env.SMA_STORE, "/store");
    assert.equal(env.PYTHONUNBUFFERED, "1");
  } finally {
    if (prev === undefined) delete process.env.SMA_THREADS;
    else process.env.SMA_THREADS = prev;
  }
});

test("pythonEnv pins the common thread env vars when SMA_THREADS is set", () => {
  const prev = process.env.SMA_THREADS;
  try {
    process.env.SMA_THREADS = "12";
    const env = pythonEnv("/store", { EXTRA: "x" });
    assert.equal(env.OMP_NUM_THREADS, "12");
    assert.equal(env.MKL_NUM_THREADS, "12");
    assert.equal(env.OPENBLAS_NUM_THREADS, "12");
    assert.equal(env.VECLIB_MAXIMUM_THREADS, "12");
    assert.equal(env.NUMEXPR_NUM_THREADS, "12");
    assert.equal(env.EXTRA, "x", "caller overrides are still applied");
  } finally {
    if (prev === undefined) delete process.env.SMA_THREADS;
    else process.env.SMA_THREADS = prev;
  }
});
