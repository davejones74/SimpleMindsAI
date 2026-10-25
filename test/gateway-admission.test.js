import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdmissionStore,
  DEFAULT_CAP_LIMIT,
  OUTCOME,
  COMPLIANCE,
} from "../src/gateway/admission-store.js";
import { AcquisitionGateway } from "../src/gateway/acquisition-gateway.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-admission-"));
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const digest = (ch) => ch.repeat(64);
const fixedClock = () => new Date("2026-10-25T00:00:00.000Z");

async function openStore(dir, opts = {}) {
  const { capLimit = DEFAULT_CAP_LIMIT, capEpoch = "test-epoch", ackRequired = false, protocolVersion = "baseline-v1", ...rest } = opts;
  return AdmissionStore.open({
    dir,
    clock: fixedClock,
    config: { capLimit, capEpoch, ackRequired, protocolVersion },
    ...rest,
  });
}

test("default cap is 420 and first admission consumes exactly one unit", async () => {
  const dir = tmp();
  const store = await openStore(dir);
  try {
    assert.equal(store.capLimit, DEFAULT_CAP_LIMIT);
    assert.equal(store.capLimit, 420);

    const result = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(result.decision, "ADMITTED");
    assert.equal(result.outcome, OUTCOME.ADMITTED);
    assert.equal(result.replayed, false);
    assert.equal(result.compliance, COMPLIANCE.COMPLIANT);
    assert.equal(result.capUsed, 1);
    assert.equal(store.capUsage(), 1);
    assert.equal(store.getDecision("req-1").decision, "ADMITTED");
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("replaying the same request and payload does not consume more capacity", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capLimit: 2 });
  try {
    const first = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    const replay = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });

    assert.equal(first.decision, "ADMITTED");
    assert.equal(replay.decision, "ADMITTED");
    assert.equal(replay.replayed, true);
    assert.equal(replay.capUsed, 1);
    assert.equal(store.capUsage(), 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("a rejected request does not consume capacity and replay preserves the rejection", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capLimit: 1 });
  try {
    await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    const rejected = await store.admit({ requestId: "req-2", payloadDigest: digest("b") });
    const replay = await store.admit({ requestId: "req-2", payloadDigest: digest("b") });

    assert.equal(rejected.decision, "REJECTED");
    assert.equal(rejected.reason, "cap");
    assert.equal(rejected.capUsed, 1);
    assert.equal(replay.decision, "REJECTED");
    assert.equal(replay.replayed, true);
    assert.equal(store.capUsage(), 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("a conflicting payload after a decision preserves the decision and cap usage", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capLimit: 2 });
  try {
    const first = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    const conflict = await store.admit({ requestId: "req-1", payloadDigest: digest("b") });

    assert.equal(first.decision, "ADMITTED");
    assert.equal(conflict.decision, "ADMITTED");
    assert.equal(conflict.compliance, COMPLIANCE.VIOLATED);
    assert.equal(conflict.replayed, false);
    assert.equal(conflict.capUsed, 1);
    assert.equal(store.capUsage(), 1);
    assert.equal(store.getDecision("req-1").payloadDigest, digest("a"));
  } finally {
    store.close();
  }

  const reopened = await openStore(dir, { capLimit: 2 });
  try {
    assert.equal(reopened.getDecision("req-1").payloadDigest, digest("a"));
    assert.equal(reopened.capUsage(), 1);
  } finally {
    reopened.close();
    cleanup(dir);
  }
});

test("a post-decision conflict cannot be hidden by a later replay", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capLimit: 2 });
  try {
    const first = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    const conflict = await store.admit({ requestId: "req-1", payloadDigest: digest("b") });

    assert.equal(first.decision, "ADMITTED");
    assert.equal(conflict.decision, "ADMITTED");
    assert.equal(conflict.compliance, COMPLIANCE.VIOLATED);
    assert.equal(conflict.payloadDigest, digest("a"), "the decision payload digest is immutable");
    assert.equal(conflict.attemptPayloadDigest, digest("b"), "the conflicting attempt stays auditable");

    const replay = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(replay.decision, "ADMITTED");
    assert.equal(replay.replayed, true);
    assert.equal(replay.compliance, COMPLIANCE.VIOLATED, "compliance derives from durable conflict facts");
  } finally {
    store.close();
  }

  const reopened = await openStore(dir, { capLimit: 2 });
  try {
    const replay = await reopened.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(replay.compliance, COMPLIANCE.VIOLATED, "the violation survives restart");
    assert.equal(reopened.getDecision("req-1").payloadDigest, digest("a"));
  } finally {
    reopened.close();
    cleanup(dir);
  }
});

