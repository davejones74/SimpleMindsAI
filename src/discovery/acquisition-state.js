/**
 * Authoritative acquisition-exhaustion classification.
 *
 * The crawler, the supervisor and the UI must agree on ONE definition of "are we
 * out of things to fetch?", so this is the single source of truth. It classifies
 * a discovery pass into an actionable state — never a raw boolean — and carries
 * the machine-readable reason so a job can explain *why* it is waiting or done.
 *
 * The distinction that matters for a perpetual learning job:
 *   - "work"      : there is immediately claimable (or soon-claimable) frontier
 *                   work, or the pass actually enqueued new candidates.
 *   - "viable"    : nothing claimable right now, but a discovery provider is
 *                   configured and did not error — another bounded round may
 *                   still produce candidates.
 *   - "degraded"  : nothing claimable and the providers that DID run errored —
 *                   a transient condition, not permanent exhaustion.
 *   - "exhausted" : nothing claimable, nothing deferred, and no viable provider.
 */

export const ACQUISITION_STATE = Object.freeze({
  WORK: "work",
  SCHEDULED: "scheduled",
  VIABLE: "viable",
  DEGRADED: "degraded",
  EXHAUSTED: "exhausted",
});

/**
 * @param {object} opts
 * @param {object|null} [opts.frontier] - `frontier.summary()`: queued/deferred/deferredDue/rediscoveryDue/nextDueAt
 * @param {object|null} [opts.discovery] - DiscoveryService.collect() `discovery` report
 * @param {number} [opts.ingested] - articles ingested this pass
 * @returns {{state: string, reason: string, claimable: number, retryable: number, viable: boolean, providerErrored: boolean, rediscoveryDue?: number, nextDueAt?: string}}
 */
export function classifyAcquisition({ frontier = null, discovery = null, ingested = 0 } = {}) {
  const f = frontier ?? {};
  const queued = f.queued ?? 0;
  const deferred = f.deferred ?? 0;
  const inProgress = f.inProgress ?? 0;
  // `deferredDue` distinguishes a retry whose backoff has elapsed (claimable NOW)
  // from one still waiting on its independent backoff. When a caller supplies a
  // frontier summary without it (legacy), assume deferred work is claimable.
  const deferredDue = Number.isFinite(f.deferredDue) ? f.deferredDue : deferred;
  const rediscoveryDue = Number.isFinite(f.rediscoveryDue) ? f.rediscoveryDue : 0;
  const nextDueTs = f.nextDueAt ? Date.parse(f.nextDueAt) : NaN;

  const adapters = discovery?.bootstrap?.adapters ?? [];
  const enqueuedNew = adapters.some((a) => (a.enqueued ?? 0) > 0);
  const providerAvailable = Boolean(discovery?.providerAvailable);
  const providerErrored = adapters.some((a) => a.status === "error");
  const anyAdapterRan = adapters.length > 0;

  if (ingested > 0 || queued > 0 || enqueuedNew || rediscoveryDue > 0) {
    return { state: ACQUISITION_STATE.WORK, reason: "claimable frontier work or new candidates", claimable: queued + rediscoveryDue, retryable: deferred, rediscoveryDue, viable: true, providerErrored };
  }
  if (deferredDue > 0 || inProgress > 0) {
    return { state: ACQUISITION_STATE.WORK, reason: "deferred or in-progress work is recoverable", claimable: queued, retryable: deferred, rediscoveryDue, viable: true, providerErrored };
  }
  // Nothing is claimable this instant, but a retry or rediscovery has a future
  // deadline: the frontier WILL have work again. Never report exhaustion — the
  // supervisor waits (bounded, persisted) until that deadline.
  if (Number.isFinite(nextDueTs)) {
    return { state: ACQUISITION_STATE.SCHEDULED, reason: "next retry/rediscovery is scheduled", nextDueAt: f.nextDueAt, claimable: 0, retryable: deferred, rediscoveryDue, viable: true, providerErrored };
  }
  if (providerErrored && !providerAvailable) {
    return { state: ACQUISITION_STATE.DEGRADED, reason: "discovery providers are failing", claimable: queued, retryable: deferred, rediscoveryDue, viable: false, providerErrored: true };
  }
  if (providerAvailable || anyAdapterRan) {
    return { state: ACQUISITION_STATE.VIABLE, reason: "frontier empty but discovery is viable", claimable: queued, retryable: deferred, rediscoveryDue, viable: true, providerErrored };
  }
  return { state: ACQUISITION_STATE.EXHAUSTED, reason: "no claimable work and no viable discovery provider", claimable: queued, retryable: deferred, rediscoveryDue, viable: false, providerErrored };
}

/**
 * Compute the next retry deadline with bounded exponential backoff + jitter.
 * The persisted deadline is authoritative; the caller sleeps until it (the
 * in-memory timer is only an optimisation).
 *
 * @param {number} attempt - 0-based backoff attempt count
 * @param {{baseMs?: number, maxMs?: number, jitter?: number, now?: number}} [opts]
 * @returns {{nextAttemptAt: number, delayMs: number}}
 */
export function backoffDeadline(attempt, { baseMs = 60_000, maxMs = 3_600_000, jitter = 0.15, now = Date.now() } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.floor(attempt)));
  const jittered = exp * (1 + (Math.random() * 2 - 1) * jitter);
  const delayMs = Math.max(0, Math.round(jittered));
  return { nextAttemptAt: now + delayMs, delayMs };
}
