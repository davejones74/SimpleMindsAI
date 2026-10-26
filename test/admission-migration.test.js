import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AdmissionStore } from "../src/gateway/admission-store.js";
import { RollingAdmissionStore } from "../src/gateway/rolling-admission-store.js";
import {
  buildMigrationPlan,
  migrateRollingPolicy,
} from "../src/gateway/admission-migration.js";

const T0 = Date.parse("2026-10-26T22:00:00.000Z");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-migration-"));
const digest = (ch) => ch.repeat(64);

function policy(overrides = {}) {
  return {
    policyVersion: "rolling-v1",
    policyMode: "rolling",
    capEpoch: "migration-target-epoch",
    ackRequired: false,
    protocolVersion: "baseline-v1",
    quotaWindowMs: 10_000,
    quotaLimit: 100,
    perDomainLimit: 100,
    perDomainWindowMs: 10_000,
    rateWindowMs: 10_000,
    rateLimit: 1000,
    maxConcurrent: 1,
    storageMinFreeBytes: 0,
    storageMaxDbBytes: 0,
    storageRetryMs: 100,
    deferralRetentionMs: 60_000,
    deferralMaxRows: 100,
    ...overrides,
  };
}

async function legacyAt(dir, { capLimit = 100, capEpoch = "legacy-epoch", now = T0 } = {}) {
  let clockNow = now;
  const store = await AdmissionStore.open({
    dir,
    clock: () => new Date(clockNow),
    config: { capLimit, capEpoch, ackRequired: false, protocolVersion: "baseline-v1" },
  });
  return {
    store,
    setNow: (value) => { clockNow = value; },
  };
}

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function admit(store, id, payload = "a") {
  return store.admit({ requestId: id, payloadDigest: digest(payload) });
}

test("migration imports all stores, excludes cap rejections, dedupes exact identities, preserves replay/timestamps and does not create a pointer", async () => {
  const root = tmp();
  const admissionDir = path.join(root, "admission");
  const targetDir = path.join(root, "target");
  mkdirSync(path.join(admissionDir, "epochs", "e1"), { recursive: true });
  mkdirSync(path.join(admissionDir, "epochs", "e2"), { recursive: true });

  const rootStore = await legacyAt(admissionDir, { capLimit: 1, capEpoch: "root-epoch" });
  await admit(rootStore.store, "r1", "a");
  await admit(rootStore.store, "r2", "b"); // cap rejection
  rootStore.store.close();

  const e1 = await legacyAt(path.join(admissionDir, "epochs", "e1"), { capEpoch: "e1" });
  await admit(e1.store, "r3", "c");
  await admit(e1.store, "r4", "d");
  e1.store.close();

  const e2 = await legacyAt(path.join(admissionDir, "epochs", "e2"), { capEpoch: "e2" });
  await admit(e2.store, "r3", "c"); // exact duplicate identity/decision
  await admit(e2.store, "r5", "e");
  e2.store.close();

  const frontier = path.join(root, "frontier.ndjson");
  writeFileSync(
    frontier,
    [
      JSON.stringify({ requestId: "r1", url: "https://a.test/one" }),
      JSON.stringify({ requestId: "r3", url: "https://b.test/three" }),
    ].join("\n") + "\n",
  );
  const rootDb = path.join(admissionDir, "admission.sqlite");
  const sourceHashBefore = hash(rootDb);

  const plan = await buildMigrationPlan({
    admissionDir,
    targetDir,
    policyConfig: policy(),
    clock: () => new Date(T0 + 5000),
    frontierFile: frontier,
  });
  assert.equal(plan.sources.length, 3);
  assert.equal(plan.decisions.capRejectedExcluded, 1);
  assert.equal(plan.excludedCapRejections.count, 1);
  assert.equal(plan.decisions.duplicateDecisions, 1);
  assert.equal(plan.decisions.imported, 4, "r1, r3, r4, r5");
  assert.equal(plan.quota.used, 4);
  assert.equal(plan.scope.withScope, 2);
  assert.equal(plan.scope.withoutScope, 2);

  const manifest = await migrateRollingPolicy({
    admissionDir,
    targetDir,
    policyConfig: policy(),
    clock: () => new Date(T0 + 5000),
    frontierFile: frontier,
    dryRun: false,
    manifestPath: path.join(root, "manifest.json"),
  });
  assert.equal(manifest.mode, "migrate");
  assert.equal(manifest.pointerCreated, false);
  assert.equal(manifest.verification.passed, true);
  assert.equal(manifest.target.quotaUsed, 4);
  assert.ok(manifest.target.dbHash);
  assert.equal(existsSync(path.join(admissionDir, "ACTIVE_POLICY.json")), false);
  assert.equal(hash(rootDb), sourceHashBefore, "legacy source is unchanged");

  const reopened = await RollingAdmissionStore.open({ dir: targetDir, config: null, clock: () => new Date(T0 + 5000) });
  try {
    assert.equal(reopened.getDecision("r2"), null, "cap rejection was not imported as a decision");
    assert.equal(reopened.getDecision("r1").decision, "ADMITTED");
    assert.equal(reopened.getDecision("r1").scope, "a.test");
    assert.equal(reopened.getDecision("r3").scope, "b.test");
    const replay = await reopened.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(replay.decision, "ADMITTED");
    assert.equal(replay.replayed, true);
    assert.equal(reopened.quotaStatus(T0 + 5000).quotaUsed, 4);
    assert.equal(reopened.getDecision("r3").decidedAtMs, T0);
  } finally {
    reopened.close();
  }

  const rerun = await migrateRollingPolicy({
    admissionDir,
    targetDir,
    policyConfig: policy(),
    clock: () => new Date(T0 + 5000),
    frontierFile: frontier,
    dryRun: false,
  });
  assert.equal(rerun.decisions.importedNow, 0, "rerun is idempotent");
  assert.equal(rerun.decisions.skippedExisting, 4);
  assert.equal(rerun.target.dbHash, manifest.target.dbHash);
  rmSync(root, { recursive: true, force: true });
});

