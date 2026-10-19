import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAcquisition, backoffDeadline, ACQUISITION_STATE } from "../src/discovery/acquisition-state.js";

/**
 * Slice 1 — authoritative acquisition classification. The supervisor and UI must
 * agree on ONE definition of "work / wait / exhausted", derived from the frontier
 * summary + the per-adapter discovery report. A dead-end frontier with a healthy
 * provider is never permanent exhaustion.
 */

test("classifies claimable and retryable frontier work as WORK", () => {
  assert.equal(classifyAcquisition({ frontier: { queued: 3 }, discovery: null }).state, ACQUISITION_STATE.WORK);
  assert.equal(classifyAcquisition({ frontier: { deferred: 2 }, discovery: null }).state, ACQUISITION_STATE.WORK);
  assert.equal(classifyAcquisition({ frontier: { inProgress: 1 }, discovery: null }).state, ACQUISITION_STATE.WORK);
  assert.equal(
    classifyAcquisition({ frontier: {}, discovery: { providerAvailable: true, bootstrap: { adapters: [{ enqueued: 1 }] } } }).state,
    ACQUISITION_STATE.WORK,
  );
});

test("classifies a healthy-but-empty provider as VIABLE, not exhausted", () => {
  const discovery = { providerAvailable: true, bootstrap: { adapters: [{ name: "sitemap", status: "idle", enqueued: 0 }] } };
  const s = classifyAcquisition({ frontier: {}, discovery });
  assert.equal(s.state, ACQUISITION_STATE.VIABLE);
  assert.equal(s.viable, true);
});

test("classifies a provider that errored as DEGRADED (transient)", () => {
  const discovery = { providerAvailable: false, bootstrap: { adapters: [{ name: "search", status: "error", enqueued: 0 }] } };
  const s = classifyAcquisition({ frontier: {}, discovery });
  assert.equal(s.state, ACQUISITION_STATE.DEGRADED);
  assert.equal(s.providerErrored, true);
});

test("classifies an empty frontier with no providers as EXHAUSTED", () => {
  const s = classifyAcquisition({ frontier: {}, discovery: null });
  assert.equal(s.state, ACQUISITION_STATE.EXHAUSTED);
});

test("ingested articles count as WORK even with an empty frontier", () => {
  const s = classifyAcquisition({ frontier: {}, discovery: null, ingested: 2 });
  assert.equal(s.state, ACQUISITION_STATE.WORK);
});

test("backoffDeadline grows exponentially, is bounded, and is monotonic", () => {
  const a = backoffDeadline(0, { baseMs: 1000, maxMs: 8000, jitter: 0, now: 0 });
  const b = backoffDeadline(1, { baseMs: 1000, maxMs: 8000, jitter: 0, now: 0 });
  const c = backoffDeadline(2, { baseMs: 1000, maxMs: 8000, jitter: 0, now: 0 });
  assert.ok(b.delayMs > a.delayMs);
  assert.ok(c.delayMs > b.delayMs);
  assert.equal(backoffDeadline(99, { baseMs: 1000, maxMs: 8000, jitter: 0, now: 0 }).delayMs, 8000, "capped at max");
  assert.ok(Number.isFinite(a.nextAttemptAt));
});

test("a future retry/rediscovery deadline is SCHEDULED, not WORK (no tight loop)", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const s1 = classifyAcquisition({ frontier: { deferred: 2, deferredDue: 0, nextDueAt: future }, discovery: null });
  assert.equal(s1.state, ACQUISITION_STATE.SCHEDULED);
  assert.equal(s1.nextDueAt, future);
  const s2 = classifyAcquisition({ frontier: { visited: 5, rediscoveryDue: 0, nextDueAt: future }, discovery: null });
  assert.equal(s2.state, ACQUISITION_STATE.SCHEDULED);
});

test("due retry/rediscovery work is WORK; backed-off work is SCHEDULED", () => {
  assert.equal(classifyAcquisition({ frontier: { deferred: 2, deferredDue: 2 }, discovery: null }).state, ACQUISITION_STATE.WORK);
  assert.equal(classifyAcquisition({ frontier: { visited: 5, rediscoveryDue: 3 }, discovery: null }).state, ACQUISITION_STATE.WORK);
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(
    classifyAcquisition({ frontier: { deferred: 2, deferredDue: 0, nextDueAt: future }, discovery: null }).state,
    ACQUISITION_STATE.SCHEDULED,
  );
});
