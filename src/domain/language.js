/**
 * Deterministic, dependency-free language detection.
 *
 * Three stages:
 *   A. Script detection via Unicode code-point ranges. If non-Latin scripts
 *      exceed a threshold of alphabetic characters, classify immediately.
 *   B. Latin-script language heuristics via per-language stopword evidence.
 *   C. HTML <html lang> metadata as supplementary tie-break evidence only.
 *
 * Confidence is a heuristic score, NOT a statistical probability. It is high
 * when one language's stopwords dominate AND there is enough stopword evidence
 * to trust the signal.
 *
 * "und" means undetermined — the detector never forces a classification.
 */

export const LANG = Object.freeze({
  EN: "en",
  FR: "fr",
  DE: "de",
  ES: "es",
  NL: "nl",
  IT: "it",
  PT: "pt",
  UND: "und",
});

export const SCRIPT = Object.freeze({
  LATIN: "Latin",
  CYRILLIC: "Cyrl",
  ARABIC: "Arab",
  HEBREW: "Hebr",
  DEVANAGARI: "Deva",
  GREEK: "Grek",
  HAN: "Hani",
  HIRAGANA: "Hira",
  KATAKANA: "Kana",
  HANGUL: "Hang",
  THAI: "Thai",
  TAMIL: "Taml",
  TELUGU: "Telu",
  BENGALI: "Beng",
  GEORGIAN: "Geor",
  ARMENIAN: "Armn",
});

// Unicode code-point ranges for non-Latin scripts. Each entry is [start, end].
const NON_LATIN_RANGES = [
  [0x0400, 0x04ff], [0x0500, 0x052f], // Cyrillic
  [0x0600, 0x06ff], [0x0750, 0x077f], // Arabic
  [0x0590, 0x05ff],                     // Hebrew
  [0x0900, 0x097f],                     // Devanagari
  [0x0370, 0x03ff], [0x1f00, 0x1fff], // Greek
  [0x4e00, 0x9fff], [0x3400, 0x4dbf], // Han (CJK)
  [0x3040, 0x309f],                     // Hiragana
  [0x30a0, 0x30ff],                     // Katakana
  [0xac00, 0xd7af], [0x1100, 0x11ff], // Hangul
  [0x0e00, 0x0e7f],                     // Thai
  [0x0b80, 0x0bff],                     // Tamil
  [0x0c00, 0x0c7f],                     // Telugu
  [0x0980, 0x09ff],                     // Bengali
  [0x10a0, 0x10ff],                     // Georgian
  [0x0530, 0x058f],                     // Armenian
];

// Heuristic starting values — NOT calibrated accuracy guarantees.
const NON_LATIN_THRESHOLD = 0.30; // >30% non-Latin alpha chars => non-Latin
const ENGLISH_UPPER = 0.60;       // englishRatio >= this => English
const ENGLISH_LOWER = 0.40;       // englishRatio <= this => non-English
const MIN_ALPHA_CHARS = 20;       // fewer alphabetic chars => insufficient
const MIN_STOPWORD_HITS = 3;      // fewer stopword matches => insufficient
const MIN_STOPWORD_DENSITY = 0.02; // stopword hits / total words below => low-density

