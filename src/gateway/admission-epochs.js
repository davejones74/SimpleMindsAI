import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { AdmissionStore } from "./admission-store.js";

/**
 * Durable admission-epoch ownership.
 *
 * The original Baseline v1 store lives at `<ADMISSION_DIR>/admission.sqlite` and
 * is immutable once sealed. A rollover never edits that database: it seals a
 * new, isolated store under `<ADMISSION_DIR>/epochs/<epoch>/admission.sqlite`
 * and atomically moves `<ADMISSION_DIR>/ACTIVE_EPOCH.json` to the new epoch.
 *
 * The pointer is authoritative for the running service, so an explicit rollover
 * performed by a CLI is picked up by the acquisition gateway without editing the
 * old epoch or restarting the process. Every transition is also appended to
 * `<ADMISSION_DIR>/epochs.ndjson` for audit.
 */

export const ACTIVE_EPOCH_FILE = "ACTIVE_EPOCH.json";
export const EPOCH_LEDGER_FILE = "epochs.ndjson";
export const EPOCHS_DIR = "epochs";
export const LEGACY_DB_FILE = "admission.sqlite";
export const ROLLOVER_LOCK_DIR = "ROLLOVER.lock";
export const POINTER_VERSION = 1;

const EPOCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const LOCK_STALE_MS = 10 * 60 * 1000;

export class AdmissionEpochError extends Error {
  constructor(message, code = "ADMISSION_EPOCH_ERROR") {
    super(message);
    this.name = "AdmissionEpochError";
    this.code = code;
  }
}

export function validateEpochId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdmissionEpochError("epoch must be a non-empty string", "INVALID_EPOCH");
  }
  if (value !== value.trim() || CONTROL_RE.test(value) || !EPOCH_ID_RE.test(value) || value.includes("..")) {
    throw new AdmissionEpochError(
      "epoch must match [A-Za-z0-9][A-Za-z0-9._-]{2,199}, without whitespace, control characters or '..'",
      "INVALID_EPOCH",
    );
  }
  return value;
}

export function epochDirectory(rootDir, epoch) {
  return path.join(rootDir, EPOCHS_DIR, validateEpochId(epoch));
}

export function epochDatabasePath(rootDir, epoch) {
  return path.join(epochDirectory(rootDir, epoch), LEGACY_DB_FILE);
}

export function activePointerPath(rootDir) {
  return path.join(rootDir, ACTIVE_EPOCH_FILE);
}

export function epochLedgerPath(rootDir) {
  return path.join(rootDir, EPOCH_LEDGER_FILE);
}

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AdmissionEpochError("clock returned an invalid date", "INVALID_CLOCK");
  }
  return date.toISOString();
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new AdmissionEpochError(`unreadable ${path.basename(file)}: ${err.message}`, "EPOCH_METADATA_UNREADABLE");
  }
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(tmp, "w", 0o640);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  // Best-effort directory fsync so the rename survives a host crash.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* not all platforms permit opening a directory */
  }
}

function appendLedgerLine(rootDir, record) {
  mkdirSync(rootDir, { recursive: true });
  const file = epochLedgerPath(rootDir);
  const fd = openSync(file, "a", 0o640);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validatePointerShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdmissionEpochError(`${ACTIVE_EPOCH_FILE} must contain an object`, "EPOCH_POINTER_INVALID");
  }
  if (value.version !== POINTER_VERSION) {
    throw new AdmissionEpochError(`unsupported epoch pointer version ${String(value.version)}`, "EPOCH_POINTER_INVALID");
  }
  validateEpochId(value.epoch);
  if (!Number.isSafeInteger(value.capLimit) || value.capLimit < 1) {
    throw new AdmissionEpochError("epoch pointer capLimit must be a positive safe integer", "EPOCH_POINTER_INVALID");
  }
  if (typeof value.ackRequired !== "boolean") {
    throw new AdmissionEpochError("epoch pointer ackRequired must be a boolean", "EPOCH_POINTER_INVALID");
  }
  if (typeof value.protocolVersion !== "string" || !value.protocolVersion.trim()) {
    throw new AdmissionEpochError("epoch pointer protocolVersion is required", "EPOCH_POINTER_INVALID");
  }
  if (typeof value.activatedAt !== "string" || Number.isNaN(Date.parse(value.activatedAt))) {
    throw new AdmissionEpochError("epoch pointer activatedAt must be an ISO timestamp", "EPOCH_POINTER_INVALID");
  }
  if (value.previousEpoch != null) validateEpochId(value.previousEpoch);
  return value;
}

/** Active epoch pointer, or null when no rollover has occurred yet. */
export function readActiveEpochPointer(rootDir) {
  const raw = readJsonFile(activePointerPath(rootDir));
  return raw == null ? null : validatePointerShape(raw);
}

