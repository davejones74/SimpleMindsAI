import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  RollingAdmissionStore,
  ROLLING_POLICY_VERSION,
} from "../src/gateway/rolling-admission-store.js";
import {
  AdmissionPolicyManager,
  policyDatabasePath,
  writeActivePolicyPointer,
} from "../src/gateway/admission-policy.js";
import { AcquisitionGateway } from "../src/gateway/acquisition-gateway.js";
import { AdmissionStore } from "../src/gateway/admission-store.js";

const T0 = Date.parse("2026-10-26T20:00:00.000Z");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-rolling-"));
const digest = (ch) => ch.repeat(64);

function policyConfig(overrides = {}) {
  return {
    policyVersion: ROLLING_POLICY_VERSION,
    policyMode: "rolling",
    capEpoch: "rolling-test-epoch",
    ackRequired: false,
    protocolVersion: "baseline-v1",
    quotaWindowMs: 1000,
    quotaLimit: 2,
    perDomainLimit: 1000,
    perDomainWindowMs: 1000,
    rateWindowMs: 1000,
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

async function openAt(dir, overrides = {}, extra = {}) {
  let now = T0;
  const clock = () => new Date(now);
  const store = await RollingAdmissionStore.open({ dir, config: policyConfig(overrides), clock, ...extra });
  return {
    store,
    setNow: (value) => { now = value; },
    now: () => now,
  };
}

function pointerFor(sealed, policyId = "rolling-v1") {
  return {
    version: 1,
    policyId,
    policyVersion: sealed.policyVersion,
    policyMode: sealed.policyMode,
    directory: `policies/${policyId}`,
    capEpoch: sealed.capEpoch,
    quotaWindowMs: sealed.quotaWindowMs,
    quotaLimit: sealed.quotaLimit,
    perDomainLimit: sealed.perDomainLimit,
    perDomainWindowMs: sealed.perDomainWindowMs,
    rateWindowMs: sealed.rateWindowMs,
    rateLimit: sealed.rateLimit,
    maxConcurrent: sealed.maxConcurrent,
    storageMinFreeBytes: sealed.storageMinFreeBytes,
    storageMaxDbBytes: sealed.storageMaxDbBytes,
    storageRetryMs: sealed.storageRetryMs,
    deferralRetentionMs: sealed.deferralRetentionMs,
    deferralMaxRows: sealed.deferralMaxRows,
    ackRequired: sealed.ackRequired,
    protocolVersion: sealed.protocolVersion,
    configHash: sealed.configHash,
    activatedAt: new Date(T0).toISOString(),
  };
}

test("rolling window boundary, transient deferral, and retry with the same request ID", async () => {
  const dir = tmp();
  const { store, setNow } = await openAt(dir, { quotaLimit: 1 });
  try {
    const first = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(first.decision, "ADMITTED");

    const blocked = await store.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "a.test" });
    assert.equal(blocked.decision, "DEFERRED");
    assert.equal(blocked.reason, "quota");
    assert.ok(blocked.retryAfterMs > 0);
    assert.equal(store.getDecision("r2"), null, "quota exhaustion writes no durable decision");
    assert.equal(store.quotaStatus().quotaUsed, 1);

    setNow(T0 + 999);
    const stillBlocked = await store.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "a.test" });
    assert.equal(stillBlocked.decision, "DEFERRED");

    setNow(T0 + 1000);
    const retried = await store.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "a.test" });
    assert.equal(retried.decision, "ADMITTED", "the same request ID can succeed after capacity returns");
    assert.equal(store.getDecision("r2").decision, "ADMITTED");
    assert.equal(store.quotaStatus().quotaUsed, 1, "the first admission has aged out");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay does not consume quota and duplicate decisions remain first-decision-wins", async () => {
  const dir = tmp();
  const { store } = await openAt(dir, { quotaLimit: 1 });
  try {
    const first = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    const replay = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(first.decision, "ADMITTED");
    assert.equal(replay.decision, "ADMITTED");
    assert.equal(replay.replayed, true);
    assert.equal(store.quotaStatus().quotaUsed, 1);
    assert.equal(store.quotaStatus().deferrals.count, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("global quota never overshoots under concurrent in-process admissions", async () => {
  const dir = tmp();
  const { store } = await openAt(dir, { quotaLimit: 2, rateLimit: 1000, perDomainLimit: 1000 });
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.admit({ requestId: `r${i}`, payloadDigest: (i % 16).toString(16).repeat(64), scope: "a.test" }),
      ),
    );
    assert.equal(results.filter((r) => r.decision === "ADMITTED").length, 2);
    assert.equal(results.filter((r) => r.decision === "DEFERRED").length, 8);
    assert.equal(results.filter((r) => r.decision === "REJECTED").length, 0);
    assert.equal(store.quotaStatus().quotaUsed, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-domain and short-window rate limits are independent", async () => {
  const dir = tmp();
  const { store, setNow } = await openAt(dir, {
    quotaLimit: 100,
    perDomainLimit: 1,
    perDomainWindowMs: 1000,
    rateWindowMs: 1000,
    rateLimit: 100,
  });
  try {
    assert.equal((await store.admit({ requestId: "a1", payloadDigest: digest("a"), scope: "a.test" })).decision, "ADMITTED");
    const domainBlocked = await store.admit({ requestId: "a2", payloadDigest: digest("b"), scope: "a.test" });
    assert.equal(domainBlocked.decision, "DEFERRED");
    assert.equal(domainBlocked.reason, "domain");
    assert.equal((await store.admit({ requestId: "b1", payloadDigest: digest("c"), scope: "b.test" })).decision, "ADMITTED");

    setNow(T0 + 1000);
    const rateLimited = await openAt(path.join(dir, "rate"), {
      quotaLimit: 100,
      rateLimit: 1,
      rateWindowMs: 1000,
      perDomainLimit: 100,
    });
    try {
      assert.equal((await rateLimited.store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" })).decision, "ADMITTED");
      const deferred = await rateLimited.store.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "b.test" });
      assert.equal(deferred.decision, "DEFERRED");
      assert.equal(deferred.reason, "rate");
      rateLimited.setNow(T0 + 1000);
      assert.equal((await rateLimited.store.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "b.test" })).decision, "ADMITTED");
    } finally {
      rateLimited.store.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage guard defers without a decision and allows retry when it recovers", async () => {
  const dir = tmp();
  let storageOk = false;
  const { store } = await openAt(dir, { quotaLimit: 10, perDomainLimit: 10 }, {
    storageGuard: () => ({
      ok: storageOk,
      freeBytes: 1,
      dbBytes: 2,
      retryAfterMs: 25,
      minFreeBytes: 100,
      maxDbBytes: 1000,
    }),
  });
  try {
    const blocked = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(blocked.decision, "DEFERRED");
    assert.equal(blocked.reason, "storage");
    assert.equal(store.getDecision("r1"), null);
    storageOk = true;
    const admitted = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(admitted.decision, "ADMITTED");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clock regression fails closed", async () => {
  const dir = tmp();
  const { store, setNow } = await openAt(dir, { quotaLimit: 10, perDomainLimit: 10 });
  try {
    await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    setNow(T0 - 1);
    await assert.rejects(
      () => store.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "a.test" }),
      (err) => err.code === "CLOCK_REGRESSION",
    );
    assert.equal(store.getDecision("r2"), null);
    assert.equal(store.quotaStatus().clockRegression, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deferral metadata is bounded and does not create request decisions", async () => {
  const dir = tmp();
  const { store } = await openAt(dir, {
    quotaLimit: 1,
    deferralMaxRows: 2,
    deferralRetentionMs: 60_000,
  });
  try {
    await store.admit({ requestId: "admitted", payloadDigest: digest("a"), scope: "a.test" });
    for (let i = 0; i < 6; i++) {
      const result = await store.admit({ requestId: `d${i}`, payloadDigest: digest(String(i % 10)), scope: "a.test" });
      assert.equal(result.decision, "DEFERRED");
    }
    assert.ok(store.quotaStatus().deferrals.count <= 2, "deferral rows are bounded");
    for (let i = 0; i < 6; i++) assert.equal(store.getDecision(`d${i}`), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fault injection preserves the deferral/decision boundary across restart", async () => {
  const dir = tmp();
  let failBefore = true;
  let now = T0;
  const clock = () => new Date(now);
  const store = await RollingAdmissionStore.open({
    dir,
    config: policyConfig({ quotaLimit: 1 }),
    clock,
    faultInjector: ({ phase }) => {
      if (failBefore && phase === "before_decision_commit") throw new Error("injected before decision");
    },
  });
  try {
    await assert.rejects(
      () => store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" }),
      /injected before decision/,
    );
    assert.equal(store.getDecision("r1"), null);
    assert.equal(store.quotaStatus().quotaUsed, 0);
    failBefore = false;
    now = T0 + 1;
    const retry = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(retry.decision, "ADMITTED");
  } finally {
    store.close();
  }

  const reopened = await RollingAdmissionStore.open({ dir, config: null, clock });
  try {
    assert.equal(reopened.getDecision("r1").decision, "ADMITTED");
    assert.equal(reopened.quotaStatus().quotaUsed, 1);
    now = T0 + 1000;
    const deferred = await reopened.admit({ requestId: "r2", payloadDigest: digest("b"), scope: "a.test" });
    assert.equal(deferred.decision, "DEFERRED");
    assert.equal(reopened.getDecision("r2"), null);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("configured storage hard stop is enforced without a decision", async () => {
  const dir = tmp();
  const { store } = await openAt(dir, {
    quotaLimit: 10,
    storageMinFreeBytes: Number.MAX_SAFE_INTEGER,
    storageRetryMs: 25,
  });
  try {
    const deferred = await store.admit({ requestId: "r1", payloadDigest: digest("a"), scope: "a.test" });
    assert.equal(deferred.decision, "DEFERRED");
    assert.equal(deferred.reason, "storage");
    assert.equal(store.getDecision("r1"), null);
    assert.equal(store.quotaStatus().storage.ok, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy manager falls back to the legacy epoch when no policy pointer exists", async () => {
  const dir = tmp();
  const legacy = await AdmissionStore.open({
    dir,
    clock: () => new Date(T0),
    config: {
      capLimit: 1,
      capEpoch: "legacy-policy-test",
      ackRequired: false,
      protocolVersion: "baseline-v1",
    },
  });
  legacy.close();
  const manager = await AdmissionPolicyManager.open({
    dir,
    config: {
      capLimit: 1,
      capEpoch: "legacy-policy-test",
      ackRequired: false,
      protocolVersion: "baseline-v1",
    },
    clock: () => new Date(T0),
  });
  try {
    assert.equal(manager.source, "legacy");
    assert.equal(manager.status().mode, "legacy-epoch");
    assert.equal(manager.policy, null);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy manager loads the pointer and gateway uses the rolling store", async () => {
  const admissionDir = tmp();
  const policyId = "rolling-v1";
  const storeDir = path.dirname(policyDatabasePath(admissionDir, policyId));
  const store = await RollingAdmissionStore.open({ dir: storeDir, config: policyConfig({ quotaLimit: 1 }), clock: () => new Date(T0) });
  const pointer = pointerFor(store.sealedConfig, policyId);
  store.close();
  writeActivePolicyPointer(admissionDir, pointer);

  const manager = await AdmissionPolicyManager.open({ dir: admissionDir, config: null, clock: () => new Date(T0) });
  try {
    assert.equal(manager.source, "policy");
    assert.equal(manager.policyId, policyId);
    assert.equal(manager.status().mode, "policy");
    assert.equal(manager.status().policy.quotaLimit, 1);
    const gateway = new AcquisitionGateway({ store: manager.store, epochManager: manager });
    const first = await gateway.authorize({ url: "https://a.test/x", generation: 0 });
    assert.equal(first.decision, "ADMITTED");
    const second = await gateway.authorize({ url: "https://b.test/y", generation: 0 });
    assert.equal(second.decision, "DEFERRED");
    assert.equal(second.reason, "quota");
  } finally {
    manager.close();
    rmSync(admissionDir, { recursive: true, force: true });
  }
});

test("malformed sealed policy fails closed", async () => {
  const dir = tmp();
  const store = await RollingAdmissionStore.open({ dir, config: policyConfig(), clock: () => new Date(T0) });
  store.close();
  const db = new DatabaseSync(path.join(dir, "admission.sqlite"));
  db.prepare("UPDATE sealed_policy SET quota_limit = 999 WHERE id = 1").run();
  db.close();
  await assert.rejects(
    () => RollingAdmissionStore.open({ dir, config: null, clock: () => new Date(T0) }),
    (err) => err.code === "CORRUPT_POLICY",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent processes never overshoot the rolling quota", async () => {
  const dir = tmp();
  const init = await RollingAdmissionStore.open({ dir, config: policyConfig({ quotaLimit: 1 }), clock: () => new Date(T0) });
  init.close();
  const modulePath = fileURLToPath(new URL("../src/gateway/rolling-admission-store.js", import.meta.url));
  const script = `
    import { RollingAdmissionStore } from ${JSON.stringify(modulePath)};
    const store = await RollingAdmissionStore.open({ dir: process.env.D, config: null });
    try {
      const result = await store.admit({ requestId: process.env.R, payloadDigest: process.env.P, scope: "a.test" });
      process.stdout.write(JSON.stringify(result));
    } finally { store.close(); }
  `;
  const run = (index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, D: dir, R: `r${index}`, P: (index % 16).toString(16).repeat(64) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`child ${index} ${code}: ${err}`));
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`bad json: ${out}`)); }
      });
    });
  try {
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map(run));
    assert.equal(results.filter((r) => r.decision === "ADMITTED").length, 1);
    assert.equal(results.filter((r) => r.decision === "DEFERRED").length, 5);
    const reopened = await RollingAdmissionStore.open({ dir, config: null });
    try {
      assert.equal(reopened.quotaStatus().quotaUsed, 1);
      for (let i = 0; i < 6; i++) {
        const decision = reopened.getDecision(`r${i}`);
        if (decision) assert.equal(decision.decision, "ADMITTED");
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
