import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Frontier } from "../src/frontier.js";
import { runCrawlCycle } from "../src/harness/crawler.js";
import { RESOLUTION_STATUS } from "../src/discovery/source-resolver.js";
import { contentHashFor } from "../src/harness/fetcher.js";

const DETAILS = "https://archive.org/details/book/page/n1/mode/2up";
const DOWNLOAD = "https://archive.org/download/book/book_djvu.txt";
const ROBOTS = "https://archive.org/robots.txt";

function response({ status = 200, body = "", headers = {} } = {}) {
  return new Response(status === 204 ? null : body, { status, headers });
}

function mockFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    const route = routes[target];
    if (!route) return response({ status: 404, body: "missing" });
    return typeof route === "function" ? route() : route;
  };
  return { calls, fetchImpl };
}

async function makeFrontier(t) {
  const root = mkdtempSync(path.join(tmpdir(), "sma-archive-resolution-"));
  const frontier = new Frontier({ dir: path.join(root, "frontier") });
  await frontier.init();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return frontier;
}

function resolverReturning(value) {
  const calls = [];
  return {
    calls,
    sourceResolver: async (url) => {
      calls.push(url);
      return value;
    },
  };
}

const ENGLISH_TEXT = `Digitized by the Internet Archive
in 2020 with funding from
Example Library
https://archive.org/details/book

The steam engine converted heat into work. Its development changed transport and industry.`;

test("English archive.org details URL fetches the resolved OCR text, not the details page", async (t) => {
  const frontier = await makeFrontier(t);
  await frontier.enqueue(DETAILS, { depth: 0 });
  const net = mockFetch({
    [ROBOTS]: response({ headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }),
    [DOWNLOAD]: response({ headers: { "content-type": "text/plain; charset=utf-8" }, body: ENGLISH_TEXT }),
  });
  const resolver = resolverReturning({
    status: RESOLUTION_STATUS.RESOLVED,
    requestedUrl: DETAILS,
    resolvedUrl: DOWNLOAD,
    itemId: "book",
    textFile: { name: "book_djvu.txt", format: "DjVuTXT", size: 100 },
    languages: ["eng"],
    cleanText: true,
  });

  const summary = await runCrawlCycle({
    frontier,
    sourceResolver: resolver.sourceResolver,
    fetchImpl: net.fetchImpl,
    allowPrivate: true,
    maxDepth: 2,
  });

  assert.equal(summary.errors, 0);
  assert.equal(summary.documents.length, 1);
  assert.equal(summary.archiveResolved, 1);
  assert.equal(net.calls.includes(DETAILS), false, "the catalogue page is never fetched");
  assert.equal(net.calls.includes(DOWNLOAD), true);
  const doc = summary.documents[0];
  assert.equal(doc.url, DOWNLOAD);
  assert.equal(doc.fetchedUrl, DOWNLOAD);
  assert.equal(doc.requestedUrl, DETAILS);
  assert.equal(doc.resolvedFrom, DETAILS);
  assert.equal(doc.sourceResolution.itemId, "book");
  assert.match(doc.text, /The steam engine converted heat into work/);
  assert.doesNotMatch(doc.text, /Digitized by the Internet Archive/);
  assert.equal(doc.contentHash, contentHashFor(doc.text));

  const record = frontier.get(DETAILS);
  assert.equal(record.state, "visited");
  assert.equal(record.resolvedUrl, null);
  assert.equal(record.lastResolvedUrl, DOWNLOAD);
  assert.equal(record.resolution.itemId, "book");
});

