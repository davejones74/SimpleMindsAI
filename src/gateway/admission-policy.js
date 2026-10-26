import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { AdmissionEpochManager } from "./admission-epochs.js";
import { RollingAdmissionStore } from "./rolling-admission-store.js";

/**
 * Durable policy selection for article admission.
 *
 * `ACTIVE_POLICY.json` selects a versioned rolling-policy store. When the
 * pointer is absent, the legacy sealed epoch remains the active store. Neither
 * the pointer nor the rolling store is created automatically; migration is an
 * explicit operator/tool action.
 */

export const ACTIVE_POLICY_FILE = "ACTIVE_POLICY.json";
export const POLICIES_DIR = "policies";
export const POLICY_DB_FILE = "admission.sqlite";
export const POLICY_POINTER_VERSION = 1;

const POLICY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class AdmissionPolicyError extends Error {
  constructor(message, code = "ADMISSION_POLICY_ERROR") {
    super(message);
    this.name = "AdmissionPolicyError";
    this.code = code;
  }
}

export function validatePolicyId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AdmissionPolicyError("policyId must be a non-empty string", "INVALID_POLICY_ID");
  }
  if (value !== value.trim() || CONTROL_RE.test(value) || !POLICY_ID_RE.test(value) || value.includes("..")) {
    throw new AdmissionPolicyError(
      "policyId must match [A-Za-z0-9][A-Za-z0-9._-]{2,199}, without whitespace, control characters or '..'",
      "INVALID_POLICY_ID",
    );
  }
  return value;
}

export function policyDirectory(rootDir, policyId) {
  return path.join(rootDir, POLICIES_DIR, validatePolicyId(policyId));
}

export function policyDatabasePath(rootDir, policyId) {
  return path.join(policyDirectory(rootDir, policyId), POLICY_DB_FILE);
}

export function activePolicyPath(rootDir) {
  return path.join(rootDir, ACTIVE_POLICY_FILE);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new AdmissionPolicyError(`unreadable ${path.basename(file)}: ${err.message}`, "POLICY_METADATA_UNREADABLE");
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
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* best effort */
  }
}

