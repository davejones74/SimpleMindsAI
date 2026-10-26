import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configHashFor } from "./admission-store.js";
import { normalizeRollingPolicy, RollingAdmissionStore } from "./rolling-admission-store.js";

/**
 * Stage 2 migration planner/executor.
 *
 * The tool reads every legacy sealed admission store, excludes legacy
 * reason='cap' rejections from target decisions, imports admitted and genuine
 * non-quota decisions with their original timestamps, verifies identity and
 * replay behavior, and writes a manifest. It never writes ACTIVE_POLICY.json.
 * Real mode writes only to an explicit target directory; dry-run writes nothing
 * except an optional manifest.
 */

export const MIGRATION_TOOL_VERSION = 1;
const DB_FILE = "admission.sqlite";
const REQUEST_RE = /^[0-9a-f]{64}$/i;

export class AdmissionMigrationError extends Error {
  constructor(message, code = "MIGRATION_ERROR", details = {}) {
    super(message);
    this.name = "AdmissionMigrationError";
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parseTimestamp(value, source) {
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    throw new AdmissionMigrationError(`malformed decided_at in ${source}: ${String(value)}`, "MALFORMED_TIMESTAMP", {
      source,
      value,
    });
  }
  return ms;
}

function normalizeClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AdmissionMigrationError("clock returned an invalid date", "INVALID_CLOCK");
  return date;
}

function resolveFrontierFile(frontierFile) {
  if (!frontierFile) return null;
  const resolved = path.resolve(frontierFile);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return path.join(resolved, "frontier.ndjson");
  }
  return resolved;
}

export function loadFrontierScopeMap(frontierFile) {
  const file = resolveFrontierFile(frontierFile);
  if (!file) return { file: null, hash: null, map: new Map(), records: 0 };
  if (!existsSync(file)) throw new AdmissionMigrationError(`frontier file is missing: ${file}`, "FRONTIER_MISSING");
  const map = new Map();
  let records = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record?.requestId || !record?.url) continue;
    let domain;
    try {
      domain = new URL(record.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const prior = map.get(record.requestId);
    if (prior && prior !== domain) {
      throw new AdmissionMigrationError(
        `frontier scope conflict for request ${record.requestId}: ${prior} vs ${domain}`,
        "SCOPE_CONFLICT",
      );
    }
    map.set(record.requestId, domain);
    records++;
  }
  return { file, hash: sha256File(file), map, records };
}

