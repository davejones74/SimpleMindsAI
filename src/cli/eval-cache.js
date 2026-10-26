#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import {
  cacheEntrySatisfiesEvidence,
  evalCacheFile,
  loadEvalCache,
  pruneEvalCache,
} from "../training/eval-cache.js";

const USAGE = `SimpleMindsAI baseline evaluation cache control

Usage:
  node src/cli/eval-cache.js status [--registry-dir DIR]
  node src/cli/eval-cache.js prune --missing-per-document [--version V] [--dry-run] [--registry-dir DIR]

The cache is only an optimisation. A key now includes the evidence shape
(aggregate vs per-document), and an enforce-mode run refuses a cached entry that
lacks per-document rows. prune physically removes stale entries for audit.
`;

function summary(entry) {
  const rows = Array.isArray(entry?.perDocument) ? entry.perDocument.length : 0;
  return {
    version: entry?.version ?? null,
    loss: entry?.loss ?? null,
    datasetHash: entry?.datasetHash ?? null,
    ok: entry?.ok === true,
    perDocumentRows: rows,
    usableUnderEnforcement: cacheEntrySatisfiesEvidence(entry, { perDocument: true }),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "registry-dir": { type: "string" },
      version: { type: "string" },
      "missing-per-document": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  const registryDir = path.resolve(values["registry-dir"] ?? process.env.REGISTRY_DIR ?? "data/registry");
  const file = evalCacheFile(registryDir);
  const command = positionals[0];

  if (command === "status") {
    const cache = loadEvalCache(registryDir);
    const entries = Object.entries(cache).map(([key, entry]) => ({ key, ...summary(entry) }));
    process.stdout.write(
      `${JSON.stringify(
        {
          file,
          entries: entries.length,
          staleAggregateOnly: entries.filter((e) => !e.usableUnderEnforcement).length,
          cache: entries,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "prune") {
    if (!values["missing-per-document"]) {
      throw new Error("prune requires --missing-per-document");
    }
    const version = values.version ?? null;
    const keep = (key, entry) => {
      if (version && entry?.version !== version) return true;
      return cacheEntrySatisfiesEvidence(entry, { perDocument: true });
    };
    const cache = loadEvalCache(registryDir);
    const stale = Object.entries(cache)
      .filter(([key, entry]) => !keep(key, entry))
      .map(([key, entry]) => ({ key, ...summary(entry) }));
    if (values["dry-run"]) {
      process.stdout.write(`${JSON.stringify({ file, dryRun: true, removed: stale, count: stale.length }, null, 2)}\n`);
      return;
    }
    const result = pruneEvalCache(registryDir, keep);
    process.stdout.write(
      `${JSON.stringify({ file, version, removed: stale, removedCount: result.removed.length, remaining: result.remaining }, null, 2)}\n`,
    );
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[eval-cache] ${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
}
