import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import { ArticleStore } from "../storage/article-store.js";
import { buildValidationBank } from "../dataset/validation-bank.js";

function resolveTokenizerPath() {
  for (const pointer of ["active.json", "working.json"]) {
    try {
      const record = JSON.parse(readFileSync(path.join(config.pythonStore, pointer), "utf8"));
      if (record?.version) {
        const candidate = path.join(config.pythonStore, record.version, "tokenizer.json");
        if (existsSync(candidate)) return candidate;
      }
    } catch { /* try next pointer */ }
  }
  return null;
}

const tokenizerPath = process.env.TOKENIZER_PATH || resolveTokenizerPath();
if (!tokenizerPath) {
  console.error("No tokenizer.json found in the active/working model; set TOKENIZER_PATH");
  process.exit(1);
}
const store = await ArticleStore.open(config.paths.articles);
try {
  const out = await buildValidationBank({
    store,
    dir: config.paths.validationBanks,
    tokenizerPath,
    targetBlocks: config.validationBank.targetBlocks,
    marginBlocks: config.validationBank.marginBlocks,
    minSources: config.validationBank.minSources,
    maxCandidates: config.validationBank.maxCandidates,
  });
  console.log(JSON.stringify({
    bankVersion: out.manifest.bankVersion,
    blocks: out.manifest.selectedBlocks,
    tokens: out.manifest.tokens,
    articles: out.manifest.articleIds.length,
    sources: out.manifest.sourceIds.length,
    manifestHash: out.manifest.manifestHash,
    reserved: out.reservation.reserved.length,
  }, null, 2));
} finally {
  await store.close?.();
}
