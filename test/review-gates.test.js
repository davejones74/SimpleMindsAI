import { test } from "node:test";
import assert from "node:assert/strict";
import { preScreen, mojibakeRatio, heuristicPenalty, GATE } from "../src/domain/review-gates.js";

/**
 * P3 — review-time quality gates (deterministic, dependency-free).
 *
 * The ingest seam already refuses non-English pages, but a curator (teacher
 * model) can still emit a non-English or corrupted unit, or a caller can bypass
 * the crawler. The review pipeline is therefore the LAST line of defence: a
 * text that reaches review must not be APPROVED merely because the LLM critic
 * is language-blind. These gates run BEFORE the critic and separate the three
 * concerns the operator asked for:
 *
 *   - language : a DECISION (may reject) — judged on the ACTUAL text, not on
 *                the source host, so a valid English translation still passes.
 *   - quality  : a DECISION (may reject) — mojibake / degenerate repetition.
 *   - mission  : ADVISORY only (never rejects) — not exercised here.
 */

const EN =
  "The steam engine converted thermal energy into mechanical work, and it did so " +
  "because pressure was allowed to act on a piston inside a cylinder. When the valve " +
  "opened, steam that had been heated in the boiler pushed the piston, and the motion " +
  "was then transferred to a wheel through a connecting rod. Engineers of the era were " +
  "concerned that the apparatus would waste fuel, but the improvements that followed " +
  "were remarkable and they changed industry forever.";

const FR =
  "Le moteur à vapeur transformait l'énergie thermique en énergie mécanique, et il le " +
  "faisait parce que la pression était appliquée sur un piston à l'intérieur d'un " +
  "cylindre. Quand la valve s'ouvrait, la vapeur qui avait été chauffée dans la chaudière " +
  "poussait le piston, et le mouvement était ensuite transmis à une roue par une bielle.";

const HI =
  "भाप इंजन तापीय ऊर्जा को यांत्रिक ऊर्जा में बदलता है और यह सिलेंडर के भीतर पिस्टन पर " +
  "दबाव डालकर काम करता है। जब वाल्व खुलता था तो भाप पिस्टन को धकेलती थी।";

const AR =
  "المحرك البخاري يحول الطاقة الحرارية إلى طاقة ميكانيكية، وقد فعل ذلك لأن الضغط كان " +
  "يؤثر على مكبس داخل أسطوانة. وعندما فُتح الصمام دفع البخار المكبس إلى الأمام.";

// Double-encoded UTF-8 ("cafÃ©") plus replacement characters: corruption that
// survived cleaning.
const MOJI = (
  "The cafÃ© served crÃ¨me brÃ»lÃ©e and the naÃ¯ve rÃ©sumÃ© was \uFFFD \uFFFD truncated. " +
  "A seÃ±or ordered a piÃ±a colada at the cafÃ© while the rÃ©sumÃ© was \uFFFD reviewed again. "
).repeat(4);

// Repetitive English "junk": fluent-looking but degenerate — the critic would
// otherwise be free to approve it on content alone.
const JUNK = "The steam engine was developed in Britain during the eighteenth century. ".repeat(20);

const LF_ON = { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" };

test("language gate: confident non-Latin scripts are rejected at review", () => {
  for (const [label, text] of [["hindi", HI], ["arabic", AR]]) {
    const r = preScreen(text, { languageFilter: LF_ON });
    assert.equal(r.decision, "reject", `${label} must be rejected`);
    assert.equal(r.gate, GATE.LANGUAGE, `${label} must fail the LANGUAGE gate`);
  }
});

test("language gate: Latin-script non-English is rejected at review", () => {
  const r = preScreen(FR, { languageFilter: LF_ON });
  assert.equal(r.decision, "reject");
  assert.equal(r.gate, GATE.LANGUAGE);
});

test("language gate: a valid English translation of a foreign source PASSES", () => {
  // The source host declares French, but the TRAINING TEXT is fluent English.
  // Provenance must not, by itself, cause a rejection.
  const r = preScreen(EN, {
    languageFilter: LF_ON,
    sourceUrl: "https://fr.wikipedia.org/wiki/Machine_%C3%A0_vapeur",
    htmlLang: "fr",
  });
  assert.equal(r.decision, "proceed", JSON.stringify(r));
  assert.equal(r.gate, null);
});

test("language gate: declared-language mismatch with non-English text is rejected", () => {
  const r = preScreen("Qués el premi Nobel de Literatura de 1986?\n\nWole Soyinka", {
    languageFilter: LF_ON,
    htmlLang: "ca",
  });
  assert.equal(r.decision, "reject");
  assert.equal(r.gate, GATE.LANGUAGE);
});

test("language gate: disabled or shadow mode never rejects", () => {
  assert.equal(preScreen(FR, { languageFilter: { enabled: false } }).decision, "proceed");
  assert.equal(preScreen(FR, { languageFilter: { ...LF_ON, shadow: true } }).decision, "proceed");
});

test("quality gate: encoding corruption (mojibake) is rejected", () => {
  assert.ok(mojibakeRatio(MOJI) > 0.02, `expected mojibake ratio above floor, got ${mojibakeRatio(MOJI)}`);
  const r = preScreen(MOJI, { languageFilter: LF_ON });
  assert.equal(r.decision, "reject");
  assert.equal(r.gate, GATE.QUALITY);
});

test("quality gate: degenerate repetitive English is rejected", () => {
  const r = preScreen(JUNK, { languageFilter: LF_ON });
  assert.equal(r.decision, "reject");
  assert.equal(r.gate, GATE.QUALITY);
});

test("quality gate: healthy prose proceeds", () => {
  const r = preScreen(EN, { languageFilter: LF_ON });
  assert.equal(r.decision, "proceed", JSON.stringify(r));
});

test("quality gate can be disabled (reversible)", () => {
  const r = preScreen(JUNK, { languageFilter: LF_ON, quality: { enabled: false } });
  assert.equal(r.decision, "proceed");
});

test("heuristicPenalty remains the shared repetition primitive", () => {
  assert.equal(heuristicPenalty(""), 0);
  assert.ok(heuristicPenalty(EN) > heuristicPenalty(JUNK));
  assert.ok(heuristicPenalty(EN) > 0.15);
});

test("repetitionPenalty is neutral for non-Latin text, 0 only for empty input", () => {
  assert.equal(heuristicPenalty(""), 0);
  assert.equal(heuristicPenalty("   "), 0);
  // Non-empty text with no ASCII words must NOT read as "degenerate" (that zeroed
  // a critic's score to 0 and sent non-Latin articles into the uncertain loop).
  assert.equal(heuristicPenalty("دورة رانكين واحتراق خارجي"), 1);
  assert.equal(heuristicPenalty("蒸汽机"), 1);
  assert.equal(heuristicPenalty("γειά σου"), 1);
});
