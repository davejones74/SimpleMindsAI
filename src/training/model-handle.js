import { config } from "../config.js";

/**
 * ModelHandle — a thin, framework-agnostic descriptor for "a model that can be
 * evaluated and promoted". Today it wraps either a registry ModelRecord
 * (baseline/candidate) or the raw base model (pre-first-promotion baseline).
 *
 * The evaluator and lifecycle never call into PyTorch/ONNX: they only carry
 * modelId/kind/checkpointPath and hand the COMPLETION LOOKUP to whatever
 * adapter provides it (ollama in dev, a stub in tests, real inference later).
 */
export function modelHandle(model, { kind = "base", checkpointPath = null } = {}) {
  const m = model ?? {};
  return {
    modelId: m.modelId ?? null,
    kind: m.kind ?? kind,
    baseModel: m.baseModel ?? m.baseModel ?? config.baseModel,
    parentModelId: m.parentModelId ?? null,
    trainingRunId: m.trainingRunId ?? null,
    datasetId: m.datasetId ?? null,
    checkpointPath: m.checkpointPath ?? checkpointPath,
    status: m.status ?? "active",
  };
}

export function describe(model) {
  const h = modelHandle(model);
  return `${h.kind}:${h.modelId ?? h.baseModel}${h.checkpointPath ? `@${h.checkpointPath}` : ""}`;
}

/**
 * The only completion lookup the evaluator needs. Default goes through
 * OllamaClient (fixture = deterministic no-GPU), tests inject a fake.
 */
export function makeCompletor({ ollama = null } = {}) {
  return async (promptText) => {
    const o = ollama ?? (await import("../services/ollama-client.js")).newDefaultOllama();
    const { text } = await o.chat({
      temperature: 0.1,
      messages: [
        { role: "system", content: "Answer concisely. Factual. No chain-of-thought." },
        { role: "user", content: promptText },
      ],
    });
    return { text: String(text ?? "") };
  };
}