export function listLegacyAdmissionStores(admissionDir, { excludeDir = null } = {}) {
  const root = path.resolve(admissionDir);
  const excluded = excludeDir ? path.resolve(excludeDir) : null;
  const sources = [];
  const add = (file, kind, epoch = null) => {
    if (!existsSync(file)) return;
    if (excluded && path.resolve(path.dirname(file)) === excluded) return;
    sources.push({ path: path.resolve(file), kind, epoch });
  };
  add(path.join(root, DB_FILE), "legacy-root");
  const epochsDir = path.join(root, "epochs");
  if (existsSync(epochsDir) && statSync(epochsDir).isDirectory()) {
    for (const entry of readdirSync(epochsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      add(path.join(epochsDir, entry.name, DB_FILE), "epoch", entry.name);
    }
  }
  sources.sort((a, b) => a.path.localeCompare(b.path));
  return sources;
}

function readLegacySource(source, { clock, requireQuiescent = true }) {
  // A clean SQLite close may leave an empty WAL and a transient SHM. Those are
  // safe to read. A non-empty WAL means the source may still have uncheckpointed
  // writes, so the production procedure requires a stopped/checkpointed source.
  const walPath = `${source.path}-wal`;
  if (requireQuiescent && existsSync(walPath) && statSync(walPath).size > 0) {
    throw new AdmissionMigrationError(
      `source ${source.path} has a non-empty WAL; stop the service/checkpoint before migration`,
      "SOURCE_NOT_QUIESCENT",
      { source: source.path, walBytes: statSync(walPath).size },
    );
  }
  const beforeHash = sha256File(source.path);
  const db = new DatabaseSync(source.path, { readOnly: true });
  try {
    const sealed = db
      .prepare("SELECT cap_limit, cap_epoch, ack_required, protocol_version, sealed_at, config_hash FROM sealed_config WHERE id = 1")
      .get();
    if (!sealed) {
      throw new AdmissionMigrationError(`source is unsealed: ${source.path}`, "SOURCE_UNSEALED", { source: source.path });
    }
    const sealedConfig = {
      capLimit: Number(sealed.cap_limit),
      capEpoch: sealed.cap_epoch,
      ackRequired: Boolean(sealed.ack_required),
      protocolVersion: sealed.protocol_version,
      sealedAt: sealed.sealed_at,
      configHash: sealed.config_hash,
    };
    if (configHashFor(sealedConfig) !== sealedConfig.configHash) {
      throw new AdmissionMigrationError(`source sealed config hash mismatch: ${source.path}`, "SOURCE_CORRUPT_CONFIG", {
        source: source.path,
      });
    }

    const requests = db
      .prepare("SELECT request_id, payload_digest, decision, reason, decided_at FROM requests")
      .all();
    const decisions = requests.map((row) => {
      if (typeof row.request_id !== "string" || !row.request_id) {
        throw new AdmissionMigrationError(`invalid request_id in ${source.path}`, "INVALID_SOURCE_IDENTITY", { source: source.path });
      }
      if (typeof row.payload_digest !== "string" || !REQUEST_RE.test(row.payload_digest)) {
        throw new AdmissionMigrationError(`invalid payload_digest for ${row.request_id}`, "INVALID_SOURCE_IDENTITY", {
          source: source.path,
          requestId: row.request_id,
        });
      }
      if (row.decision !== "ADMITTED" && row.decision !== "REJECTED") {
        throw new AdmissionMigrationError(`invalid decision for ${row.request_id}`, "INVALID_SOURCE_DECISION", {
          source: source.path,
          requestId: row.request_id,
        });
      }
      const decidedAt = String(row.decided_at);
      return {
        requestId: row.request_id,
        payloadDigest: row.payload_digest.toLowerCase(),
        decision: row.decision,
        reason: row.reason ?? null,
        decidedAt,
        decidedAtMs: parseTimestamp(decidedAt, source.path),
        capRejection: row.decision === "REJECTED" && row.reason === "cap",
        sourcePath: source.path,
        sourceKind: source.kind,
        sourceEpoch: source.epoch,
        scope: null,
      };
    });

    const attemptsByRequest = new Map();
    for (const row of db.prepare("SELECT request_id, payload_digest, first_seen_at FROM attempts").all()) {
      if (!attemptsByRequest.has(row.request_id)) attemptsByRequest.set(row.request_id, []);
      attemptsByRequest.get(row.request_id).push({
        payloadDigest: row.payload_digest,
        firstSeenAt: row.first_seen_at,
      });
    }
    const conflictsByRequest = new Map();
    for (const row of db.prepare("SELECT request_id, payload_digest, kind, detected_at FROM conflicts").all()) {
      if (!conflictsByRequest.has(row.request_id)) conflictsByRequest.set(row.request_id, []);
      conflictsByRequest.get(row.request_id).push({
        payloadDigest: row.payload_digest,
        kind: row.kind,
        detectedAt: row.detected_at,
      });
    }

    const afterHash = sha256File(source.path);
    if (beforeHash !== afterHash) {
      throw new AdmissionMigrationError(`source changed while reading: ${source.path}`, "SOURCE_CHANGED_DURING_READ", {
        source: source.path,
      });
    }
    return {
      ...source,
      dbHash: beforeHash,
      sealedConfig,
      decisions,
      attemptsByRequest,
      conflictsByRequest,
      counts: {
        decisions: decisions.length,
        admitted: decisions.filter((d) => d.decision === "ADMITTED").length,
        nonCapRejected: decisions.filter((d) => d.decision === "REJECTED" && !d.capRejection).length,
        capRejected: decisions.filter((d) => d.capRejection).length,
        attempts: [...attemptsByRequest.values()].reduce((n, a) => n + a.length, 0),
        conflicts: [...conflictsByRequest.values()].reduce((n, a) => n + a.length, 0),
      },
    };
  } finally {
    db.close();
  }
}

function sameDecision(a, b) {
  return (
    a.requestId === b.requestId &&
    a.payloadDigest === b.payloadDigest &&
    a.decision === b.decision &&
    (a.reason ?? null) === (b.reason ?? null) &&
    a.decidedAtMs === b.decidedAtMs &&
    a.decidedAt === b.decidedAt
  );
}

function mergeFacts(target, source, requestId) {
  const attempts = new Map(
    (target.attempts ?? []).map((attempt) => [`${attempt.payloadDigest}|${attempt.firstSeenAt}`, attempt]),
  );
  const conflicts = new Map(
    (target.conflicts ?? []).map((conflict) => [`${conflict.payloadDigest}|${conflict.kind}|${conflict.detectedAt}`, conflict]),
  );
  for (const attempt of source.attemptsByRequest.get(requestId) ?? []) {
    attempts.set(`${attempt.payloadDigest}|${attempt.firstSeenAt}`, attempt);
  }
  for (const conflict of source.conflictsByRequest.get(requestId) ?? []) {
    conflicts.set(`${conflict.payloadDigest}|${conflict.kind}|${conflict.detectedAt}`, conflict);
  }
  target.attempts = [...attempts.values()];
  target.conflicts = [...conflicts.values()];
}

export async function buildMigrationPlan({
  admissionDir,
  targetDir = null,
  policyConfig,
  clock = () => new Date(),
  frontierFile = null,
  requireQuiescent = true,
} = {}) {
  if (typeof admissionDir !== "string" || !admissionDir.trim()) {
    throw new AdmissionMigrationError("admissionDir is required", "INVALID_SOURCE");
  }
  if (targetDir != null && path.resolve(targetDir) === path.resolve(admissionDir)) {
    throw new AdmissionMigrationError("targetDir must not be the admission source directory", "INVALID_TARGET");
  }
  const policy = normalizeRollingPolicy(policyConfig);
  const sources = listLegacyAdmissionStores(admissionDir, { excludeDir: targetDir });
  if (!sources.length) {
    throw new AdmissionMigrationError(`no legacy admission stores found under ${admissionDir}`, "SOURCE_MISSING");
  }
  const readSources = sources.map((source) => readLegacySource(source, { clock, requireQuiescent }));
  const scopeInfo = loadFrontierScopeMap(frontierFile);

  const groups = new Map();
  for (const source of readSources) {
    for (const decision of source.decisions) {
      if (!groups.has(decision.requestId)) groups.set(decision.requestId, []);
      groups.get(decision.requestId).push(decision);
    }
  }

  const imported = [];
  const identityConflicts = [];
  const duplicateIds = [];
  const capExcluded = [];
  let duplicateDecisions = 0;

  for (const [requestId, records] of groups.entries()) {
    if (records.length > 1) duplicateIds.push(requestId);
    const nonCap = records.filter((d) => !d.capRejection);
    const cap = records.filter((d) => d.capRejection);
    if (nonCap.length && cap.length) {
      identityConflicts.push({
        requestId,
        reason: "cap-and-non-cap-decision",
        records: records.map((d) => ({ source: d.sourcePath, decision: d.decision, reason: d.reason })),
      });
      continue;
    }
    if (!nonCap.length) {
      const firstCap = cap[0];
      if (cap.some((d) => !sameDecision(firstCap, d))) {
        identityConflicts.push({
          requestId,
          reason: "conflicting-cap-rejections",
          records: cap.map((d) => ({ source: d.sourcePath, payloadDigest: d.payloadDigest, decidedAt: d.decidedAt })),
        });
        continue;
      }
      capExcluded.push(...cap);
      continue;
    }
    const first = nonCap[0];
    if (nonCap.some((d) => !sameDecision(first, d))) {
      identityConflicts.push({
        requestId,
        reason: "conflicting-decisions",
        records: nonCap.map((d) => ({ source: d.sourcePath, payloadDigest: d.payloadDigest, decision: d.decision, decidedAt: d.decidedAt })),
      });
      continue;
    }
    if (nonCap.length > 1) duplicateDecisions += nonCap.length - 1;
    const scope = scopeInfo.map.get(requestId) ?? null;
    const target = {
      ...first,
      scope,
      attempts: [],
      conflicts: [],
    };
    for (const record of nonCap) {
      const source = readSources.find((s) => s.path === record.sourcePath);
      if (source) mergeFacts(target, source, requestId);
    }
    imported.push(target);
  }

  if (identityConflicts.length) {
    throw new AdmissionMigrationError(
      `identity conflicts detected for ${identityConflicts.length} request(s)`,
      "MIGRATION_IDENTITY_CONFLICT",
      { conflicts: identityConflicts },
    );
  }

  const now = normalizeClock(clock);
  const nowMs = now.getTime();
  const future = imported.find((d) => d.decidedAtMs > nowMs);
  if (future) {
    throw new AdmissionMigrationError(
      `clock regression: imported decision ${future.requestId} is after migration clock`,
      "CLOCK_REGRESSION",
      { requestId: future.requestId, decidedAt: future.decidedAt, now: now.toISOString() },
    );
  }
  const admissions = imported.filter((d) => d.decision === "ADMITTED");
  const counted = admissions
    .filter((d) => d.decidedAtMs > nowMs - policy.quotaWindowMs && d.decidedAtMs <= nowMs)
    .sort((a, b) => a.decidedAtMs - b.decidedAtMs);
  const quotaUsed = counted.length;
  const oldest = counted[0]?.decidedAtMs ?? null;
  const quota = {
    windowMs: policy.quotaWindowMs,
    limit: policy.quotaLimit,
    used: quotaUsed,
    remaining: Math.max(0, policy.quotaLimit - quotaUsed),
    oldestCountedAt: oldest == null ? null : new Date(oldest).toISOString(),
    nextCapacityAt: oldest == null ? null : new Date(oldest + policy.quotaWindowMs).toISOString(),
    now: now.toISOString(),
  };
  const scopeCoverage = {
    withScope: imported.filter((d) => d.scope != null).length,
    withoutScope: imported.filter((d) => d.scope == null).length,
    frontierFile: scopeInfo.file,
    frontierHash: scopeInfo.hash,
    frontierRecords: scopeInfo.records,
  };

  return {
    toolVersion: MIGRATION_TOOL_VERSION,
    admissionDir: path.resolve(admissionDir),
    targetDir: targetDir == null ? null : path.resolve(targetDir),
    policy,
    now: now.toISOString(),
    sources: readSources.map((source) => ({
      path: source.path,
      kind: source.kind,
      epoch: source.epoch,
      dbHash: source.dbHash,
      sealedConfig: source.sealedConfig,
      counts: source.counts,
    })),
    decisions: {
      sourceTotal: readSources.reduce((n, s) => n + s.counts.decisions, 0),
      imported: imported.length,
      admitted: admissions.length,
      nonCapRejected: imported.filter((d) => d.decision === "REJECTED").length,
      capRejectedExcluded: capExcluded.length,
      duplicateDecisions,
      duplicateRequestIds: duplicateIds.length,
    },
    excludedCapRejections: {
      count: new Set(capExcluded.map((d) => d.requestId)).size,
      sourceRows: capExcluded.length,
      sample: capExcluded.slice(0, 20).map((d) => ({
        requestId: d.requestId,
        source: d.sourcePath,
        decidedAt: d.decidedAt,
      })),
    },
    identityConflicts: [],
    scope: scopeCoverage,
    quota,
    importedDecisions: imported,
  };
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(path.resolve(file));
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function verifyTarget(target, plan, nowMs) {
  const decisions = target.listDecisions();
  const expected = new Map(plan.importedDecisions.map((d) => [d.requestId, d]));
  const actual = new Map(decisions.map((d) => [d.requestId, d]));
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const extra = [...actual.keys()].filter((id) => !expected.has(id));
  if (missing.length || extra.length) {
    throw new AdmissionMigrationError("target decision set does not match migration plan", "MIGRATION_VERIFICATION_FAILED", {
      missing,
      extra,
    });
  }
  for (const [requestId, want] of expected) {
    const got = actual.get(requestId);
    if (
      got.payloadDigest !== want.payloadDigest ||
      got.decision !== want.decision ||
      (got.reason ?? null) !== (want.reason ?? null) ||
      got.decidedAtMs !== want.decidedAtMs ||
      (got.scope ?? null) !== (want.scope ?? null)
    ) {
      throw new AdmissionMigrationError(`target decision mismatch for ${requestId}`, "MIGRATION_VERIFICATION_FAILED", {
        requestId,
      });
    }
  }
  const status = target.quotaStatus(nowMs);
  if (status.quotaUsed !== plan.quota.used) {
    throw new AdmissionMigrationError("target rolling usage does not match migration plan", "MIGRATION_VERIFICATION_FAILED", {
      expected: plan.quota.used,
      actual: status.quotaUsed,
    });
  }
  return {
    decisions: decisions.length,
    quotaUsed: status.quotaUsed,
    oldestCountedAt: status.oldestCountedAt,
    nextCapacityAt: status.nextCapacityAt,
  };
}

export async function migrateRollingPolicy({
  admissionDir,
  targetDir = null,
  policyConfig,
  clock = () => new Date(),
  frontierFile = null,
  dryRun = true,
  manifestPath = null,
  requireQuiescent = true,
} = {}) {
  const plan = await buildMigrationPlan({ admissionDir, targetDir, policyConfig, clock, frontierFile, requireQuiescent });
  const nowMs = Date.parse(plan.now);
  if (dryRun) {
    const manifest = {
      ...plan,
      mode: "dry-run",
      target: plan.targetDir ? { dir: plan.targetDir, created: false, verified: false } : null,
      verification: { sourceHashesUnchanged: true, targetDecisionsMatch: null, quotaMatches: true, passed: true },
      pointerCreated: false,
    };
    if (manifestPath) atomicWriteJson(manifestPath, manifest);
    return manifest;
  }

  if (!plan.targetDir) throw new AdmissionMigrationError("targetDir is required for real migration", "INVALID_TARGET");
  for (const source of plan.sources) {
    if (path.resolve(source.path) === path.join(plan.targetDir, DB_FILE)) {
      throw new AdmissionMigrationError("target database is also a source database", "INVALID_TARGET");
    }
  }

  const store = await RollingAdmissionStore.open({ dir: plan.targetDir, config: plan.policy, clock });
  let imported = 0;
  let skipped = 0;
  try {
    const before = store.listDecisions();
    const expectedIds = new Set(plan.importedDecisions.map((d) => d.requestId));
    const extras = before.filter((d) => !expectedIds.has(d.requestId));
    if (extras.length) {
      throw new AdmissionMigrationError("target has decisions outside the migration plan", "TARGET_HAS_EXTRA_DECISIONS", {
        requestIds: extras.map((d) => d.requestId),
      });
    }
    for (const decision of plan.importedDecisions) {
      const result = await store.importDecision({
        ...decision,
        nowMs,
      });
      if (result.imported) imported++;
      else skipped++;
    }
    const verify = verifyTarget(store, plan, nowMs);
    const targetPolicy = store.sealedConfig;
    if (targetPolicy.configHash !== plan.policy.configHash) {
      throw new AdmissionMigrationError("target sealed policy does not match plan", "MIGRATION_VERIFICATION_FAILED");
    }
    const sourceHashes = plan.sources.map((source) => sha256File(source.path));
    const sourceHashesUnchanged = sourceHashes.every((hash, i) => hash === plan.sources[i].dbHash);
    if (!sourceHashesUnchanged) {
      throw new AdmissionMigrationError("source hash changed during migration", "MIGRATION_VERIFICATION_FAILED");
    }
    const manifest = {
      ...plan,
      mode: "migrate",
      decisions: { ...plan.decisions, importedNow: imported, skippedExisting: skipped },
      target: {
        dir: plan.targetDir,
        policy: targetPolicy,
        verified: true,
        decisionCount: verify.decisions,
        quotaUsed: verify.quotaUsed,
        oldestCountedAt: verify.oldestCountedAt,
        nextCapacityAt: verify.nextCapacityAt,
      },
      verification: {
        sourceHashesUnchanged,
        targetDecisionsMatch: true,
        quotaMatches: true,
        passed: true,
      },
      pointerCreated: false,
    };
    if (manifestPath) atomicWriteJson(manifestPath, manifest);
    store.close();
    manifest.target.dbHash = sha256File(path.join(plan.targetDir, DB_FILE));
    if (manifestPath) atomicWriteJson(manifestPath, manifest);
    return manifest;
  } catch (err) {
    store.close();
    throw err;
  }
}
