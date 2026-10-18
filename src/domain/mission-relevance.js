/**
 * Advisory mission relevance (P4, locked decision #5).
 *
 * A deterministic, dependency-free lexical score measuring how much an article's
 * vocabulary overlaps the mission statement(s). It is ADVISORY ONLY:
 *
 *   - it is never a rejection rule (a low score never blocks ingestion, review,
 *     training or promotion);
 *   - its only use is a POSITIVE review-selection signal (review-policy.js) and
 *     an observability field on the article record;
 *   - it returns null when there is no mission to score against, so "no signal"
 *     and "irrelevant" are never conflated.
 *
 * The score is overlap / distinct-mission-words, clamped to [0,1], over content
 * words (stopwords removed, de-duplicated). It is deliberately cheap and crude:
 * it is a hint, not a classifier.
 */

const STOPWORDS = new Set(
  (
    "a an the to of in on for and or nor but if then than that this these those is are was were be been being am do does did doing have has had having " +
    "it its as at by from into over under with without within about against between during before after above below up down out off again further once here there " +
    "all any both each few more most other some such no not only own same so too very can could may might must shall should will would i you he she they we me him her them us who whom which what when where why how " +
    "into toward towards across based through upon while since until because"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Distinct content words (lowercased, stopword-filtered, length >= 3). */
function words(text) {
  const seen = new Set();
  const out = [];
  for (const w of String(text ?? "").toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? []) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/**
 * @param {string} text - the article text to score
 * @param {string|string[]} missionTexts - one or more mission statements
 * @returns {number|null} a score in [0,1], or null when there is no mission signal
 */
export function scoreMissionRelevance(text, missionTexts) {
  const texts = (Array.isArray(missionTexts) ? missionTexts : [missionTexts]).filter(
    (t) => typeof t === "string" && t.trim(),
  );
  if (!texts.length) return null;
  const missionWords = new Set(texts.flatMap(words));
  if (!missionWords.size) return null;
  const textWords = new Set(words(text));
  if (!textWords.size) return 0;
  let hit = 0;
  for (const w of missionWords) if (textWords.has(w)) hit++;
  return hit / missionWords.size;
}
