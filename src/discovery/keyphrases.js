/**
 * Corpus → search-query derivation (P4 keyphrase generator, deterministic).
 *
 * The approved/reviewed corpus is the best evidence of what the system should
 * learn more about: the multi-word phrases that recur ACROSS many reviewed
 * articles are salient keyphrases worth querying for. This module extracts them
 * by document frequency — no LLM, no randomness — so the behaviour is
 * reproducible and cheap to reason about.
 *
 * Everything here is advisory: the derived queries only ever become candidate
 * URLs through the normal adapters, which the DiscoveryService filters through
 * the discovery policy and the domain registry like any other candidate.
 */

import { STOPWORDS } from "./tokens.js";

/** Content words in order, stopword-filtered but NOT de-duplicated (n-grams need adjacency). */
function contentWordsRaw(text) {
  const tokens = String(text ?? "")
    .toLowerCase()
    .match(/[a-z][a-z0-9'-]*/g);
  if (!tokens) return [];
  return tokens.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Extract salient keyphrases from a corpus of article texts.
 *
 * A keyphrase is a 2..`maxWords` word content-word n-gram that appears in at
 * least `minFreq` DISTINCT documents. Ranking is by document frequency
 * (descending), with first-seen order as the deterministic tie-break. Same
 * input ⇒ same output.
 *
 * @param {string|string[]} texts
 * @param {{max?: number, minFreq?: number, maxWords?: number}} [opts]
 * @returns {string[]}
 */
export function extractCorpusKeyphrases(texts, { max = 20, minFreq = 2, maxWords = 3 } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === "string" && t.trim());
  if (!list.length) return [];
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (!limit) return [];

  const docFreq = new Map(); // phrase -> number of distinct documents containing it
  const order = []; // first-seen order for deterministic tie-break
  for (const text of list) {
    const words = contentWordsRaw(text);
    const phrases = new Set();
    for (let n = Math.min(maxWords, words.length); n >= 2; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        phrases.add(words.slice(i, i + n).join(" "));
      }
    }
    for (const p of phrases) {
      if (!docFreq.has(p)) {
        docFreq.set(p, 0);
        order.push(p);
      }
      docFreq.set(p, docFreq.get(p) + 1);
    }
  }

  const floor = Number.isFinite(minFreq) ? minFreq : 1;
  const rank = new Map(order.map((p, idx) => [p, idx]));
  const candidates = order.filter((p) => docFreq.get(p) >= floor);
  candidates.sort((a, b) => (docFreq.get(b) - docFreq.get(a)) || (rank.get(a) - rank.get(b)));
  return candidates.slice(0, limit);
}

/**
 * Derive search queries from the reviewed corpus: the top keyphrases, used
 * directly as query strings. Deterministic; empty corpus ⇒ no queries.
 *
 * @param {string|string[]} texts
 * @param {{max?: number, minFreq?: number}} [opts]
 * @returns {string[]}
 */
export function deriveCorpusQueries(texts, { max = 20, minFreq = 2 } = {}) {
  return extractCorpusKeyphrases(texts, { max, minFreq });
}

/**
 * Concatenate query lists, de-duplicated, preserving order. Configured queries
 * (first argument) are never dropped.
 *
 * @param {...(string[]|undefined)} lists
 * @returns {string[]}
 */
export function combineQueries(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const q of list ?? []) {
      if (q && !seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }
  }
  return out;
}
