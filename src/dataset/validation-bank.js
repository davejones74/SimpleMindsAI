import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import { buildContentClusters } from "./dedup.js";
import { normalizeSourceUrl } from "./partition.js";
import { assessContentQuality } from "../domain/content-quality.js";
import { explainFocusText, LANGUAGE_MECHANICS_STRONG_TERMS, LANGUAGE_MECHANICS_WEAK_TERMS, LANGUAGE_MECHANICS_STRONG_PHRASES, COMMERCIAL_NEGATIVE_TERMS, COMMERCIAL_NEGATIVE_PHRASES } from "../discovery/mission-profile.js";
import { reuseEligible } from "./snapshot.js";
import { contentHash } from "../domain/article.js";
import { measureDocuments } from "../training/tokenizer-measurement.js";

export const VALIDATION_BANK_SCHEMA = "sma/validation-bank@1";
export const VALIDATION_BANK_POLICY_VERSION = "validation-bank-v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validationBankDir(dir = config.paths.validationBanks) {
  return dir;
}

export function activeValidationBankPointer(dir = config.paths.validationBanks) {
  return path.join(dir, "active.json");
}

function manifestPath(dir, bankVersion) {
  return path.join(dir, bankVersion, "manifest.json");
}

function bankDataPath(dir, bankVersion) {
  return path.join(dir, bankVersion, "bank.ndjson");
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  return file;
}

function sourceIdFor(article) {
  return article.fetchedContentHash || normalizeSourceUrl(article.sourceUrl) || article.articleId;
}

function publisherFor(article) {
  return article.sourceDomain || article.source || "unknown";
}

function rowsForClusters(clusters, tokenById) {
  const rows = [];
  for (const cluster of clusters) {
    for (const row of cluster.members ?? []) {
      rows.push({
        articleId: row.articleId,
        contentHash: row.contentHash ?? contentHash(row.text),
        text: row.text,
        corpusRole: "validation",
        sourceId: row.sourceId,
        publisherId: row.publisherId,
        sourceUrl: row.sourceUrl ?? null,
        licence: row.licence ?? null,
        clusterId: cluster.clusterId,
        tokenCount: tokenById.get(row.articleId) ?? 0,
      });
    }
  }
  return rows;
}

/**
 * Build an immutable validation bank from reviewed, unconsumed, trainable
 * articles. The bank is selected independently of any training batch and is
 * sized with the student tokenizer.
 */
