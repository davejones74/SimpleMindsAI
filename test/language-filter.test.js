import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { runCrawlBatches, collectDocuments } from "../src/harness/crawler.js";
import { extractHtmlLang, fetchDocument } from "../src/harness/fetcher.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENGLISH_HTML_BODY =
  "The steam engine converted thermal energy into mechanical work, and it did so " +
  "because pressure was allowed to act on a piston inside a cylinder. When the valve " +
  "opened, steam that had been heated in the boiler pushed the piston, and the motion " +
  "was then transferred to a wheel through a connecting rod. Engineers of the era were " +
  "concerned that the apparatus would waste fuel, but the improvements that followed " +
  "were remarkable, and efficiency climbed steadily over the following decades.";

const FRENCH_HTML_BODY =
  "Le moteur à vapeur transformait l'énergie thermique en énergie mécanique, et il le " +
  "faisait parce que la pression était appliquée sur un piston à l'intérieur d'un " +
  "cylindre. Quand la valve s'ouvrait, la vapeur qui avait été chauffée dans la chaudière " +
  "poussait le piston, et le mouvement était ensuite transmis à une roue par une bielle. " +
  "Les ingénieurs de l'époque craignaient que l'appareil ne gaspille du carburant, mais " +
  "les améliorations qui ont suivi ont été remarquables.";

const NON_LATIN_BODY =
  "В конце концов, всё меняется, и мы должны учиться жить в новом мире, где старые " +
  "правила больше не работают. Каждый день приносит новые открытия и новые вопросы, " +
  "и только терпение помогает нам двигаться вперёд.";

// A page whose declared <html lang> is WRONG: it claims English but the body is
// French. Strong textual evidence must win (the page is excluded).
const WRONG_META_BODY = FRENCH_HTML_BODY;

let server;
let base;

function englishPage(extraLink = "") {
  return `<html lang="en"><head><title>English</title></head><body><p>${ENGLISH_HTML_BODY}</p>${extraLink}</body></html>`;
}
function frenchPage(extraLink = "") {
  return `<html lang="fr"><head><title>Français</title></head><body><p>${FRENCH_HTML_BODY}</p>${extraLink}</body></html>`;
}
function nonLatinPage() {
  return `<html><head><title>Doc</title></head><body><p>${NON_LATIN_BODY}</p></body></html>`;
}
function wrongMetaPage() {
  return `<html lang="en"><head><title>Claims English</title></head><body><p>${WRONG_META_BODY}</p></body></html>`;
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const origin = `http://${req.headers.host}`;
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    const html = {
      "/english": () => englishPage(`<a href="${origin}/english-child">child</a>`),
      "/english-child": () => englishPage(),
      "/french": () => frenchPage(`<a href="${origin}/english-from-french">child</a>`),
      "/english-from-french": () => englishPage(),
      "/nonlatin": () => nonLatinPage(),
      "/wrong-meta": () => wrongMetaPage(),
    }[url.pathname];
    if (html) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html());
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

function freshFrontier() {
  return new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-lang-frontier-")) });
}

const ENFORCED = Object.freeze({ enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "allow" });

// ---------------------------------------------------------------------------
// fetcher: HTML language metadata extraction
// ---------------------------------------------------------------------------

test("extractHtmlLang reads <html lang> and meta content-language, and never guesses", () => {
  assert.equal(extractHtmlLang('<html lang="en"><body>x</body></html>'), "en");
  assert.equal(extractHtmlLang("<html lang='fr-CA'>x</html>"), "fr-CA");
  assert.equal(extractHtmlLang('<html><head><meta http-equiv="content-language" content="de"></head></html>'), "de");
  assert.equal(extractHtmlLang("<html><body>no metadata here</body></html>"), null);
  assert.equal(extractHtmlLang(""), null);
});

// ---------------------------------------------------------------------------
// Harvest seam — enforcement
// ---------------------------------------------------------------------------

test("harvest seam excludes non-English pages without counting them as failures", async () => {
  const frontier = freshFrontier();
  await frontier.init();
  await frontier.enqueue(`${base}/english`);
  await frontier.enqueue(`${base}/french`);

  const res = await runCrawlBatches({
    frontier,
    allowPrivate: true,
    maxCycles: 6,
    maxDepth: 2,
    languageFilter: ENFORCED,
  });

  const urls = res.documents.map((d) => new URL(d.url).pathname);
  assert.ok(urls.includes("/english"), "English page must be ingested");
  assert.ok(!urls.includes("/french"), `French page must be excluded, got ${urls.join(",")}`);

  // A language skip is NOT a fetch failure and NOT an error.
  assert.equal(res.failures.length, 0, "language skips must not appear as failures");
  assert.ok(res.languageFiltered >= 1, "languageFiltered counter must reflect the exclusion");
  const skipped = res.skipped.find((s) => s.url.endsWith("/french"));
  assert.ok(skipped, "skipped[] must record the excluded French URL");
  assert.equal(skipped.reason, "non-english");
  assert.equal(skipped.language, "fr");
});

