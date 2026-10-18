import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, assess, isEnglish, normalizeLangTag, languageFromUrl } from "../src/domain/language.js";

// ---------------------------------------------------------------------------
// Script detection (Stage A)
// ---------------------------------------------------------------------------

test("non-Latin scripts are classified immediately with high confidence", () => {
  const cyr = detectLanguage("В конце концов, всё меняется, и мы должны учиться жить в новом мире.");
  assert.equal(cyr.reason, "non-latin-script");
  assert.equal(cyr.language, "und");
  assert.equal(cyr.script, "Cyrl");
  assert.ok(cyr.confidence >= 0.9);

  const ara = detectLanguage("في نهاية المطاف، تتغير كل شيء ويجب أن نتعلم كيف نعيش في عالم جديد.");
  assert.equal(ara.reason, "non-latin-script");
  assert.equal(ara.script, "Arab");

  const han = detectLanguage("最后，一切都改变了，我们必须学会在新的世界里生活。");
  assert.equal(han.reason, "non-latin-script");
  assert.equal(han.script, "Hani");
});

test("mostly-Latin text with a few accented characters stays on the Latin path", () => {
  const r = detectLanguage(
    "The café opened near the naïve architect's résumé and the clientele loved it very much indeed.",
  );
  assert.equal(r.script, "Latin");
  assert.notEqual(r.reason, "non-latin-script");
});

test("Japanese text (Han + kana) is non-Latin script and rejected, never claimed as a CJK language", () => {
  const jp = "蒸気機関は蒸気の圧力を利用してピストンを動かす熱機関です。これは産業革命を支えました。";
  const d = detectLanguage(jp);
  assert.equal(d.reason, "non-latin-script");
  // Han is shared by Chinese/Japanese/Korean, so the script stage deliberately
  // leaves the ISO language "und" rather than mislabel it zh/ja/ko.
  assert.equal(d.language, "und");
  assert.equal(d.script, "Hani");
  assert.equal(assess(jp).verdict, "non-english");
});

test("English text with an embedded CJK term stays Latin and is never rejected by script alone", () => {
  const mixed =
    "The steam engine is a heat engine that performs mechanical work using steam as its working fluid. " +
    "In Chinese it is called 蒸汽机, and it pushed the piston with steam pressure inside a cylinder to turn a wheel.";
  const d = detectLanguage(mixed);
  assert.equal(d.script, "Latin", "a few Han characters must not flip the script classification");
  assert.equal(d.language, "en");
  assert.equal(d.reason, "english");
  assert.notEqual(assess(mixed).verdict, "non-english", "embedded CJK must never reject English prose");
});

test("empty and digit-only text is insufficient evidence, never a language", () => {
  for (const input of ["", "   ", "12345 67890 !!! ???", "🙂🙂🙂"]) {
    const r = detectLanguage(input);
    assert.equal(r.language, "und");
    assert.equal(r.reason, "insufficient-evidence");
    assert.equal(r.confidence, 0);
  }
});

// ---------------------------------------------------------------------------
// English detection (Stage B)
// ---------------------------------------------------------------------------

const ENGLISH_PROSE =
  "The steam engine converted thermal energy into mechanical work, and it did so " +
  "because pressure was allowed to act on a piston inside a cylinder. When the valve " +
  "opened, steam that had been heated in the boiler pushed the piston, and the motion " +
  "was then transferred to a wheel through a connecting rod. Engineers of the era were " +
  "concerned that the apparatus would waste fuel, but the improvements that followed " +
  "were remarkable, and efficiency climbed steadily over the following decades.";

// A shorter English sample used to build deliberately BALANCED mixtures: paired
// with the French passage below it lands inside the ambiguous band
// (englishRatio between 0.4 and 0.6), which is the only region where HTML lang
// is permitted to break the tie.
const MIXED_ENGLISH =
  "The steam engine converted thermal energy into mechanical work, and it did so " +
  "because pressure was allowed to act on a piston inside a cylinder. " +
  "When the valve opened, the piston moved.";

const FRENCH_PROSE =
  "Le moteur à vapeur transformait l'énergie thermique en énergie mécanique, et il le " +
  "faisait parce que la pression était appliquée sur un piston à l'intérieur d'un " +
  "cylindre. Quand la valve s'ouvrait, la vapeur qui avait été chauffée dans la chaudière " +
  "poussait le piston, et le mouvement était ensuite transmis à une roue par une bielle. " +
  "Les ingénieurs de l'époque craignaient que l'appareil ne gaspille du carburant, mais " +
  "les améliorations qui ont suivi ont été remarquables.";

