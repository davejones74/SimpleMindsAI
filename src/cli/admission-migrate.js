#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../config.js";
import { readActiveEpochPointer } from "../gateway/admission-epochs.js";
import { migrateRollingPolicy } from "../gateway/admission-migration.js";

const USAGE = `Rolling admission migration (Stage 2)

Usage:
  node src/cli/admission-migrate.js --source-dir DIR --target-dir DIR [options]
  node src/cli/admission-migrate.js --source-dir DIR --target-dir DIR --execute [options]

Default mode is a read-only dry-run. Real migration requires --execute and writes
only to --target-dir/--manifest. This tool never creates ACTIVE_POLICY.json and
never switches the active policy.

Options:
  --source-dir DIR       Admission directory containing legacy/epoch stores
  --target-dir DIR       New rolling-v1 policy store directory
  --manifest FILE        Migration manifest output path
  --frontier-dir DIR     Optional frontier directory/file for domain scope backfill
  --cap-epoch ID         Target policy identity scope (default: active epoch/env)
  --quota-limit N        Default 50000
  --quota-window-ms N    Default 86400000
  --per-domain-limit N   Default 5000
  --rate-limit N         Default 2000
  --execute              Perform the real migration (still no pointer switch)
  --help, -h
`;

function int(value, name, dflt) {
  if (value === undefined) return dflt;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    "target-dir": { type: "string" },
    manifest: { type: "string" },
    "frontier-dir": { type: "string" },
    "cap-epoch": { type: "string" },
    "quota-limit": { type: "string" },
    "quota-window-ms": { type: "string" },
    "per-domain-limit": { type: "string" },
    "rate-limit": { type: "string" },
    execute: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const sourceDir = values["source-dir"] ? path.resolve(values["source-dir"]) : null;
const targetDir = values["target-dir"] ? path.resolve(values["target-dir"]) : null;
if (!sourceDir || !targetDir) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const active = readActiveEpochPointer(sourceDir);
const capEpoch = values["cap-epoch"] ?? active?.epoch ?? config.admissionCapEpoch;
const policyConfig = {
  ...config.admissionPolicy,
  capEpoch,
  ackRequired: config.admissionAckRequired,
  protocolVersion: config.admissionProtocolVersion,
  quotaLimit: int(values["quota-limit"], "quota-limit", config.admissionPolicy.quotaLimit),
  quotaWindowMs: int(values["quota-window-ms"], "quota-window-ms", config.admissionPolicy.quotaWindowMs),
  perDomainLimit: int(values["per-domain-limit"], "per-domain-limit", config.admissionPolicy.perDomainLimit),
  rateLimit: int(values["rate-limit"], "rate-limit", config.admissionPolicy.rateLimit),
};
const frontierFile = values["frontier-dir"] ? path.resolve(values["frontier-dir"]) : null;
const manifestPath = values.manifest
  ? path.resolve(values.manifest)
  : values.execute
    ? path.join(targetDir, "migration-manifest.json")
    : null;

try {
  const manifest = await migrateRollingPolicy({
    admissionDir: sourceDir,
    targetDir,
    policyConfig,
    frontierFile,
    dryRun: !values.execute,
    manifestPath,
  });
  if (!manifestPath) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        mode: manifest.mode,
        sources: manifest.sources.length,
        imported: manifest.decisions.imported,
        capRejectedExcluded: manifest.decisions.capRejectedExcluded,
        quota: manifest.quota,
        target: manifest.target,
        verification: manifest.verification,
        pointerCreated: manifest.pointerCreated,
        manifest: manifestPath,
      }, null, 2)}\n`,
    );
  }
} catch (err) {
  process.stderr.write(`[migration] ${err?.code ? `${err.code}: ` : ""}${err?.message ?? String(err)}\n`);
  if (err?.details) process.stderr.write(`${JSON.stringify(err.details, null, 2)}\n`);
  process.exitCode = 1;
}
