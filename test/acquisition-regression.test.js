import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { createSitemapAdapter } from "../src/discovery/adapters/sitemap-adapter.js";
import { classifyAcquisition, ACQUISITION_STATE } from "../src/discovery/acquisition-state.js";

/**
 * Slice 8 regression for the job-16 dead end. A site whose sitemap always serves
 * the same large URL list made the crawler replay the same leading page every
 * cycle (`found:500 / duplicate:500`) until acquisition reported exhaustion.
 *
 * The fix has two halves, both asserted here end-to-end:
 *   1. dedup-before-cap lets a bounded candidate window ADVANCE through a static
 *      sitemap, so later entries are eventually reached; and
 *   2. a drained-but-revisitable frontier is SCHEDULED (waiting for rediscovery),
 *      never terminal exhaustion.
 */

const ORIGIN = "https://static.example";

function sitemapFetcher(pageUrls) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset>${pageUrls
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join("")}</urlset>`;
  return async (url, { isRobots } = {}) => {
    if (isRobots) return "User-agent: *\nAllow: /\n";
    if (url.endsWith("/sitemap.xml")) return xml;
    throw new Error(`unexpected fetch ${url}`);
  };
}

test("job-16 regression: a static sitemap advances past the cap and never dead-ends", async () => {
  const pages = Array.from({ length: 7 }, (_, i) => `${ORIGIN}/p${i + 1}`);
  const frontier = new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-job16-")) });
  await frontier.init();

  const adapter = createSitemapAdapter({
    fetchText: sitemapFetcher(pages),
    maxCandidates: 2,
    knownUrls: (url) => frontier.has(url),
  });

  const enqueued = new Set();
  const keys = new Map();
  // Each cycle re-reads the SAME sitemap; the dedup must push the window forward.
  for (let cycle = 0; cycle < 6 && enqueued.size < pages.length; cycle++) {
    const res = await adapter.discover({ roots: [`${ORIGIN}/`] });
    for (const c of res.candidates) {
      const key = await frontier.enqueue(c.url, { depth: 0 });
      if (key) {
        enqueued.add(c.url);
        keys.set(c.url, key);
      }
    }
  }
  assert.equal(enqueued.size, pages.length, "every sitemap page is reached across cycles");

  // Drain them with a future rediscovery deadline (content fetched successfully).
  const nextCrawlAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  for (const url of pages) await frontier.markVisited(keys.get(url), { nextCrawlAt });

  const summary = frontier.summary();
  assert.equal(summary.queued, 0);
  assert.equal(summary.visited, pages.length);
  assert.ok(summary.nextDueAt, "a rediscovery deadline is scheduled");

  // Momentarily empty, but NOT exhausted: the supervisor should wait, not stop.
  const acq = classifyAcquisition({ frontier: summary, discovery: { providerAvailable: false, bootstrap: { adapters: [] } } });
  assert.equal(acq.state, ACQUISITION_STATE.SCHEDULED);

  // Once the TTL elapses the URLs become claimable rediscovery work again.
  const due = { ...summary, rediscoveryDue: pages.length };
  assert.equal(classifyAcquisition({ frontier: due }).state, ACQUISITION_STATE.WORK);
});

test("job-16 regression: discovery exhaustion vs learning readiness stay distinct", () => {
  // No frontier work, no providers, no scheduled retry => truly exhausted.
  assert.equal(classifyAcquisition({ frontier: {} }).state, ACQUISITION_STATE.EXHAUSTED);
  // A scheduled retry => not exhausted.
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(
    classifyAcquisition({ frontier: { deferred: 1, deferredDue: 0, nextDueAt: future } }).state,
    ACQUISITION_STATE.SCHEDULED,
  );
  // A due retry => claimable work.
  assert.equal(classifyAcquisition({ frontier: { deferred: 1, deferredDue: 1 } }).state, ACQUISITION_STATE.WORK);
});
