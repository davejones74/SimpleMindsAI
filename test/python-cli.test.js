import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJsonProcess } from "../src/brain/python-cli.js";

/**
 * Always-on Node<->subprocess contract test. It exercises the real spawn →
 * stdout-JSON -> exit-code path with the Node executable as the child, so it
 * runs everywhere and never depends on a Python toolchain or torch.
 */

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test-support", "fake-brain.mjs");
const bin = process.execPath;

test("subprocess contract: spawn -> parsed stdout JSON", async () => {
  const out = await runJsonProcess({ bin, args: [FAKE, "status"] });
  assert.equal(out.ok, true);
  assert.equal(out.verb, "status");
  assert.equal(out.versions[0].version, "v001");
});

test("subprocess contract: non-zero exit rejects with stderr detail", async () => {
  await assert.rejects(runJsonProcess({ bin, args: [FAKE, "boom"] }), /exited 3: boom happened/);
});

test("subprocess contract: non-JSON stdout rejects", async () => {
  await assert.rejects(runJsonProcess({ bin, args: [FAKE, "garbage"] }), /did not emit a JSON object/);
});

test("subprocess contract: timeout rejects", async () => {
  await assert.rejects(runJsonProcess({ bin, args: [FAKE, "sleep"], timeoutMs: 250 }), /timed out after 250ms/);
});

test("subprocess contract: stderr lines are forwarded without breaking stdout parsing", async () => {
  const lines = [];
  const out = await runJsonProcess({
    bin,
    args: [FAKE, "telemetry"],
    onStderrLine: (line) => lines.push(line),
  });
  assert.equal(out.ok, true);
  assert.equal(out.verb, "telemetry");
  assert.ok(lines.includes("[sma] ordinary log"));
  assert.ok(lines.some((line) => line.includes('"seq":1')));
  assert.ok(lines.some((line) => line.includes('"seq":2')), "a split stderr chunk is reassembled into one line");
});
