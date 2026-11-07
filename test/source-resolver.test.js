import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESOLUTION_STATUS,
  archiveDownloadUrl,
  archiveOrgItemId,
  classifyArchiveLanguage,
  cleanArchiveOrgText,
  createArchiveOrgResolver,
  isArchiveOrgItemUrl,
  selectArchiveTextFile,
} from "../src/discovery/source-resolver.js";

function metadata(body) {
  return JSON.stringify(body);
}

function fakeFetchText(result) {
  const calls = [];
  const fetchText = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (typeof result === "function") return result(url, opts, calls);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, fetchText };
}

test("archive.org item URLs are parsed but direct downloads are not item pages", () => {
  assert.equal(archiveOrgItemId("https://archive.org/details/nicolaicopernici00cope_1/page/n383/mode/2up"), "nicolaicopernici00cope_1");
  assert.equal(archiveOrgItemId("https://www.archive.org/details/example"), "example");
  assert.equal(archiveOrgItemId("https://archive.org/download/example/example_djvu.txt"), null);
  assert.equal(isArchiveOrgItemUrl("https://archive.org/details/example"), true);
  assert.equal(isArchiveOrgItemUrl("https://example.com/details/x"), false);
});

test("language classification is English-only and conservative for mixed/unknown", () => {
  assert.equal(classifyArchiveLanguage("eng").status, "english");
  assert.equal(classifyArchiveLanguage(["English"]).status, "english");
  assert.equal(classifyArchiveLanguage("lat").status, "non-english");
  assert.equal(classifyArchiveLanguage(["eng", "lat"]).status, "mixed");
  assert.equal(classifyArchiveLanguage(null).status, "unknown");
});

test("text file selection prefers DjVuTXT and ignores restricted/binary files", () => {
  const file = selectArchiveTextFile(
    [
      { name: "book.pdf", format: "Text PDF", size: 1000 },
      { name: "book_djvu.xml", format: "Djvu XML", size: 900 },
      { name: "book_djvu.txt", format: "DjVuTXT", size: 500 },
      { name: "other.txt", format: "Text", size: 700 },
      { name: "private_djvu.txt", format: "DjVuTXT", private: true, size: 900 },
    ],
    "book",
  );
  assert.equal(file.name, "book_djvu.txt");
  assert.equal(archiveDownloadUrl("book", "a b/c.txt"), "https://archive.org/download/book/a%20b/c.txt");
});

test("English metadata resolves to the OCR download URL", async () => {
  const { calls, fetchText } = fakeFetchText(
    metadata({
      metadata: { language: "eng" },
      files: [{ name: "book_djvu.txt", format: "DjVuTXT", size: 100 }],
    }),
  );
  const resolve = createArchiveOrgResolver({ fetchText });
  const result = await resolve("https://archive.org/details/book/page/n1/mode/2up");
  assert.equal(result.status, RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.resolvedUrl, "https://archive.org/download/book/book_djvu.txt");
  assert.equal(result.itemId, "book");
  assert.equal(result.cleanText, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://archive.org/metadata/book");
  assert.equal(calls[0].opts.allowJson, true);
});

test("non-English metadata is rejected before any text download", async () => {
  const { calls, fetchText } = fakeFetchText(
    metadata({
      metadata: { language: "lat" },
      files: [{ name: "book_djvu.txt", format: "DjVuTXT", size: 100 }],
    }),
  );
  const resolve = createArchiveOrgResolver({ fetchText });
  const result = await resolve("https://archive.org/details/book");
  assert.equal(result.status, RESOLUTION_STATUS.NON_ENGLISH);
  assert.equal(result.reason, "non-english-language");
  assert.equal(calls.length, 1, "only metadata is fetched");
});

test("missing or mixed language is unverified, never silently resolved", async () => {
  const missing = fakeFetchText(metadata({ metadata: {}, files: [{ name: "book_djvu.txt", format: "DjVuTXT" }] }));
  const mixed = fakeFetchText(metadata({ metadata: { language: ["eng", "lat"] }, files: [{ name: "book_djvu.txt", format: "DjVuTXT" }] }));
  assert.equal(
    (await createArchiveOrgResolver({ fetchText: missing.fetchText })("https://archive.org/details/book")).status,
    RESOLUTION_STATUS.UNVERIFIED_LANGUAGE,
  );
  assert.equal(
    (await createArchiveOrgResolver({ fetchText: mixed.fetchText })("https://archive.org/details/book")).status,
    RESOLUTION_STATUS.UNVERIFIED_LANGUAGE,
  );
});

test("no text file and restricted items are terminal non-content outcomes", async () => {
  const noText = fakeFetchText(metadata({ metadata: { language: "eng" }, files: [{ name: "book.pdf", format: "Text PDF" }] }));
  const restricted = fakeFetchText(metadata({ metadata: { language: "eng", "access-restricted-item": true }, files: [{ name: "book_djvu.txt", format: "DjVuTXT" }] }));
  assert.equal(
    (await createArchiveOrgResolver({ fetchText: noText.fetchText })("https://archive.org/details/book")).status,
    RESOLUTION_STATUS.NO_FULLTEXT,
  );
  assert.equal(
    (await createArchiveOrgResolver({ fetchText: restricted.fetchText })("https://archive.org/details/book")).status,
    RESOLUTION_STATUS.RESTRICTED,
  );
});

test("transient metadata failures are retryable; invalid metadata is not", async () => {
  const timeout = Object.assign(new Error("slow"), { code: "FETCH_TIMEOUT" });
  const retry = await createArchiveOrgResolver({ fetchText: fakeFetchText(timeout).fetchText })("https://archive.org/details/book");
  assert.equal(retry.status, RESOLUTION_STATUS.RETRY);
  const invalid = await createArchiveOrgResolver({ fetchText: fakeFetchText("not json").fetchText })("https://archive.org/details/book");
  assert.equal(invalid.status, RESOLUTION_STATUS.NO_FULLTEXT);
});

test("non-archive URLs are not applicable", async () => {
  const { calls, fetchText } = fakeFetchText(metadata({}));
  const result = await createArchiveOrgResolver({ fetchText })("https://example.com/article");
  assert.equal(result.status, RESOLUTION_STATUS.NOT_APPLICABLE);
  assert.equal(calls.length, 0);
});

test("cleanArchiveOrgText removes only the archive.org digitisation notice", () => {
  const text = `Digitized by the Internet Archive
in 2016 with funding from
Boston Public Library
https://archive.org/details/book

DE REVOLUTIONIBUS
Liber primus.`;
  const cleaned = cleanArchiveOrgText(text);
  assert.equal(cleaned, "DE REVOLUTIONIBUS\nLiber primus.");
  assert.equal(cleanArchiveOrgText("A normal article about identifiers and scanners."), "A normal article about identifiers and scanners.");
});
