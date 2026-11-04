#!/usr/bin/env node
/**
 * Isolated migration/deployment rehearsal.
 *
 * Builds a throwaway store with legacy (unlicensed) records, rehearses licence
 * backfill apply, verifies rollback restores the pre-migration state, runs the
 * retired-replay audit, and verifies the new deployment environment parses.
 *
 * It never reads or writes production data.
 */
import { mkdtemp, mkdir, cp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";

import { ArticleStore } from "../../src/storage/article-store.js";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const root = await mkdtemp(path.join(tmpdir(), "sma-rehearsal-"));
const pristine = path.join(root, "pristine");
const storeDir = path.join(root, "store");
const backup = path.join(root, "backup");
const long = (name) => `Article ${name}. ` + Array.from({ length: 20 }, (_, i) => `Sentence ${i} describes complete English prose about engineering, pressure and motion.`).join(" ");
const shortProse = "The steam engine used pressure to move a piston and turn a wheel.";

const store = await ArticleStore.open(storeDir, { licence: { enforcement: "off" } });
const safe = await store.ingestArticle({ text: long("safe"), sourceUrl: "https://science.nasa.gov/mission/webb/" });
const uncertain = await store.ingestArticle({ text: long("uncertain"), sourceUrl: "https://en.wikipedia.org/wiki/Steam_engine" });
const safeShort = await store.ingestArticle({ text: shortProse, sourceUrl: "https://science.nasa.gov/mission/webb/" });
for (const article of [safe, uncertain, safeShort]) {
  await store.recordReview({ articleId: article.articleId, verdict: "approve", authority: "human" });
  await store.markConsumed([article.articleId], { runId: "run-rehearsal" });
  await store.retireArticle(article.articleId, { reason: "legacy retirement" });
}
await store.close();
await cp(storeDir, pristine, { recursive: true });

function runNode(script, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`${script} failed: ${(r.stderr ?? "").slice(-1000)}`);
  return JSON.parse(r.stdout);
}

const backfillScript = path.resolve("scripts/knowledge-pilot/backfill-licences.mjs");
const auditScript = path.resolve("scripts/knowledge-pilot/audit-retired-replay.mjs");
const dry = runNode(backfillScript, ["--store", storeDir]);
const applied = runNode(backfillScript, ["--store", storeDir, "--apply", "--confirm"]);

const afterApply = await ArticleStore.open(storeDir, { readOnly: true });
const licences = {};
for (const id of [safe.articleId, uncertain.articleId, safeShort.articleId]) {
  licences[id] = afterApply.getArticle(id).licence?.status ?? null;
}
await afterApply.close();

const audit = runNode(auditScript, ["--store", storeDir]);

// Roll back by replacing the store with the pristine pre-migration copy.
await rm(storeDir, { recursive: true, force: true });
await cp(pristine, storeDir, { recursive: true });
const afterRollback = await ArticleStore.open(storeDir, { readOnly: true });
const rolledBack = {};
for (const id of [safe.articleId, uncertain.articleId, safeShort.articleId]) {
  rolledBack[id] = afterRollback.getArticle(id).licence?.status ?? null;
}
await afterRollback.close();

// Verify the new environment parses through the real config module.
const configProbe = spawnSync(process.execPath, ["--input-type=module", "-e", "import {config} from './src/config.js'; console.log(JSON.stringify({curatorStrategy:config.curatorStrategy,urlQuality:config.discoveryUrlQuality,licence:config.licence.enforcement,prefilter:config.review.prefilterMode,knowledgeTokenizerMeasurement:config.knowledgeTokenizerMeasurement}))"], {
  cwd: path.resolve("."),
  encoding: "utf8",
  env: {
    ...process.env,
    CURATOR_STRATEGY: "segmented",
    DISCOVERY_URL_QUALITY: "enforce",
    LICENCE_ENFORCEMENT: "shadow",
    REVIEW_PREFILTER_MODE: "shadow",
    KNOWLEDGE_TOKENIZER_MEASUREMENT: "false",
  },
});
if (configProbe.status !== 0) throw new Error(`config probe failed: ${configProbe.stderr}`);
const config = JSON.parse(configProbe.stdout);

const report = {
  schema: "sma/deployment-rehearsal@1",
  at: new Date().toISOString(),
  mode: "isolated",
  root,
  steps: {
    backfillDryRun: { resolved: dry.resolved, byStatus: dry.byStatus, alreadyResolved: dry.alreadyResolved },
    backfillApply: { resolved: applied.resolved, byStatus: applied.byStatus },
    audit: { scannedRetired: audit.scannedRetired, counts: audit.counts, safeShort: audit.recoverableSafeShortCount },
    rollback: { licencesAfterApply: licences, licencesAfterRollback: rolledBack },
    config,
  },
  checks: {
    dryRunReadOnly: dry.mode === "dry-run",
    applyRecordedLicences: Object.values(licences).every(Boolean),
    rollbackRemovedLicences: Object.values(rolledBack).every((value) => value === null),
    auditClassifiedSafeShort: audit.recoverableSafeShortCount >= 1,
    configParsed: config.curatorStrategy === "segmented" && config.urlQuality === "enforce" && config.licence === "shadow" && config.prefilter === "shadow",
  },
  note: "Isolated rehearsal only. No production store, service, job, pointer or environment was touched.",
};
await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
