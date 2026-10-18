/**
 * Discovery-time language prior (P4, locked decision #4).
 *
 * A URL that DECLARES a non-English content language in its host (a multilingual
 * source such as `ca.wikipedia.org`) is classified up front, before it is ever
 * fetched. This is an advisory/optional prior on DISCOVERY candidates — it is
 * deliberately a SEPARATE, independent backstop from the ingest-time language
 * filter (`config.languageFilter`), which still runs on the actual document text
 * and remains the authoritative gate.
 *
 *   off    : never consider the URL's declared language at discovery
 *   warn   : DEFAULT — enqueue, but count it so the operator sees the share of
 *            foreign-language candidates discovery is producing
 *   reject : refuse to enqueue candidates whose host declares a non-English
 *            language (English-variant hosts like `en.wikipedia.org` still pass)
 *
 * The prior reads only a DECLARATION (`languageFromUrl`), never the document
 * body, so it can never reject an English article that happens to live on a
 * foreign-language host — that is the ingest filter's and the review gate's job,
 * and they both inspect the actual text.
 */

import { languageFromUrl, LANG } from "../domain/language.js";

export const DISCOVERY_LANGUAGE_PRIORS = Object.freeze(["off", "warn", "reject"]);

/**
 * @param {string} url
 * @param {"off"|"warn"|"reject"} mode
 * @returns {{declaredLang: string|null, action: "allow"|"warn"|"reject"}}
 */
export function classifyDiscoveryLanguage(url, mode = "warn") {
  const declaredLang = languageFromUrl(url);
  if (!declaredLang || declaredLang === LANG.EN) {
    return { declaredLang, action: "allow" };
  }
  if (mode === "reject") return { declaredLang, action: "reject" };
  if (mode === "warn") return { declaredLang, action: "warn" };
  return { declaredLang, action: "allow" };
}
