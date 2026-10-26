import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  statfsSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  AdmissionStoreError,
  AdmissionValidationError,
  COMPLIANCE,
  DECISION,
  OUTCOME,
} from "./admission-store.js";

/**
 * Versioned rolling-window admission store.
 *
 * This is deliberately separate from the legacy sealed epoch store. It never
 * opens or mutates `epochs/*` or the legacy root database. The policy pointer
 * (`ACTIVE_POLICY.json`) selects this store when present.
 *
 * Quota exhaustion is a transient DEFERRED outcome. No `requests` decision is
 * written, so a retry of the same request identity can be admitted when capacity
 * returns. Non-quota decisions remain durable and first-decision-wins.
 */

export const ROLLING_POLICY_VERSION = "rolling-v1";
export const ROLLING_POLICY_MODE = "rolling";
const LEGACY_DB_FILE = "admission.sqlite";
const REQUEST_ID_MAX = 200;
const PAYLOAD_DIGEST_RE = /^[0-9a-f]{64}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const ROLLING_POLICY_DEFAULTS = Object.freeze({
  policyVersion: ROLLING_POLICY_VERSION,
  policyMode: ROLLING_POLICY_MODE,
  quotaWindowMs: 86_400_000,
  quotaLimit: 50_000,
  perDomainLimit: 5_000,
  perDomainWindowMs: 86_400_000,
  rateWindowMs: 60_000,
  rateLimit: 2_000,
  maxConcurrent: 1,
  storageMinFreeBytes: 0,
  storageMaxDbBytes: 0,
  storageRetryMs: 60_000,
  deferralRetentionMs: 7 * 24 * 60 * 60 * 1000,
  deferralMaxRows: 100_000,
  ackRequired: false,
  protocolVersion: "baseline-v1",
});

function positiveInt(value, name, { allowZero = false } = {}) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new AdmissionValidationError(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
      "INVALID_POLICY",
    );
  }
  return n;
}

function nonEmptyString(value, name, max = 200) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new AdmissionValidationError(`${name} must be a non-empty string of at most ${max} characters`, "INVALID_POLICY");
  }
  if (value !== value.trim() || CONTROL_RE.test(value)) {
    throw new AdmissionValidationError(`${name} must not have surrounding whitespace or control characters`, "INVALID_POLICY");
  }
  return value;
}

function normalizePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdmissionValidationError("policy configuration is required", "INVALID_POLICY");
  }
  const policyVersion = nonEmptyString(value.policyVersion ?? ROLLING_POLICY_DEFAULTS.policyVersion, "policyVersion", 100);
  if (policyVersion !== ROLLING_POLICY_VERSION) {
    throw new AdmissionValidationError(`unsupported policy version ${policyVersion}`, "INVALID_POLICY");
  }
  const policyMode = value.policyMode ?? ROLLING_POLICY_MODE;
  if (policyMode !== ROLLING_POLICY_MODE) {
    throw new AdmissionValidationError(`unsupported policy mode ${policyMode}`, "INVALID_POLICY");
  }
  if (typeof value.ackRequired !== "boolean") {
    throw new AdmissionValidationError("ackRequired must be a boolean", "INVALID_POLICY");
  }
  const core = {
    policyVersion,
    policyMode,
    capEpoch: nonEmptyString(value.capEpoch, "capEpoch", 200),
    quotaWindowMs: positiveInt(value.quotaWindowMs ?? ROLLING_POLICY_DEFAULTS.quotaWindowMs, "quotaWindowMs"),
    quotaLimit: positiveInt(value.quotaLimit ?? ROLLING_POLICY_DEFAULTS.quotaLimit, "quotaLimit"),
    perDomainLimit: positiveInt(value.perDomainLimit ?? ROLLING_POLICY_DEFAULTS.perDomainLimit, "perDomainLimit", { allowZero: true }),
    perDomainWindowMs: positiveInt(value.perDomainWindowMs ?? ROLLING_POLICY_DEFAULTS.perDomainWindowMs, "perDomainWindowMs"),
    rateWindowMs: positiveInt(value.rateWindowMs ?? ROLLING_POLICY_DEFAULTS.rateWindowMs, "rateWindowMs"),
    rateLimit: positiveInt(value.rateLimit ?? ROLLING_POLICY_DEFAULTS.rateLimit, "rateLimit"),
    maxConcurrent: positiveInt(value.maxConcurrent ?? ROLLING_POLICY_DEFAULTS.maxConcurrent, "maxConcurrent"),
    storageMinFreeBytes: positiveInt(value.storageMinFreeBytes ?? ROLLING_POLICY_DEFAULTS.storageMinFreeBytes, "storageMinFreeBytes", { allowZero: true }),
    storageMaxDbBytes: positiveInt(value.storageMaxDbBytes ?? ROLLING_POLICY_DEFAULTS.storageMaxDbBytes, "storageMaxDbBytes", { allowZero: true }),
    storageRetryMs: positiveInt(value.storageRetryMs ?? ROLLING_POLICY_DEFAULTS.storageRetryMs, "storageRetryMs"),
    deferralRetentionMs: positiveInt(value.deferralRetentionMs ?? ROLLING_POLICY_DEFAULTS.deferralRetentionMs, "deferralRetentionMs"),
    deferralMaxRows: positiveInt(value.deferralMaxRows ?? ROLLING_POLICY_DEFAULTS.deferralMaxRows, "deferralMaxRows"),
    ackRequired: value.ackRequired,
    protocolVersion: nonEmptyString(value.protocolVersion ?? ROLLING_POLICY_DEFAULTS.protocolVersion, "protocolVersion", 100),
  };
  return { ...core, configHash: policyHashFor(core) };
}

