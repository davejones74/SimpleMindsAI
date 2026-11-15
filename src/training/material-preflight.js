import { existsSync, readFileSync } from "node:fs";
import { config as defaultConfig } from "../config.js";
import { collectRowsFromArticles, estimateTokenCount } from "../dataset/snapshot.js";
import { loadActiveValidationBank } from "../dataset/validation-bank.js";
import { measureDocuments } from "./tokenizer-measurement.js";

/**
 * Cheap material preflight BEFORE acquiring RUN.lock.
 *
 * The authoritative lifecycle checks remain in place; this function only avoids
 * the lock churn caused by repeatedly acquiring the run lock for a batch that
 * is already known to be below the fresh-token floor or lacks a complete
 * validation bank. It does not modify articles, snapshots or pointers.
 */
function resolveTokenizerPath(cfg) {
  const root = cfg.pythonStore;
  if (!root) return null;
  for (const pointer of ["active.json", "working.json"]) {
    try {
      const record = JSON.parse(readFileSync(`${root}/${pointer}`, "utf8"));
      if (record?.version) {
        const candidate = `${root}/${record.version}/tokenizer.json`;
        if (existsSync(candidate)) return candidate;
      }
    } catch { /* try next */ }
  }
  return null;
}

export async function preflightMaterial({ store, config: cfg = defaultConfig, measure = measureDocuments } = {}) {
  if (!store?.getStats) return { ok: true, skipped: true };
  const minEligible = cfg.jobs?.training?.minEligible ?? 1;
  const stats = store.getStats();
  if ((stats.trainable ?? 0) < minEligible) {
    const err = new Error(`insufficient eligible material: ${stats.trainable ?? 0} reviewed+unconsumed article(s), need ${minEligible}`);
    err.code = "INSUFFICIENT_ELIGIBLE";
    err.eligible = stats.trainable ?? 0;
    throw err;
  }
  let fresh = null;
  if (cfg.trainMinFreshTokens > 0) {
    // A cheap dry collection catches the common "all remaining fresh rows were
    // excluded by quality/caps/eval-guard" case before RUN.lock is acquired.
    const dry = collectRowsFromArticles(store, {
      limit: Math.min(cfg.snapshotLimit ?? 512, 512),
      replayPercent: 0,
      validationBlocks: 0,
      corpusMode: cfg.trainCorpusMode,
      deferValidationPartition: true,
    });
    if (!dry.rows.length || !dry.freshArticleIds.length) {
      const err = new Error("corpus has no training documents after freshness and quality filters");
      err.code = "NO_ELIGIBLE_MATERIAL";
      throw err;
    }
    fresh = 0;
    const rows = [];
    let cursor = null;
    while (rows.length < 512) {
      const page = store.articlesPage({
        after: cursor,
        limit: Math.min(512, 512 - rows.length),
        status: "REVIEWED",
        consumed: false,
        trainableOnly: true,
        order: "asc",
      });
      if (!page.items?.length) break;
      for (const article of page.items) rows.push({ itemId: article.articleId, text: article.text ?? "" });
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (cfg.trainPreflightTokenizer) {
      const tokenizerPath = resolveTokenizerPath(cfg);
      if (tokenizerPath) {
        const measured = await measure(rows, { tokenizerPath, seqLen: cfg.trainSeqLen });
        fresh = Number(measured.totalTokens) || 0;
      }
    }
    if (!cfg.trainPreflightTokenizer || fresh === 0) {
      fresh = rows.reduce((sum, row) => sum + estimateTokenCount(row.text), 0);
    }
    if (fresh < cfg.trainMinFreshTokens) {
      const err = new Error(`fresh training delta has ${fresh} estimated token(s), below the minimum of ${cfg.trainMinFreshTokens}`);
      err.code = "INSUFFICIENT_FRESH_DATA";
      err.tokens = fresh;
      err.minFreshTokens = cfg.trainMinFreshTokens;
      throw err;
    }
  }
  if (cfg.validationBank?.enabled) {
    const bank = loadActiveValidationBank({ dir: cfg.paths.validationBanks });
    if (!bank || bank.manifest.selectedBlocks < cfg.trainValBlocks) {
      const err = new Error(
        `validation bank capacity ${bank?.manifest?.selectedBlocks ?? 0}/${cfg.trainValBlocks} blocks`,
      );
      err.code = "INSUFFICIENT_VALIDATION_BANK";
      err.blocks = bank?.manifest?.selectedBlocks ?? 0;
      throw err;
    }
  }
  return { ok: true, estimatedFreshTokens: fresh };
}
