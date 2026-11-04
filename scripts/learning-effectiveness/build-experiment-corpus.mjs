#!/usr/bin/env node
/**
 * Build an isolated, reproducible curation/training experiment corpus.
 *
 * All sources are Project Gutenberg public-domain texts (US public domain;
 * Gutenberg is on the conservative safe-domain policy). Training, validation,
 * prospective and retention material are source-disjoint by construction.
 *
 * This script downloads into an isolated workdir. It never touches production.
 *
 * Usage:
 *   node scripts/learning-effectiveness/build-experiment-corpus.mjs \
 *     --workdir /tmp/opencode/sma-curation-experiment [--force]
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { cleanRawText, buildCommonLines } from "../../src/dataset/corpus-text.js";
import {
  createSealedCohort,
  verifyCohortDisjointness,
  verifySealedCohort,
} from "../../src/training/sealed-cohort.js";

const TRAIN_SOURCES = [
  { id: "pride-prejudice", gutenberg: 1342, title: "Pride and Prejudice" },
  { id: "frankenstein", gutenberg: 84, title: "Frankenstein" },
  { id: "moby-dick", gutenberg: 2701, title: "Moby Dick" },
  { id: "sherlock-holmes", gutenberg: 1661, title: "The Adventures of Sherlock Holmes" },
  { id: "tale-two-cities", gutenberg: 98, title: "A Tale of Two Cities" },
];
const VALIDATION_SOURCE = { id: "war-and-peace", gutenberg: 2600, title: "War and Peace", role: "validation" };
const PROSPECTIVE_SOURCES = [
  { id: "alice", gutenberg: 11, title: "Alice's Adventures in Wonderland" },
  { id: "war-worlds", gutenberg: 36, title: "The War of the Worlds" },
  { id: "tom-sawyer", gutenberg: 74, title: "The Adventures of Tom Sawyer" },
  { id: "huck-finn", gutenberg: 76, title: "Adventures of Huckleberry Finn" },
  { id: "dracula", gutenberg: 345, title: "Dracula" },
  { id: "emma", gutenberg: 158, title: "Emma" },
];

const TRAIN_CAP_CHARS = 60_000;
const PROSPECTIVE_CAP_CHARS = 120_000;
const VALIDATION_CAP_CHARS = 40_000;

const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const pref = `${name}=`;
  const found = process.argv.find((v) => v.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function downloadText(source, rawDir, force) {
  const file = path.join(rawDir, `${source.id}.txt`);
  if (!force && await exists(file)) return readFile(file, "utf8");
  const url = `https://www.gutenberg.org/files/${source.gutenberg}/${source.gutenberg}-0.txt`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${url}: HTTP ${res.status}`);
  const raw = await res.text();
  const start = raw.indexOf("*** START OF THE PROJECT GUTENBERG EBOOK");
  const end = raw.indexOf("*** END OF THE PROJECT GUTENBERG EBOOK");
  const body = start >= 0 && end > start ? raw.slice(raw.indexOf("\n", start) + 1, end) : raw;
  const text = body.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  await writeFile(file, text);
  return text;
}

function splitUnits(text, { maxChars = 1_200, minChars = 500 } = {}) {
  const blocks = String(text ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (const block of blocks) {
    if (block.length > maxChars) {
      push();
      const sentences = block.split(/(?<=[.!?])\s+/).filter(Boolean);
      let sentenceCurrent = "";
      for (const sentence of sentences) {
        if (!sentenceCurrent) sentenceCurrent = sentence;
        else if (sentenceCurrent.length + 1 + sentence.length <= maxChars) sentenceCurrent += ` ${sentence}`;
        else { chunks.push(sentenceCurrent.trim()); sentenceCurrent = sentence; }
      }
      if (sentenceCurrent.trim()) chunks.push(sentenceCurrent.trim());
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars) current = candidate;
    else { push(); current = block; }
  }
  push();
  const merged = [];
  let pending = "";
  for (const chunk of chunks) {
    const candidate = pending ? `${pending}\n\n${chunk}` : chunk;
    if (candidate.length <= maxChars && (pending.length < minChars || chunk.length < minChars)) pending = candidate;
    else { if (pending) merged.push(pending); pending = chunk; }
  }
  if (pending) merged.push(pending);
  return merged;
}

function sectionSamples(text, { targetChars = 4_000, maxDocs = 5 } = {}) {
  const units = splitUnits(text);
  const docs = [];
  const stride = Math.max(1, Math.floor(units.length / maxDocs));
  for (let i = 0; i < units.length && docs.length < maxDocs; i += stride) docs.push(units[i]);
  return docs.map((doc, index) => ({ itemId: `prospective-${index}`, text: doc.slice(0, targetChars) }));
}

const workdir = arg("--workdir");
if (!workdir) throw new Error("--workdir is required");
const force = process.argv.includes("--force");
const rawDir = path.join(workdir, "raw");
const corpusDir = path.join(workdir, "corpora");
const cohortDir = path.join(workdir, "cohorts");
await mkdir(rawDir, { recursive: true });
await mkdir(corpusDir, { recursive: true });
await mkdir(cohortDir, { recursive: true });

const allSources = [...TRAIN_SOURCES, VALIDATION_SOURCE, ...PROSPECTIVE_SOURCES];
const texts = new Map();
for (const source of allSources) {
  const text = await downloadText(source, rawDir, force);
  texts.set(source.id, text);
  console.log(`source ${source.id}: ${text.length} chars`);
}

const sourceUrl = (source) => `https://www.gutenberg.org/files/${source.gutenberg}/${source.gutenberg}-0.txt`;
const trainTexts = TRAIN_SOURCES.map((source) => ({ ...source, text: texts.get(source.id).slice(0, TRAIN_CAP_CHARS), url: sourceUrl(source) }));
const validationText = { ...VALIDATION_SOURCE, text: texts.get(VALIDATION_SOURCE.id).slice(0, VALIDATION_CAP_CHARS), url: sourceUrl(VALIDATION_SOURCE) };

// ---- sealed prospective cohort ----
const prospectiveRows = [];
for (const source of PROSPECTIVE_SOURCES) {
  const text = texts.get(source.id).slice(0, PROSPECTIVE_CAP_CHARS);
  for (const doc of sectionSamples(text)) {
    prospectiveRows.push({ itemId: `${source.id}-${doc.itemId}`, text: doc.text, sourceUrl: sourceUrl(source) });
  }
}
const prospective = createSealedCohort({
  id: "curation-experiment-prospective-v1",
  kind: "prospective",
  rows: prospectiveRows,
  source: "Project Gutenberg public-domain texts",
  notes: "Six books disjoint from all training/validation sources.",
});

// ---- sealed retention cohort: fixed text that all curation modes include ----
const retentionRows = [];
for (const source of trainTexts) {
  const sample = source.text.slice(0, 2_000);
  for (const [index, doc] of splitUnits(sample, { maxChars: 1_000, minChars: 400 }).slice(0, 2).entries()) {
    retentionRows.push({ itemId: `${source.id}-retention-${index}`, text: doc, sourceUrl: source.url });
  }
}
const retention = createSealedCohort({
  id: "curation-experiment-retention-v1",
  kind: "retention",
  rows: retentionRows,
  source: "Held-out probe from the first 2k chars of each training source",
  notes: "The same text is included in every curation mode, so forgetting is comparable.",
});

const allTrainingTexts = [...trainTexts, validationText].map((s) => ({ text: s.text, rawText: s.text }));
const commonLines = buildCommonLines(allTrainingTexts, { threshold: 10 });

function fragmentCorpus(mode) {
  const rows = [];
  const add = (source, text, role) => {
    const selected = mode === "legacy" ? String(text).slice(0, 14_000) : String(text);
    for (const [index, unit] of splitUnits(selected).entries()) {
      const articleId = `${mode}-${source.id}-${index}`;
      rows.push({ articleId, contentHash: sha256(unit), text: unit, domain: "literature", ...(role ? { corpusRole: role } : {}), sourceUrl: source.url });
    }
  };
  for (const source of trainTexts) add(source, source.text, null);
  add(validationText, validationText.text, "validation");
  return rows;
}

function rawTextCorpus() {
  const rows = [];
  const add = (source, role) => {
    const cleaned = cleanRawText(source.text, { commonLines, minChars: 1_000, minSentenceRatio: 0.4 });
    const text = cleaned.accepted ? cleaned.text : source.text;
    rows.push({ articleId: `raw-${source.id}`, contentHash: sha256(text), text, domain: "literature", ...(role ? { corpusRole: role } : {}), sourceUrl: source.url });
  };
  for (const source of trainTexts) add(source, null);
  add(validationText, "validation");
  return rows;
}

const corpora = {
  legacy: fragmentCorpus("legacy"),
  segmented: fragmentCorpus("segmented"),
  "raw-text": rawTextCorpus(),
};

const manifest = {
  schema: "sma/curation-experiment-corpus@1",
  at: new Date().toISOString(),
  workdir,
  trainSources: trainTexts.map((s) => ({ id: s.id, title: s.title, url: s.url, chars: s.text.length, sha256: sha256(s.text) })),
  validationSource: { id: validationText.id, title: validationText.title, url: validationText.url, chars: validationText.text.length, sha256: sha256(validationText.text) },
  prospectiveSources: PROSPECTIVE_SOURCES.map((s) => ({ id: s.id, title: s.title, url: sourceUrl(s) })),
  prospective,
  retention,
  corpora: {},
};

for (const [mode, rows] of Object.entries(corpora)) {
  const file = path.join(corpusDir, `${mode}.jsonl`);
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(file, body);
  const train = rows.filter((r) => r.corpusRole !== "validation");
  const val = rows.filter((r) => r.corpusRole === "validation");
  manifest.corpora[mode] = {
    file,
    sha256: sha256(body),
    rows: rows.length,
    trainRows: train.length,
    validationRows: val.length,
    chars: rows.reduce((sum, r) => sum + r.text.length, 0),
    trainChars: train.reduce((sum, r) => sum + r.text.length, 0),
    validationChars: val.reduce((sum, r) => sum + r.text.length, 0),
  };
}

await writeFile(path.join(cohortDir, "prospective.jsonl"), prospectiveRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
await writeFile(path.join(cohortDir, "retention.jsonl"), retentionRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
await writeFile(path.join(cohortDir, "prospective.manifest.json"), JSON.stringify(prospective, null, 2));
await writeFile(path.join(cohortDir, "retention.manifest.json"), JSON.stringify(retention, null, 2));

const seenHashes = new Set(Object.values(corpora).flat().map((r) => r.contentHash));
const seenUrls = new Set(Object.values(corpora).flat().map((r) => r.sourceUrl).filter(Boolean));
const leak = verifySealedCohort(prospective, { seenContentHashes: seenHashes, seenSourceUrls: seenUrls });
const disjoint = verifyCohortDisjointness(prospective, retention);
manifest.verification = { prospectiveLeak: leak, cohortDisjointness: disjoint, trainingRowHashes: seenHashes.size };
if (!leak.ok) throw new Error(`prospective cohort leaked: ${JSON.stringify(leak.leaks)}`);
if (!disjoint.ok) throw new Error(`cohorts overlap: ${JSON.stringify(disjoint.overlaps)}`);

await writeFile(path.join(workdir, "corpus-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`corpora written to ${corpusDir}`);
for (const [mode, info] of Object.entries(manifest.corpora)) {
  console.log(`  ${mode}: ${info.rows} rows (${info.trainRows} train / ${info.validationRows} validation), ${info.chars} chars`);
}
console.log(`prospective: ${prospective.itemCount} docs; retention: ${retention.itemCount} docs; leak=${leak.ok} disjoint=${disjoint.ok}`);
