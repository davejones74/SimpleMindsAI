import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../src/harness/fetcher.js";
import { extractDocument } from "../src/harness/extract.js";

/**
 * P3 — reversible, feature-gated extraction.
 *
 * `EXTRACTION_MODE=readability` isolates the main article; `legacy` (the
 * default) is the original tag-stripper. Extraction must never fail a fetch:
 * an absent dependency or a parse failure falls back to legacy.
 */

const PARAS = [
  "The steam engine converted thermal energy into mechanical work because pressure acted on a piston inside a cylinder.",
  "When the valve opened, steam that had been heated in the boiler pushed the piston, and the motion was transferred to a wheel through a connecting rod.",
  "Engineers of the era were concerned that the apparatus would waste fuel, but the improvements that followed were remarkable and they changed industry.",
  "Newcomen built the first practical engine in 1712, and Watt's separate condenser later made the engine dramatically more efficient and widely adopted.",
  "The consequences reached far beyond the mine and the mill, reshaping transport, cities, and the economy of the following century.",
];

const HTML = `<!doctype html><html lang="en"><head><title>Steam Power</title></head><body>
<nav>Home About Contact Privacy Sitemap Login Subscribe</nav>
<article>
<h1>Steam Power</h1>
${PARAS.map((p) => `<p>${p}</p>`).join("\n")}
</article>
<footer>Copyright 2026 Example Inc. All rights reserved. Terms of Service.</footer>
<script>console.log('tracking pixel')</script>
</body></html>`;

test("legacy extraction (default) strips tags and keeps the body", async () => {
  const out = await extractDocument(HTML, { mode: "legacy" });
  assert.ok(out.text.includes("steam engine"), out.text.slice(0, 120));
  assert.ok(!out.text.includes("<p>"));
  // htmlToText is the reference legacy implementation.
  assert.equal(out.text, htmlToText(HTML).text);
});

test("readability extraction returns the article body and drops chrome", async () => {
  const out = await extractDocument(HTML, { mode: "readability" });
  assert.ok(out.text.includes("steam engine"), out.text.slice(0, 200));
  assert.ok(!/Privacy Sitemap Login/.test(out.text), "nav chrome should be removed");
  assert.ok(!/All rights reserved/.test(out.text), "footer chrome should be removed");
});

test("extraction is reversible: an unrecognised mode falls back to legacy", async () => {
  const out = await extractDocument(HTML, { mode: "not-a-mode" });
  assert.equal(out.text, htmlToText(HTML).text);
});

test("readability falls back to legacy for a near-empty document", async () => {
  const tiny = "<html><body><article><p>Hi.</p></article></body></html>";
  const out = await extractDocument(tiny, { mode: "readability" });
  assert.equal(out.text, htmlToText(tiny).text, "below the readable threshold, legacy output is used");
});
