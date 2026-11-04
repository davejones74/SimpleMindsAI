#!/usr/bin/env node
/**
 * Read-only measurement of the curation segmentation change.
 *
 * Compares the historical 14k single-slice plan with full-source segmentation
 * over the CURRENT fresh trainable cohort. It does not curate, train or write.
 *
 * Usage:
 *   node scripts/learning-effectiveness/measure-segmentation.mjs \
 *     --store /var/lib/simpleminds/data/articles \
 *     [--tokenizer /var/lib/simpleminds/store/v500/tokenizer.json] \
 *     [--python /opt/simpleminds/python/.venv/bin/python] \
 *     [--out report.json]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { ArticleStore } from "../../src/storage/article-store.js";
import { config } from "../../src/config.js";
import { planCuration } from "../../src/services/curator-segmentation.js";
import { buildCommonLines, cleanRawText } from "../../src/dataset/corpus-text.js";
import { measureDocuments } from "../../src/training/tokenizer-measurement.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const pref = `${name}=`;
  const found = process.argv.find((v) => v.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
}

const storeDir = arg("--store", "/var/lib/simpleminds/data/articles");
const tokenizerPath = arg("--tokenizer", null);
const pythonBin = arg("--python", process.env.SMA_PYTHON ?? null);
const out = arg("--out", null);

const store = await ArticleStore.open(storeDir, { readOnly: true });
try {
  const fresh = store.articlesPage({ status: "REVIEWED", limit: 10000 }).items
    .filter((a) => !a.consumedAt && a.replayOnly !== true);
  const sources = new Map();
  for (const article of fresh) {
    const key = article.fetchedContentHash || article.sourceUrl || article.articleId;
    const entry = sources.get(key) ?? { key, rawText: "", units: [] };
    entry.units.push(article);
    if ((article.rawText?.length ?? 0) > entry.rawText.length) entry.rawText = article.rawText;
    sources.set(key, entry);
  }

  const sourceList = [...sources.values()];
  const commonLines = buildCommonLines(sourceList.flatMap((entry) => entry.units), {
    threshold: config.trainCorpusCommonLineDocs,
  });
  const cleanedRows = sourceList.map((entry, index) => {
    const cleaned = cleanRawText(entry.rawText || "", {
      commonLines,
      minChars: config.trainCorpusMinChars,
      minSentenceRatio: config.trainCorpusMinSentenceRatio,
    });
    return { itemId: `cleaned-${index}`, text: cleaned.text, accepted: cleaned.accepted, chars: cleaned.chars };
  });

  const rows = [];
  for (const entry of sources.values()) {
    const raw = entry.rawText || "";
    const legacy = planCuration(raw, {
      strategy: "legacy",
      legacyMaxChars: config.curatorLegacyMaxChars,
    });
    const segmented = planCuration(raw, {
      strategy: "segmented",
      maxChars: config.curatorChunkMaxChars,
      minChars: config.curatorChunkMinChars,
      targetChars: config.curatorChunkTargetChars,
    });
    rows.push({
      sourceKey: entry.key,
      units: entry.units.length,
      curatedChars: entry.units.reduce((sum, u) => sum + String(u.text ?? "").length, 0),
      rawChars: raw.length,
      legacyVisibleChars: legacy.reduce((sum, c) => sum + c.chars, 0),
      segmentedVisibleChars: segmented.reduce((sum, c) => sum + c.chars, 0),
      legacyChunks: legacy.length,
      segmentedChunks: segmented.length,
    });
  }

  const sum = (field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
  const report = {
    schema: "sma/segmentation-measurement@1",
    at: new Date().toISOString(),
    mode: "read-only",
    store: storeDir,
    freshArticles: fresh.length,
    uniqueSources: rows.length,
    curatedChars: sum("curatedChars"),
    rawChars: sum("rawChars"),
    legacyVisibleChars: sum("legacyVisibleChars"),
    segmentedVisibleChars: sum("segmentedVisibleChars"),
    legacyCoverage: sum("rawChars") ? sum("legacyVisibleChars") / sum("rawChars") : null,
    segmentedCoverage: sum("rawChars") ? sum("segmentedVisibleChars") / sum("rawChars") : null,
    legacyChunks: sum("legacyChunks"),
    segmentedChunks: sum("segmentedChunks"),
    cleanedRaw: {
      sources: cleanedRows.length,
      accepted: cleanedRows.filter((row) => row.accepted).length,
      rejected: cleanedRows.filter((row) => !row.accepted).length,
      chars: cleanedRows.reduce((total, row) => total + row.chars, 0),
      estimatedTokens: Math.ceil(cleanedRows.reduce((total, row) => total + row.chars, 0) / 4),
    },
    estimated: {
      curatedTokens: Math.ceil(sum("curatedChars") / 4),
      rawTokens: Math.ceil(sum("rawChars") / 4),
      legacyVisibleTokens: Math.ceil(sum("legacyVisibleChars") / 4),
      segmentedVisibleTokens: Math.ceil(sum("segmentedVisibleChars") / 4),
    },
    sources: rows,
  };

  if (tokenizerPath) {
    const curatedRows = fresh.map((a) => ({ itemId: a.articleId, text: a.text ?? "" }));
    const rawRows = [...sources.values()].map((entry, index) => ({ itemId: `source-${index}`, text: entry.rawText }));
    const options = { tokenizerPath, seqLen: config.trainSeqLen, ...(pythonBin ? { bin: pythonBin } : {}) };
    report.actual = {
      curated: await measureDocuments(curatedRows, options),
      rawRepresentatives: await measureDocuments(rawRows, options),
      cleanedRaw: await measureDocuments(cleanedRows.map((row) => ({ itemId: row.itemId, text: row.text })), options),
    };
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
  if (out) {
    console.log(`segmentation: ${fresh.length} fresh articles / ${rows.length} sources`);
    console.log(`legacy visible ${report.legacyVisibleChars} chars (${(report.legacyCoverage * 100).toFixed(1)}%), segmented ${report.segmentedVisibleChars} chars (${(report.segmentedCoverage * 100).toFixed(1)}%)`);
    console.log(`raw/curated char ratio ${(report.rawChars / Math.max(1, report.curatedChars)).toFixed(1)}x`);
  }
} finally {
  await store.close();
}