// Raw stopwords per language. After deduplication, each word belongs to at
// most one language so cross-language dilution cannot bias the ratio.
const RAW_STOPWORDS = {
  en: [
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
    "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing",
    "down", "during", "each", "few", "for", "from", "further", "had", "has",
    "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
    "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just",
    "like", "me", "more", "most", "my", "myself", "no", "nor", "not", "now", "of",
    "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out",
    "over", "own", "same", "she", "should", "so", "some", "such", "than", "that",
    "the", "their", "theirs", "them", "themselves", "then", "there", "these",
    "they", "this", "those", "through", "to", "too", "under", "until", "up",
    "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
    "whom", "why", "will", "with", "you", "your", "yours", "yourself", "yourselves",
  ],
  fr: [
    "alors", "au", "aucuns", "aussi", "autre", "avant", "avec", "avoir", "bon",
    "car", "ce", "cela", "ces", "ceux", "chaque", "ci", "comme", "comment",
    "dans", "des", "du", "dedans", "dehors", "depuis", "doit", "donc", "elle",
    "elles", "en", "encore", "est", "et", "eu", "fait", "faites", "fois", "font",
    "haut", "hors", "ici", "il", "ils", "je", "juste", "la", "le", "les", "leur",
    "leurs", "lui", "ma", "maintenant", "mais", "mes", "moins", "mon", "meme",
    "ni", "notre", "nous", "nouveaux", "ou", "par", "parce", "pas", "peut", "peu",
    "pour", "pourquoi", "quand", "que", "quel", "quelle", "quelles", "quels",
    "qui", "sa", "sans", "se", "ses", "seulement", "si", "son", "sont", "sous",
    "sur", "ta", "te", "tes", "toi", "ton", "tous", "tout", "trop", "tu", "un",
    "une", "voiture", "vont", "votre", "vous", "vu", "y", "etait", "etre",
  ],
  de: [
    "aber", "alle", "allem", "allen", "aller", "alles", "als", "also", "am", "an",
    "auch", "auf", "aus", "bei", "bin", "bis", "bist", "da", "damit", "dann",
    "das", "dass", "dazu", "dein", "deine", "dem", "den", "denn", "der", "des",
    "dich", "die", "dies", "diese", "diesem", "dieser", "dieses", "dir", "doch",
    "dort", "du", "durch", "ein", "eine", "einem", "einen", "einer", "eines",
    "er", "es", "euch", "euer", "fuer", "gegen", "gewesen", "hab", "habe",
    "haben", "hat", "hatte", "hatten", "hier", "hin", "hinter", "ich", "ihm",
    "ihnen", "ihr", "ihre", "im", "in", "indem", "ins", "ist", "jede", "jedem",
    "jeden", "jeder", "jedes", "jene", "jetzt", "kann", "kein", "keine", "koennen",
    "machen", "man", "mehr", "mein", "meine", "mit", "muss", "nach", "nicht",
    "nichts", "noch", "nun", "nur", "ob", "oder", "ohne", "sehr", "sein", "seine",
    "selbst", "sich", "sie", "sind", "so", "solche", "sollen", "sondern", "ueber",
    "und", "unser", "unsere", "unter", "vom", "von", "vor", "war", "waren",
    "warum", "was", "weiter", "wenn", "wer", "werde", "werden", "wie", "wieder",
    "will", "wir", "wird", "wirst", "wo", "wollen", "wollte", "wuerden", "zu",
    "zum", "zur", "zwar", "zwischen",
  ],
  es: [
    "a", "al", "algo", "algunas", "algunos", "ante", "antes", "como", "con",
    "contra", "cual", "cuando", "de", "del", "desde", "donde", "durante", "e",
    "el", "ella", "ellas", "ellos", "en", "entre", "era", "eran", "eres", "es",
    "esa", "esas", "ese", "eso", "esos", "esta", "estado", "estan", "este",
    "esto", "estos", "estoy", "ha", "habeis", "habia", "hasta", "hay", "la",
    "las", "le", "les", "lo", "los", "me", "mi", "mis", "mucho", "muy", "mas",
    "mi", "mio", "nada", "ni", "no", "nos", "nosotros", "nuestra", "o", "os",
    "otra", "otro", "para", "pero", "poco", "por", "porque", "que", "quien",
    "quienes", "sea", "se", "sean", "segun", "ser", "si", "sido", "siendo",
    "sin", "sobre", "sois", "somos", "son", "soy", "su", "sus", "tambien",
    "tanto", "te", "teneis", "tenemos", "tener", "tienes", "todo", "todos",
    "tu", "tus", "un", "una", "uno", "unos", "usted", "vosotros", "vuestra",
    "y", "ya", "yo", "el", "ella", "ello",
  ],
  nl: [
    "al", "alle", "alleen", "alles", "als", "andere", "ben", "bij", "daar",
    "dan", "dat", "de", "deze", "die", "dit", "doch", "door", "dus", "een",
    "eens", "en", "er", "ge", "geen", "haar", "had", "heb", "hebben", "heeft",
    "hem", "het", "hier", "hij", "hoe", "hun", "iemand", "iets", "ik", "in",
    "is", "ja", "je", "kan", "kon", "kunnen", "maar", "me", "meer", "men",
    "met", "mij", "mijn", "moet", "na", "naar", "niet", "niets", "nog", "nu",
    "of", "om", "omdat", "ons", "ook", "op", "over", "reeds", "te", "tegen",
    "toch", "tot", "u", "uit", "uw", "van", "veel", "voor", "want", "waren",
    "was", "wat", "we", "wel", "werd", "wie", "wij", "wil", "worden", "zal",
    "ze", "zei", "zelf", "zich", "zij", "zijn", "zo", "zonder", "zou",
  ],
  it: [
    "a", "abbia", "abbiamo", "abbiano", "abbiate", "ad", "adesso", "agli",
    "ai", "al", "all", "alla", "alle", "allo", "allora", "altri", "altro",
    "anche", "ancora", "avere", "aveva", "avevano", "avevate", "avevi",
    "avevo", "avete", "aveva", "avrà", "avuta", "avute", "avuti", "avuto",
    "basta", "bene", "che", "chi", "chiunque", "ci", "ciascuno", "cioè",
    "come", "con", "contro", "cui", "da", "dagli", "dai", "dal", "dall",
    "dalla", "dalle", "dallo", "del", "della", "delle", "dello", "di", "dove",
    "dovunque", "durante", "e", "ebbe", "ebbero", "ebbi", "ed", "era",
    "erano", "eravamo", "eravate", "eri", "ero", "essere", "fa", "fai",
    "fanno", "fare", "fatto", "fece", "fecero", "fin", "fra", "fu", "furono",
    "gli", "gliela", "gliele", "glieli", "glielo", "gliene", "ha", "hai",
    "hanno", "ho", "i", "il", "in", "infatti", "inoltre", "invece", "io", "l",
    "la", "le", "lei", "li", "lo", "loro", "lui", "ma", "mentre", "mi",
    "molto", "ne", "né", "noi", "non", "nostra", "nostre", "nostri", "nostro",
    "o", "ora", "per", "perché", "più", "quando", "quindi", "se", "senza",
    "si", "sia", "siamo", "siano", "siate", "siete", "sono", "su", "sua",
    "sue", "suoi", "suo", "te", "ti", "tra", "tu", "tua", "tue", "tuo",
    "tuoi", "tutti", "tutto", "un", "una", "uno", "vi", "voi", "vostra",
    "vostre", "vostri", "vostro",
  ],
  pt: [
    "a", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo", "as",
    "até", "com", "como", "da", "das", "de", "dela", "delas", "dele", "deles",
    "depois", "do", "dos", "e", "ela", "elas", "ele", "eles", "em", "entre",
    "era", "eram", "essa", "essas", "esse", "esses", "esta", "estar",
    "estamos", "estavam", "este", "estes", "eu", "foi", "fomos", "for",
    "foram", "ha", "isso", "isto", "já", "lhe", "lhes", "mais", "mas", "me",
    "mesmo", "meu", "meus", "minha", "minhas", "muito", "na", "nas", "nem",
    "no", "nos", "nossa", "nossas", "nosso", "nossos", "num", "numa", "o",
    "os", "ou", "para", "pela", "pelas", "pelo", "pelos", "por", "qual",
    "quando", "que", "quem", "se", "sem", "ser", "seu", "seus", "só", "também",
    "te", "tem", "têm", "ter", "teu", "teus", "tu", "tua", "tuas", "um",
    "uma", "umas", "uns", "você", "vocês", "vos",
  ],
};

