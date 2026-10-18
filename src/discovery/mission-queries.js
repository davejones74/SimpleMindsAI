/**
 * Mission → search-query derivation (P4, deterministic templates — NO model).
 *
 * The mission statement is the north star for autonomous acquisition. As a
 * deliberate first step, queries are derived from it by DETERMINISTIC TEMPLATES
 * over the mission's topic words — no LLM, no randomness — so the behaviour is
 * reproducible and cheap to reason about. A model-assisted derivation can come
 * later behind the same seam.
 *
 * Everything here is advisory: the derived queries only ever become candidate
 * URLs through the normal adapters, which the DiscoveryService filters through
 * the discovery policy and the domain registry like any other candidate. A bad
 * or empty derivation therefore degrades to "no extra candidates", never to an
 * unsafe fetch.
 */

/** Query shapes applied to each extracted topic, most specific first. */
export const MISSION_QUERY_TEMPLATES = Object.freeze([
  "{topic}",
  "{topic} explained",
  "{topic} history",
  "how {topic} works",
]);

// Standard English function words, plus mission-boilerplate adverbs/adjectives
// that describe HOW the mission is pursued rather than WHAT it is about. Filtering
// the boilerplate keeps derived topics on-subject (e.g. "human language" rather
// than "accurately"). All lowercase.
const STOPWORDS = new Set(
  (
    "a an the to of in on for and or nor but if then than that this these those is are was were be been being am do does did doing have has had having " +
    "it its as at by from into over under with without within about against between during before after above below up down out off again further once here there " +
    "all any both each few more most other some such no not only own same so too very can could may might must shall should will would i you he she they we me him her them us who whom which what when where why how " +
    "accurately seamlessly continually meaningfully ethically objectively culturally adaptively securely safely clearly simply fully truly deeply widely " +
    "aligned enable enables enabling enabled ensure ensures ensuring ensuring remain remains remaining through across toward towards based"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Content words (lowercased, length >= 3, not stopwords/numbers) in order. */
function contentWords(text) {
  const tokens = String(text ?? "")
    .toLowerCase()
    .match(/[a-z][a-z0-9'-]*/g);
  if (!tokens) return [];
  const seen = new Set();
  const out = [];
  for (const w of tokens) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    if (seen.has(w)) continue; // de-duplicate repeated words inside one text
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Topics for one mission text: adjacent BIGRAMS first (more specific), then words. */
function extractTopics(text) {
  const words = contentWords(text);
  const topics = [];
  const seen = new Set();
  const push = (t) => {
    const k = t.trim();
    if (k.length >= 3 && !seen.has(k)) {
      seen.add(k);
      topics.push(k);
    }
  };
  for (let i = 0; i + 1 < words.length; i++) push(`${words[i]} ${words[i + 1]}`);
  for (const w of words) push(w);
  return topics;
}

/**
 * Deterministically derive up to `max` search queries from one or more mission
 * statements. Same input ⇒ same output.
 *
 * @param {string|string[]} missionTexts
 * @param {{max?: number, templates?: readonly string[]}} [opts]
 * @returns {string[]}
 */
export function deriveMissionQueries(missionTexts, { max = 8, templates = MISSION_QUERY_TEMPLATES } = {}) {
  const texts = (Array.isArray(missionTexts) ? missionTexts : [missionTexts]).filter(
    (t) => typeof t === "string" && t.trim(),
  );
  if (!texts.length) return [];
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (!limit) return [];

  const topics = texts.flatMap(extractTopics);
  const out = [];
  const seen = new Set();
  outer: for (const topic of topics) {
    for (const tpl of templates) {
      if (out.length >= limit) break outer;
      const q = String(tpl).replace("{topic}", topic).trim();
      if (q && !seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }
  }
  return out;
}

/**
 * The EFFECTIVE search-query list. Configured queries come first and are never
 * dropped; when mission queries are enabled, derived queries are appended
 * (de-duplicated) up to `max` derived entries. Flag OFF ⇒ configured list only.
 *
 * @param {{configured?: string[], missionTexts?: string|string[], enabled?: boolean, max?: number}} [opts]
 * @returns {string[]}
 */
export function resolveSearchQueries({ configured = [], missionTexts = [], enabled = false, max } = {}) {
  const base = [...configured];
  if (!enabled) return base;
  const seen = new Set(base);
  for (const q of deriveMissionQueries(missionTexts, { max })) {
    if (!seen.has(q)) {
      seen.add(q);
      base.push(q);
    }
  }
  return base;
}
