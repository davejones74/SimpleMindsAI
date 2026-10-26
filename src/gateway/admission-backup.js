import { createHash } from "node:crypto";
import { createReadStream, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import path from "node:path";
import {
  ACTIVE_EPOCH_FILE,
  EPOCH_LEDGER_FILE,
  LEGACY_DB_FILE,
  epochDatabasePath,
  readActiveEpochPointer,
} from "./admission-epochs.js";
import { FRONTIER_FILE } from "../frontier.js";

async function hashFile(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function stampFor(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * Consistent, read-only backup of the admission database(s), the active pointer,
 * the epoch ledger and the frontier. The originals are never moved or modified.
 * Run with acquisition stopped: the frontier file is copied, not locked.
 */
export async function backupAdmissionState({
  admissionDir,
  frontierDir,
  backupRoot,
  clock = () => new Date(),
  logger = null,
} = {}) {
  if (!admissionDir) throw new Error("admissionDir is required");
  if (!frontierDir) throw new Error("frontierDir is required");
  if (!backupRoot) throw new Error("backupRoot is required");

  const now = clock();
  const destination = path.join(backupRoot, `admission-rollover-${stampFor(now)}`);
  if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
  mkdirSync(destination, { recursive: true, mode: 0o750 });

  const files = [];
  const pointer = readActiveEpochPointer(admissionDir);
  const dbs = [];
  if (pointer) dbs.push({ label: `active-${pointer.epoch}`, file: path.join(epochDatabasePath(admissionDir, pointer.epoch)) });
  const legacy = path.join(admissionDir, LEGACY_DB_FILE);
  if (existsSync(legacy)) dbs.push({ label: "legacy", file: legacy });

  for (const entry of dbs) {
    if (!existsSync(entry.file)) continue;
    const target = path.join(destination, `${entry.label}.sqlite`);
    const db = new DatabaseSync(entry.file, { readOnly: true });
    try {
      await backup(db, target);
    } finally {
      db.close();
    }
    files.push({ role: `admission:${entry.label}`, source: entry.file, backup: target, bytes: statSync(target).size, sha256: await hashFile(target) });
  }

  for (const [role, source] of [
    ["active-pointer", path.join(admissionDir, ACTIVE_EPOCH_FILE)],
    ["epoch-ledger", path.join(admissionDir, EPOCH_LEDGER_FILE)],
    ["frontier", path.join(frontierDir, FRONTIER_FILE)],
  ]) {
    if (!existsSync(source)) continue;
    const target = path.join(destination, `${role}${path.extname(source) || (role === "frontier" ? ".ndjson" : ".json")}`);
    copyFileSync(source, target);
    files.push({ role, source, backup: target, bytes: statSync(target).size, sha256: await hashFile(target) });
  }

  const manifest = {
    kind: "admission-rollover-backup",
    createdAt: now.toISOString(),
    admissionDir,
    frontierDir,
    activeEpoch: pointer?.epoch ?? null,
    files,
  };
  writeFileSync(path.join(destination, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
  logger?.log?.(`[admission] backup written to ${destination} (${files.length} file(s))`);
  return { destination, manifest };
}