export function normalizeRollingPolicy(value) {
  return normalizePolicy(value);
}

function policyHashFor(policy) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "rolling-v1-policy",
        policy.policyVersion,
        policy.policyMode,
        policy.capEpoch,
        policy.quotaWindowMs,
        policy.quotaLimit,
        policy.perDomainLimit,
        policy.perDomainWindowMs,
        policy.rateWindowMs,
        policy.rateLimit,
        policy.maxConcurrent,
        policy.storageMinFreeBytes,
        policy.storageMaxDbBytes,
        policy.storageRetryMs,
        policy.deferralRetentionMs,
        policy.deferralMaxRows,
        policy.ackRequired,
        policy.protocolVersion,
      ]),
    )
    .digest("hex");
}

function samePolicy(a, b) {
  return policyHashFor(a) === policyHashFor(b);
}

function readSealedPolicy(db) {
  const row = db.prepare("SELECT * FROM sealed_policy WHERE id = 1").get();
  if (!row) return null;
  const policy = {
    policyVersion: row.policy_version,
    policyMode: row.policy_mode,
    capEpoch: row.cap_epoch,
    quotaWindowMs: Number(row.quota_window_ms),
    quotaLimit: Number(row.quota_limit),
    perDomainLimit: Number(row.per_domain_limit),
    perDomainWindowMs: Number(row.per_domain_window_ms),
    rateWindowMs: Number(row.rate_window_ms),
    rateLimit: Number(row.rate_limit),
    maxConcurrent: Number(row.max_concurrent),
    storageMinFreeBytes: Number(row.storage_min_free_bytes),
    storageMaxDbBytes: Number(row.storage_max_db_bytes),
    storageRetryMs: Number(row.storage_retry_ms),
    deferralRetentionMs: Number(row.deferral_retention_ms),
    deferralMaxRows: Number(row.deferral_max_rows),
    ackRequired: Boolean(row.ack_required),
    protocolVersion: row.protocol_version,
    sealedAt: row.sealed_at,
    configHash: row.config_hash,
  };
  if (policyHashFor(policy) !== policy.configHash) {
    throw new AdmissionStoreError("sealed rolling policy integrity check failed", "CORRUPT_POLICY");
  }
  return policy;
}

function normalizeRequestId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > REQUEST_ID_MAX) {
    throw new AdmissionValidationError(`requestId must be 1..${REQUEST_ID_MAX} characters`, "INVALID_REQUEST_ID");
  }
  if (value !== value.trim() || CONTROL_RE.test(value)) {
    throw new AdmissionValidationError("requestId must not have surrounding whitespace or control characters", "INVALID_REQUEST_ID");
  }
  return value;
}

function normalizePayloadDigest(value) {
  if (typeof value !== "string" || !PAYLOAD_DIGEST_RE.test(value)) {
    throw new AdmissionValidationError("payloadDigest must be a 64-character SHA-256 hex digest", "INVALID_PAYLOAD_DIGEST");
  }
  return value.toLowerCase();
}

function dateFromClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AdmissionValidationError("clock returned an invalid date", "INVALID_CLOCK");
  return date;
}

function isoFromDate(date) {
  return date.toISOString();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusy = (err) => /locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(err?.message ?? ""));

export class RollingAdmissionStore {
  #db;
  #dbPath;
  #config;
  #clock;
  #faultInjector;
  #storageGuard;
  #closed = false;
  #inFlight = 0;
  #waiters = [];

  constructor({ db, dbPath, config, clock = () => new Date(), faultInjector = null, storageGuard = null }) {
    this.#db = db;
    this.#dbPath = dbPath;
    this.#config = config;
    this.#clock = clock;
    this.#faultInjector = faultInjector;
    this.#storageGuard = storageGuard;
  }

