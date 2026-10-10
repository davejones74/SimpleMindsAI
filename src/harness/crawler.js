import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { fetchDocument, parseRobots, robotsAllows, assertUrlAllowed, contentHashFor } from "./fetcher.js";

/**
 * Harvest — the ONLY entry point that produces raw docs.
 *
 * CRAWL_MODE=real fetches ONLY the operator-supplied URLs in CRAWL_URLS, one at
 * a time, through the bounded SSRF-aware fetcher. There is NO search-engine or
 * link-following DISCOVERY capability — the system cannot invent sources. If
 * real mode is requested without CRAWL_URLS it fails closed rather than
 * silently falling back to fixtures.
 *
 * CRAWL_MODE=fixture emits the built-in sample docs for pipeline smoke tests.
 *
 * Every raw record is labelled with the capability that produced it, so the
 * ledger can never mistake a fixture for a fetched document.
 */

export const CAPABILITY = Object.freeze({
  real: "configured-fetch",
  fixture: "fixture",
});

const FIXTURE_DOCS = [
  `|| History of the steam engine ||
The steam engine was developed in Britain during the 18th century. Thomas
Newcomen built the first practical atmospheric engine in 1712. James Watt added
a separate condenser in 1769, dramatically improving fuel efficiency, which made
steam power economical for factories and, later, locomotives.`,
  `LIMITED TIME! Buy our miracle supplement now!!! 90% off!!! Click HERE for the
one weird trick doctors hate. 100% natural, guaranteed results in 24 hours,
no scientific basis whatsoever, just give us your credit card number.`,
  `|| Introduction to recursive algorithms ||
A recursive function solves a problem by calling itself on a strictly smaller
input, with a base case that terminates the recursion. The call stack holds one
frame per pending call, so depth is bounded by available stack space. Memoisation
caches subproblem results to turn exponential naive recursion into linear work.`,
];

/** Resolve and validate the requested mode. Fail-closed; never guesses. */
export function classifyCrawlMode({ mode, urls } = {}) {
  const m = String(mode ?? "").toLowerCase();
  const list = (urls ?? []).filter(Boolean);
  if (m === "fixture") return { mode: "fixture", capability: CAPABILITY.fixture, urls: [] };
  if (m === "real") {
    if (!list.length) {
      throw new Error(
        "CRAWL_MODE=real requires CRAWL_URLS (comma-separated configured source URLs); " +
          "refusing to silently fall back to fixtures. Set CRAWL_URLS or use CRAWL_MODE=fixture.",
      );
    }
    return { mode: "real", capability: CAPABILITY.real, urls: list };
  }
  throw new Error(`unknown CRAWL_MODE "${mode}" (expected "real" or "fixture")`);
}

function fixtureRecord(text, source = "harvest") {
  return {
    text,
    domain: "general",
    source,
    url: null,
    fetchedAt: new Date().toISOString(),
    contentHash: contentHashFor(text),
    crawlMode: "fixture",
    capability: CAPABILITY.fixture,
  };
}

async function loadRobots(url, { timeoutMs, allowPrivate, userAgent, fetchImpl }) {
  const origin = new URL(url).origin;
  try {
    const res = await fetchDocument(`${origin}/robots.txt`, { timeoutMs: Math.min(timeoutMs, 5000), allowPrivate, userAgent, fetchImpl });
    return parseRobots(res.text);
  } catch {
    return []; // missing/unreadable robots.txt => no restrictions
  }
}

/**
 * Collect documents WITHOUT touching disk (unit-testable).
 * @returns {Promise<{mode,capability,documents,failures}>}
 */
export async function collectDocuments({
  mode = "fixture",
  urls = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxBytes = 2_000_000,
  maxRedirects = 5,
  allowPrivate = false,
  respectRobots = true,
  userAgent = "SimpleMindsAI/0.2",
} = {}) {
  const decided = classifyCrawlMode({ mode, urls });
  if (decided.mode === "fixture") {
    return { mode: "fixture", capability: CAPABILITY.fixture, documents: FIXTURE_DOCS.map((t) => fixtureRecord(t)), failures: [] };
  }

  const documents = [];
  const failures = [];
  for (const url of decided.urls) {
    try {
      await assertUrlAllowed(url, { allowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(url, { timeoutMs, allowPrivate, userAgent, fetchImpl });
        const { pathname, search } = new URL(url);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          failures.push({ url, ok: false, reason: "robots-disallowed" });
          continue;
        }
      }
      const doc = await fetchDocument(url, { timeoutMs, maxBytes, maxRedirects, allowPrivate, userAgent, fetchImpl });
      documents.push({
        text: doc.text,
        domain: "general",
        source: new URL(doc.url).hostname,
        url: doc.url,
        title: doc.title,
        status: doc.status,
        contentType: doc.contentType,
        bytes: doc.bytes,
        fetchedAt: doc.fetchedAt,
        contentHash: doc.contentHash,
        crawlMode: "real",
        capability: CAPABILITY.real,
      });
    } catch (err) {
      failures.push({ url, ok: false, reason: err?.code ?? err?.message ?? "fetch-failed" });
    }
  }
  return { mode: "real", capability: CAPABILITY.real, documents, failures };
}

/**
 * Collect documents and persist them to the raw dir. Successful documents go to
 * the corpus file (picked up by the curator); failures are written alongside so
 * "fetched" and "attempted" stay distinguishable.
 */
export async function harvest({
  dir = config.paths.raw,
  mode = config.crawlMode,
  urls = config.crawlUrls,
  fetchImpl,
  timeoutMs = config.crawlTimeoutMs,
  maxBytes = config.crawlMaxBytes,
  maxRedirects = config.crawlMaxRedirects,
  allowPrivate = config.crawlAllowPrivate,
  respectRobots = config.crawlRespectRobots,
  userAgent = config.crawlUserAgent,
} = {}) {
  const result = await collectDocuments({ mode, urls, fetchImpl, timeoutMs, maxBytes, maxRedirects, allowPrivate, respectRobots, userAgent });
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${result.mode}-${stamp}.ndjson`);
  const body = `${result.documents.map((d) => JSON.stringify(d)).join("\n")}${result.documents.length ? "\n" : ""}`;
  await writeFile(file, body, "utf8");

  let failuresFile = null;
  if (result.failures.length) {
    failuresFile = path.join(dir, `failures-${stamp}.ndjson`);
    const failed = result.failures
      .map((f) => JSON.stringify({ ...f, crawlMode: result.mode, capability: result.capability, attemptedAt: new Date().toISOString() }))
      .join("\n");
    await writeFile(failuresFile, `${failed}\n`, "utf8");
  }
  return { ...result, file, failuresFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const res = await harvest();
    console.log(`[crawl] mode=${res.mode} capability=${res.capability} fetched=${res.documents.length} failed=${res.failures.length}`);
    console.log(`[crawl] wrote ${res.documents.length} raw docs -> ${res.file}`);
    if (res.failuresFile) console.log(`[crawl] ${res.failures.length} failures -> ${res.failuresFile}`);
    if (res.mode === "real" && res.documents.length === 0) {
      console.error("[crawl] real mode fetched nothing — check CRAWL_URLS / failures file");
      process.exitCode = 1;
    }
    console.log(`[crawl] next: npm run curate -- --file ${res.file}`);
  } catch (err) {
    console.error(`[crawl] ${err.message}`);
    process.exitCode = 1;
  }
}