/** Append-only epoch history. Malformed trailing lines are ignored. */
export function readEpochLedger(rootDir) {
  const file = epochLedgerPath(rootDir);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a crash can leave one torn trailing line; the committed prefix is valid */
    }
  }
  return out;
}

export async function readSealedEpoch({ dir, config = null, clock = () => new Date(), faultInjector = null } = {}) {
  const file = path.join(dir, LEGACY_DB_FILE);
  if (!existsSync(file)) return null;
  const store = await AdmissionStore.open({ dir, config, clock, faultInjector });
  try {
    const sealed = store.sealedConfig;
    if (!sealed) {
      throw new AdmissionEpochError(`admission store at ${dir} is not sealed`, "EPOCH_UNSEALED");
    }
    return { ...sealed, capUsed: store.capUsage(), dir };
  } finally {
    store.close();
  }
}

function assertPointerMatchesStore(pointer, sealed) {
  if (
    pointer.capLimit !== sealed.capLimit ||
    pointer.ackRequired !== sealed.ackRequired ||
    pointer.protocolVersion !== sealed.protocolVersion ||
    pointer.epoch !== sealed.capEpoch
  ) {
    throw new AdmissionEpochError(
      `active epoch pointer does not match the sealed store (${pointer.epoch})`,
      "EPOCH_POINTER_MISMATCH",
    );
  }
}

/**
 * Open the currently active epoch. A pointer always wins over env/bootstrap
 * configuration; the legacy root database is used only when no pointer exists.
 */