test("dry-run does not create the target and reports the computed window usage", async () => {
  const root = tmp();
  const admissionDir = path.join(root, "admission");
  const targetDir = path.join(root, "target");
  mkdirSync(admissionDir, { recursive: true });
  const source = await legacyAt(admissionDir, { capEpoch: "dry" });
  await admit(source.store, "r1", "a");
  source.store.close();
  try {
    const manifest = await migrateRollingPolicy({
      admissionDir,
      targetDir,
      policyConfig: policy({ quotaWindowMs: 1000 }),
      clock: () => new Date(T0 + 1000),
      dryRun: true,
    });
    assert.equal(manifest.mode, "dry-run");
    assert.equal(manifest.target.created, false);
    assert.equal(existsSync(targetDir), false);
    assert.equal(manifest.quota.used, 0, "T0 is exactly 1000ms old and therefore outside (now-24h, now]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration fails on conflicting identities and malformed timestamps", async () => {
  const root = tmp();
  const admissionDir = path.join(root, "admission");
  mkdirSync(path.join(admissionDir, "epochs", "a"), { recursive: true });
  mkdirSync(path.join(admissionDir, "epochs", "b"), { recursive: true });
  const a = await legacyAt(path.join(admissionDir, "epochs", "a"), { capEpoch: "a" });
  await admit(a.store, "same", "a"); a.store.close();
  const b = await legacyAt(path.join(admissionDir, "epochs", "b"), { capEpoch: "b" });
  await admit(b.store, "same", "b"); b.store.close();
  await assert.rejects(
    () => buildMigrationPlan({
      admissionDir,
      targetDir: path.join(root, "target"),
      policyConfig: policy(),
      clock: () => new Date(T0 + 1000),
    }),
    (err) => err.code === "MIGRATION_IDENTITY_CONFLICT",
  );
  rmSync(path.join(admissionDir, "epochs", "b"), { recursive: true, force: true });
  const db = new DatabaseSync(path.join(admissionDir, "epochs", "a", "admission.sqlite"));
  db.prepare("UPDATE requests SET decided_at = 'not-a-time'").run();
  db.close();
  await assert.rejects(
    () => buildMigrationPlan({
      admissionDir,
      targetDir: path.join(root, "target"),
      policyConfig: policy(),
      clock: () => new Date(T0 + 1000),
    }),
    (err) => err.code === "MALFORMED_TIMESTAMP",
  );
  rmSync(root, { recursive: true, force: true });
});

test("migration fails on clock regression and missing sources", async () => {
  const root = tmp();
  const admissionDir = path.join(root, "admission");
  mkdirSync(admissionDir, { recursive: true });
  let now = T0 + 5000;
  const source = await AdmissionStore.open({
    dir: admissionDir,
    clock: () => new Date(now),
    config: { capLimit: 100, capEpoch: "clock", ackRequired: false, protocolVersion: "baseline-v1" },
  });
  await admit(source, "r1", "a");
  source.close();
  try {
    await assert.rejects(
      () => buildMigrationPlan({
        admissionDir,
        targetDir: path.join(root, "target"),
        policyConfig: policy(),
        clock: () => new Date(T0),
      }),
      (err) => err.code === "CLOCK_REGRESSION",
    );
    await assert.rejects(
      () => buildMigrationPlan({
        admissionDir: path.join(root, "missing"),
        targetDir: path.join(root, "target"),
        policyConfig: policy(),
      }),
      (err) => err.code === "SOURCE_MISSING",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration fails when the target already contains a decision outside the plan", async () => {
  const root = tmp();
  const admissionDir = path.join(root, "admission");
  const targetDir = path.join(root, "target");
  mkdirSync(admissionDir, { recursive: true });
  const source = await legacyAt(admissionDir, { capEpoch: "source" });
  await admit(source.store, "r1", "a");
  source.store.close();
  const target = await RollingAdmissionStore.open({
    dir: targetDir,
    config: policy(),
    clock: () => new Date(T0 + 1000),
  });
  await target.admit({ requestId: "extra", payloadDigest: digest("f"), scope: "z.test" });
  target.close();
  try {
    await assert.rejects(
      () => migrateRollingPolicy({
        admissionDir,
        targetDir,
        policyConfig: policy(),
        clock: () => new Date(T0 + 1000),
        dryRun: false,
      }),
      (err) => err.code === "TARGET_HAS_EXTRA_DECISIONS",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration window boundary is based on original timestamps", async () => {
  const root = tmp();
  const admissionDir = path.join(root, "admission");
  mkdirSync(admissionDir, { recursive: true });
  const source = await legacyAt(admissionDir, { capEpoch: "boundary", now: T0 });
  await admit(source.store, "old", "a");
  source.setNow(T0 + 1000);
  await admit(source.store, "edge", "b");
  source.store.close();
  try {
    const plan = await buildMigrationPlan({
      admissionDir,
      targetDir: path.join(root, "target"),
      policyConfig: policy({ quotaWindowMs: 1000 }),
      clock: () => new Date(T0 + 1000),
    });
    assert.equal(plan.quota.used, 1, "T0 is outside; T0+1000 is inside");
    assert.equal(plan.quota.oldestCountedAt, new Date(T0 + 1000).toISOString());
    assert.equal(plan.quota.nextCapacityAt, new Date(T0 + 2000).toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
