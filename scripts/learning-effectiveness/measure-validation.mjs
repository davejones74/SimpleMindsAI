#!/usr/bin/env node
/**
 * Read-only validation-cohort measurement using the real tokenizer.
 *
 * Usage:
 *   node scripts/learning-effectiveness/measure-validation.mjs \
 *     --store /var/lib/simpleminds/data/articles \
 *     --registry /var/lib/simpleminds/data/registry \
 *     --tokenizer /var/lib/simpleminds/store/v500/tokenizer.json \
 *     [--seq-len 128]
 *
 * It opens the article/registry stores read-only. It does not build a snapshot,
 * consume material, train or write any checkpoint.
 */
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { config } from "../../src/config.js";
import { measureValidationAvailability } from "../../src/training/tokenizer-measurement.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const pref = `${name}=`;
  const found = process.argv.find((v) => v.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
}

const storeDir = arg("--store", "/var/lib/simpleminds/data/articles");
const registryDir = arg("--registry", "/var/lib/simpleminds/data/registry");
const tokenizerPath = arg("--tokenizer", "/var/lib/simpleminds/store/v500/tokenizer.json");
const seqLen = Number(arg("--seq-len", "128")) || 128;
const pythonBin = arg("--python", process.env.SMA_PYTHON ?? null);

const store = await ArticleStore.open(storeDir, { readOnly: true });
const registry = await RegistryStore.open(registryDir, { readOnly: true });
try {
  const result = await measureValidationAvailability(store, registry, {
    config,
    tokenizerPath,
    seqLen,
    ...(pythonBin ? { bin: pythonBin } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await store.close();
  await registry.close?.();
}
