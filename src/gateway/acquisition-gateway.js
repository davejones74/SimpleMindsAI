import { createHash } from "node:crypto";

const ACCEPT_DEFAULT = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("generation must be a non-negative safe integer");
  }
  return value;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("url must be a non-empty canonical URL");
  }
  return value;
}

/**
 * The immutable identity of one target acquisition generation.
 *
 * `request_id` is scoped by the sealed cap epoch so a new epoch cannot replay a
 * previous run's decision. `generation` only advances after terminal success,
 * so retries and crash recovery reuse both the ID and payload digest.
 */
export function deriveAcquisitionIdentity({
  config,
  url,
  generation,
  etag = null,
  lastModified = null,
  userAgent = "",
  accept = ACCEPT_DEFAULT,
  respectRobots = true,
  maxRedirects = 5,
}) {
  if (!config || !config.capEpoch || !config.protocolVersion) {
    throw new Error("sealed admission configuration is required");
  }
  const requestId = sha256(
    stableJson([
      "target-acquisition-request",
      config.protocolVersion,
      config.capEpoch,
      normalizeUrl(url),
      normalizeGeneration(generation),
    ]),
  );
  const payloadDigest = sha256(
    stableJson([
      "target-acquisition-payload",
      config.protocolVersion,
      "GET",
      normalizeUrl(url),
      generation,
      etag ?? null,
      lastModified ?? null,
      userAgent,
      accept,
      Boolean(respectRobots),
      maxRedirects,
    ]),
  );
  return { requestId, payloadDigest, generation };
}

/**
 * Bounded integration wrapper around the durable admission store.
 *
 * One authorization covers one target acquisition generation: the target fetch,
 * its robots prerequisite, and its bounded redirect chain. Network I/O remains
 * the caller's responsibility and must only occur after `decision === ADMITTED`
 * and `compliance === COMPLIANT`.
 */
export class AcquisitionGateway {
  #store;

  constructor({ store } = {}) {
    if (!store || typeof store.admit !== "function") {
      throw new TypeError("AdmissionStore instance is required");
    }
    if (!store.sealedConfig) {
      throw new Error("admission store must have a sealed configuration");
    }
    this.#store = store;
  }

  get store() {
    return this.#store;
  }

  async authorize({
    url,
    generation = 0,
    etag = null,
    lastModified = null,
    userAgent = "",
    accept = ACCEPT_DEFAULT,
    respectRobots = true,
    maxRedirects = 5,
  } = {}) {
    const config = this.#store.sealedConfig;
    if (!config) throw new Error("admission store must have a sealed configuration");
    const identity = deriveAcquisitionIdentity({
      config,
      url,
      generation,
      etag,
      lastModified,
      userAgent,
      accept,
      respectRobots,
      maxRedirects,
    });
    const decision = await this.#store.admit(identity);
    return {
      ...decision,
      requestId: identity.requestId,
      // A durable decision's payload digest is immutable. Preserve it even when
      // the current attempt presented a conflicting payload; expose the current
      // attempt digest separately so the violation remains auditable.
      payloadDigest: decision.payloadDigest ?? identity.payloadDigest,
      attemptPayloadDigest: identity.payloadDigest,
      generation: identity.generation,
      capEpoch: config.capEpoch,
      protocolVersion: config.protocolVersion,
    };
  }
}
