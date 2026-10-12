import { config } from "../config.js";

/**
 * Teacher readiness — the Observatory asks one honest question before any
 * learning or training run: is the CONFIGURED Ollama teacher actually there, and
 * is it the model we think it is?
 *
 * The probe reports the actual configured model and its observed digest; it
 * never substitutes a fallback. A pinned `OLLAMA_MODEL_DIGEST` turns "installed"
 * into "installed and byte-identical", so a silently re-tagged teacher is caught
 * rather than trusted. Under `OLLAMA_FIXTURE=true` the teacher calls are stubbed
 * by contract, so readiness is reported as satisfied in `fixture` mode.
 */
export async function probeTeacher({
  endpoint = config.ollamaEndpoint,
  model = config.ollamaModel,
  expectedDigest = config.ollamaModelDigest,
  fixture = config.ollamaFixture,
  timeoutMs = config.ollamaReadinessTimeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = { endpoint, model, expectedDigest: expectedDigest ?? null, fixture };

  if (fixture) {
    return {
      ...base,
      ready: true,
      available: true,
      mode: "fixture",
      reason: "OLLAMA_FIXTURE=true: teacher calls are deterministic stubs",
      tags: [],
      digest: null,
      matchesExpectedDigest: null,
    };
  }

  let res;
  try {
    res = await fetchImpl(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return {
      ...base,
      ready: false,
      available: false,
      mode: "remote",
      reason: `teacher endpoint unreachable at ${endpoint}: ${err?.message ?? err}`,
      tags: [],
      digest: null,
      matchesExpectedDigest: null,
    };
  }

  if (!res.ok) {
    return {
      ...base,
      ready: false,
      available: false,
      mode: "remote",
      reason: `teacher endpoint ${endpoint} returned HTTP ${res.status}`,
      tags: [],
      digest: null,
      matchesExpectedDigest: null,
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ...base,
      ready: false,
      available: false,
      mode: "remote",
      reason: `teacher endpoint ${endpoint} did not return JSON from /api/tags`,
      tags: [],
      digest: null,
      matchesExpectedDigest: null,
    };
  }

  const models = Array.isArray(body?.models) ? body.models : [];
  const tags = models.map((m) => m.name ?? m.model).filter(Boolean);
  const match = models.find((m) => (m.name ?? m.model) === model) ?? null;
  const digest = match?.digest ?? null;
  const available = Boolean(match);
  const matchesExpectedDigest = expectedDigest ? digest === expectedDigest : null;
  const ready = available && matchesExpectedDigest !== false;

  let reason = null;
  if (!available) {
    reason = `configured teacher '${model}' is not installed on ${endpoint} (available: ${tags.join(", ") || "none"})`;
  } else if (matchesExpectedDigest === false) {
    reason = `teacher '${model}' digest ${digest} does not match pinned ${expectedDigest}`;
  }

  return { ...base, ready, available, mode: "remote", reason, tags, digest, matchesExpectedDigest };
}