// Build deduplicated stopword sets: each word belongs to exactly ONE language
// so the englishRatio is not diluted by cross-language function-word overlap.
function buildStopwordIndex() {
  const langOf = new Map(); // word -> language
  for (const [lang, words] of Object.entries(RAW_STOPWORDS)) {
    for (const w of new Set(words)) {
      langOf.set(w, lang); // last write wins; we re-validate below
    }
  }
  // Count how many languages claim each word.
  const claimCount = new Map();
  for (const [lang, words] of Object.entries(RAW_STOPWORDS)) {
    for (const w of new Set(words)) {
      claimCount.set(w, (claimCount.get(w) ?? 0) + 1);
    }
  }
  const index = Object.fromEntries(
    Object.keys(RAW_STOPWORDS).map((lang) => [lang, new Set()]),
  );
  for (const [lang, words] of Object.entries(RAW_STOPWORDS)) {
    for (const w of new Set(words)) {
      if (claimCount.get(w) === 1) index[lang].add(w);
    }
  }
  return index;
}

const STOPWORDS = buildStopwordIndex();

// Set views of the RAW (non-deduplicated) stopword lists, used for the raw
// evidence tally. Values in RAW_STOPWORDS are arrays; membership needs Sets.
const RAW_INDEX = Object.fromEntries(
  Object.entries(RAW_STOPWORDS).map(([lang, words]) => [lang, new Set(words)]),
);

