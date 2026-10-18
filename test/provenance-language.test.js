import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { runCrawlBatches } from "../src/harness/crawler.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { Curator } from "../src/services/curator.js";
import { loadEvaluationSet } from "../src/dataset/evaluation-set.js";

/**
 * Phase 0 regression suite: provenance propagation + language-decision integrity.
 *
 * These tests fail against the pre-Phase-0 code and are the acceptance gate for
 * the provenance/backstop fix. They are deliberately independent of each other
 * (see the plan's refinement #1): rolling back one behaviour must not require
 * weakening another.
 *
 * Provenance rule under test: an article's declared source (URL) and declared
 * language (`<html lang>`) must survive EVERY ingest route — the frontier
 * harvest, the durable article record, and the curator's GraphQL path — because
 * the deterministic language backstop and the audit ledger both depend on it.
 * A DECLARED foreign source is decisive ONLY when the body text is not
 * confidently English: a translated-to-English unit from a foreign source is
 * valid training material and must still ingest.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-prov-")));

const ENFORCED = Object.freeze({ enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "allow" });
const DISABLED = Object.freeze({ enabled: false, shadow: false, minConfidence: 0.8, unknownPolicy: "allow" });

const ENGLISH =
  "The steam engine converted thermal energy into mechanical work, and it did so " +
  "because pressure was allowed to act on a piston inside a cylinder. When the valve " +
  "opened, steam that had been heated in the boiler pushed the piston, and the motion " +
  "was then transferred to a wheel through a connecting rod. Engineers of the era were " +
  "concerned that the apparatus would waste fuel, but the improvements that followed " +
  "were remarkable, and efficiency climbed steadily over the following decades.";

// Short, ambiguous by itself (would be "unknown" fail-open), but the host declares
// a non-English content language.
const DUTCH_SHORT = "De stoommachine zet warmte om in beweging en dat veranderde de wereld.";

// ---------------------------------------------------------------------------
// 1. Harvest seam retains htmlLang for the frontier/learning path
// ---------------------------------------------------------------------------

test("frontier harvest retains the declared htmlLang on raw docs", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html lang="fr"><head><title>Français</title></head><body><p>${ENGLISH}</p></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const frontier = new Frontier({ dir: tmp() });
    await frontier.init();
    await frontier.enqueue(`${base}/page`);
    // No language filter here: we assert the RAW DOCUMENT's provenance survives.
    const res = await runCrawlBatches({ frontier, allowPrivate: true, maxCycles: 2, maxDepth: 0 });
    assert.equal(res.documents.length, 1, JSON.stringify(res.documents));
    assert.equal(res.documents[0].htmlLang, "fr", "normalizeRawDoc must not drop the declared htmlLang");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// 2. The durable article record keeps provenance (sourceUrl AND htmlLang)
// ---------------------------------------------------------------------------

test("ArticleStore persists htmlLang provenance when supplied", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: DISABLED });
  const r = await store.ingestArticle({
    text: ENGLISH,
    domain: "general",
    sourceUrl: "https://en.wikipedia.org/wiki/Steam_engine",
    htmlLang: "en",
  });
  assert.ok(r.articleId);
  const persisted = store.getArticle(r.articleId);
  assert.equal(persisted.sourceUrl, "https://en.wikipedia.org/wiki/Steam_engine");
  assert.equal(persisted.htmlLang, "en", "htmlLang must be auditable, not silently dropped");
  await store.close();
});

test("ArticleStore omits provenance fields exactly when they were not supplied", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: DISABLED });
  const r = await store.ingestArticle({ text: ENGLISH, domain: "general" });
  const persisted = store.getArticle(r.articleId);
  assert.equal("sourceUrl" in persisted, false);
  assert.equal("htmlLang" in persisted, false);
  await store.close();
});

// ---------------------------------------------------------------------------
// 3. The backstop honours the DECLARED language, and never rejects a translation
// ---------------------------------------------------------------------------

test("backstop refuses ambiguous text when the sourceUrl declares a foreign language", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: ENFORCED });
  const r = await store.ingestArticle({ text: DUTCH_SHORT, domain: "general", sourceUrl: "https://nl.wikipedia.org/wiki/Stoommachine" });
  assert.equal(r.skipped, true, JSON.stringify(r));
  assert.equal(r.reason, "non-english");
  assert.equal(store.getStats().totalArticles, 0);
  await store.close();
});

test("backstop refuses ambiguous text when htmlLang declares a foreign language", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: ENFORCED });
  const r = await store.ingestArticle({ text: DUTCH_SHORT, domain: "general", htmlLang: "nl" });
  assert.equal(r.skipped, true, JSON.stringify(r));
  assert.equal(r.reason, "non-english");
  await store.close();
});

test("a declared foreign source with confidently-English text still ingests (translation is allowed)", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: ENFORCED });
  const r = await store.ingestArticle({
    text: ENGLISH,
    domain: "general",
    sourceUrl: "https://af.wikipedia.org/wiki/Stoommasjien",
    htmlLang: "af",
  });
  assert.ok(r.articleId, "translated English from a foreign source must not be auto-rejected");
  await store.close();
});

// ---------------------------------------------------------------------------
// 4. The curator forwards provenance into the ledger on every route
// ---------------------------------------------------------------------------

test("Curator.ingestArticleText forwards sourceUrl and htmlLang to GraphQL", async () => {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return { json: async () => ({ data: { ingestArticle: { articleId: "art_x" } } }) };
  };
  try {
    const curator = new Curator();
    const r = await curator.ingestArticleText({
      text: "hello",
      domain: "general",
      source: "af.wikipedia.org",
      rawText: "raw",
      sourceUrl: "https://af.wikipedia.org/wiki/Stoommasjien",
      htmlLang: "af",
    });
    assert.equal(captured.variables.input.sourceUrl, "https://af.wikipedia.org/wiki/Stoommasjien");
    assert.equal(captured.variables.input.htmlLang, "af");
    assert.equal(r.articleId, "art_x");
  } finally {
    globalThis.fetch = original;
  }
});

test("Curator.processRaw forwards provenance to every cleaned unit", async () => {
  const curator = new Curator({ ollama: { clean: async () => [{ text: "unit one", domain: "general" }] } });
  const calls = [];
  curator.ingestArticleText = async (args) => {
    calls.push(args);
    return { articleId: "art_y" };
  };
  await curator.processRaw("raw blob", {
    source: "af.wikipedia.org",
    sourceUrl: "https://af.wikipedia.org/wiki/Stoommasjien",
    htmlLang: "af",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceUrl, "https://af.wikipedia.org/wiki/Stoommasjien");
  assert.equal(calls[0].htmlLang, "af");
});

// ---------------------------------------------------------------------------
// 5. Evaluation-set integrity: eval-002 is broad enough to be a stable baseline
// ---------------------------------------------------------------------------

test("eval-002 is a valid, large, provenance-carrying corpus (one-block defect resolved)", async () => {
  const set = await loadEvaluationSet({ dir: tmp(), datasetId: "eval-002" });
  assert.equal(set.manifest.source, "bundled");
  assert.ok(set.size >= 50, `expected a broad baseline, got ${set.size}`);
  assert.ok(set.estimatedTokens >= 20000, `expected a large token estimate, got ${set.estimatedTokens}`);
  // The whole point of adopting eval-002 at seq-len 128: many scored blocks,
  // not the single 32-token block that made eval-001 a coin flip.
  assert.ok(
    Math.floor(set.estimatedTokens / 128) >= 100,
    `eval-002 must form many blocks at seq-len 128, got ~${Math.floor(set.estimatedTokens / 128)}`,
  );
  // Frozen identity — a drift here means scores are no longer comparable.
  assert.equal(set.datasetVersion, "69e276fcfb84");
  assert.ok(set.domains.history > 0 && set.domains.science > 0);
  assert.deepEqual(set.warnings, []);
  // Provenance: every row is a real en.wikipedia document with a domain.
  assert.ok(set.items.every((r) => typeof r.text === "string" && r.text.length > 0));
  assert.ok(set.items.every((r) => String(r.sourceUrl ?? "").includes("wikipedia.org")));
});
