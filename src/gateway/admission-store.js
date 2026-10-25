import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Baseline v1 admission core.
 *
 * This slice owns exactly one durable gateway decision per logical request and
 * the global admission cap. It deliberately does not implement delivery,
 * acknowledgement, evidence sealing, reconciliation, or freeze eligibility.
 *
 * Persistence is SQLite (`node:sqlite`) in WAL mode with
 * `synchronous=FULL`: a successful `COMMIT` is the durability boundary. The
 * cap and the decision are written in the same immediate transaction, so the
 * cap cannot be overrun by concurrent callers.
 */

export const DEFAULT_CAP_LIMIT = 420;
const REQUEST_ID_MAX = 200;
const PAYLOAD_DIGEST_RE = /^[0-9a-f]{64}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const DECISION = Object.freeze({
  ADMITTED: "ADMITTED",
  REJECTED: "REJECTED",
});

export const OUTCOME = Object.freeze({
  ADMITTED: "ADMITTED",
  REJECTED: "REJECTED",
  CONTRADICTORY: "CONTRADICTORY",
});

export const COMPLIANCE = Object.freeze({
  COMPLIANT: "COMPLIANT",
  VIOLATED: "VIOLATED",
});

export class AdmissionValidationError extends Error {
  constructor(message, code = "INVALID_INPUT") {
    super(message);
    this.name = "AdmissionValidationError";
    this.code = code;
  }
}

export class AdmissionStoreError extends Error {
  constructor(message, code = "ADMISSION_STORE_ERROR") {
    super(message);
    this.name = "AdmissionStoreError";
    this.code = code;
  }
}

function validateCapLimit(value) {
  const n = value === undefined ? DEFAULT_CAP_LIMIT : value;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new AdmissionValidationError(`capLimit must be a positive safe integer, got ${String(value)}`, "INVALID_CAP_LIMIT");
  }
  return n;
}

function validateCapEpoch(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new AdmissionValidationError("capEpoch must be a non-empty string of at most 200 characters", "INVALID_CAP_EPOCH");
  }
  if (value !== value.trim() || CONTROL_RE.test(value)) {
    throw new AdmissionValidationError("capEpoch must not have surrounding whitespace or control characters", "INVALID_CAP_EPOCH");
  }
  return value;
}

function validateProtocolVersion(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new AdmissionValidationError("protocolVersion must be a non-empty string of at most 100 characters", "INVALID_PROTOCOL_VERSION");
  }
  if (value !== value.trim() || CONTROL_RE.test(value)) {
    throw new AdmissionValidationError("protocolVersion must not have surrounding whitespace or control characters", "INVALID_PROTOCOL_VERSION");
  }
  return value;
}

function normalizeSealedConfig(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdmissionValidationError("config is required to seal a new admission store", "INVALID_CONFIG");
  }
  const capLimit = validateCapLimit(value.capLimit);
  const capEpoch = validateCapEpoch(value.capEpoch);
  if (typeof value.ackRequired !== "boolean") {
    throw new AdmissionValidationError("ackRequired must be a boolean", "INVALID_ACK_REQUIRED");
  }
  const protocolVersion = validateProtocolVersion(value.protocolVersion ?? "baseline-v1");
  const core = { capLimit, capEpoch, ackRequired: value.ackRequired, protocolVersion };
  return { ...core, configHash: configHashFor(core) };
}

function configHashFor({ capLimit, capEpoch, ackRequired, protocolVersion }) {
  return createHash("sha256")
    .update(JSON.stringify(["baseline-v1-config", capLimit, capEpoch, ackRequired, protocolVersion]))
    .digest("hex");
}

function readSealedConfig(db) {
  const row = db
    .prepare(
      "SELECT cap_limit, cap_epoch, ack_required, protocol_version, sealed_at, config_hash FROM sealed_config WHERE id = 1",
    )
    .get();
  if (!row) return null;
  const config = {
    capLimit: Number(row.cap_limit),
    capEpoch: row.cap_epoch,
    ackRequired: Boolean(row.ack_required),
    protocolVersion: row.protocol_version,
    sealedAt: row.sealed_at,
    configHash: row.config_hash,
  };
  const expected = configHashFor(config);
  if (expected !== config.configHash) {
    throw new AdmissionStoreError("sealed configuration integrity check failed", "CORRUPT_CONFIG");
  }
  return config;
}

function sameConfig(a, b) {
  return (
    a.capLimit === b.capLimit &&
    a.capEpoch === b.capEpoch &&
    a.ackRequired === b.ackRequired &&
    a.protocolVersion === b.protocolVersion
  );
}