test("a foreign page still yields its links and domains (filter runs AFTER discovery)", async () => {
  const frontier = freshFrontier();
  await frontier.init();
  await frontier.enqueue(`${base}/french`);

  const res = await runCrawlBatches({
    frontier,
    allowPrivate: true,
    maxCycles: 6,
    maxDepth: 2,
    languageFilter: ENFORCED,
  });

  // The French parent was excluded...
  assert.ok(res.skipped.some((s) => s.url.endsWith("/french")));
  // ...but its English child was still discovered and fetched.
  const urls = res.documents.map((d) => new URL(d.url).pathname);
  assert.ok(
    urls.includes("/english-from-french"),
    `link discovered on a foreign page must still be followed, got ${urls.join(",")}`,
  );
  assert.ok(res.discovered.some((d) => d.accepted && d.url.endsWith("/english-from-french")));
});

test("non-Latin script pages are excluded", async () => {
  const frontier = freshFrontier();
  await frontier.init();
  await frontier.enqueue(`${base}/nonlatin`);
  const res = await runCrawlBatches({ frontier, allowPrivate: true, maxCycles: 3, maxDepth: 1, languageFilter: ENFORCED });
  assert.equal(res.documents.length, 0);
  const skipped = res.skipped.find((s) => s.url.endsWith("/nonlatin"));
  assert.ok(skipped);
  assert.equal(skipped.reason, "non-english");
});

test("wrong <html lang> metadata cannot smuggle a non-English page in", async () => {
  const frontier = freshFrontier();
  await frontier.init();
  await frontier.enqueue(`${base}/wrong-meta`);
  const res = await runCrawlBatches({ frontier, allowPrivate: true, maxCycles: 3, maxDepth: 1, languageFilter: ENFORCED });
  assert.equal(res.documents.length, 0, "text evidence must override a lying lang attribute");
  assert.ok(res.skipped.some((s) => s.url.endsWith("/wrong-meta")));
});

// ---------------------------------------------------------------------------
// Shadow mode and disabled mode
// ---------------------------------------------------------------------------

test("shadow mode reports would-be exclusions but changes nothing", async () => {
  const frontier = freshFrontier();
  await frontier.init();
  await frontier.enqueue(`${base}/french`);

  const res = await runCrawlBatches({
    frontier,
    allowPrivate: true,
    maxCycles: 6,
    maxDepth: 2,
    languageFilter: { ...ENFORCED, shadow: true },
  });

  const urls = res.documents.map((d) => new URL(d.url).pathname);
  assert.ok(urls.includes("/french"), "shadow mode must still ingest the page");
  assert.equal(res.languageFiltered, 0);
  assert.equal(res.skipped.length, 0);
  const shadow = res.shadowRejected.find((s) => s.url.endsWith("/french"));
  assert.ok(shadow, "shadow mode must record the would-be exclusion");
  assert.equal(shadow.verdict, "non-english");
});

test("disabled / absent filter preserves existing behaviour exactly", async () => {
  for (const languageFilter of [null, { enabled: false, shadow: false, minConfidence: 0.8, unknownPolicy: "allow" }]) {
    const frontier = freshFrontier();
    await frontier.init();
    await frontier.enqueue(`${base}/french`);
    const res = await runCrawlBatches({ frontier, allowPrivate: true, maxCycles: 3, maxDepth: 1, languageFilter });
    const urls = res.documents.map((d) => new URL(d.url).pathname);
    assert.ok(urls.includes("/french"), `filter ${JSON.stringify(languageFilter)} must not exclude`);
    assert.equal(res.languageFiltered, 0);
    assert.equal(res.skipped.length, 0);
  }
});

// ---------------------------------------------------------------------------
// collectDocuments (direct-fetch path) — same rules
// ---------------------------------------------------------------------------

test("collectDocuments honours the filter without inventing failures", async () => {
  const excluded = await collectDocuments({
    mode: "real",
    urls: [`${base}/french`, `${base}/nonlatin`],
    allowPrivate: true,
    languageFilter: ENFORCED,
    fetchImpl: fetch,
  });
  assert.equal(excluded.documents.length, 0);
  assert.equal(excluded.failures.length, 0, "a language skip is not a fetch failure");
  assert.equal(excluded.languageFiltered, 2);
  assert.ok(excluded.skipped.some((s) => s.url.endsWith("/french")));
});