test("the gateway preserves the durable decision digest across a conflicting attempt", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capLimit: 2 });
  try {
    const gateway = new AcquisitionGateway({ store });
    const first = await gateway.authorize({ url: "https://example.test/a", generation: 0 });
    const conflict = await gateway.authorize({
      url: "https://example.test/a",
      generation: 0,
      userAgent: "different-agent",
    });

    assert.equal(conflict.requestId, first.requestId);
    assert.equal(conflict.decision, "ADMITTED");
    assert.equal(conflict.compliance, COMPLIANCE.VIOLATED);
    assert.equal(conflict.payloadDigest, first.payloadDigest);
    assert.notEqual(conflict.attemptPayloadDigest, first.payloadDigest);
    assert.equal(store.capUsage(), 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("a payload conflict before a decision cannot create an admission", async () => {
  const dir = tmp();
  let inject = true;
  const store = await openStore(dir, {
    capLimit: 2,
    faultInjector: ({ phase }) => {
      if (inject && phase === "before_decision_commit") throw new Error("injected decision failure");
    },
  });
  try {
    // The attempt commits; the decision transaction is rolled back.
    await assert.rejects(
      store.admit({ requestId: "req-1", payloadDigest: digest("a") }),
      /injected decision failure/,
    );
    assert.equal(store.capUsage(), 0);
    assert.equal(store.getDecision("req-1"), null);

    inject = false;
    const conflict = await store.admit({ requestId: "req-1", payloadDigest: digest("b") });
    assert.equal(conflict.outcome, OUTCOME.CONTRADICTORY);
    assert.equal(conflict.decision, null);
    assert.equal(conflict.compliance, COMPLIANCE.VIOLATED);
    assert.equal(store.capUsage(), 0);

    const originalPayload = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(originalPayload.outcome, OUTCOME.CONTRADICTORY);
    assert.equal(store.capUsage(), 0);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("concurrent processes competing for the final cap unit produce one winner", async () => {
  const dir = tmp();
  const init = await openStore(dir, { capLimit: 1 });
  init.close();

  const modulePath = fileURLToPath(new URL("../src/gateway/admission-store.js", import.meta.url));
  const script = `
    import { AdmissionStore } from ${JSON.stringify(modulePath)};
    const store = await AdmissionStore.open({ dir: process.env.ADMISSION_DIR, capLimit: 1 });
    try {
      const result = await store.admit({
        requestId: process.env.ADMISSION_REQUEST_ID,
        payloadDigest: process.env.ADMISSION_DIGEST,
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      store.close();
    }
  `;

  const run = (index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: {
          ...process.env,
          ADMISSION_DIR: dir,
          ADMISSION_REQUEST_ID: `req-${index}`,
          ADMISSION_DIGEST: digest(String(index % 10)),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`child ${index} failed (${code}): ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`child ${index} returned invalid JSON: ${stdout}\n${err.message}`));
        }
      });
    });

  try {
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map(run));
    assert.equal(results.filter((r) => r.outcome === OUTCOME.ADMITTED).length, 1);
    assert.equal(results.filter((r) => r.outcome === OUTCOME.REJECTED).length, 5);

    const reopened = await openStore(dir, { capLimit: 1 });
    try {
      assert.equal(reopened.capUsage(), 1);
      assert.equal(
        ["req-0", "req-1", "req-2", "req-3", "req-4", "req-5"]
          .map((id) => reopened.getDecision(id).decision)
          .filter((decision) => decision === "ADMITTED").length,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("simultaneous opens of a fresh store seal once and remain usable", async () => {
  const dir = tmp();
  const capLimit = 48;
  const modulePath = fileURLToPath(new URL("../src/gateway/admission-store.js", import.meta.url));
  const sealed = JSON.stringify({ capLimit, capEpoch: "open-race", ackRequired: false, protocolVersion: "baseline-v1" });
  const script = `
    import { AdmissionStore } from ${JSON.stringify(modulePath)};
    const store = await AdmissionStore.open({ dir: process.env.ADMISSION_DIR, config: ${sealed} });
    try {
      const result = await store.admit({
        requestId: process.env.ADMISSION_REQUEST_ID,
        payloadDigest: process.env.ADMISSION_DIGEST,
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      store.close();
    }
  `;

  const run = (index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: {
          ...process.env,
          ADMISSION_DIR: dir,
          ADMISSION_REQUEST_ID: `req-${index}`,
          ADMISSION_DIGEST: (index % 16).toString(16).repeat(64),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`child ${index} failed (${code}): ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`child ${index} returned invalid JSON: ${stdout}\n${err.message}`));
        }
      });
    });

  try {
    const results = await Promise.all(Array.from({ length: capLimit }, (_, i) => run(i)));
    assert.equal(results.filter((r) => r.outcome === OUTCOME.ADMITTED).length, capLimit);
    assert.equal(new Set(results.map((r) => r.requestId)).size, capLimit);

    const reopened = await openStore(dir, { capLimit, capEpoch: "open-race" });
    try {
      assert.equal(reopened.capUsage(), capLimit);
      assert.equal(reopened.sealedConfig.capEpoch, "open-race");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(dir);
  }
});

test("restart reconstructs decisions and cap usage from durable storage", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capLimit: 1 });
  try {
    await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    await store.admit({ requestId: "req-2", payloadDigest: digest("b") });
    assert.equal(store.capUsage(), 1);
  } finally {
    store.close();
  }

  const reopened = await openStore(dir, { capLimit: 1 });
  try {
    assert.equal(reopened.capUsage(), 1);
    assert.equal(reopened.getDecision("req-1").decision, "ADMITTED");
    assert.equal(reopened.getDecision("req-2").decision, "REJECTED");
    const later = await reopened.admit({ requestId: "req-3", payloadDigest: digest("c") });
    assert.equal(later.decision, "REJECTED");
    assert.equal(reopened.capUsage(), 1);
  } finally {
    reopened.close();
    cleanup(dir);
  }
});