function normalizeRequestId(value) {
  if (typeof value !== "string") {
    throw new AdmissionValidationError("requestId must be a string", "INVALID_REQUEST_ID");
  }
  if (value.length < 1 || value.length > REQUEST_ID_MAX) {
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

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AdmissionStoreError("clock returned an invalid date", "INVALID_CLOCK");
  }
  return date.toISOString();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBusy(err) {
  return /database.*locked|locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(err?.message ?? ""));
}

export class AdmissionStore {
  #db;
  #config;
  #clock;
  #faultInjector;
  #closed = false;

  constructor({ db, config, clock, faultInjector }) {
    this.#db = db;
    this.#config = config;
    this.#clock = clock;
    this.#faultInjector = faultInjector;
  }

  /**
   * Open or create an isolated admission store.
   *
   * A new store must be sealed with `config`; an existing store returns its
   * persisted sealed configuration. The configuration is immutable once written.
   *
   * @param {object} opts
   * @param {string} opts.dir - directory holding `admission.sqlite`
   * @param {object} [opts.config] - { capLimit, capEpoch, ackRequired, protocolVersion }
   * @param {() => Date|string|number} [opts.clock] - testable timestamp source
   * @param {(ctx: {phase: string, requestId?: string}) => void} [opts.faultInjector]
   */
  static async open({ dir, config = null, clock = () => new Date(), faultInjector = null } = {}) {
    if (typeof dir !== "string" || !dir.trim()) {
      throw new AdmissionValidationError("dir is required", "INVALID_DIR");
    }
    const requestedConfig = config == null ? null : normalizeSealedConfig(config);
    if (typeof clock !== "function") {
      throw new AdmissionValidationError("clock must be a function", "INVALID_CLOCK");
    }
    if (faultInjector !== null && typeof faultInjector !== "function") {
      throw new AdmissionValidationError("faultInjector must be a function or null", "INVALID_FAULT_INJECTOR");
    }

    mkdirSync(dir, { recursive: true });

    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      throw new AdmissionStoreError(
        "Baseline v1 admission requires Node.js with node:sqlite (Node >= 22.13 is recommended)",
        "SQLITE_UNAVAILABLE",
      );
    }

