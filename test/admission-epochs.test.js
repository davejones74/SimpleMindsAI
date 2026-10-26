import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AdmissionStore } from "../src/gateway/admission-store.js";
import { AcquisitionGateway } from "../src/gateway/acquisition-gateway.js";
import {
  ACTIVE_EPOCH_FILE,
  AdmissionEpochManager,
  EPOCH_LEDGER_FILE,
  epochDatabasePath,
  readActiveEpochPointer,
  readEpochLedger,
  rolloverAdmissionEpoch,
} from "../src/gateway/admission-epochs.js";

const fixedClock = () => new Date("2026-10-26T00:00:00.000Z");
const digest = (ch) => ch.repeat(64);

async function legacyStore(dir, { capLimit = 2, capEpoch = "gateway-test-01" } = {}) {
  return AdmissionStore.open({
    dir,
    clock: fixedClock,
    config: { capLimit, capEpoch, ackRequired: false, protocolVersion: "baseline-v1" },
  });
}

test("rollover preserves the legacy epoch and seals an isolated 500-request epoch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-epochs-"));
  const admissionDir = path.join(root, "gateway");
  try {
    const legacy = await legacyStore(admissionDir, { capLimit: 2, capEpoch: "gateway-test-01" });
    await legacy.admit({ requestId: "old-1", payloadDigest: digest("a") });
    await legacy.admit({ requestId: "old-2", payloadDigest: digest("b") });
    await legacy.admit({ requestId: "old-3", payloadDigest: digest("c") });
    legacy.close();
    const legacyDb = path.join(admissionDir, "admission.sqlite");
    const beforeHash = createHash("sha256").update(readFileSync(legacyDb)).digest("hex");

    const result = await rolloverAdmissionEpoch({
      dir: admissionDir,
      newEpoch: "gateway-test-02",
      capLimit: 500,
      clock: fixedClock,
      logger: { log() {} },
    });
    assert.equal(result.activated, true);
    assert.equal(result.previous.epoch, "gateway-test-01");
    assert.equal(result.previous.source, "legacy");
    assert.equal(result.capLimit, 500);

    const pointer = readActiveEpochPointer(admissionDir);
    assert.equal(pointer.epoch, "gateway-test-02");
    assert.equal(pointer.capLimit, 500);
    assert.equal(pointer.previousEpoch, "gateway-test-01");
    assert.equal(existsSync(path.join(admissionDir, ACTIVE_EPOCH_FILE)), true);
    assert.equal(existsSync(path.join(admissionDir, EPOCH_LEDGER_FILE)), true);

    const ledger = readEpochLedger(admissionDir);
    assert.equal(ledger.filter((r) => r.type === "epoch" && r.epoch === "gateway-test-02").length, 1);
    assert.equal(ledger.filter((r) => r.type === "active" && r.epoch === "gateway-test-02").length, 1);

    const legacyAgain = await AdmissionStore.open({
      dir: admissionDir,
      clock: fixedClock,
      config: { capLimit: 2, capEpoch: "gateway-test-01", ackRequired: false, protocolVersion: "baseline-v1" },
    });
    try {
      assert.equal(legacyAgain.capUsage(), 2);
      assert.equal(legacyAgain.getDecision("old-3").decision, "REJECTED");
      assert.equal(legacyAgain.getDecision("old-3").reason, "cap");
    } finally {
      legacyAgain.close();
    }
    assert.equal(
      createHash("sha256").update(readFileSync(legacyDb)).digest("hex"),
      beforeHash,
      "the legacy database must remain byte-for-byte unchanged",
    );

    const fresh = await AdmissionStore.open({ dir: path.dirname(epochDatabasePath(admissionDir, "gateway-test-02")), clock: fixedClock });
    try {
      assert.equal(fresh.sealedConfig.capEpoch, "gateway-test-02");
      assert.equal(fresh.sealedConfig.capLimit, 500);
      assert.equal(fresh.capUsage(), 0);
      assert.equal(fresh.getDecision("old-1"), null, "old decisions are isolated from the new epoch");
    } finally {
      fresh.close();
    }

    const second = await rolloverAdmissionEpoch({
      dir: admissionDir,
      newEpoch: "gateway-test-02",
      capLimit: 500,
      clock: fixedClock,
      logger: { log() {} },
    });
    assert.equal(second.alreadyActive, true);
    assert.equal(
      readEpochLedger(admissionDir).filter((r) => r.type === "epoch" && r.epoch === "gateway-test-02").length,
      1,
      "idempotent rollover does not duplicate epoch history",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the new epoch enforces its own 500-request cap", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-epoch-cap-"));
  const admissionDir = path.join(root, "gateway");
  try {
    const legacy = await legacyStore(admissionDir, { capLimit: 1, capEpoch: "gateway-test-01" });
    await legacy.admit({ requestId: "old-1", payloadDigest: digest("a") });
    legacy.close();
    await rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-02", capLimit: 500, clock: fixedClock });

    const store = await AdmissionStore.open({ dir: path.dirname(epochDatabasePath(admissionDir, "gateway-test-02")), clock: fixedClock });
    try {
      for (let i = 0; i < 500; i += 1) {
        const result = await store.admit({ requestId: `new-${i}`, payloadDigest: digest((i % 16).toString(16)) });
        assert.equal(result.decision, "ADMITTED", `request ${i}`);
      }
      assert.equal(store.capUsage(), 500);
      const over = await store.admit({ requestId: "new-over", payloadDigest: digest("f") });
      assert.equal(over.decision, "REJECTED");
      assert.equal(over.reason, "cap");
      assert.equal(store.capUsage(), 500);
    } finally {
      store.close();
    }

    const legacyAgain = await AdmissionStore.open({
      dir: admissionDir,
      clock: fixedClock,
      config: { capLimit: 1, capEpoch: "gateway-test-01", ackRequired: false, protocolVersion: "baseline-v1" },
    });
    try {
      assert.equal(legacyAgain.capUsage(), 1, "the old epoch's cap usage is untouched");
    } finally {
      legacyAgain.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollover refuses to reactivate an epoch that has already admitted work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-epoch-reuse-"));
  const admissionDir = path.join(root, "gateway");
  try {
    const legacy = await legacyStore(admissionDir, { capLimit: 1, capEpoch: "gateway-test-01" });
    await legacy.admit({ requestId: "old-1", payloadDigest: digest("a") });
    legacy.close();
    await rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-02", capLimit: 5, clock: fixedClock });
    const second = await AdmissionStore.open({ dir: path.dirname(epochDatabasePath(admissionDir, "gateway-test-02")), clock: fixedClock });
    await second.admit({ requestId: "new-1", payloadDigest: digest("b") });
    second.close();
    await rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-03", capLimit: 5, clock: fixedClock });

    await assert.rejects(
      rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-02", capLimit: 5, clock: fixedClock }),
      (err) => err.code === "EPOCH_ALREADY_USED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash between sealing and pointer write is recoverable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-epoch-crash-"));
  const admissionDir = path.join(root, "gateway");
  try {
    const legacy = await legacyStore(admissionDir, { capLimit: 1, capEpoch: "gateway-test-01" });
    await legacy.admit({ requestId: "old-1", payloadDigest: digest("a") });
    legacy.close();

    // Simulate a process that sealed the target but died before writing history
    // or the active pointer.
    const targetDir = path.dirname(epochDatabasePath(admissionDir, "gateway-test-02"));
    const pending = await AdmissionStore.open({
      dir: targetDir,
      clock: fixedClock,
      config: { capLimit: 500, capEpoch: "gateway-test-02", ackRequired: false, protocolVersion: "baseline-v1" },
    });
    pending.close();
    assert.equal(existsSync(path.join(admissionDir, ACTIVE_EPOCH_FILE)), false);

    const result = await rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-02", capLimit: 500, clock: fixedClock });
    assert.equal(result.activated, true);
    assert.equal(readActiveEpochPointer(admissionDir).epoch, "gateway-test-02");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the running manager adopts a newly activated epoch without a restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-epoch-manager-"));
  const admissionDir = path.join(root, "gateway");
  try {
    const legacy = await legacyStore(admissionDir, { capLimit: 1, capEpoch: "gateway-test-01" });
    await legacy.admit({ requestId: "old-1", payloadDigest: digest("a") });
    legacy.close();

    const manager = await AdmissionEpochManager.open({ dir: admissionDir, config: null, clock: fixedClock, logger: { log() {}, warn() {} } });
    try {
      assert.equal(manager.epoch, "gateway-test-01");
      assert.equal(manager.capLimit, 1);
      await rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-02", capLimit: 500, clock: fixedClock });
      const changed = await manager.maybeRefresh({ force: true });
      assert.equal(changed, true);
      assert.equal(manager.epoch, "gateway-test-02");
      assert.equal(manager.capLimit, 500);
      assert.equal(manager.capUsage(), 0);
      assert.equal(await manager.maybeRefresh({ force: true }), false, "a stable pointer is a no-op");
    } finally {
      manager.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the gateway retries a cap rejection once after adopting a new epoch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-epoch-gateway-"));
  const admissionDir = path.join(root, "gateway");
  try {
    const legacy = await legacyStore(admissionDir, { capLimit: 1, capEpoch: "gateway-test-01" });
    legacy.close();
    const manager = await AdmissionEpochManager.open({ dir: admissionDir, config: null, clock: fixedClock, logger: { log() {}, warn() {} } });
    try {
      const realRefresh = manager.maybeRefresh.bind(manager);
      let firstCheck = true;
      manager.maybeRefresh = async (opts = {}) => {
        // Simulate the pointer changing between the pre-check and the cap
        // rejection: the unforced check misses it, the forced check adopts it.
        if (!opts.force && firstCheck) {
          firstCheck = false;
          return false;
        }
        return realRefresh(opts);
      };
      const gateway = new AcquisitionGateway({ store: manager.store, epochManager: manager });
      const first = await gateway.authorize({ url: "https://example.test/one", generation: 0 });
      assert.equal(first.decision, "ADMITTED");
      assert.equal(first.capEpoch, "gateway-test-01");

      await rolloverAdmissionEpoch({ dir: admissionDir, newEpoch: "gateway-test-02", capLimit: 500, clock: fixedClock });
      const second = await gateway.authorize({ url: "https://example.test/two", generation: 0 });
      assert.equal(second.decision, "ADMITTED", "the same request is retried in the new epoch");
      assert.equal(second.capEpoch, "gateway-test-02");
      assert.equal(manager.epoch, "gateway-test-02");
      assert.equal(manager.capUsage(), 1);
    } finally {
      manager.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
