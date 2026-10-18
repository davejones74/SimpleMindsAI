/**
 * Shared tokenization for the discovery query-derivation modules.
 *
 * One stopword list so mission-topic derivation (mission-queries.js) and
 * corpus-keyphrase derivation (keyphrases.js) agree on what a "content word" is.
 * Deterministic and dependency-free.
 */

// Standard English function words, plus mission-boilerplate adverbs/adjectives
// that describe HOW the mission is pursued rather than WHAT it is about.
export const STOPWORDS = new Set(
  (
    "a an the to of in on for and or nor but if then than that this these those is are was were be been being am do does did doing have has had having " +
    "it its as at by from into over under with without within about against between during before after above below up down out off again further once here there " +
    "all any both each few more most other some such no not only own same so too very can could may might must shall should will would i you he she they we me him her them us who whom which what when where why how " +
    "accurately seamlessly continually meaningfully ethically objectively culturally adaptively securely safely clearly simply fully truly deeply widely " +
    "aligned enable enables enabling enabled ensure ensures ensuring ensure remain remains remaining through across toward towards based"
  )
    .split(/\s+/)
    .filter(Boolean),
);