    const db = new DatabaseSync(path.join(dir, "admission.sqlite"));
    try {
      // busy_timeout must be set BEFORE switching journal mode: the WAL pragma
      // can take a lock, and without a busy handler a simultaneous opener fails
      // immediately with SQLITE_BUSY. Concurrent openers are serialized by
      // SQLite, but opening must wait rather than fail closed by accident.
      const initSql = `
        PRAGMA busy_timeout = 10000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS sealed_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          cap_limit INTEGER NOT NULL,
          cap_epoch TEXT NOT NULL,
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
          decided_at TEXT NOT NULL
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
        CREATE INDEX IF NOT EXISTS conflicts_request_idx ON conflicts(request_id);
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

      const persistedConfig = readSealedConfig(db);
      if (persistedConfig && requestedConfig && !sameConfig(persistedConfig, requestedConfig)) {
        throw new AdmissionStoreError(
          "requested sealed configuration does not match the persisted configuration",
          "CONFIG_MISMATCH",
        );
      }
      let sealedConfig = persistedConfig;
      if (!sealedConfig && requestedConfig) {
        const sealedAt = iso(clock);
        try {
          db.prepare(
            `INSERT INTO sealed_config(id, cap_limit, cap_epoch, ack_required, protocol_version, sealed_at, config_hash)
             VALUES (1, ?, ?, ?, ?, ?, ?)`,
          ).run(
            requestedConfig.capLimit,
            requestedConfig.capEpoch,
            requestedConfig.ackRequired ? 1 : 0,
            requestedConfig.protocolVersion,
            sealedAt,
            requestedConfig.configHash,
          );
          sealedConfig = { ...requestedConfig, sealedAt };
        } catch (err) {
          // A simultaneous first opener may have sealed the store already. If it
          // used the same configuration this open succeeds; otherwise the store
          // is immutable and this open must fail.
          const winner = readSealedConfig(db);
          if (!winner) throw err;
          if (!sameConfig(winner, requestedConfig)) {
            throw new AdmissionStoreError(
              "requested sealed configuration does not match the persisted configuration",
              "CONFIG_MISMATCH",
            );
          }
          sealedConfig = winner;
        }
      }

      const contradictory = db
        .prepare(
          `SELECT c.request_id
             FROM conflicts c
             JOIN requests r ON r.request_id = c.request_id
            WHERE c.kind = 'pre_decision'
            LIMIT 1`,
        )
        .get();
      if (contradictory) {
        throw new AdmissionStoreError(
          `durable facts are internally contradictory for request ${contradictory.request_id}`,
          "CORRUPT_LEDGER",
        );
      }

      return new AdmissionStore({
        db,
        config: sealedConfig,
        clock,
        faultInjector,
      });
    } catch (err) {
      try {
        db.close();
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  get capLimit() {
    return this.#config?.capLimit ?? null;
  }

  get sealedConfig() {
    return this.#config == null ? null : Object.freeze({ ...this.#config });
  }

  #assertOpen() {
    if (this.#closed) throw new AdmissionStoreError("admission store is closed", "STORE_CLOSED");
  }

  #requireSealedConfig() {
    if (!this.#config) {
      throw new AdmissionStoreError(
        "admission is blocked until the durable configuration is sealed",
        "CONFIG_UNSEALED",
      );
    }
    return this.#config;
  }

  #fault(phase, requestId) {
    if (this.#faultInjector) this.#faultInjector({ phase, requestId });
  }

  #capUsed() {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM requests WHERE decision = 'ADMITTED'").get();
    return Number(row?.n ?? 0);
  }

  #decisionRow(requestId) {
    return (
      this.#db
        .prepare(
          "SELECT request_id, payload_digest, decision, reason, decided_at FROM requests WHERE request_id = ?",
        )
        .get(requestId) ?? null
    );
  }

  #anyConflict(requestId) {
    return (
      this.#db
        .prepare("SELECT request_id, payload_digest, kind FROM conflicts WHERE request_id = ? LIMIT 1")
        .get(requestId) ?? null
    );
  }

  #attemptDigests(requestId) {
    return this.#db
      .prepare("SELECT payload_digest FROM attempts WHERE request_id = ?")
      .all(requestId)
      .map((r) => r.payload_digest);
  }

  #insertAttempt(requestId, payloadDigest) {
    this.#db
      .prepare("INSERT OR IGNORE INTO attempts(request_id, payload_digest, first_seen_at) VALUES (?, ?, ?)")
      .run(requestId, payloadDigest, iso(this.#clock));
  }

  #insertConflict(requestId, payloadDigest, kind) {
    this.#db
      .prepare("INSERT INTO conflicts(request_id, payload_digest, kind, detected_at) VALUES (?, ?, ?, ?)")
      .run(requestId, payloadDigest, kind, iso(this.#clock));
  }

  #insertDecision(requestId, payloadDigest, decision, reason) {
    this.#db
      .prepare(
        "INSERT INTO requests(request_id, payload_digest, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(requestId, payloadDigest, decision, reason, iso(this.#clock));
  }

  #result({ requestId, payloadDigest, attemptPayloadDigest = undefined, decision = null, outcome, reason = null, replayed = false, compliance, capUsed }) {
    return {
      requestId,
      payloadDigest,
      ...(attemptPayloadDigest === undefined ? {} : { attemptPayloadDigest }),
      decision,
      outcome,
      reason,
      replayed,
      compliance,
      capUsed,
      capLimit: this.#config?.capLimit ?? null,
    };
  }

  #existingResult(row, { requestId, payloadDigest, replayed, compliance }) {
    // Compliance is derived from durable facts, not from the shape of the
    // current call. A replay after an earlier post-decision payload conflict is
    // still a violation even when the replay itself uses the original payload.
    const conflicted = this.#anyConflict(requestId) != null;
    return this.#result({
      requestId,
      // The decision's payload digest is immutable. A later conflicting attempt
      // must not make the result look as if the wrong payload was admitted.
      payloadDigest: row.payload_digest,
      attemptPayloadDigest: payloadDigest,
      decision: row.decision,
      outcome: row.decision,
      reason: row.reason,
      replayed,
      compliance: conflicted ? COMPLIANCE.VIOLATED : compliance,
      capUsed: this.#capUsed(),
    });
  }

  #contradictoryResult(requestId, payloadDigest) {
    return this.#result({
      requestId,
      payloadDigest,
      decision: null,
      outcome: OUTCOME.CONTRADICTORY,
      reason: "payload-conflict",
      replayed: false,
      compliance: COMPLIANCE.VIOLATED,
      capUsed: this.#capUsed(),
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
        /* the transaction may already be rolled back */
      }
      throw err;
    }
  }

  /**
   * Register one attempt and resolve the existing decision/conflict state.
   * The attempt is committed before the decision transaction so a crash can
   * leave a real "no decision yet" request (which is not an admission).
   */
  #prepareAttempt(requestId, payloadDigest) {
    const existing = this.#decisionRow(requestId);
    if (existing) {
      if (existing.payload_digest !== payloadDigest) {
        this.#insertConflict(requestId, payloadDigest, "post_decision");
        return {
          needsDecision: false,
          result: this.#existingResult(existing, {
            requestId,
            payloadDigest,
            replayed: false,
            compliance: COMPLIANCE.VIOLATED,
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
        }),
      };
    }

    if (this.#anyConflict(requestId)) {
      return { needsDecision: false, result: this.#contradictoryResult(requestId, payloadDigest) };
    }

    const digests = this.#attemptDigests(requestId);
    if (digests.length > 0 && (digests.length > 1 || !digests.includes(payloadDigest))) {
      this.#insertAttempt(requestId, payloadDigest);
      this.#insertConflict(requestId, payloadDigest, "pre_decision");
      return { needsDecision: false, result: this.#contradictoryResult(requestId, payloadDigest) };
    }

    this.#insertAttempt(requestId, payloadDigest);
    return { needsDecision: true, result: null };
  }

  #decide(requestId, payloadDigest) {
    if (this.#anyConflict(requestId)) {
      return this.#contradictoryResult(requestId, payloadDigest);
    }

    const existing = this.#decisionRow(requestId);
    if (existing) {
      if (existing.payload_digest !== payloadDigest) {
        this.#insertConflict(requestId, payloadDigest, "post_decision");
        return this.#existingResult(existing, {
          requestId,
          payloadDigest,
          replayed: false,
          compliance: COMPLIANCE.VIOLATED,
        });
      }
      return this.#existingResult(existing, {
        requestId,
        payloadDigest,
        replayed: true,
        compliance: COMPLIANCE.COMPLIANT,
      });
    }

    const digests = this.#attemptDigests(requestId);
    if (digests.some((digest) => digest !== payloadDigest)) {
      this.#insertConflict(requestId, payloadDigest, "pre_decision");
      return this.#contradictoryResult(requestId, payloadDigest);
    }

    const capLimit = this.#requireSealedConfig().capLimit;
    const capUsed = this.#capUsed();
    if (capUsed >= capLimit) {
      this.#insertDecision(requestId, payloadDigest, DECISION.REJECTED, "cap");
      return this.#result({
        requestId,
        payloadDigest,
        decision: DECISION.REJECTED,
        outcome: OUTCOME.REJECTED,
        reason: "cap",
        replayed: false,
        compliance: COMPLIANCE.COMPLIANT,
        capUsed,
      });
    }

    this.#insertDecision(requestId, payloadDigest, DECISION.ADMITTED, "admitted");
    return this.#result({
      requestId,
      payloadDigest,
      decision: DECISION.ADMITTED,
      outcome: OUTCOME.ADMITTED,
      reason: "admitted",
      replayed: false,
      compliance: COMPLIANCE.COMPLIANT,
      capUsed: capUsed + 1,
    });
  }

  /**
   * Resolve a logical request.
   *
   * The attempt is committed first; the decision is durably committed before
   * this method returns. A fault before the decision commit leaves no decision;
   * a fault after the decision commit leaves the decision durable but does not
   * report it to the caller.
   */
  async admit({ requestId, payloadDigest } = {}) {
    this.#assertOpen();
    this.#requireSealedConfig();
    const rid = normalizeRequestId(requestId);
    const digest = normalizePayloadDigest(payloadDigest);

    const prepared = this.#withImmediate(() => {
      const value = this.#prepareAttempt(rid, digest);
      this.#fault("before_attempt_commit", rid);
      return value;
    });
    this.#fault("after_attempt_commit", rid);
    if (!prepared.needsDecision) return prepared.result;

    const result = this.#withImmediate(() => {
      const value = this.#decide(rid, digest);
      this.#fault("before_decision_commit", rid);
      return value;
    });
    this.#fault("after_decision_commit", rid);
    return result;
  }

  /** Durable decision for a request, or null when no decision exists. */
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
      decidedAt: row.decided_at,
    };
  }

  /** Cap usage derived from durable admission facts, never an in-memory counter. */
  capUsage() {
    this.#assertOpen();
    return this.#capUsed();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