// Languages whose script is Latin and that we attempt to distinguish.
const LATIN_CANDIDATES = Object.freeze([...Object.keys(STOPWORDS)]);

/** Classify each alphabetic character's script. Returns counts per script group. */
function classifyScripts(text) {
  const counts = Object.create(null);
  let alpha = 0;
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (!isAlphabetic(cp)) continue;
    alpha += 1;
    const script = scriptForCodePoint(cp);
    if (script) counts[script] = (counts[script] ?? 0) + 1;
  }
  return { counts, alpha };
}

function isAlphabetic(cp) {
  // Latin letters (incl. extended), plus a broad "other alphabetic" fallback
  // for scripts not explicitly listed. We only need to distinguish Latin vs
  // non-Latin, so any non-Latin lettering counts as non-Latin.
  if (cp >= 0x0041 && cp <= 0x007a) return true; // Basic Latin
  if (cp >= 0x00c0 && cp <= 0x024f) return true; // Latin Extended-A/B
  if (cp >= 0x1e00 && cp <= 0x1eff) return true; // Latin Extended Additional
  // Everything else: treat as alphabetic if it's a letter category. We use a
  // conservative surrogate range check for the non-Latin scripts we know;
  // anything outside Latin ranges is treated as non-Latin alpha.
  return isNonLatinAlphabetic(cp);
}

function isNonLatinAlphabetic(cp) {
  for (const [start, end] of NON_LATIN_RANGES) {
    if (cp >= start && cp <= end) return true;
  }
  return false;
}

function scriptForCodePoint(cp) {
  if (cp >= 0x0041 && cp <= 0x007a) return SCRIPT.LATIN;
  if (cp >= 0x00c0 && cp <= 0x024f) return SCRIPT.LATIN;
  if (cp >= 0x1e00 && cp <= 0x1eff) return SCRIPT.LATIN;
  for (const [start, end] of NON_LATIN_RANGES) {
    if (cp >= start && cp <= end) return scriptNameForRange(cp);
  }
  return null;
}

function scriptNameForRange(cp) {
  if (cp >= 0x0400 && cp <= 0x052f) return SCRIPT.CYRILLIC;
  if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f)) return SCRIPT.ARABIC;
  if (cp >= 0x0590 && cp <= 0x05ff) return SCRIPT.HEBREW;
  if (cp >= 0x0900 && cp <= 0x097f) return SCRIPT.DEVANAGARI;
  if ((cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff)) return SCRIPT.GREEK;
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) return SCRIPT.HAN;
  if (cp >= 0x3040 && cp <= 0x309f) return SCRIPT.HIRAGANA;
  if (cp >= 0x30a0 && cp <= 0x30ff) return SCRIPT.KATAKANA;
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) return SCRIPT.HANGUL;
  if (cp >= 0x0e00 && cp <= 0x0e7f) return SCRIPT.THAI;
  if (cp >= 0x0b80 && cp <= 0x0bff) return SCRIPT.TAMIL;
  if (cp >= 0x0c00 && cp <= 0x0c7f) return SCRIPT.TELUGU;
  if (cp >= 0x0980 && cp <= 0x09ff) return SCRIPT.BENGALI;
  if (cp >= 0x10a0 && cp <= 0x10ff) return SCRIPT.GEORGIAN;
  if (cp >= 0x0530 && cp <= 0x058f) return SCRIPT.ARMENIAN;
  return null;
}

