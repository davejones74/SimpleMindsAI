import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scoreMissionRelevance } from "../src/domain/mission-relevance.js";
import { ArticleStore } from "../src/storage/article-store.js";

/**
 * P4 — advisory mission relevance (locked decision #5).
 *
 * A deterministic lexical overlap score that is NEVER a rejection rule. A low or
 * null score never blocks ingestion, review, training or promotion — it only
 * (de)selects for the positive "mission-relevance" review hint.
 */

const MISSION = "To accurately comprehend the nuances of human language, transforming unstructured text into clear, contextual insights.";
const MISSION_TOPIC = "accurately comprehend the nuances of human language transforming unstructured text into clear contextual insights";

test("scoreMissionRelevance returns null when there is no mission signal", () => {
  assert.equal(scoreMissionRelevance("human language", []), null);
  assert.equal(scoreMissionRelevance("human language", [""]), null);
  assert.equal(scoreMissionRelevance("human language", null), null);
  assert.equal(scoreMissionRelevance("human language", undefined), null);
});

test("scoreMissionRelevance is 0 for unrelated text and 1 for full overlap", () => {
  assert.equal(scoreMissionRelevance("quantum chromodynamics gauge bosons", MISSION), 0);
  // "comprehend nuances human language contextual insights" covers every mission word.
  assert.equal(scoreMissionRelevance(MISSION_TOPIC, MISSION), 1);
});

test("scoreMissionRelevance is deterministic, monotone in overlap, and bounded", () => {
  const low = scoreMissionRelevance("human language is useful", MISSION);
  const high = scoreMissionRelevance("comprehend the nuances of human language", MISSION);
  assert.equal(scoreMissionRelevance("human language is useful", MISSION), low, "deterministic");
  assert.ok(high > low, "more overlapping content words => higher score");
  assert.ok(low >= 0 && low <= 1 && high >= 0 && high <= 1);
});

test("ingest computes and persists an advisory missionRelevance when enabled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-mr-"));
  const store = await ArticleStore.open(dir, { languageFilter: null, missionTexts: [MISSION], missionRelevanceEnabled: true });

  const onMission = await store.ingestArticle({ text: "The nuances of human language and contextual insights matter deeply to readers.", domain: "general" });
  assert.equal(typeof onMission.missionRelevance, "number");
  assert.ok(onMission.missionRelevance > 0);

  const offMission = await store.ingestArticle({ text: "Quantum chromodynamics studies the strong force binding quarks inside nucleons.", domain: "general" });
  assert.equal(offMission.missionRelevance, 0);
});

test("a zero-relevance article is NEVER rejected — it still ingests", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-mr-"));
  const store = await ArticleStore.open(dir, { languageFilter: null, missionTexts: [MISSION], missionRelevanceEnabled: true });

  const r = await store.ingestArticle({ text: "Quantum chromodynamics studies the strong force binding quarks inside nucleons.", domain: "general" });
  assert.ok(!r.skipped, "not language-skipped");
  assert.ok(r.articleId, "article was ingested");
  assert.equal(r.missionRelevance, 0);
  assert.notEqual(r.status, "rejected");
});

test("without a mission reference, no score is computed (null)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-mr-"));
  const store = await ArticleStore.open(dir, { languageFilter: null, missionRelevanceEnabled: true });
  const r = await store.ingestArticle({ text: "The nuances of human language matter deeply to readers.", domain: "general" });
  assert.equal(r.missionRelevance, null, "no mission => null, never a fabricated score");
});