  static async open({ dir, config = null, clock = () => new Date(), faultInjector = null, storageGuard = null } = {}) {
    if (typeof dir !== "string" || !dir.trim()) throw new AdmissionValidationError("dir is required", "INVALID_DIR");
    const requested = config == null ? null : normalizePolicy(config);
    if (typeof clock !== "function") throw new AdmissionValidationError("clock must be a function", "INVALID_CLOCK");
    if (faultInjector !== null && typeof faultInjector !== "function") {
      throw new AdmissionValidationError("faultInjector must be a function or null", "INVALID_FAULT_INJECTOR");
    }
    mkdirSync(dir, { recursive: true });
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      throw new AdmissionStoreError("Rolling admission requires Node.js with node:sqlite", "SQLITE_UNAVAILABLE");
    }
    const db = new DatabaseSync(path.join(dir, LEGACY_DB_FILE));
    try {
      const initSql = `
        PRAGMA busy_timeout = 10000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS sealed_policy (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          policy_version TEXT NOT NULL,
          policy_mode TEXT NOT NULL,
          cap_epoch TEXT NOT NULL,
          quota_window_ms INTEGER NOT NULL,
          quota_limit INTEGER NOT NULL,
          per_domain_limit INTEGER NOT NULL,
          per_domain_window_ms INTEGER NOT NULL,
          rate_window_ms INTEGER NOT NULL,
          rate_limit INTEGER NOT NULL,
          max_concurrent INTEGER NOT NULL,
          storage_min_free_bytes INTEGER NOT NULL,
          storage_max_db_bytes INTEGER NOT NULL,
          storage_retry_ms INTEGER NOT NULL,
          deferral_retention_ms INTEGER NOT NULL,
          deferral_max_rows INTEGER NOT NULL,
          ack_required INTEGER NOT NULL CHECK (ack_required IN (0, 1)),
          protocol_version TEXT NOT NULL,
          sealed_at TEXT NOT NULL,
          config_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests (
          request_id TEXT PRIMARY KEY,
          payload_digest TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('ADMITTED', 'REJECTED')),
          reason TEXT,
          decided_at_ms INTEGER NOT NULL,
          decided_at TEXT NOT NULL,
          scope TEXT
        );
        CREATE TABLE IF NOT EXISTS attempts (
          request_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          PRIMARY KEY (request_id, payload_digest)
        );
        CREATE TABLE IF NOT EXISTS conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('pre_decision', 'post_decision')),
          detected_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deferrals (
          request_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          scope TEXT,
          first_at_ms INTEGER NOT NULL,
          last_at_ms INTEGER NOT NULL,
          count INTEGER NOT NULL,
          retry_after_ms INTEGER,
          policy_version TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS requests_decision_ms_idx ON requests(decision, decided_at_ms);
        CREATE INDEX IF NOT EXISTS requests_scope_ms_idx ON requests(scope, decision, decided_at_ms);
        CREATE INDEX IF NOT EXISTS conflicts_request_idx ON conflicts(request_id);
        CREATE UNIQUE INDEX IF NOT EXISTS conflicts_identity_idx
          ON conflicts(request_id, payload_digest, kind, detected_at);
        CREATE INDEX IF NOT EXISTS deferrals_last_idx ON deferrals(last_at_ms);
      `;
      for (let attempt = 0; ; attempt++) {
        try {
          db.exec(initSql);
          break;
        } catch (err) {
          if (attempt >= 8 || !isBusy(err)) throw err;
          await sleep(25 * (attempt + 1));
        }
      }

      const persisted = readSealedPolicy(db);
      if (persisted && requested && !samePolicy(persisted, requested)) {
        throw new AdmissionStoreError("requested rolling policy does not match the persisted policy", "CONFIG_MISMATCH");
      }
      let sealed = persisted;
      if (!sealed && requested) {
        const sealedAt = isoFromDate(dateFromClock(clock));
        try {
          db.prepare(`INSERT INTO sealed_policy(id, policy_version, policy_mode, cap_epoch, quota_window_ms, quota_limit,
            per_domain_limit, per_domain_window_ms, rate_window_ms, rate_limit, max_concurrent,
            storage_min_free_bytes, storage_max_db_bytes, storage_retry_ms, deferral_retention_ms,
            deferral_max_rows, ack_required, protocol_version, sealed_at, config_hash)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            requested.policyVersion,
            requested.policyMode,
            requested.capEpoch,
            requested.quotaWindowMs,
            requested.quotaLimit,
            requested.perDomainLimit,
            requested.perDomainWindowMs,
            requested.rateWindowMs,
            requested.rateLimit,
            requested.maxConcurrent,
            requested.storageMinFreeBytes,
            requested.storageMaxDbBytes,
            requested.storageRetryMs,
            requested.deferralRetentionMs,
            requested.deferralMaxRows,
            requested.ackRequired ? 1 : 0,
            requested.protocolVersion,
            sealedAt,
            requested.configHash,
          );
          sealed = { ...requested, sealedAt };
        } catch (err) {
          const winner = readSealedPolicy(db);
          if (!winner) throw err;
          if (!samePolicy(winner, requested)) {
            throw new AdmissionStoreError("requested rolling policy does not match the persisted policy", "CONFIG_MISMATCH");
          }
          sealed = winner;
        }
      }
      return new RollingAdmissionStore({ db, dbPath: dir, config: sealed, clock, faultInjector, storageGuard });
    } catch (err) {
      try {
        db.close();
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  get sealedConfig() {
    if (!this.#config) return null;
    return Object.freeze({
      ...this.#config,
      capLimit: this.#config.quotaLimit,
      capEpoch: this.#config.capEpoch,
    });
  }

  get capLimit() {
    return this.#config?.quotaLimit ?? null;
  }

  get policy() {
    return this.#config == null ? null : Object.freeze({ ...this.#config });
  }

  #assertOpen() {
    if (this.#closed) throw new AdmissionStoreError("rolling admission store is closed", "STORE_CLOSED");
  }

  #requirePolicy() {
    if (!this.#config) throw new AdmissionStoreError("rolling policy is not sealed", "POLICY_UNSEALED");
    return this.#config;
  }

  #fault(phase, requestId) {
    if (this.#faultInjector) this.#faultInjector({ phase, requestId });
  }

  #nowMs() {
    return dateFromClock(this.#clock).getTime();
  }

  #assertClockNotRegressed(nowMs) {
    const row = this.#db.prepare("SELECT MAX(decided_at_ms) AS max_ms FROM requests").get();
    const maxMs = row?.max_ms == null ? null : Number(row.max_ms);
    if (maxMs != null && nowMs < maxMs) {
      throw new AdmissionStoreError(
        `clock regression: now ${new Date(nowMs).toISOString()} is before latest decision ${new Date(maxMs).toISOString()}`,
        "CLOCK_REGRESSION",
      );
    }
  }

  #capUsed(nowMs, windowMs = this.#requirePolicy().quotaWindowMs) {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM requests WHERE decision = 'ADMITTED' AND decided_at_ms > ? AND decided_at_ms <= ?")
      .get(nowMs - windowMs, nowMs);
    return Number(row?.n ?? 0);
  }

  #rateUsed(nowMs, windowMs = this.#requirePolicy().rateWindowMs) {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM requests WHERE decision = 'ADMITTED' AND decided_at_ms > ? AND decided_at_ms <= ?")
      .get(nowMs - windowMs, nowMs);
    return Number(row?.n ?? 0);
  }

  #domainUsed(scope, nowMs, windowMs = this.#requirePolicy().perDomainWindowMs) {
    if (!scope) return 0;
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM requests WHERE decision = 'ADMITTED' AND scope = ? AND decided_at_ms > ? AND decided_at_ms <= ?")
      .get(scope, nowMs - windowMs, nowMs);
    return Number(row?.n ?? 0);
  }

  #oldestMs(whereSql, params) {
    const row = this.#db.prepare(`SELECT MIN(decided_at_ms) AS ms FROM requests WHERE ${whereSql}`).get(...params);
    return row?.ms == null ? null : Number(row.ms);
  }

  #decisionRow(requestId) {
    return (
      this.#db
        .prepare("SELECT request_id, payload_digest, decision, reason, decided_at_ms, decided_at, scope FROM requests WHERE request_id = ?")
        .get(requestId) ?? null
    );
  }

  #anyConflict(requestId) {
    return (
      this.#db.prepare("SELECT request_id, payload_digest, kind FROM conflicts WHERE request_id = ? LIMIT 1").get(requestId) ?? null
    );
  }

  #attemptDigests(requestId) {
    return this.#db
      .prepare("SELECT payload_digest FROM attempts WHERE request_id = ?")
      .all(requestId)
      .map((r) => r.payload_digest);
  }

  #insertAttempt(requestId, payloadDigest, at) {
    this.#db
      .prepare("INSERT OR IGNORE INTO attempts(request_id, payload_digest, first_seen_at) VALUES (?, ?, ?)")
      .run(requestId, payloadDigest, at);
  }

  #insertConflict(requestId, payloadDigest, kind, at) {
    this.#db
      .prepare("INSERT INTO conflicts(request_id, payload_digest, kind, detected_at) VALUES (?, ?, ?, ?)")
      .run(requestId, payloadDigest, kind, at);
  }

  #insertDecision(requestId, payloadDigest, decision, reason, nowMs, nowIso, scope) {
    this.#db
      .prepare(
        "INSERT INTO requests(request_id, payload_digest, decision, reason, decided_at_ms, decided_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(requestId, payloadDigest, decision, reason, nowMs, nowIso, scope ?? null);
  }

  #deferralStats() {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n, MAX(last_at_ms) AS last_ms FROM deferrals")
      .get();
    const reasons = this.#db
      .prepare("SELECT reason, COUNT(*) AS n FROM deferrals GROUP BY reason ORDER BY n DESC")
      .all();
    return {
      count: Number(row?.n ?? 0),
      lastAt: row?.last_ms == null ? null : new Date(Number(row.last_ms)).toISOString(),
      reasons: Object.fromEntries(reasons.map((r) => [r.reason, Number(r.n)])),
    };
  }

  #domainStatus(nowMs) {
    return this.#db
      .prepare(
        `SELECT scope, COUNT(*) AS n FROM requests
         WHERE decision = 'ADMITTED' AND scope IS NOT NULL AND decided_at_ms > ? AND decided_at_ms <= ?
         GROUP BY scope ORDER BY n DESC, scope ASC LIMIT 10`,
      )
      .all(nowMs - this.#requirePolicy().perDomainWindowMs, nowMs)
      .map((r) => ({ domain: r.scope, used: Number(r.n) }));
  }

  #storageStatus() {
    const policy = this.#requirePolicy();
    const dbFile = path.join(this.#dbPath ?? "", LEGACY_DB_FILE);
    let freeBytes = null;
    let dbBytes = null;
    try {
      const fs = statfsSync(this.#dbPath ?? ".");
      freeBytes = Number(fs.bavail) * Number(fs.bsize);
    } catch {
      /* status reports unknown */
    }
    try {
      dbBytes = statSync(dbFile).size;
    } catch {
      /* status reports unknown */
    }
    const thresholded = policy.storageMinFreeBytes > 0 || policy.storageMaxDbBytes > 0;
    const ok =
      !thresholded ||
      ((policy.storageMinFreeBytes === 0 || (freeBytes != null && freeBytes >= policy.storageMinFreeBytes)) &&
        (policy.storageMaxDbBytes === 0 || (dbBytes != null && dbBytes <= policy.storageMaxDbBytes)));
    return {
      ok,
      freeBytes,
      dbBytes,
      minFreeBytes: policy.storageMinFreeBytes,
      maxDbBytes: policy.storageMaxDbBytes,
      retryAfterMs: policy.storageRetryMs,
    };
  }

  #recordDeferral({ requestId, reason, scope, nowMs, retryAfterMs }) {
    const policy = this.#requirePolicy();
    this.#db
      .prepare(
        `INSERT INTO deferrals(request_id, reason, scope, first_at_ms, last_at_ms, count, retry_after_ms, policy_version)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           reason = excluded.reason,
           scope = excluded.scope,
           last_at_ms = excluded.last_at_ms,
           count = deferrals.count + 1,
           retry_after_ms = excluded.retry_after_ms,
           policy_version = excluded.policy_version`,
      )
      .run(requestId, reason, scope ?? null, nowMs, nowMs, retryAfterMs ?? null, policy.policyVersion);
    this.#db.prepare("DELETE FROM deferrals WHERE last_at_ms < ?").run(nowMs - policy.deferralRetentionMs);
    const count = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM deferrals").get()?.n ?? 0);
    if (count > policy.deferralMaxRows) {
      this.#db
        .prepare(
          `DELETE FROM deferrals WHERE request_id IN (
             SELECT request_id FROM deferrals ORDER BY last_at_ms ASC LIMIT ?
           )`,
        )
        .run(count - policy.deferralMaxRows);
    }
  }

  #baseResult({ requestId, payloadDigest, decision = null, outcome, reason = null, replayed = false, compliance, quotaUsed, nowMs }) {
    const policy = this.#config;
    return {
      requestId,
      payloadDigest,
      decision,
      outcome,
      reason,
      replayed,
      compliance,
      quotaUsed,
      quotaLimit: policy?.quotaLimit ?? null,
      remaining: policy ? Math.max(0, policy.quotaLimit - quotaUsed) : null,
      policyVersion: policy?.policyVersion ?? null,
      policyMode: policy?.policyMode ?? null,
      capEpoch: policy?.capEpoch ?? null,
      protocolVersion: policy?.protocolVersion ?? null,
      capLimit: policy?.quotaLimit ?? null,
    };
  }

  #existingResult(row, { requestId, payloadDigest, replayed, compliance, nowMs }) {
    const conflicted = this.#anyConflict(requestId) != null;
    const quotaUsed = this.#capUsed(nowMs);
    return this.#baseResult({
      requestId,
      payloadDigest: row.payload_digest,
      decision: row.decision,
      outcome: row.decision,
      reason: row.reason,
      replayed,
      compliance: conflicted ? COMPLIANCE.VIOLATED : compliance,
      quotaUsed,
      nowMs,
    });
  }

  #contradictoryResult(requestId, payloadDigest, nowMs) {
    return this.#baseResult({
      requestId,
      payloadDigest,
      decision: null,
      outcome: OUTCOME.CONTRADICTORY,
      reason: "payload-conflict",
      replayed: false,
      compliance: COMPLIANCE.VIOLATED,
      quotaUsed: this.#capUsed(nowMs),
      nowMs,
    });
  }

  #withImmediate(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.#db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  #prepareAttempt(requestId, payloadDigest, nowIso) {
    const existing = this.#decisionRow(requestId);
    if (existing) {
      if (existing.payload_digest !== payloadDigest) {
        this.#insertConflict(requestId, payloadDigest, "post_decision", nowIso);
        return {
          needsDecision: false,
          result: this.#existingResult(existing, {
            requestId,
            payloadDigest,
            replayed: false,
            compliance: COMPLIANCE.VIOLATED,
            nowMs: this.#nowMs(),
          }),
        };
      }
      return {
        needsDecision: false,
        result: this.#existingResult(existing, {
          requestId,
          payloadDigest,
          replayed: true,
          compliance: COMPLIANCE.COMPLIANT,
          nowMs: this.#nowMs(),
        }),
      };
    }
    if (this.#anyConflict(requestId)) {
      return { needsDecision: false, result: this.#contradictoryResult(requestId, payloadDigest, this.#nowMs()) };
    }
    const digests = this.#attemptDigests(requestId);
    if (digests.length > 0 && (digests.length > 1 || !digests.includes(payloadDigest))) {
      this.#insertAttempt(requestId, payloadDigest, nowIso);
      this.#insertConflict(requestId, payloadDigest, "pre_decision", nowIso);
      return { needsDecision: false, result: this.#contradictoryResult(requestId, payloadDigest, this.#nowMs()) };
    }
    this.#insertAttempt(requestId, payloadDigest, nowIso);
    return { needsDecision: true, result: null };
  }

  #deferResult({ requestId, payloadDigest, reason, nowMs, quotaUsed, retryAfterMs, detail }) {
    const policy = this.#requirePolicy();
    const used = quotaUsed ?? this.#capUsed(nowMs);
    return {
      ...this.#baseResult({
        requestId,
        payloadDigest,
        decision: DECISION.DEFERRED,
        outcome: OUTCOME.DEFERRED,
        reason,
        replayed: false,
        compliance: COMPLIANCE.COMPLIANT,
        quotaUsed: used,
        nowMs,
      }),
      deferred: true,
      retryAfterMs,
      nextCapacityAt: retryAfterMs != null ? new Date(nowMs + retryAfterMs).toISOString() : null,
      ...detail,
    };
  }

  #decide(requestId, payloadDigest, scope, nowMs) {
    const policy = this.#requirePolicy();
    const nowIso = isoFromDate(new Date(nowMs));
    if (this.#anyConflict(requestId)) {
      return this.#contradictoryResult(requestId, payloadDigest, nowMs);
    }
    const existing = this.#decisionRow(requestId);
    if (existing) {
      if (existing.payload_digest !== payloadDigest) {
        this.#insertConflict(requestId, payloadDigest, "post_decision", nowIso);
        return this.#existingResult(existing, {
          requestId,
          payloadDigest,
          replayed: false,
          compliance: COMPLIANCE.VIOLATED,
          nowMs,
        });
      }
      return this.#existingResult(existing, {
        requestId,
        payloadDigest,
        replayed: true,
        compliance: COMPLIANCE.COMPLIANT,
        nowMs,
      });
    }

    const digests = this.#attemptDigests(requestId);
    if (digests.some((digest) => digest !== payloadDigest)) {
      this.#insertConflict(requestId, payloadDigest, "pre_decision", nowIso);
      return this.#contradictoryResult(requestId, payloadDigest, nowMs);
    }

    this.#assertClockNotRegressed(nowMs);

    const storage = this.#storageGuard ? this.#storageGuard() : this.#storageStatus();
    if (!storage.ok) {
      const retryAfterMs = storage.retryAfterMs ?? policy.storageRetryMs;
      this.#recordDeferral({ requestId, reason: "storage", scope, nowMs, retryAfterMs });
      return this.#deferResult({
        requestId,
        payloadDigest,
        reason: "storage",
        nowMs,
        quotaUsed: this.#capUsed(nowMs),
        retryAfterMs,
        detail: { storage: { ...storage, ok: false } },
      });
    }

    const quotaUsed = this.#capUsed(nowMs);
    if (quotaUsed >= policy.quotaLimit) {
      const oldest = this.#oldestMs("decision = 'ADMITTED' AND decided_at_ms > ? AND decided_at_ms <= ?", [
        nowMs - policy.quotaWindowMs,
        nowMs,
      ]);
      const retryAfterMs = oldest == null ? 1000 : Math.max(1, oldest + policy.quotaWindowMs - nowMs);
      this.#recordDeferral({ requestId, reason: "quota", scope, nowMs, retryAfterMs });
      return this.#deferResult({
        requestId,
        payloadDigest,
        reason: "quota",
        nowMs,
        quotaUsed,
        retryAfterMs,
        detail: { quotaWindowMs: policy.quotaWindowMs, oldestCountedAt: oldest == null ? null : new Date(oldest).toISOString() },
      });
    }

    const rateUsed = this.#rateUsed(nowMs);
    if (rateUsed >= policy.rateLimit) {
      const oldest = this.#oldestMs("decision = 'ADMITTED' AND decided_at_ms > ? AND decided_at_ms <= ?", [
        nowMs - policy.rateWindowMs,
        nowMs,
      ]);
      const retryAfterMs = oldest == null ? 1000 : Math.max(1, oldest + policy.rateWindowMs - nowMs);
      this.#recordDeferral({ requestId, reason: "rate", scope, nowMs, retryAfterMs });
      return this.#deferResult({
        requestId,
        payloadDigest,
        reason: "rate",
        nowMs,
        quotaUsed,
        retryAfterMs,
        detail: { rateWindowMs: policy.rateWindowMs, rateLimit: policy.rateLimit, rateUsed },
      });
    }

    if (scope && policy.perDomainLimit > 0) {
      const domainUsed = this.#domainUsed(scope, nowMs);
      if (domainUsed >= policy.perDomainLimit) {
        const oldest = this.#oldestMs(
          "decision = 'ADMITTED' AND scope = ? AND decided_at_ms > ? AND decided_at_ms <= ?",
          [scope, nowMs - policy.perDomainWindowMs, nowMs],
        );
        const retryAfterMs = oldest == null ? 1000 : Math.max(1, oldest + policy.perDomainWindowMs - nowMs);
        this.#recordDeferral({ requestId, reason: "domain", scope, nowMs, retryAfterMs });
        return this.#deferResult({
          requestId,
          payloadDigest,
          reason: "domain",
          nowMs,
          quotaUsed,
          retryAfterMs,
          detail: { scope, domainUsed, perDomainLimit: policy.perDomainLimit, perDomainWindowMs: policy.perDomainWindowMs },
        });
      }
    }

    this.#insertDecision(requestId, payloadDigest, DECISION.ADMITTED, "admitted", nowMs, nowIso, scope);
    return this.#baseResult({
      requestId,
      payloadDigest,
      decision: DECISION.ADMITTED,
      outcome: OUTCOME.ADMITTED,
      reason: "admitted",
      replayed: false,
      compliance: COMPLIANCE.COMPLIANT,
      quotaUsed: quotaUsed + 1,
      nowMs,
    });
  }

  #acquireSlot() {
    if (this.#inFlight < this.#requirePolicy().maxConcurrent) {
      this.#inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #releaseSlot() {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#inFlight = Math.max(0, this.#inFlight - 1);
  }

  async admit({ requestId, payloadDigest, scope = null } = {}) {
    this.#assertOpen();
    this.#requirePolicy();
    const rid = normalizeRequestId(requestId);
    const digest = normalizePayloadDigest(payloadDigest);
    await this.#acquireSlot();
    try {
      const nowIso = isoFromDate(dateFromClock(this.#clock));
      const prepared = this.#withImmediate(() => {
        const value = this.#prepareAttempt(rid, digest, nowIso);
        this.#fault("before_attempt_commit", rid);
        return value;
      });
      this.#fault("after_attempt_commit", rid);
      if (!prepared.needsDecision) return prepared.result;

      const result = this.#withImmediate(() => {
        const value = this.#decide(rid, digest, scope, this.#nowMs());
        this.#fault("before_decision_commit", rid);
        return value;
      });
      this.#fault("after_decision_commit", rid);
      return result;
    } finally {
      this.#releaseSlot();
    }
  }

  /**
   * Import one historical decision into the rolling store without applying the
   * current quota/rate checks. Timestamps and request identity are preserved.
   * Idempotent for identical rows; conflicting target rows fail closed. Used by
   * the Stage 2 migration tool only.
   */
  async importDecision({
    requestId,
    payloadDigest,
    decision,
    reason = null,
    decidedAtMs,
    decidedAt,
    scope = null,
    attempts = [],
    conflicts = [],
    nowMs = this.#nowMs(),
  } = {}) {
    this.#assertOpen();
    this.#requirePolicy();
    const rid = normalizeRequestId(requestId);
    const digest = normalizePayloadDigest(payloadDigest);
    if (decision !== DECISION.ADMITTED && decision !== DECISION.REJECTED) {
      throw new AdmissionValidationError(`invalid imported decision ${String(decision)}`, "INVALID_IMPORT_DECISION");
    }
    if (!Number.isSafeInteger(decidedAtMs)) {
      throw new AdmissionValidationError("decidedAtMs must be a safe integer", "INVALID_TIMESTAMP");
    }
    const parsed = Date.parse(String(decidedAt));
    if (!Number.isFinite(parsed) || parsed !== decidedAtMs) {
      throw new AdmissionValidationError("decidedAt does not match decidedAtMs", "INVALID_TIMESTAMP");
    }
    if (decidedAtMs > nowMs) {
      throw new AdmissionStoreError("cannot import a decision after the migration clock", "CLOCK_REGRESSION");
    }
    return this.#withImmediate(() => {
      const existing = this.#decisionRow(rid);
      if (existing) {
        const same =
          existing.payload_digest === digest &&
          existing.decision === decision &&
          (existing.reason ?? null) === (reason ?? null) &&
          Number(existing.decided_at_ms) === decidedAtMs &&
          (existing.scope ?? null) === (scope ?? null);
        if (!same) {
          throw new AdmissionStoreError(`migration decision conflict for request ${rid}`, "MIGRATION_DECISION_CONFLICT");
        }
      } else {
        this.#insertDecision(rid, digest, decision, reason, decidedAtMs, String(decidedAt), scope);
      }
      for (const attempt of attempts) {
        const attemptDigest = normalizePayloadDigest(attempt.payloadDigest);
        const firstSeenAt = String(attempt.firstSeenAt ?? decidedAt);
        this.#db
          .prepare("INSERT OR IGNORE INTO attempts(request_id, payload_digest, first_seen_at) VALUES (?, ?, ?)")
          .run(rid, attemptDigest, firstSeenAt);
      }
      for (const conflict of conflicts) {
        const conflictDigest = normalizePayloadDigest(conflict.payloadDigest);
        const kind = conflict.kind;
        if (kind !== "pre_decision" && kind !== "post_decision") {
          throw new AdmissionValidationError(`invalid imported conflict kind ${String(kind)}`, "INVALID_IMPORT_CONFLICT");
        }
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO conflicts(request_id, payload_digest, kind, detected_at) VALUES (?, ?, ?, ?)",
          )
          .run(rid, conflictDigest, kind, String(conflict.detectedAt ?? decidedAt));
      }
      return { imported: !existing, skipped: Boolean(existing), requestId: rid };
    });
  }

  /** Read all decisions (migration verification/status; not used on hot paths). */
  listDecisions() {
    this.#assertOpen();
    return this.#db
      .prepare(
        "SELECT request_id, payload_digest, decision, reason, decided_at_ms, decided_at, scope FROM requests ORDER BY request_id",
      )
      .all()
      .map((row) => ({
        requestId: row.request_id,
        payloadDigest: row.payload_digest,
        decision: row.decision,
        reason: row.reason,
        decidedAtMs: Number(row.decided_at_ms),
        decidedAt: row.decided_at,
        scope: row.scope ?? null,
      }));
  }

  getDecision(requestId) {
    this.#assertOpen();
    const rid = normalizeRequestId(requestId);
    const row = this.#decisionRow(rid);
    if (!row) return null;
    return {
      requestId: row.request_id,
      payloadDigest: row.payload_digest,
      decision: row.decision,
      reason: row.reason,
      decidedAtMs: row.decided_at_ms,
      decidedAt: row.decided_at,
      scope: row.scope ?? null,
    };
  }

  quotaStatus(nowMs = this.#nowMs()) {
    this.#assertOpen();
    const policy = this.#requirePolicy();
    const maxRow = this.#db.prepare("SELECT MAX(decided_at_ms) AS max_ms FROM requests").get();
    const maxMs = maxRow?.max_ms == null ? null : Number(maxRow.max_ms);
    const clockRegression = maxMs != null && nowMs < maxMs;
    const quotaUsed = this.#capUsed(nowMs);
    const oldestQuota = this.#oldestMs("decision = 'ADMITTED' AND decided_at_ms > ? AND decided_at_ms <= ?", [
      nowMs - policy.quotaWindowMs,
      nowMs,
    ]);
    const rateUsed = this.#rateUsed(nowMs);
    const oldestRate = this.#oldestMs("decision = 'ADMITTED' AND decided_at_ms > ? AND decided_at_ms <= ?", [
      nowMs - policy.rateWindowMs,
      nowMs,
    ]);
    return {
      policyVersion: policy.policyVersion,
      policyMode: policy.policyMode,
      capEpoch: policy.capEpoch,
      quotaWindowMs: policy.quotaWindowMs,
      quotaLimit: policy.quotaLimit,
      quotaUsed,
      remaining: Math.max(0, policy.quotaLimit - quotaUsed),
      oldestCountedAt: oldestQuota == null ? null : new Date(oldestQuota).toISOString(),
      nextCapacityAt: oldestQuota == null ? null : new Date(oldestQuota + policy.quotaWindowMs).toISOString(),
      rateWindowMs: policy.rateWindowMs,
      rateLimit: policy.rateLimit,
      rateUsed,
      rateNextAt: oldestRate == null ? null : new Date(oldestRate + policy.rateWindowMs).toISOString(),
      perDomainLimit: policy.perDomainLimit,
      perDomainWindowMs: policy.perDomainWindowMs,
      domains: this.#domainStatus(nowMs),
      deferrals: this.#deferralStats(),
      storage: this.#storageStatus(),
      clockRegression,
      latestDecisionAt: maxMs == null ? null : new Date(maxMs).toISOString(),
    };
  }

  policyStatus(nowMs = this.#nowMs()) {
    return this.quotaStatus(nowMs);
  }

  capUsage() {
    this.#assertOpen();
    return this.#capUsed(this.#nowMs());
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