export async function openActiveAdmissionStore({
  dir,
  config = null,
  clock = () => new Date(),
  faultInjector = null,
  logger = null,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const pointer = readActiveEpochPointer(dir);
  if (pointer) {
    const targetDir = epochDirectory(dir, pointer.epoch);
    const targetDb = path.join(targetDir, LEGACY_DB_FILE);
    if (!existsSync(targetDb)) {
      throw new AdmissionEpochError(
        `active epoch ${pointer.epoch} points at a missing database (${targetDb})`,
        "EPOCH_TARGET_MISSING",
      );
    }
    const store = await AdmissionStore.open({ dir: targetDir, config: null, clock, faultInjector });
    try {
      if (!store.sealedConfig) {
        throw new AdmissionEpochError(`active epoch ${pointer.epoch} is not sealed`, "EPOCH_UNSEALED");
      }
      assertPointerMatchesStore(pointer, store.sealedConfig);
    } catch (err) {
      store.close();
      throw err;
    }
    const warnings = [];
    if (config?.capEpoch && config.capEpoch !== pointer.epoch) {
      warnings.push(`env ADMISSION_CAP_EPOCH=${config.capEpoch} is stale; active epoch is ${pointer.epoch}`);
    }
    if (config && Number.isFinite(config.capLimit) && config.capLimit !== store.sealedConfig.capLimit) {
      warnings.push(`env ADMISSION_CAP_LIMIT=${config.capLimit} is stale; active cap is ${store.sealedConfig.capLimit}`);
    }
    for (const warning of warnings) logger?.warn?.(`[admission] ${warning}`);
    return {
      store,
      epoch: pointer.epoch,
      dir: targetDir,
      source: "pointer",
      pointer,
      warnings,
    };
  }

  const store = await AdmissionStore.open({ dir, config, clock, faultInjector });
  return {
    store,
    epoch: store.sealedConfig?.capEpoch ?? null,
    dir,
    source: "legacy",
    pointer: null,
    warnings: [],
  };
}

function acquireRolloverLock(rootDir, clock) {
  const lockDir = path.join(rootDir, ROLLOVER_LOCK_DIR);
  const ownerFile = path.join(lockDir, "owner.json");
  try {
    mkdirSync(lockDir);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    let stale = false;
    try {
      stale = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = false;
    }
    if (!stale) {
      let owner = null;
      try {
        owner = readJsonFile(ownerFile);
      } catch {
        owner = null;
      }
      throw new AdmissionEpochError(
        `another rollover is in progress${owner?.pid ? ` (pid ${owner.pid})` : ""}`,
        "ROLLOVER_LOCKED",
      );
    }
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  const owner = { pid: process.pid, host: process.env.HOSTNAME ?? null, startedAt: iso(clock) };
  writeFileSync(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o640 });
  return () => rmSync(lockDir, { recursive: true, force: true });
}

function hasEpochRecord(ledger, epoch) {
  return ledger.some((record) => record?.type === "epoch" && record.epoch === epoch);
}

function hasActiveRecord(ledger, epoch) {
  return ledger.some((record) => record?.type === "active" && record.epoch === epoch);
}

export function proposeNextEpochId({ rootDir, now = new Date(), prefix = "gateway" } = {}) {
  const datePart = now.toISOString().slice(0, 10).replaceAll("-", "");
  const ledger = readEpochLedger(rootDir);
  const existing = new Set([
    ...ledger.filter((r) => r?.type === "epoch").map((r) => r.epoch),
    ...(existsSync(path.join(rootDir, EPOCHS_DIR))
      ? readdirSync(path.join(rootDir, EPOCHS_DIR), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : []),
  ]);
  for (let sequence = 1; sequence <= 9999; sequence += 1) {
    const candidate = `${prefix}-${datePart}-${String(sequence).padStart(2, "0")}`;
    if (!existing.has(candidate) && !existsSync(epochDirectory(rootDir, candidate))) return candidate;
  }
  throw new AdmissionEpochError("could not allocate a unique epoch id", "EPOCH_ID_EXHAUSTED");
}

/**
 * Seal and activate a new epoch. The currently active store is never modified.
 * Re-running with the already-active epoch is idempotent; re-activating an old
 * epoch that has admitted requests is refused.
 */
export async function rolloverAdmissionEpoch({
  dir,
  newEpoch,
  capLimit = 500,
  ackRequired = false,
  protocolVersion = "baseline-v1",
  clock = () => new Date(),
  faultInjector = null,
  reason = "operator-requested",
  logger = null,
} = {}) {
  validateEpochId(newEpoch);
  if (!Number.isSafeInteger(capLimit) || capLimit < 1) {
    throw new AdmissionEpochError("capLimit must be a positive safe integer", "INVALID_CAP_LIMIT");
  }
  if (typeof ackRequired !== "boolean") {
    throw new AdmissionEpochError("ackRequired must be a boolean", "INVALID_ACK_REQUIRED");
  }
  if (typeof protocolVersion !== "string" || !protocolVersion.trim()) {
    throw new AdmissionEpochError("protocolVersion is required", "INVALID_PROTOCOL_VERSION");
  }

  mkdirSync(dir, { recursive: true });
  const release = acquireRolloverLock(dir, clock);
  try {
    const pointer = readActiveEpochPointer(dir);
    const ledger = readEpochLedger(dir);
    let previous = null;

    if (pointer) {
      previous = {
        epoch: pointer.epoch,
        dir: epochDirectory(dir, pointer.epoch),
        source: "pointer",
        capLimit: pointer.capLimit,
      };
    } else {
      const legacy = await readSealedEpoch({ dir, clock, faultInjector });
      if (legacy) {
        previous = {
          epoch: legacy.capEpoch,
          dir,
          source: "legacy",
          capLimit: legacy.capLimit,
          capUsed: legacy.capUsed,
        };
      }
    }

    if (previous?.epoch === newEpoch) {
      const active = await readSealedEpoch({ dir: epochDirectory(dir, newEpoch), clock, faultInjector });
      if (!active) throw new AdmissionEpochError(`active epoch ${newEpoch} has no sealed store`, "EPOCH_UNSEALED");
      if (
        active.capLimit !== capLimit ||
        active.ackRequired !== ackRequired ||
        active.protocolVersion !== protocolVersion
      ) {
        throw new AdmissionEpochError(
          `epoch ${newEpoch} is already active with a different sealed configuration`,
          "EPOCH_CONFIG_MISMATCH",
        );
      }
      return {
        activated: false,
        alreadyActive: true,
        previous: null,
        epoch: newEpoch,
        dir: epochDirectory(dir, newEpoch),
        capLimit: active.capLimit,
        capUsed: active.capUsed,
      };
    }

    const targetDir = epochDirectory(dir, newEpoch);
    const targetDb = path.join(targetDir, LEGACY_DB_FILE);
    const exists = existsSync(targetDb);
    if (exists) {
      const sealed = await readSealedEpoch({ dir: targetDir, clock, faultInjector });
      if (!sealed) throw new AdmissionEpochError(`epoch ${newEpoch} has no sealed store`, "EPOCH_UNSEALED");
      if (
        sealed.capEpoch !== newEpoch ||
        sealed.capLimit !== capLimit ||
        sealed.ackRequired !== ackRequired ||
        sealed.protocolVersion !== protocolVersion
      ) {
        throw new AdmissionEpochError(
          `epoch ${newEpoch} exists with a different sealed configuration`,
          "EPOCH_CONFIG_MISMATCH",
        );
      }
      if (hasActiveRecord(ledger, newEpoch) || sealed.capUsed > 0) {
        throw new AdmissionEpochError(
          `epoch ${newEpoch} was already used and cannot be reactivated`,
          "EPOCH_ALREADY_USED",
        );
      }
    } else {
      mkdirSync(targetDir, { recursive: true, mode: 0o750 });
      const store = await AdmissionStore.open({
        dir: targetDir,
        config: { capLimit, capEpoch: newEpoch, ackRequired, protocolVersion },
        clock,
        faultInjector,
      });
      store.close();
    }

    if (!hasEpochRecord(ledger, newEpoch)) {
      appendLedgerLine(dir, {
        type: "epoch",
        epoch: newEpoch,
        capLimit,
        ackRequired,
        protocolVersion,
        sealedAt: iso(clock),
      });
    }

    const activatedAt = iso(clock);
    const pointerRecord = {
      version: POINTER_VERSION,
      epoch: newEpoch,
      capLimit,
      ackRequired,
      protocolVersion,
      activatedAt,
      previousEpoch: previous?.epoch ?? null,
      reason,
    };
    atomicWriteJson(activePointerPath(dir), pointerRecord);
    appendLedgerLine(dir, {
      type: "active",
      epoch: newEpoch,
      previousEpoch: previous?.epoch ?? null,
      capLimit,
      activatedAt,
      reason,
    });
    logger?.log?.(`[admission] activated epoch ${newEpoch} (cap ${capLimit}); previous ${previous?.epoch ?? "none"}`);

    return {
      activated: true,
      alreadyActive: false,
      previous,
      epoch: newEpoch,
      dir: targetDir,
      capLimit,
      capUsed: 0,
      pointer: pointerRecord,
    };
  } finally {
    release();
  }
}

/**
 * Process-local view of the active epoch. The gateway calls `maybeRefresh`
 * before an admission and forcibly after a cap rejection, so an operator-run
 * rollover is adopted without restarting the service.
 */
export class AdmissionEpochManager {
  #rootDir;
  #config;
  #clock;
  #faultInjector;
  #logger;
  #store;
  #epoch;
  #dir;
  #source;
  #pointer;
  #warnings;
  #lastCheckAt = 0;
  #refreshing = null;
  #closed = false;

  static async open({
    dir,
    config = null,
    clock = () => new Date(),
    faultInjector = null,
    logger = null,
  } = {}) {
    const resolved = await openActiveAdmissionStore({ dir, config, clock, faultInjector, logger });
    return new AdmissionEpochManager({
      rootDir: dir,
      config,
      clock,
      faultInjector,
      logger,
      ...resolved,
    });
  }

  constructor({ rootDir, config, clock, faultInjector, logger, store, epoch, dir, source, pointer, warnings }) {
    this.#rootDir = rootDir;
    this.#config = config;
    this.#clock = clock;
    this.#faultInjector = faultInjector;
    this.#logger = logger;
    this.#store = store;
    this.#epoch = epoch;
    this.#dir = dir;
    this.#source = source;
    this.#pointer = pointer;
    this.#warnings = warnings ?? [];
  }

  get store() {
    return this.#store;
  }

  get epoch() {
    return this.#epoch;
  }

  get directory() {
    return this.#dir;
  }

  get source() {
    return this.#source;
  }

  get pointer() {
    return this.#pointer;
  }

  get warnings() {
    return [...this.#warnings];
  }

  get capLimit() {
    return this.#store?.sealedConfig?.capLimit ?? null;
  }

  capUsage() {
    return this.#store?.capUsage() ?? 0;
  }

  status() {
    return {
      epoch: this.#epoch,
      directory: this.#dir,
      source: this.#source,
      capLimit: this.capLimit,
      capUsed: this.capUsage(),
      sealedConfig: this.#store?.sealedConfig ?? null,
      pointer: this.#pointer,
      warnings: [...this.#warnings],
    };
  }

  /** Adopt a new durable active pointer. Returns true when the store changed. */
  async maybeRefresh({ force = false, maxAgeMs = 5000, config = this.#config } = {}) {
    if (this.#closed) throw new AdmissionEpochError("admission epoch manager is closed", "MANAGER_CLOSED");
    if (this.#refreshing) return this.#refreshing;
    const now = Date.now();
    if (!force && now - this.#lastCheckAt < maxAgeMs) return false;
    this.#lastCheckAt = now;
    this.#refreshing = (async () => {
      const pointer = readActiveEpochPointer(this.#rootDir);
      if (!pointer || pointer.epoch === this.#epoch) return false;
      const next = await openActiveAdmissionStore({
        dir: this.#rootDir,
        config,
        clock: this.#clock,
        faultInjector: this.#faultInjector,
        logger: this.#logger,
      });
      const previousStore = this.#store;
      this.#store = next.store;
      this.#epoch = next.epoch;
      this.#dir = next.dir;
      this.#source = next.source;
      this.#pointer = next.pointer;
      this.#warnings = next.warnings;
      previousStore?.close?.();
      this.#logger?.log?.(
        `[admission] adopted active epoch ${this.#epoch} (cap ${next.store?.sealedConfig?.capLimit ?? "?"}); previous store closed`,
      );
      return true;
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#store?.close?.();
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