test("an injected failure before decision commit leaves no reported decision", async () => {
  const dir = tmp();
  let inject = true;
  const store = await openStore(dir, {
    capLimit: 1,
    faultInjector: ({ phase }) => {
      if (inject && phase === "before_decision_commit") throw new Error("injected pre-commit failure");
    },
  });
  try {
    await assert.rejects(
      store.admit({ requestId: "req-1", payloadDigest: digest("a") }),
      /injected pre-commit failure/,
    );
    assert.equal(store.capUsage(), 0);
    assert.equal(store.getDecision("req-1"), null);

    inject = false;
    const retry = await store.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(retry.decision, "ADMITTED");
    assert.equal(store.capUsage(), 1);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test("failures at attempt persistence boundaries leave no decision and remain retryable", async () => {
  const beforeDir = tmp();
  let failBefore = true;
  const beforeStore = await openStore(beforeDir, {
    capLimit: 1,
    faultInjector: ({ phase }) => {
      if (failBefore && phase === "before_attempt_commit") throw new Error("injected attempt commit failure");
    },
  });
  try {
    await assert.rejects(
      beforeStore.admit({ requestId: "req-1", payloadDigest: digest("a") }),
      /injected attempt commit failure/,
    );
    assert.equal(beforeStore.getDecision("req-1"), null);
    assert.equal(beforeStore.capUsage(), 0);
    failBefore = false;
    const retry = await beforeStore.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(retry.decision, "ADMITTED");
  } finally {
    beforeStore.close();
    cleanup(beforeDir);
  }

  const afterDir = tmp();
  let failAfter = true;
  const afterStore = await openStore(afterDir, {
    capLimit: 1,
    faultInjector: ({ phase }) => {
      if (failAfter && phase === "after_attempt_commit") throw new Error("injected post-attempt failure");
    },
  });
  try {
    await assert.rejects(
      afterStore.admit({ requestId: "req-1", payloadDigest: digest("a") }),
      /injected post-attempt failure/,
    );
    assert.equal(afterStore.getDecision("req-1"), null);
    assert.equal(afterStore.capUsage(), 0);
    failAfter = false;
    const retry = await afterStore.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(retry.decision, "ADMITTED");
  } finally {
    afterStore.close();
    cleanup(afterDir);
  }
});

test("a failure after decision commit does not report a non-durable decision", async () => {
  const dir = tmp();
  const store = await openStore(dir, {
    capLimit: 1,
    faultInjector: ({ phase }) => {
      if (phase === "after_decision_commit") throw new Error("injected post-commit response failure");
    },
  });
  try {
    await assert.rejects(
      store.admit({ requestId: "req-1", payloadDigest: digest("a") }),
      /injected post-commit response failure/,
    );
    assert.equal(store.capUsage(), 1);
    assert.equal(store.getDecision("req-1").decision, "ADMITTED");
  } finally {
    store.close();
  }

  const reopened = await openStore(dir, { capLimit: 1 });
  try {
    assert.equal(reopened.getDecision("req-1").decision, "ADMITTED");
    assert.equal(reopened.capUsage(), 1);
    const replay = await reopened.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(replay.replayed, true);
  } finally {
    reopened.close();
    cleanup(dir);
  }
});

test("invalid configuration and malformed identity/digest fail safely", async () => {
  const dir = tmp();
  try {
    await assert.rejects(openStore(dir, { capLimit: 0 }), /capLimit/);
    await assert.rejects(openStore(dir, { capLimit: 1.5 }), /capLimit/);
    await assert.rejects(openStore(dir, { capLimit: Number.NaN }), /capLimit/);

    const store = await openStore(dir, { capLimit: 1 });
    try {
      await assert.rejects(store.admit({ requestId: "", payloadDigest: digest("a") }), /requestId/);
      await assert.rejects(store.admit({ requestId: " req ", payloadDigest: digest("a") }), /requestId/);
      await assert.rejects(store.admit({ requestId: "req-1", payloadDigest: "not-a-digest" }), /payloadDigest/);
      assert.equal(store.capUsage(), 0);
    } finally {
      store.close();
    }

    await assert.rejects(openStore(dir, { capLimit: 2 }), /does not match the persisted configuration/);
  } finally {
    cleanup(dir);
  }
});

test("admission is blocked until a durable configuration is sealed", async () => {
  const dir = tmp();
  const unsealed = await AdmissionStore.open({ dir, clock: fixedClock });
  try {
    assert.equal(unsealed.sealedConfig, null);
    await assert.rejects(
      unsealed.admit({ requestId: "req-1", payloadDigest: digest("a") }),
      (err) => err.code === "CONFIG_UNSEALED",
    );
    assert.equal(unsealed.capUsage(), 0);
    assert.equal(unsealed.getDecision("req-1"), null);
  } finally {
    unsealed.close();
  }

  const sealed = await openStore(dir, {
    capLimit: 3,
    capEpoch: "epoch-a",
    ackRequired: true,
    protocolVersion: "baseline-v1",
  });
  try {
    assert.deepEqual(
      {
        capLimit: sealed.sealedConfig.capLimit,
        capEpoch: sealed.sealedConfig.capEpoch,
        ackRequired: sealed.sealedConfig.ackRequired,
        protocolVersion: sealed.sealedConfig.protocolVersion,
      },
      { capLimit: 3, capEpoch: "epoch-a", ackRequired: true, protocolVersion: "baseline-v1" },
    );
    const result = await sealed.admit({ requestId: "req-1", payloadDigest: digest("a") });
    assert.equal(result.decision, "ADMITTED");
  } finally {
    sealed.close();
    cleanup(dir);
  }
});

test("a changed sealed configuration is rejected on reopen", async () => {
  const dir = tmp();
  const store = await openStore(dir, { capEpoch: "epoch-a" });
  store.close();
  await assert.rejects(openStore(dir, { capEpoch: "epoch-b" }), /does not match/);
  cleanup(dir);
});

test("repeating the same workload against the same durable facts is deterministic", async () => {
  const steps = [
    { requestId: "req-1", payloadDigest: digest("a") },
    { requestId: "req-2", payloadDigest: digest("b") },
    { requestId: "req-1", payloadDigest: digest("a") },
    { requestId: "req-1", payloadDigest: digest("c") },
    { requestId: "req-2", payloadDigest: digest("b") },
  ];

  async function run() {
    const dir = tmp();
    const store = await openStore(dir, { capLimit: 1 });
    try {
      const results = [];
      for (const step of steps) results.push(await store.admit(step));
      return {
        results,
        capUsed: store.capUsage(),
        decisions: ["req-1", "req-2"].map((id) => store.getDecision(id)),
      };
    } finally {
      store.close();
      cleanup(dir);
    }
  }

  assert.deepEqual(await run(), await run());
});