const GERMAN_PROSE =
  "Die Dampfmaschine verwandelte thermische Energie in mechanische Arbeit, und das " +
  "geschah, weil der Druck auf einen Kolben im Zylinder wirkte. Wenn das Ventil sich " +
  "öffnete, schob der Dampf, der im Kessel erhitzt worden war, den Kolben, und die " +
  "Bewegung wurde dann über eine Pleuelstange auf ein Rad übertragen. Die Ingenieure " +
  "jener Zeit fürchteten, dass die Vorlage Brennstoff verschwenden würde, doch die " +
  "Verbesserungen, die folgten, waren bemerkenswert.";

test("clear English prose is detected as English with usable confidence", () => {
  const d = detectLanguage(ENGLISH_PROSE);
  assert.equal(d.language, "en");
  assert.equal(d.reason, "english");
  assert.ok(d.confidence >= 0.6, `confidence ${d.confidence} too low for clear English`);
  assert.ok(d.englishRatio >= 0.6, `englishRatio ${d.englishRatio} should be >= 0.6`);
  assert.equal(assess(ENGLISH_PROSE).verdict, "english");
});

test("clear French and German prose are detected as their own language", () => {
  const fr = detectLanguage(FRENCH_PROSE);
  assert.equal(fr.language, "fr");
  assert.equal(fr.reason, "non-english");
  assert.equal(assess(FRENCH_PROSE).verdict, "non-english");

  const de = detectLanguage(GERMAN_PROSE);
  assert.equal(de.language, "de");
  assert.equal(assess(GERMAN_PROSE).verdict, "non-english");
});

test("English technical documentation with low stopword density is unknown, not non-English", () => {
  // Code-like / spec-like English: mostly terms, identifiers and numbers.
  const technical =
    "GET /v1/articles/{articleId} 200 OK — returns articleId, contentHash, status, " +
    "importance, category, sourceDomain, createdAt, updatedAt. Rate limit: 600 " +
    "requests / 10 min window. Retry-After header present on 429. Token budget " +
    "128000; context window truncation begins past 100000 tokens. Latency p99 " +
    "142 ms. Null response when articleId not found.";
  const d = detectLanguage(technical);
  assert.notEqual(d.language, "fr");
  assert.notEqual(d.language, "de");
  // The important property: it must NEVER be confidently non-English.
  const verdict = assess(technical).verdict;
  assert.notEqual(verdict, "non-english", `technical English must not be excluded, got ${verdict}`);
  assert.equal(isEnglish(technical), verdict === "english");
});

test("too little text yields unknown even if every word is an English stopword", () => {
  const d = detectLanguage("the and of");
  assert.equal(d.language, "und");
  assert.equal(d.reason, "insufficient-evidence");
  assert.equal(assess("the and of").verdict, "unknown");
});

// ---------------------------------------------------------------------------
// Mixed language
// ---------------------------------------------------------------------------

test("mixed-language sentences are unknown, not silently assigned to either side", () => {
  const mixed = `${MIXED_ENGLISH} ${FRENCH_PROSE}`;
  const d = detectLanguage(mixed);
  // A genuinely balanced mixture must not be confidently classified either way.
  assert.equal(d.language, "und");
  assert.equal(d.reason, "mixed-language");
  assert.equal(assess(mixed).verdict, "unknown");
});

// ---------------------------------------------------------------------------
// HTML lang metadata (Stage C) — supplementary only
// ---------------------------------------------------------------------------

test("wrong html lang cannot override strong textual evidence", () => {
  // Page claims Russian but the body is English.
  const en = detectLanguage(ENGLISH_PROSE, { htmlLang: "ru" });
  assert.equal(en.language, "en");
  assert.equal(en.reason, "english");

  // Page claims English but the body is German.
  const de = detectLanguage(GERMAN_PROSE, { htmlLang: "en" });
  assert.equal(de.language, "de");
  assert.equal(de.reason, "non-english");
});

test("html lang never forces a classification when the text itself is insufficient", () => {
  const r = detectLanguage("404 — not found. 12345", { htmlLang: "en" });
  assert.equal(r.language, "und");
  assert.equal(r.reason, "insufficient-evidence");
  assert.equal(assess("404 — not found. 12345", { htmlLang: "en" }).verdict, "unknown");
});

test("html lang only breaks the tie inside the ambiguous mixed band", () => {
  // Balanced mixture sits between 0.4 and 0.6 — the only region HTML may decide.
  const balanced = `${MIXED_ENGLISH} ${FRENCH_PROSE}`;
  const withoutHint = detectLanguage(balanced);
  assert.equal(withoutHint.language, "und");
  assert.equal(withoutHint.reason, "mixed-language");
  const withEnHint = detectLanguage(balanced, { htmlLang: "en" });
  assert.equal(withEnHint.reason, "html-tiebreak");
  assert.equal(withEnHint.language, "en");
});

