#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import {
  AdmissionEpochManager,
  epochDatabasePath,
  proposeNextEpochId,
  readActiveEpochPointer,
  readSealedEpoch,
  rolloverAdmissionEpoch,
} from "../gateway/admission-epochs.js";
import { backupAdmissionState } from "../gateway/admission-backup.js";
import { AdmissionPolicyManager, readActivePolicyPointer } from "../gateway/admission-policy.js";
import { Frontier } from "../frontier.js";

const USAGE = `SimpleMindsAI admission epoch control

Usage:
  node src/cli/admission.js status   [--admission-dir DIR] [--frontier-dir DIR]
  node src/cli/admission.js policy-status [--admission-dir DIR] [--frontier-dir DIR]
  node src/cli/admission.js backup   --backup-root DIR [--admission-dir DIR] [--frontier-dir DIR]
  node src/cli/admission.js rollover --epoch ID --cap N [--ack-required] [--protocol-version V]
                                     [--recover-cap-rejected] [--backup-root DIR]
                                     [--admission-dir DIR] [--frontier-dir DIR]
  node src/cli/admission.js rollover --next-epoch --cap N [...] [--dry-run]
  node src/cli/admission.js recover  [--epoch ID] [--dry-run]
                                     [--admission-dir DIR] [--frontier-dir DIR]

Rollover never edits the active sealed database. It seals a new isolated epoch
under epochs/<ID>/admission.sqlite, then atomically switches ACTIVE_EPOCH.json.
The running service adopts the new pointer within a few seconds.
`;