test("confident English is never excluded, even under unknownPolicy=reject", async () => {
  const res = await collectDocuments({
    mode: "real",
    urls: [`${base}/english`],
    allowPrivate: true,
    languageFilter: { ...ENFORCED, unknownPolicy: "reject" },
    fetchImpl: fetch,
  });
  assert.equal(res.documents.length, 1);
  assert.equal(res.languageFiltered, 0);
});

// ---------------------------------------------------------------------------
// Ingestion backstop — the guarantee against bypass
// ---------------------------------------------------------------------------

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-lang-store-")));

test("ArticleStore backstop refuses non-English text and records no article", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: ENFORCED });
  const r = await store.ingestArticle({ text: FRENCH_HTML_BODY, domain: "general" });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "non-english");
  assert.equal(r.articleId, undefined);
  assert.equal(store.getStats().totalArticles, 0, "a skipped doc must not become an article");
  assert.equal(store.getStats().languageSkipped, 1);
  await store.close();
});

test("ArticleStore backstop accepts English and non-Latin is refused", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: ENFORCED });
  const en = await store.ingestArticle({ text: ENGLISH_HTML_BODY, domain: "general" });
  assert.equal(en.skipped, undefined);
  assert.ok(en.articleId);
  const ru = await store.ingestArticle({ text: NON_LATIN_BODY, domain: "general" });
  assert.equal(ru.skipped, true);
  assert.equal(store.getStats().totalArticles, 1);
  await store.close();
});

test("backstop is a no-op when the filter is disabled or absent", async () => {
  for (const languageFilter of [null, { enabled: false, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" }]) {
    const store = await ArticleStore.open(tmp(), { languageFilter });
    const r = await store.ingestArticle({ text: NON_LATIN_BODY, domain: "general" });
    assert.ok(r.articleId, `disabled filter (${JSON.stringify(languageFilter)}) must ingest`);
    assert.equal(store.getStats().totalArticles, 1);
    await store.close();
  }
});

test("store opened without options inherits the configured backstop (wiring guard)", async () => {
  // Regression guard: server.js / cli/perpetual.js open the store with no
  // languageFilter argument, so the backstop must resolve from config. If a
  // future caller forgets to thread the policy through, this catches it.
  const prior = { ...config.languageFilter };
  Object.assign(config.languageFilter, ENFORCED);
  try {
    const store = await ArticleStore.open(tmp());
    const r = await store.ingestArticle({ text: FRENCH_HTML_BODY, domain: "general" });
    assert.equal(r.skipped, true, "configured-but-unpassed filter must still exclude");
    assert.equal(r.reason, "non-english");
    assert.equal(store.getStats().totalArticles, 0);
    await store.close();
  } finally {
    Object.assign(config.languageFilter, prior);
  }
});

test("backstop unknown policy: fail-open passes, reject excludes", async () => {
  const unknownText = "404 — not found. 12345 ???";
  const allow = await ArticleStore.open(tmp(), { languageFilter: ENFORCED });
  const a = await allow.ingestArticle({ text: unknownText, domain: "general" });
  assert.ok(a.articleId, "unknown text passes under allow (default)");
  await allow.close();

  const reject = await ArticleStore.open(tmp(), { languageFilter: { ...ENFORCED, unknownPolicy: "reject" } });
  const b = await reject.ingestArticle({ text: unknownText, domain: "general" });
  assert.equal(b.skipped, true);
  assert.equal(b.reason, "unknown-language");
  await reject.close();
});

test("shadow backstop ingests and annotates without writing extra record fields", async () => {
  const store = await ArticleStore.open(tmp(), { languageFilter: { ...ENFORCED, shadow: true } });
  const r = await store.ingestArticle({ text: FRENCH_HTML_BODY, domain: "general" });
  assert.ok(r.articleId, "shadow mode must still ingest");
  assert.equal(r.languageVerdict?.verdict, "non-english");
  // The persisted record itself must not carry the shadow annotation.
  const persisted = store.getArticle(r.articleId);
  assert.equal(persisted.languageVerdict, undefined);
  await store.close();
});

// ---------------------------------------------------------------------------
// fetchDocument exposes htmlLang
// ---------------------------------------------------------------------------

test("fetchDocument surfaces the declared HTML language for the detector", async () => {
  const doc = await fetchDocument(`${base}/french`, { allowPrivate: true });
  assert.equal(doc.htmlLang, "fr");
  const en = await fetchDocument(`${base}/english`, { allowPrivate: true });
  assert.equal(en.htmlLang, "en");
});
