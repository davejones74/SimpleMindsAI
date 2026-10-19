import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";

/**
 * Frontier retry semantics.
 *
 * A transient fetch failure (e.g. a DNS blip) must NOT strand the URL: with
 * retries remaining the URL is DEFERRED and claimable again. Only once retries
 * are exhausted is it terminal FAILED. The previous logic assigned FAILED on the
 * FIRST failure, which `claimNext` never returns — leaving the frontier empty of
 * claimable work and the crawl reporting "no sources".
 */

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-frontier-"));

test("a once-failed URL is deferred and retryable", async () => {
  const f = new Frontier({ dir: tmp() });
  await f.init();
  const url = "https://en.wikipedia.org/wiki/Example";
  const canonical = await f.enqueue(url, { depth: 0 });
  assert.ok(canonical);

  const claimed = await f.claimNext();
  assert.equal(claimed.canonical, canonical);
  await f.markFailed(canonical, { reason: "FETCH_DNS" });

  const again = await f.claimNext();
  assert.equal(again?.canonical, canonical, "a once-failed URL must be claimable again");
});

test("a URL that exhausts its retries becomes terminal and unclaimable", async () => {
  const f = new Frontier({ dir: tmp() });
  await f.init();
  const canonical = await f.enqueue("https://en.wikipedia.org/wiki/Example", { depth: 0 });
  assert.ok(canonical);

  await f.markFailed(canonical, { reason: "FETCH_DNS" }); // retries 0 -> 1 => DEFERRED
  await f.markFailed(canonical, { reason: "FETCH_DNS" }); // retries 1 -> 2 => FAILED (exhausted)

  assert.equal(await f.claimNext(), null, "an exhausted URL must not be claimable");
});

test("a visited URL is never re-enqueued, a forced re-enqueue revives an exhausted one", async () => {
  const f = new Frontier({ dir: tmp() });
  await f.init();
  const canonical = await f.enqueue("https://en.wikipedia.org/wiki/Example", { depth: 0 });

  await f.markVisited(canonical, { contentHash: "x" });
  assert.equal(await f.enqueue("https://en.wikipedia.org/wiki/Example", { depth: 0 }), null, "visited => not re-enqueued");

  const f2 = new Frontier({ dir: tmp() });
  await f2.init();
  const c2 = await f2.enqueue("https://example.com/a", { depth: 0 });
  await f2.markFailed(c2, { reason: "x" });
  await f2.markFailed(c2, { reason: "x" }); // exhausted => FAILED
  assert.equal(await f2.enqueue("https://example.com/a", { depth: 0 }), null, "exhausted => not re-enqueued without force");
  assert.ok(await f2.enqueue("https://example.com/a", { depth: 0, force: true }), "force revives an exhausted URL");
});

test("has() reports whether a URL is already tracked (any state)", async () => {
  const f = new Frontier({ dir: tmp() });
  await f.init();
  assert.equal(f.has("https://en.wikipedia.org/wiki/Example"), false);
  await f.enqueue("https://en.wikipedia.org/wiki/Example", { depth: 0 });
  assert.equal(f.has("https://en.wikipedia.org/wiki/Example"), true);
  // Canonicalisation is applied, so an equivalent form also reports true.
  assert.equal(f.has("https://EN.Wikipedia.org/wiki/Example"), true);
  assert.equal(f.has("https://en.wikipedia.org/wiki/Other"), false);
});