/** Tokenize to lowercase Latin-script word tokens. */
function tokenize(text) {
  return String(text ?? "").toLowerCase().match(/[a-z0-9\u00c0-\u024f']+/g) ?? [];
}

/**
 * Count stopword hits per language across a token stream.
 *
 * Two tallies are kept:
 *   raw       — every stopword occurrence, including words shared across
 *               languages. This measures how much function-word EVIDENCE exists.
 *   exclusive — only words that belong to a single language (see
 *               buildStopwordIndex). This is used for the English RATIO, so a
 *               word shared with other languages cannot inflate the English
 *               share of a foreign-language text.
 *
 * The split matters for the confidence score: Romance languages share most of
 * their function words, so an exclusive-only tally would starve a clearly
 * French/Spanish page of evidence and leave it confusable with "unknown".
 */
function countStopwordHits(tokens) {
  const raw = Object.create(null);
  const exclusive = Object.create(null);
  let rawTotal = 0;
  let exclusiveTotal = 0;
  for (const token of tokens) {
    for (const lang of LATIN_CANDIDATES) {
      if (RAW_INDEX[lang].has(token)) {
        raw[lang] = (raw[lang] ?? 0) + 1;
        rawTotal += 1;
      }
      if (STOPWORDS[lang].has(token)) {
        exclusive[lang] = (exclusive[lang] ?? 0) + 1;
        exclusiveTotal += 1;
      }
    }
  }
  return { raw, rawTotal, exclusive, exclusiveTotal };
}

/** Saturating evidence score: 0 hits -> 0, grows toward 1 with ~10 hits. */
function evidenceScore(hits) {
  return 1 - Math.exp(-hits / 10);
}

/**
 * Normalise an HTML lang tag to an ISO 639-1 primary subtag.
 * "en-US" => "en", "en-GB" => "en", "pt-BR" => "pt", "fr" => "fr".
 * Returns null for empty or malformed tags.
 */
export function normalizeLangTag(tag) {
  const raw = String(tag ?? "").trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  return primary;
}

function detectLatinLanguage(tokens, htmlLang) {
  const { raw, rawTotal, exclusive, exclusiveTotal } = countStopwordHits(tokens);
  const wordCount = tokens.length;

  // Evidence must exist at all — either tally suffices here.
  if (rawTotal < MIN_STOPWORD_HITS) {
    return { language: LANG.UND, confidence: 0, reason: "insufficient-evidence", englishRatio: null };
  }
  if (wordCount < MIN_ALPHA_CHARS) {
    return { language: LANG.UND, confidence: 0, reason: "insufficient-evidence", englishRatio: null };
  }

  const density = rawTotal / Math.max(1, wordCount);
  if (density < MIN_STOPWORD_DENSITY) {
    return { language: LANG.UND, confidence: 0, reason: "low-density", englishRatio: null };
  }

  // English RATIO uses exclusive (single-language) counts so a word shared with
  // French/Spanish/etc. cannot prop up the English share of a foreign page.
  // When NO exclusive evidence exists at all, the text sits squarely in the
  // ambiguous band by definition.
  const englishRatio = exclusiveTotal > 0
    ? (exclusive[LANG.EN] ?? 0) / exclusiveTotal
    : 0.5;

  // Plurality language is decided on EXCLUSIVE counts — the only evidence that
  // actually distinguishes these Latin-script languages from one another.
  let bestLang = LANG.UND;
  let bestHits = 0;
  for (const lang of LATIN_CANDIDATES) {
    if ((exclusive[lang] ?? 0) > bestHits) {
      bestHits = exclusive[lang] ?? 0;
      bestLang = lang;
    }
  }

  // Confidence saturation is measured on RAW evidence: how much function-word
  // material supports the decision. Shared words are genuine evidence, so a
  // French page is not declared "unknown" merely for using "le"/"de"/"que".
  const enEvidence = evidenceScore(raw[LANG.EN] ?? 0);
  const pluralityEvidence = evidenceScore(bestHits > 0 ? (raw[bestLang] ?? 0) : 0);

  if (englishRatio >= ENGLISH_UPPER) {
    return {
      language: LANG.EN,
      confidence: englishRatio * enEvidence,
      reason: "english",
      englishRatio,
    };
  }

  if (englishRatio <= ENGLISH_LOWER && bestLang !== LANG.UND) {
    return {
      language: bestLang,
      confidence: (1 - englishRatio) * pluralityEvidence,
      reason: "non-english",
      englishRatio,
    };
  }

  // Ambiguous / mixed-language region. HTML lang may break the tie, but only
  // when the textual evidence itself is NOT strong (which it isn't here, since
  // we're between the boundaries). Strong text evidence always wins; HTML never
  // forces a classification when the text is insufficient.
  if (htmlLang) {
    if (htmlLang === LANG.EN) {
      return {
        language: LANG.EN,
        confidence: englishRatio * enEvidence,
        reason: "html-tiebreak",
        englishRatio,
      };
    }
    if (STOPWORDS[htmlLang]) {
      return {
        language: htmlLang,
        confidence: (1 - englishRatio) * evidenceScore(raw[htmlLang] ?? 0),
        reason: "html-tiebreak",
        englishRatio,
      };
    }
  }

  return { language: LANG.UND, confidence: 0, reason: "mixed-language", englishRatio };
}

/**
 * Detect the language of a text.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string|null} [options.htmlLang] - supplementary <html lang> hint
 * @returns {{language: string, script: string|null, confidence: number,
 *   reason: string, englishRatio: number|null, htmlLang: string|null}}
 */
export function detectLanguage(text, { htmlLang = null } = {}) {
  const normalizedHtmlLang = normalizeLangTag(htmlLang);

  const { counts, alpha } = classifyScripts(text);

  if (alpha === 0) {
    return {
      language: LANG.UND,
      script: null,
      confidence: 0,
      reason: "insufficient-evidence",
      englishRatio: null,
      htmlLang: normalizedHtmlLang,
    };
  }

  let nonLatin = 0;
  let nonLatinScript = null;
  for (const [script, count] of Object.entries(counts)) {
    if (script === SCRIPT.LATIN) continue;
    nonLatin += count;
    if (!nonLatinScript || count > (counts[nonLatinScript] ?? 0)) nonLatinScript = script;
  }

  const nonLatinRatio = nonLatin / alpha;
  if (nonLatinRatio > NON_LATIN_THRESHOLD) {
    return {
      language: LANG.UND,
      script: nonLatinScript,
      confidence: 0.95,
      reason: "non-latin-script",
      englishRatio: null,
      htmlLang: normalizedHtmlLang,
    };
  }

  const tokens = tokenize(text);
  const result = detectLatinLanguage(tokens, normalizedHtmlLang);
  return {
    language: result.language,
    script: SCRIPT.LATIN,
    confidence: result.confidence,
    reason: result.reason,
    englishRatio: result.englishRatio,
    htmlLang: normalizedHtmlLang,
  };
}

/**
 * True only when the detector is confident the text is English.
 * "Unknown" or low-confidence text never passes as English.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.minConfidence=0.80]
 * @param {string|null} [options.htmlLang]
 */
export function isEnglish(text, { minConfidence = 0.80, htmlLang = null } = {}) {
  const result = detectLanguage(text, { htmlLang });
  return result.language === LANG.EN && result.confidence >= minConfidence;
}

/**
 * Assess a text for the language filter. Shared by both the harvest and
 * ingestion seams so they apply identical rules.
 *
 * @returns {{verdict: "english"|"non-english"|"unknown", detection: object}}
 */
export function assess(text, { minConfidence = 0.80, htmlLang = null } = {}) {
  const detection = detectLanguage(text, { htmlLang });
  if (detection.language === LANG.EN && detection.confidence >= minConfidence) {
    return { verdict: "english", detection };
  }
  // Stage-A script evidence is decisive: a page that is >30% non-Latin script
  // is confidently NOT English, even though its ISO language stays "und". The
  // fail-open "unknown" policy must not rescue it.
  if (detection.reason === "non-latin-script" && detection.confidence >= minConfidence) {
    return { verdict: "non-english", detection };
  }
  if (detection.language !== LANG.UND && detection.confidence >= minConfidence) {
    return { verdict: "non-english", detection };
  }
  return { verdict: "unknown", detection };
}
