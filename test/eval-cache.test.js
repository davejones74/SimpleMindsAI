import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  baselineCacheKey,
  cacheEntrySatisfiesEvidence,
  loadEvalCache,
  pruneEvalCache,
  saveEvalCache,
  evalCacheFile,
} from "../src/training/eval-cache.js";

/**
 * Immutable parent-loss cache. A cache hit reuses a frozen version's loss; a miss
 * (or a changed eval-set/config) re-evaluates. The key must change whenever the
 * measured loss could change, so the cache can never cause a wrong promotion.
 */

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-evalcache-"));

test("save + load round-trips the cache map", () => {
  const dir = tmp();
  saveEvalCache(dir, { k: { loss: 1.23, ok: true } });
  assert.deepEqual(loadEvalCache(dir), { k: { loss: 1.23, ok: true } });
});

test("load returns {} for a missing or corrupt cache file", () => {
  const dir = tmp();
  assert.deepEqual(loadEvalCache(dir), {});
  writeFileSync(evalCacheFile(dir), "{ not json");
  assert.deepEqual(loadEvalCache(dir), {});
});

test("baselineCacheKey is deterministic and varies with every loss-affecting input", () => {
  const base = { version: "v001", evalSetHash: "abc", seqLen: 128, microBatch: 2, device: "cpu" };
  assert.equal(baselineCacheKey(base), baselineCacheKey(base));
  assert.notEqual(baselineCacheKey({ ...base, version: "v002" }), baselineCacheKey(base), "version");
  assert.notEqual(baselineCacheKey({ ...base, evalSetHash: "def" }), baselineCacheKey(base), "eval-set content");
  assert.notEqual(baselineCacheKey({ ...base, seqLen: 32 }), baselineCacheKey(base), "seq-len");
  assert.notEqual(baselineCacheKey({ ...base, microBatch: 1 }), baselineCacheKey(base), "micro-batch");
  assert.notEqual(baselineCacheKey({ ...base, device: "cuda" }), baselineCacheKey(base), "device");
  assert.notEqual(
    baselineCacheKey({ ...base, perDocument: true }),
    baselineCacheKey(base),
    "evidence shape (aggregate vs per-document)",
  );
  assert.notEqual(baselineCacheKey({ ...base, dtype: "float16" }), baselineCacheKey(base), "compute dtype");
  assert.notEqual(
    baselineCacheKey({ ...base, codeFingerprint: "code-a" }),
    baselineCacheKey({ ...base, codeFingerprint: "code-b" }),
    "trainer code fingerprint",
  );
});

test("cacheEntrySatisfiesEvidence rejects aggregate-only data when per-document evidence is required", () => {
  assert.equal(cacheEntrySatisfiesEvidence({ ok: true, loss: 2.1 }), true);
  assert.equal(cacheEntrySatisfiesEvidence({ ok: true, loss: 2.1 }, { perDocument: true }), false);
  assert.equal(cacheEntrySatisfiesEvidence({ ok: true, loss: 2.1, perDocument: [] }, { perDocument: true }), false);
  assert.equal(
    cacheEntrySatisfiesEvidence({ ok: true, loss: 2.1, perDocument: [{ loss: null, tokens: 0 }] }, { perDocument: true }),
    false,
  );
  assert.equal(
    cacheEntrySatisfiesEvidence(
      { ok: true, loss: 2.1, perDocument: [{ articleId: "a1", group: "g1", tokens: 20, loss: 2.0 }] },
      { perDocument: true },
    ),
    true,
  );
  assert.equal(cacheEntrySatisfiesEvidence({ ok: false, perDocument: [{ tokens: 20, loss: 2.0 }] }, { perDocument: true }), false);
});

test("pruneEvalCache physically removes only entries that fail the predicate", () => {
  const dir = tmp();
  saveEvalCache(dir, {
    stale: { version: "v001", ok: true, loss: 2.1 },
    fresh: { version: "v001", ok: true, loss: 2.1, perDocument: [{ tokens: 20, loss: 2.0 }] },
    other: { version: "v002", ok: true, loss: 1.9 },
  });
  const result = pruneEvalCache(dir, (key, entry) => key === "other" || cacheEntrySatisfiesEvidence(entry, { perDocument: true }));
  assert.deepEqual(result.removed, ["stale"]);
  assert.deepEqual(Object.keys(loadEvalCache(dir)).sort(), ["fresh", "other"]);
});