// ---------------------------------------------------------------------------
// Regional tags and normalization
// ---------------------------------------------------------------------------

test("regional lang tags normalize to their primary subtag", () => {
  assert.equal(normalizeLangTag("en-US"), "en");
  assert.equal(normalizeLangTag("en-GB"), "en");
  assert.equal(normalizeLangTag("pt-BR"), "pt");
  assert.equal(normalizeLangTag("fr"), "fr");
  assert.equal(normalizeLangTag("EN_us"), "en");
  assert.equal(normalizeLangTag(""), null);
  assert.equal(normalizeLangTag(null), null);
  assert.equal(normalizeLangTag("!!!"), null);
});

test("regional html lang hints are usable as tie-breakers", () => {
  const balanced = `${MIXED_ENGLISH} ${FRENCH_PROSE}`;
  const r = detectLanguage(balanced, { htmlLang: "pt-BR" });
  assert.equal(r.language, "pt");
  assert.equal(r.reason, "html-tiebreak");
});

// ---------------------------------------------------------------------------
// Determinism and threshold behaviour
// ---------------------------------------------------------------------------

test("detection is deterministic across repeated calls", () => {
  const inputs = [ENGLISH_PROSE, FRENCH_PROSE, GERMAN_PROSE, "12345", "тест текст", ""];
  for (const input of inputs) {
    const a = JSON.stringify(detectLanguage(input, { htmlLang: "en" }));
    const b = JSON.stringify(detectLanguage(input, { htmlLang: "en" }));
    assert.equal(a, b);
  }
});

test("minConfidence gates the verdict, not just the language label", () => {
  const d = detectLanguage(ENGLISH_PROSE);
  assert.equal(d.language, "en");
  // Impossible threshold: confidently English text still cannot pass the gate.
  const strict = assess(ENGLISH_PROSE, { minConfidence: 1.1 });
  assert.notEqual(strict.verdict, "english");
  // Below the detector's own confidence: normal gate passes.
  const normal = assess(ENGLISH_PROSE, { minConfidence: 0.8 });
  assert.equal(normal.verdict, "english");
});

test("isEnglish is conservative: unknown is never English", () => {
  assert.equal(isEnglish("только кириллица здесь для проверки"), false);
  assert.equal(isEnglish(""), false);
  assert.equal(isEnglish(ENGLISH_PROSE), true);
});

// ---------------------------------------------------------------------------
// Source-declared language: multilingual host subdomains
// ---------------------------------------------------------------------------

test("languageFromUrl reads the language a multilingual source declares in its host", () => {
  assert.equal(languageFromUrl("https://ca.wikipedia.org/wiki/Rellotge"), "ca");
  assert.equal(languageFromUrl("https://de.wikipedia.org/wiki/Wasserrad"), "de");
  assert.equal(languageFromUrl("https://en.wikipedia.org/wiki/1986"), "en");
  assert.equal(languageFromUrl("fr.wiktionary.org/wiki/mot"), "fr");
  assert.equal(languageFromUrl("https://zh-min-nan.wikipedia.org/wiki/"), "zh");
  // The English alias used by Wikipedia.
  assert.equal(languageFromUrl("https://simple.wikipedia.org/wiki/Engine"), "en");
});

test("languageFromUrl returns null when the host encodes no content language", () => {
  for (const url of [
    null,
    "",
    "not a url",
    "https://example.com/article",
    "https://www.wikipedia.org/",
    "https://commons.wikimedia.org/wiki/File:X",
    "https://meta.wikimedia.org/",
    "https://en.wikipedia.org.evil.example/x",
  ]) {
    assert.equal(languageFromUrl(url), null, `expected null for ${JSON.stringify(url)}`);
  }
});

test("assess treats a declared non-English source as decisive for otherwise-unknown text", () => {
  const short = "Qués el premi Nobel de Literatura de 1986?\n\nWole Soyinka";
  assert.equal(assess(short).verdict, "unknown");
  assert.equal(assess(short, { sourceUrl: "https://ca.wikipedia.org/wiki/1986" }).verdict, "non-english");
  assert.equal(assess(short, { htmlLang: "de" }).verdict, "non-english");
});

test("a wrong non-English declaration cannot override confidently English prose", () => {
  const d = assess(ENGLISH_PROSE, { sourceUrl: "https://ru.wikipedia.org/wiki/Engine" });
  assert.equal(d.verdict, "english");
});

test("a declaration never turns insufficient or ambiguous text into English", () => {
  assert.equal(assess("404 — not found. 12345", { sourceUrl: "https://en.wikipedia.org/"}).verdict, "unknown");
});
