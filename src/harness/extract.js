/**
 * Document extraction — turn fetched HTML into the training text.
 *
 * Two modes, selected by `config.extractionMode`:
 *
 *   - "legacy" (DEFAULT): the original dependency-free tag-stripper in
 *     fetcher.js. Exactly the historical behaviour; zero new failure modes.
 *   - "readability": Mozilla Readability over jsdom, which isolates the main
 *     article and drops navigation/footer/boilerplate. This is a REVERSIBLE
 *     improvement: the deps are loaded with a dynamic `import()` so the app runs
 *     unchanged when they are absent, and ANY load/parse failure falls back to
 *     the legacy extractor rather than failing the fetch.
 *
 * Licences (verified before adoption): @mozilla/readability is Apache-2.0 and
 * jsdom is MIT — both permissive. Extraction must be compared against the legacy
 * output on representative fixtures before being enabled by default.
 */

import { htmlToText } from "./fetcher.js";

export const EXTRACTION_MODES = Object.freeze(["legacy", "readability"]);

// Readability can return a fragment for near-empty pages; below this many
// characters we prefer the legacy extraction, which never returns empty when
// there is any text at all.
const MIN_READABLE_CHARS = 200;

let depsPromise = null;
function loadReadability() {
  if (!depsPromise) {
    depsPromise = Promise.all([import("@mozilla/readability"), import("jsdom")]).then(([readability, jsdom]) => ({
      Readability: readability.Readability,
      JSDOM: jsdom.JSDOM,
    }));
  }
  return depsPromise;
}

function collapse(s) {
  return String(s ?? "")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.mode] - "legacy" | "readability"
 * @returns {Promise<{title: string|null, text: string}>}
 */
export async function extractDocument(html, { mode = "legacy" } = {}) {
  const legacy = htmlToText(html);
  if (mode !== "readability") {
    return { title: legacy.title, text: legacy.text, mode: "legacy", fallback: false, readableChars: legacy.text.length };
  }
  try {
    const { Readability, JSDOM } = await loadReadability();
    const dom = new JSDOM(String(html ?? ""), { url: "https://example.invalid/" });
    const article = new Readability(dom.window.document).parse();
    const text = collapse(article?.textContent ?? "");
    if (text.length >= MIN_READABLE_CHARS) {
      return {
        title: String(article.title ?? "").trim() || legacy.title,
        text,
        mode: "readability",
        fallback: false,
        readableChars: text.length,
      };
    }
  } catch {
    /* deps unavailable or parse failed — fall back to the legacy extractor */
  }
  return { title: legacy.title, text: legacy.text, mode: "readability", fallback: true, readableChars: legacy.text.length };
}