export async function buildValidationBank({
  store,
  dir = config.paths.validationBanks,
  tokenizerPath,
  seqLen = config.trainSeqLen,
  targetBlocks = config.validationBank.targetBlocks,
  marginBlocks = config.validationBank.marginBlocks,
  minSources = config.validationBank.minSources,
  maxCandidates = config.validationBank.maxCandidates,
  measure = measureDocuments,
  now = new Date(),
  bankVersion = null,
} = {}) {
  if (!store) throw new Error("buildValidationBank requires a store");
  if (!tokenizerPath) throw new Error("buildValidationBank requires tokenizerPath");
  mkdirSync(dir, { recursive: true });

  const candidates = [];
  let cursor = null;
  while (candidates.length < maxCandidates) {
    const page = store.articlesPage({
      after: cursor,
      limit: Math.min(500, maxCandidates - candidates.length),
      status: "REVIEWED",
      consumed: false,
      trainableOnly: true,
      order: "asc",
    });
    for (const article of page.items ?? []) {
      if (article.validationOnly === true) continue;
      const quality = assessContentQuality({ url: article.sourceUrl ?? "", title: article.title ?? "", text: article.text ?? "" });
      if (quality.decision !== "allow") continue;
      if (!reuseEligible(article)) continue;
      const focus = explainFocusText(`${article.sourceUrl ?? ""} ${article.title ?? ""} ${article.text ?? ""}`, {
        mode: "enforce",
        policyVersion: "validation-bank-focus-v2",
        minScore: 0.08,
        requireStrongSignal: true,
        strongTerms: LANGUAGE_MECHANICS_STRONG_TERMS,
        weakTerms: LANGUAGE_MECHANICS_WEAK_TERMS,
        strongPhrases: LANGUAGE_MECHANICS_STRONG_PHRASES,
        negativeTerms: COMMERCIAL_NEGATIVE_TERMS,
        negativePhrases: COMMERCIAL_NEGATIVE_PHRASES,
      });
      if (!focus.qualified) continue;
      candidates.push({ ...article, focusScore: focus.score, focusSignals: focus.signals });
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (!candidates.length) {
    const err = new Error("validation bank has no eligible reviewed, unconsumed, high-quality articles");
    err.code = "INSUFFICIENT_VALIDATION_BANK";
    throw err;
  }

  const measured = await measure(
    candidates.map((a) => ({ itemId: a.articleId, text: a.text ?? "" })),
    { tokenizerPath, seqLen },
  );
  const tokenById = new Map((measured.documents ?? []).map((row) => [row.itemId, Number(row.tokens) || 0]));
  const rows = candidates.map((a) => ({
    articleId: a.articleId,
    text: a.text ?? "",
    contentHash: a.contentHash ?? contentHash(a.text ?? ""),
    sourceId: sourceIdFor(a),
    publisherId: publisherFor(a),
    sourceUrl: a.sourceUrl ?? null,
    licence: a.licence ?? null,
    focusScore: a.focusScore ?? 0,
    tokenCount: tokenById.get(a.articleId) ?? 0,
  }));
  const clustering = buildContentClusters(rows);
  const rowById = new Map(rows.map((row) => [row.articleId, row]));
  const byCluster = new Map();
  for (const record of clustering.clusters) {
    const members = record.articleIds.map((id) => rowById.get(id)).filter(Boolean);
    const cluster = {
      clusterId: record.clusterId,
      members,
      tokens: members.reduce((sum, row) => sum + row.tokenCount, 0),
      sourceIds: new Set(members.map((row) => row.sourceId).filter(Boolean)),
      focusScore: Math.max(0, ...members.map((row) => Number(row.focusScore) || 0)),
    };
    byCluster.set(cluster.clusterId, cluster);
  }
  const clusters = [...byCluster.values()]
    .map((c) => ({ ...c, sourceIds: [...c.sourceIds].sort() }))
    .sort((a, b) => b.focusScore - a.focusScore || a.clusterId.localeCompare(b.clusterId));

  const requiredBlocks = Math.max(1, Number(targetBlocks) || 1);
  const targetTokens = requiredBlocks * seqLen + Math.max(0, Number(marginBlocks) || 0) * seqLen;
  const selected = [];
  const sources = new Set();
  const unitsPerSource = new Map();
  let tokens = 0;
  const maxUnitsPerSource = Math.max(1, Number(config.validationBank.maxUnitsPerSource) || 6);
  for (const cluster of clusters) {
    if (tokens >= targetTokens && sources.size >= Math.max(1, Number(minSources) || 1)) break;
    const members = [];
    for (const row of cluster.members) {
      const used = unitsPerSource.get(row.sourceId) ?? 0;
      if (used >= maxUnitsPerSource) continue;
      unitsPerSource.set(row.sourceId, used + 1);
      members.push(row);
      sources.add(row.sourceId);
    }
    const clusterTokens = members.reduce((sum, row) => sum + row.tokenCount, 0);
    if (!members.length) continue;
    selected.push({ ...cluster, members, tokens: clusterTokens });
    tokens += clusterTokens;
  }
  const selectedBlocks = Math.floor(tokens / Math.max(1, seqLen));
  if (selectedBlocks < requiredBlocks || (minSources > 0 && sources.size < minSources)) {
    const err = new Error(
      `validation bank capacity shortfall: ${selectedBlocks}/${requiredBlocks} blocks, ${sources.size}/${minSources} sources`,
    );
    err.code = "INSUFFICIENT_VALIDATION_BANK";
    err.blocks = selectedBlocks;
    err.requiredBlocks = requiredBlocks;
    err.sources = sources.size;
    throw err;
  }

  const bankRows = rowsForClusters(selected, tokenById);
  const bankBytes = bankRows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const contentHashValue = sha256(bankBytes);
  const version = bankVersion ?? `vb-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${contentHashValue.slice(0, 8)}`;
  const manifest = {
    schema: VALIDATION_BANK_SCHEMA,
    policyVersion: VALIDATION_BANK_POLICY_VERSION,
    bankVersion: version,
    createdAt: now.toISOString(),
    targetBlocks: requiredBlocks,
    marginBlocks: Number(marginBlocks) || 0,
    selectedBlocks,
    seqLen,
    tokens,
    articleIds: bankRows.map((row) => row.articleId),
    sourceIds: [...new Set(bankRows.map((row) => row.sourceId))].sort(),
    clusterIds: [...new Set(bankRows.map((row) => row.clusterId))].sort(),
    publisherIds: [...new Set(bankRows.map((row) => row.publisherId))].sort(),
    rows: bankRows.map((row) => ({
      articleId: row.articleId,
      contentHash: row.contentHash,
      sourceId: row.sourceId,
      publisherId: row.publisherId,
      clusterId: row.clusterId,
      tokenCount: row.tokenCount,
      licence: row.licence,
      selectionReason: "reviewed-unconsumed-trainable-source-cluster",
    })),
    bankFile: bankDataPath(dir, version),
    contentHash: contentHashValue,
    manifestHash: null,
  };
  manifest.manifestHash = sha256(stableJson({ ...manifest, manifestHash: null }));
  mkdirSync(path.join(dir, version), { recursive: true });
  writeFileAtomic(bankDataPath(dir, version), bankBytes);
  writeFileAtomic(manifestPath(dir, version), `${JSON.stringify(manifest, null, 2)}\n`);
  const reservation = typeof store.reserveValidation === "function"
    ? await store.reserveValidation(manifest.articleIds, { bankVersion: version, reason: "validation-bank" })
    : { reserved: [], skipped: [] };
  writeFileAtomic(activeValidationBankPointer(dir), `${JSON.stringify({
    schema: "sma/validation-bank-active@1",
    bankVersion: version,
    manifestHash: manifest.manifestHash,
    contentHash: manifest.contentHash,
    bankFile: manifest.bankFile,
    activatedAt: now.toISOString(),
  }, null, 2)}\n`);
  return { manifest, rows: bankRows, reservation };
}

export function loadActiveValidationBank({ dir = config.paths.validationBanks } = {}) {
  const pointerFile = activeValidationBankPointer(dir);
  if (!existsSync(pointerFile)) return null;
  let pointer;
  try { pointer = JSON.parse(readFileSync(pointerFile, "utf8")); } catch { return null; }
  if (!pointer?.bankVersion) return null;
  const mf = manifestPath(dir, pointer.bankVersion);
  const bf = bankDataPath(dir, pointer.bankVersion);
  if (!existsSync(mf) || !existsSync(bf)) return null;
  const manifest = JSON.parse(readFileSync(mf, "utf8"));
  const bankBytes = readFileSync(bf);
  const actualHash = sha256(bankBytes);
  if (manifest.contentHash !== actualHash || pointer.contentHash !== actualHash) {
    const err = new Error("validation bank content hash mismatch");
    err.code = "INVALID_VALIDATION_BANK";
    throw err;
  }
  if (manifest.manifestHash) {
    const expected = sha256(stableJson({ ...manifest, manifestHash: null }));
    if (expected !== manifest.manifestHash) {
      const err = new Error("validation bank manifest hash mismatch");
      err.code = "INVALID_VALIDATION_BANK";
      throw err;
    }
  }
  const rows = bankBytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { pointer, manifest, rows };
}

export function assertValidationBankDisjoint({ bankRows = [], trainingRows = [] } = {}) {
  const bankSources = new Set((bankRows ?? []).map((row) => row.sourceId).filter(Boolean));
  const bankHashes = new Set((bankRows ?? []).map((row) => row.contentHash).filter(Boolean));
  const overlaps = [];
  for (const row of trainingRows ?? []) {
    if (row.sourceId && bankSources.has(row.sourceId)) overlaps.push({ articleId: row.articleId, sourceId: row.sourceId, reason: "source" });
    if (row.contentHash && bankHashes.has(row.contentHash)) overlaps.push({ articleId: row.articleId, contentHash: row.contentHash, reason: "content" });
  }
  if (overlaps.length) {
    const err = new Error(`validation bank overlaps training material (${overlaps.length} row(s))`);
    err.code = "VALIDATION_BANK_OVERLAP";
    err.overlaps = overlaps.slice(0, 20);
    throw err;
  }
  return true;
}
