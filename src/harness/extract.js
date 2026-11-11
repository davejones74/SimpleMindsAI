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


const NAV_LINE = /^(jump to content|skip to content|main menu|navigation|contents|appearance|personal tools|search|donate|create account|log in|sign in|tools|what links here|related changes|upload file|special pages|permanent link|page information|cite this page|printable version|download as pdf|wikidata item|main page|random article|about wikipedia|contact us|help|learn to edit|community portal|recent changes|file upload|upload file|special pages|prif ddewislen|llywio|chwilio|offer personol|gwedd|rhoi|creu cyfrif|mewngofnodi|cynnwys|neidio i'r cynnwys)\s*$/i;
const REFERENCE_LINE = /(retrieved from|archived from|isbn\b|doi:|issn\b|oclc\b|\bpp?\.\s*\d|\bvol\.\s*\d|\bcategories?:|\bexternal links?\b|\bfurther reading\b|\bbibliography\b|\breferences?\b)/i;
const REFERENCE_HEADING = /^(references?|bibliography|external links?|see also|further reading|notes|citations?|sources?)$/i;

/**
 * Remove the residual mediawiki/document chrome that Readability sometimes
 * leaves in place, and drop reference/bibliography tails. This runs only on the
 * readability path; the legacy extractor remains byte-compatible.
 */
export function stripExtractedBoilerplate(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      kept.push("");
      continue;
    }
    if (NAV_LINE.test(line)) continue;
    // Wayback/CounterPunch-style archive and subscription chrome.
    if (/^The Wayback Machine\b/i.test(line)) continue;
    if (/^(subscribe now!?|get .* by email|click here to make a donation|remember contributions are tax-deductible|please support this website|if you find our site useful|today's stories)/i.test(line)) continue;
    if (/^what you.re missing/i.test(line)) continue;
    if (/^https?:\/\/web\.archive\.org\/web\//i.test(line)) continue;
    if (REFERENCE_HEADING.test(line.replace(/\[\s*edit\s*\]/gi, "").trim())) {
      // Reference tails are overwhelmingly at the end; do not truncate a real
      // article merely because it mentions "References" mid-prose.
      const rest = lines.slice(i + 1).filter((l) => l.trim());
      const restRefs = rest.filter((l) => REFERENCE_LINE.test(l)).length;
      if (rest.length === 0 || restRefs / Math.max(1, rest.length) >= 0.25) break;
    }
    if (REFERENCE_LINE.test(line) && line.length < 500) continue;
    kept.push(line.replace(/\s*\[\s*edit\s*\]\s*/gi, " ").replace(/\s+/g, " ").trim());
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
    const text = stripExtractedBoilerplate(collapse(article?.textContent ?? ""));
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