test("non-English archive.org item is rejected without fetching details or text", async (t) => {
  const frontier = await makeFrontier(t);
  await frontier.enqueue(DETAILS, { depth: 0 });
  const net = mockFetch();
  const resolver = resolverReturning({
    status: RESOLUTION_STATUS.NON_ENGLISH,
    requestedUrl: DETAILS,
    itemId: "book",
    languages: ["lat"],
    reason: "non-english-language",
  });

  const summary = await runCrawlCycle({
    frontier,
    sourceResolver: resolver.sourceResolver,
    fetchImpl: net.fetchImpl,
    allowPrivate: true,
    maxDepth: 2,
  });

  assert.equal(summary.archiveNonEnglish, 1);
  assert.equal(summary.sourceRejections.length, 1);
  assert.equal(summary.sourceRejections[0].reason, "non-english-fulltext");
  assert.equal(net.calls.length, 0, "no detail page and no text download");
  const record = frontier.get(DETAILS);
  assert.equal(record.state, "rejected");
  assert.equal(record.lastError, "non-english-fulltext");
});

test("no-fulltext, restricted, and unverified language are terminal non-content rejections", async (t) => {
  for (const [status, expected] of [
    [RESOLUTION_STATUS.NO_FULLTEXT, "non-content-no-fulltext"],
    [RESOLUTION_STATUS.RESTRICTED, "non-content-restricted"],
    [RESOLUTION_STATUS.UNVERIFIED_LANGUAGE, "unverified-language"],
  ]) {
    const frontier = await makeFrontier(t);
    await frontier.enqueue(DETAILS, { depth: 0 });
    const net = mockFetch();
    const summary = await runCrawlCycle({
      frontier,
      sourceResolver: async () => ({ status, requestedUrl: DETAILS, itemId: "book" }),
      fetchImpl: net.fetchImpl,
      allowPrivate: true,
      maxDepth: 2,
    });
    assert.equal(summary.sourceRejections[0]?.reason, expected, status);
    assert.equal(frontier.get(DETAILS).state, "rejected", status);
    assert.equal(frontier.get(DETAILS).lastError, expected, status);
    assert.equal(net.calls.length, 0, status);
  }
});

test("transient resolution failure defers the URL for retry", async (t) => {
  const frontier = await makeFrontier(t);
  await frontier.enqueue(DETAILS, { depth: 0 });
  const net = mockFetch();
  const summary = await runCrawlCycle({
    frontier,
    sourceResolver: async () => ({
      status: RESOLUTION_STATUS.RETRY,
      requestedUrl: DETAILS,
      itemId: "book",
      reason: "FETCH_TIMEOUT",
      error: "timed out",
    }),
    fetchImpl: net.fetchImpl,
    allowPrivate: true,
    maxDepth: 2,
  });
  assert.equal(summary.archiveResolutionRetries, 1);
  assert.equal(summary.archiveNonEnglish, 0);
  const record = frontier.get(DETAILS);
  assert.equal(record.state, "deferred");
  assert.match(record.lastError, /source-resolution/);
  assert.equal(net.calls.length, 0);
});

test("admission and robots operate on the resolved download target", async (t) => {
  const frontier = await makeFrontier(t);
  await frontier.enqueue(DETAILS, { depth: 0 });
  const net = mockFetch({
    [ROBOTS]: response({ headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }),
    [DOWNLOAD]: response({ headers: { "content-type": "text/plain" }, body: ENGLISH_TEXT }),
  });
  const admitted = [];
  const admissionGateway = {
    async authorize(args) {
      admitted.push(args);
      return {
        decision: "ADMITTED",
        compliance: "COMPLIANT",
        requestId: "req-1",
        payloadDigest: "digest-1",
        generation: args.generation,
        capEpoch: "test",
      };
    },
  };

  const summary = await runCrawlCycle({
    frontier,
    admissionGateway,
    sourceResolver: async () => ({
      status: RESOLUTION_STATUS.RESOLVED,
      requestedUrl: DETAILS,
      resolvedUrl: DOWNLOAD,
      itemId: "book",
      languages: ["eng"],
      cleanText: true,
    }),
    fetchImpl: net.fetchImpl,
    allowPrivate: true,
    maxDepth: 2,
  });

  assert.equal(summary.documents.length, 1);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].url, DOWNLOAD);
  assert.equal(net.calls[0], ROBOTS);
  assert.equal(net.calls[1], DOWNLOAD);
});