function int(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

function defaultBackupRoot(admissionDir) {
  const dataDir = path.dirname(path.resolve(admissionDir));
  if (path.basename(dataDir) === "data") return path.join(path.dirname(dataDir), "backups");
  return path.join(dataDir, "backups");
}

function envConfig(admissionDir) {
  const cap = process.env.ADMISSION_CAP_LIMIT;
  const epoch = process.env.ADMISSION_CAP_EPOCH;
  if (!cap || !epoch) return null;
  return {
    capLimit: int(cap, "ADMISSION_CAP_LIMIT"),
    capEpoch: epoch,
    ackRequired: String(process.env.ADMISSION_ACK_REQUIRED ?? "false").toLowerCase() === "true",
    protocolVersion: process.env.ADMISSION_PROTOCOL_VERSION ?? "baseline-v1",
    dir: admissionDir,
  };
}

async function status({ admissionDir, frontierDir }) {
  const pointer = readActiveEpochPointer(admissionDir);
  const legacy = existsSync(path.join(admissionDir, "admission.sqlite"))
    ? await readSealedEpoch({ dir: admissionDir })
    : null;
  let active = null;
  if (pointer) {
    const file = epochDatabasePath(admissionDir, pointer.epoch);
    active = existsSync(file) ? await readSealedEpoch({ dir: path.dirname(file) }) : { epoch: pointer.epoch, error: "missing-database" };
  } else if (legacy) {
    active = { ...legacy, epoch: legacy.capEpoch, source: "legacy" };
  }
  const frontier = new Frontier({ dir: frontierDir });
  await frontier.init();
  const capRejected = frontier.capRejectedCount();
  return {
    admissionDir,
    frontierDir,
    policy: readActivePolicyPointer(admissionDir),
    active: active
      ? {
          epoch: active.epoch ?? active.capEpoch ?? null,
          capLimit: active.capLimit ?? null,
          capUsed: active.capUsed ?? null,
          directory: active.dir ?? null,
          source: pointer ? "pointer" : "legacy",
        }
      : null,
    pointer,
    legacy: legacy
      ? { epoch: legacy.capEpoch, capLimit: legacy.capLimit, capUsed: legacy.capUsed, directory: legacy.dir }
      : null,
    capRejectedFrontier: capRejected,
    rolloverRecommended: Boolean(active && active.capLimit != null && active.capUsed >= active.capLimit),
    proposedNextEpoch: proposeNextEpochId({ rootDir: admissionDir }),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "admission-dir": { type: "string" },
      "frontier-dir": { type: "string" },
      "backup-root": { type: "string" },
      epoch: { type: "string" },
      cap: { type: "string" },
      "ack-required": { type: "boolean", default: false },
      "protocol-version": { type: "string" },
      "next-epoch": { type: "boolean", default: false },
      "recover-cap-rejected": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  const command = positionals[0];
  const admissionDir = path.resolve(values["admission-dir"] ?? process.env.ADMISSION_DIR ?? "data/gateway");
  const frontierDir = path.resolve(values["frontier-dir"] ?? process.env.FRONTIER_DIR ?? "data/frontier");
  const clock = () => new Date();

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await status({ admissionDir, frontierDir }), null, 2)}\n`);
    return;
  }

  if (command === "policy-status") {
    const hasPolicy = existsSync(path.join(admissionDir, "ACTIVE_POLICY.json"));
    const hasEpoch = existsSync(path.join(admissionDir, "ACTIVE_EPOCH.json"));
    const hasLegacy = existsSync(path.join(admissionDir, "admission.sqlite"));
    if (!hasPolicy && !hasEpoch && !hasLegacy) {
      process.stdout.write(`${JSON.stringify({ mode: "none", admissionDir }, null, 2)}\n`);
      return;
    }
    const manager = await AdmissionPolicyManager.open({
      dir: admissionDir,
      config: envConfig(admissionDir),
      clock,
      logger: console,
    });
    try {
      process.stdout.write(`${JSON.stringify(manager.status(), null, 2)}\n`);
    } finally {
      manager.close();
    }
    return;
  }

  if (command === "backup") {
    const backupRoot = path.resolve(values["backup-root"] ?? defaultBackupRoot(admissionDir));
    const result = await backupAdmissionState({ admissionDir, frontierDir, backupRoot, clock, logger: console });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "recover") {
    const frontier = new Frontier({ dir: frontierDir });
    await frontier.init();
    const before = frontier.capRejectedCount();
    if (values["dry-run"]) {
      const preview = await frontier.recoverCapRejected({ epoch: values.epoch ?? null, dryRun: true });
      process.stdout.write(`${JSON.stringify({ ...preview, before }, null, 2)}\n`);
      return;
    }
    const result = await frontier.recoverCapRejected({ epoch: values.epoch ?? null });
    process.stdout.write(`${JSON.stringify({ ...result, before, after: frontier.capRejectedCount() }, null, 2)}\n`);
    return;
  }

  if (command === "rollover") {
    const capLimit = int(values.cap ?? "500", "--cap");
    const protocolVersion = values["protocol-version"] ?? process.env.ADMISSION_PROTOCOL_VERSION ?? "baseline-v1";
    const ackRequired = values["ack-required"] || String(process.env.ADMISSION_ACK_REQUIRED ?? "false").toLowerCase() === "true";
    let newEpoch = values.epoch;
    if (!newEpoch && values["next-epoch"]) newEpoch = proposeNextEpochId({ rootDir: admissionDir, now: clock() });
    if (!newEpoch) throw new Error("rollover requires --epoch ID or --next-epoch");

    const current = readActiveEpochPointer(admissionDir);
    const legacy = !current && existsSync(path.join(admissionDir, "admission.sqlite"))
      ? await readSealedEpoch({ dir: admissionDir })
      : null;
    const currentEpoch = current?.epoch ?? legacy?.capEpoch ?? null;

    if (values["dry-run"]) {
      const targetDir = path.dirname(epochDatabasePath(admissionDir, newEpoch));
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun: true,
            currentEpoch,
            newEpoch,
            capLimit,
            ackRequired,
            protocolVersion,
            targetDir,
            targetExists: existsSync(path.join(targetDir, "admission.sqlite")),
            recoverCapRejected: Boolean(values["recover-cap-rejected"]),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    let backup = null;
    if (values["backup-root"]) {
      backup = await backupAdmissionState({
        admissionDir,
        frontierDir,
        backupRoot: path.resolve(values["backup-root"]),
        clock,
        logger: console,
      });
    }

    const rollover = await rolloverAdmissionEpoch({
      dir: admissionDir,
      newEpoch,
      capLimit,
      ackRequired,
      protocolVersion,
      reason: "operator-rollover",
      clock,
      logger: console,
    });

    let recovery = null;
    if (values["recover-cap-rejected"]) {
      const frontier = new Frontier({ dir: frontierDir });
      await frontier.init();
      const before = frontier.capRejectedCount();
      const result = await frontier.recoverCapRejected({ epoch: newEpoch });
      recovery = { ...result, before, after: frontier.capRejectedCount() };
    }

    process.stdout.write(`${JSON.stringify({ rollover, recovery, backup }, null, 2)}\n`);
    return;
  }

  if (command === "manager") {
    const manager = await AdmissionEpochManager.open({
      dir: admissionDir,
      config: envConfig(admissionDir),
      clock,
      logger: console,
    });
    try {
      process.stdout.write(`${JSON.stringify(manager.status(), null, 2)}\n`);
    } finally {
      manager.close();
    }
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
  process.stderr.write(`[admission] ${err?.code ? `${err.code}: ` : ""}${err?.message ?? String(err)}\n`);
  process.exitCode = 1;
});
