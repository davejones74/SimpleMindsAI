import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openCurationCache, curationCacheKey, CURATION_CACHE_VERSION } from "../src/services/curation-cache.js";

test("curation cache reuses only the exact source, chunk and config identity", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "curation-cache-")), "cache.ndjson");
  const base = {
    sourceIdentity: "https://example.org/page",
    sourceContentHash: "source-hash",
    chunkIndex: 0,
    chunkText: "A complete source chunk.",
    chunkMaxChars: 12000,
    chunkMinChars: 1000,
    chunkTargetChars: 4000,
    strategy: "segmented",
    teacherModel: "deepseek-r1:latest",
    focus: null,
  };
  const key = curationCacheKey(base);
  assert.equal(curationCacheKey({ ...base }), key);
  const cache = await openCurationCache(file);
  await cache.load();
  assert.equal(cache.get(key), null);
  await cache.set(key, [{ text: "cleaned", domain: "general" }]);
  assert.deepEqual(cache.get(key), [{ text: "cleaned", domain: "general" }]);

  const reopened = await openCurationCache(file);
  await reopened.load();
  assert.deepEqual(reopened.get(key), [{ text: "cleaned", domain: "general" }]);
  assert.notEqual(curationCacheKey({ ...base, chunkText: "different bytes" }), key);
  assert.notEqual(curationCacheKey({ ...base, chunkMaxChars: 13000 }), key);
  assert.notEqual(curationCacheKey({ ...base, teacherModel: "other" }), key);
  assert.equal(key.length, 64);
  assert.equal(CURATION_CACHE_VERSION, "curation-chunk-cache-v1");
});