function positiveInt(value, name, { allowZero = false } = {}) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new AdmissionPolicyError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`, "POLICY_POINTER_INVALID");
  }
  return n;
}

function validatePointer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdmissionPolicyError(`${ACTIVE_POLICY_FILE} must contain an object`, "POLICY_POINTER_INVALID");
  }
  if (value.version !== POLICY_POINTER_VERSION) {
    throw new AdmissionPolicyError(`unsupported policy pointer version ${String(value.version)}`, "POLICY_POINTER_INVALID");
  }
  const policyId = validatePolicyId(value.policyId);
  if (value.policyVersion !== "rolling-v1") {
    throw new AdmissionPolicyError(`unsupported policyVersion ${String(value.policyVersion)}`, "POLICY_POINTER_INVALID");
  }
  if (value.policyMode !== "rolling") {
    throw new AdmissionPolicyError(`unsupported policyMode ${String(value.policyMode)}`, "POLICY_POINTER_INVALID");
  }
  if (typeof value.capEpoch !== "string" || !value.capEpoch.trim()) {
    throw new AdmissionPolicyError("policy pointer capEpoch is required", "POLICY_POINTER_INVALID");
  }
  if (typeof value.ackRequired !== "boolean") {
    throw new AdmissionPolicyError("policy pointer ackRequired must be a boolean", "POLICY_POINTER_INVALID");
  }
  if (typeof value.protocolVersion !== "string" || !value.protocolVersion.trim()) {
    throw new AdmissionPolicyError("policy pointer protocolVersion is required", "POLICY_POINTER_INVALID");
  }
  if (typeof value.activatedAt !== "string" || Number.isNaN(Date.parse(value.activatedAt))) {
    throw new AdmissionPolicyError("policy pointer activatedAt must be an ISO timestamp", "POLICY_POINTER_INVALID");
  }
  if (typeof value.configHash !== "string" || !/^[0-9a-f]{64}$/i.test(value.configHash)) {
    throw new AdmissionPolicyError("policy pointer configHash must be a SHA-256 hex digest", "POLICY_POINTER_INVALID");
  }
  const expected = path.join(POLICIES_DIR, policyId);
  if (value.directory != null && value.directory !== expected) {
    throw new AdmissionPolicyError(`policy pointer directory must be ${expected}`, "POLICY_POINTER_INVALID");
  }
  return {
    ...value,
    policyId,
    directory: expected,
    quotaWindowMs: positiveInt(value.quotaWindowMs, "quotaWindowMs"),
    quotaLimit: positiveInt(value.quotaLimit, "quotaLimit"),
    perDomainLimit: positiveInt(value.perDomainLimit, "perDomainLimit", { allowZero: true }),
    perDomainWindowMs: positiveInt(value.perDomainWindowMs, "perDomainWindowMs"),
    rateWindowMs: positiveInt(value.rateWindowMs, "rateWindowMs"),
    rateLimit: positiveInt(value.rateLimit, "rateLimit"),
    maxConcurrent: positiveInt(value.maxConcurrent, "maxConcurrent"),
    storageMinFreeBytes: positiveInt(value.storageMinFreeBytes, "storageMinFreeBytes", { allowZero: true }),
    storageMaxDbBytes: positiveInt(value.storageMaxDbBytes, "storageMaxDbBytes", { allowZero: true }),
    storageRetryMs: positiveInt(value.storageRetryMs, "storageRetryMs"),
    deferralRetentionMs: positiveInt(value.deferralRetentionMs, "deferralRetentionMs"),
    deferralMaxRows: positiveInt(value.deferralMaxRows, "deferralMaxRows"),
  };
}

export function readActivePolicyPointer(rootDir) {
  const raw = readJson(activePolicyPath(rootDir));
  return raw == null ? null : validatePointer(raw);
}

export function writeActivePolicyPointer(rootDir, pointer) {
  const validated = validatePointer(pointer);
  atomicWriteJson(activePolicyPath(rootDir), validated);
  return validated;
}

function pointerMatchesPolicy(pointer, policy) {
  return (
    pointer.policyVersion === policy.policyVersion &&
    pointer.policyMode === policy.policyMode &&
    pointer.capEpoch === policy.capEpoch &&
    pointer.quotaWindowMs === policy.quotaWindowMs &&
    pointer.quotaLimit === policy.quotaLimit &&
    pointer.perDomainLimit === policy.perDomainLimit &&
    pointer.perDomainWindowMs === policy.perDomainWindowMs &&
    pointer.rateWindowMs === policy.rateWindowMs &&
    pointer.rateLimit === policy.rateLimit &&
    pointer.maxConcurrent === policy.maxConcurrent &&
    pointer.storageMinFreeBytes === policy.storageMinFreeBytes &&
    pointer.storageMaxDbBytes === policy.storageMaxDbBytes &&
    pointer.storageRetryMs === policy.storageRetryMs &&
    pointer.deferralRetentionMs === policy.deferralRetentionMs &&
    pointer.deferralMaxRows === policy.deferralMaxRows &&
    pointer.ackRequired === policy.ackRequired &&
    pointer.protocolVersion === policy.protocolVersion &&
    pointer.configHash === policy.configHash
  );
}

async function openPolicyStore({ rootDir, pointer, clock, faultInjector, logger }) {
  const dir = policyDirectory(rootDir, pointer.policyId);
  if (!existsSync(policyDatabasePath(rootDir, pointer.policyId))) {
    throw new AdmissionPolicyError(`policy ${pointer.policyId} database is missing at ${dir}`, "POLICY_TARGET_MISSING");
  }
  const store = await RollingAdmissionStore.open({ dir, config: null, clock, faultInjector, logger });
  try {
    const policy = store.sealedConfig;
    if (!policy) throw new AdmissionPolicyError(`policy ${pointer.policyId} is not sealed`, "POLICY_UNSEALED");
    if (!pointerMatchesPolicy(pointer, policy)) {
      throw new AdmissionPolicyError(`policy pointer does not match sealed store ${pointer.policyId}`, "POLICY_POINTER_MISMATCH");
    }
    return { store, policy, dir };
  } catch (err) {
    store.close();
    throw err;
  }
}

export class AdmissionPolicyManager {
  #rootDir;
  #config;
  #clock;
  #faultInjector;
  #logger;
  #legacy;
  #store;
  #policy;
  #pointer;
  #closed = false;
  #lastCheckAt = 0;
  #refreshing = null;

  static async open({
    dir,
    config = null,
    clock = () => new Date(),
    faultInjector = null,
    logger = null,
  } = {}) {
    if (typeof dir !== "string" || !dir.trim()) throw new AdmissionPolicyError("dir is required", "INVALID_DIR");
    const pointer = readActivePolicyPointer(dir);
    if (pointer) {
      const resolved = await openPolicyStore({ rootDir: dir, pointer, clock, faultInjector, logger });
      logger?.log?.(`[admission] active policy=${pointer.policyId} capEpoch=${pointer.capEpoch} quota=${pointer.quotaLimit}/${pointer.quotaWindowMs}ms source=policy`);
      return new AdmissionPolicyManager({
        rootDir: dir,
        config,
        clock,
        faultInjector,
        logger,
        store: resolved.store,
        policy: resolved.policy,
        pointer,
      });
    }
    const legacy = await AdmissionEpochManager.open({ dir, config, clock, faultInjector, logger });
    return new AdmissionPolicyManager({ rootDir: dir, config, clock, faultInjector, logger, legacy });
  }

  constructor({ rootDir, config, clock, faultInjector, logger, legacy = null, store = null, policy = null, pointer = null }) {
    this.#rootDir = rootDir;
    this.#config = config;
    this.#clock = clock;
    this.#faultInjector = faultInjector;
    this.#logger = logger;
    this.#legacy = legacy;
    this.#store = store;
    this.#policy = policy;
    this.#pointer = pointer;
  }

  get store() {
    return this.#legacy?.store ?? this.#store;
  }

  get policy() {
    return this.#policy;
  }

  get pointer() {
    return this.#pointer;
  }

  get epoch() {
    return this.#legacy?.epoch ?? this.#policy?.capEpoch ?? null;
  }

  get policyId() {
    return this.#pointer?.policyId ?? null;
  }

  get source() {
    return this.#legacy ? this.#legacy.source : "policy";
  }

  get capLimit() {
    return this.store?.sealedConfig?.capLimit ?? null;
  }

  capUsage() {
    return this.store?.capUsage() ?? 0;
  }

  policyStatus() {
    return this.#store?.policyStatus?.() ?? null;
  }

  status() {
    if (this.#legacy) {
      return {
        mode: "legacy-epoch",
        source: this.#legacy.source,
        epoch: this.#legacy.epoch,
        capLimit: this.#legacy.capLimit,
        capUsed: this.#legacy.capUsage(),
        policy: null,
        legacy: this.#legacy.status(),
      };
    }
    return {
      mode: "policy",
      source: "policy",
      policyId: this.policyId,
      epoch: this.#policy?.capEpoch ?? null,
      capLimit: this.capLimit,
      capUsed: this.capUsage(),
      policy: this.policyStatus(),
      pointer: this.#pointer,
    };
  }

  async maybeRefresh({ force = false, maxAgeMs = 5000 } = {}) {
    if (this.#closed) throw new AdmissionPolicyError("admission policy manager is closed", "MANAGER_CLOSED");
    if (this.#refreshing) return this.#refreshing;
    const now = Date.now();
    if (!force && now - this.#lastCheckAt < maxAgeMs) return false;
    this.#lastCheckAt = now;
    this.#refreshing = (async () => {
      const pointer = readActivePolicyPointer(this.#rootDir);
      if (!pointer) {
        if (this.#legacy) return false;
        return false;
      }
      if (this.#pointer?.policyId === pointer.policyId && this.#pointer?.configHash === pointer.configHash) return false;
      const resolved = await openPolicyStore({
        rootDir: this.#rootDir,
        pointer,
        clock: this.#clock,
        faultInjector: this.#faultInjector,
        logger: this.#logger,
      });
      const previous = this.#store;
      const legacy = this.#legacy;
      this.#store = resolved.store;
      this.#policy = resolved.policy;
      this.#pointer = pointer;
      this.#legacy = null;
      previous?.close?.();
      legacy?.close?.();
      this.#logger?.log?.(`[admission] adopted active policy ${pointer.policyId}`);
      return true;
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#legacy?.close?.();
    this.#store?.close?.();
  }
}
