import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDocuments, harvest } from "../src/harness/crawler.js";
import { Frontier } from "../src/frontier.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-gateway-boundary-"));

function guardNetwork() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network must not be reached");
  };
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("collectDocuments real rejects before network without gateway or injected transport", async () => {
  const net = guardNetwork();
  try {
    await assert.rejects(
      collectDocuments({
        mode: "real",
        urls: ["https://example.test/a"],
        allowPrivate: true,
      }),
      (err) =>
        err.code === "ADMISSION_PATH_DISABLED" &&
        /Baseline v1 admission/.test(err.message) &&
        /admissionGateway/.test(err.message),
    );
    assert.equal(net.calls(), 0, "the guard runs before any fetch");
  } finally {
    net.restore();
  }
});

test("harvest real rejects before network or claim without gateway or injected transport", async () => {
  const dir = tmp();
  const frontier = new Frontier({ dir: path.join(dir, "frontier") });
  await frontier.init();
  const key = await frontier.enqueue("https://example.test/a");
  const net = guardNetwork();
  try {
    await assert.rejects(
      harvest({
        dir: path.join(dir, "raw"),
        mode: "real",
        urls: ["https://example.test/a"],
        frontier,
        allowPrivate: true,
      }),
      (err) => err.code === "ADMISSION_PATH_DISABLED" && /Baseline v1 admission/.test(err.message),
    );
    assert.equal(net.calls(), 0, "the guard runs before any fetch");
    assert.equal(frontier.state.get(key).state, "queued", "the guard runs before claiming work");
  } finally {
    net.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture mode and an explicit mock transport remain usable offline", async () => {
  const net = guardNetwork();
  try {
    const fixture = await collectDocuments({ mode: "fixture" });
    assert.equal(fixture.mode, "fixture");
    assert.ok(fixture.documents.length >= 1);

    const calls = [];
    const mockFetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("<html><body><p>offline mock</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };
    const real = await collectDocuments({
      mode: "real",
      urls: ["https://example.test/a"],
      allowPrivate: true,
      fetchImpl: mockFetch,
    });
    assert.equal(real.documents.length, 1);
    assert.equal(calls.length, 2, "robots + document came from the injected transport");
    assert.equal(net.calls(), 0, "the global fetch was never used");
  } finally {
    net.restore();
  }
});

test("learning fallback cannot perform real acquisition without admission", () => {
  const script = `
    import { runLearningCycle } from "./src/jobs/learning.js";
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls++;
      throw new Error("network must not be reached");
    };
    let code = null;
    try {
      await runLearningCycle({ store: {}, ollama: {}, scorer: {} });
    } catch (err) {
      code = err?.code ?? null;
    }
    process.stdout.write(JSON.stringify({ code, networkCalls }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "",
      SMA_SKIP_ENV_FILE: "",
      CRAWL_MODE: "real",
      CRAWL_URLS: "https://example.test/a",
    },
    encoding: "utf8",
  });
  const result = JSON.parse(out);
  assert.equal(result.code, "ADMISSION_PATH_DISABLED");
  assert.equal(result.networkCalls, 0);
});

test("source probe fails closed with a clear admission explanation", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/probe-crawl-sources.mjs", "https://example.test/a"],
    {
      cwd: root,
      env: { ...process.env, NODE_TEST_CONTEXT: "", SMA_SKIP_ENV_FILE: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /blocked:/);
  assert.match(result.stdout, /Baseline v1 admission/);
  assert.match(result.stdout, /gateway-backed crawl\/learning path/);
});
