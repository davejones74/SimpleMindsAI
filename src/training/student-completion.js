/**
 * Student-only completion adapter for mission task evaluation.
 *
 * It deliberately does not use Ollama/DeepSeek. The adapter pins one committed
 * student version per call and delegates generation to the long-lived Python
 * student worker, which loads the requested checkpoint and verifies it against
 * its manifest. Generation is deterministic by default (temperature 0, fixed
 * seed) and every answer carries the student version that produced it.
 */
import { StudentWorker } from "../brain/student-worker.js";
import { resolvePythonBin, resolveStoreRoot } from "../brain/python-cli.js";
import { config } from "../config.js";

export function makeStudentCompletor({ worker, version, maxNewTokens = 32, seed = 0 } = {}) {
  if (!worker) throw new Error("makeStudentCompletor requires a StudentWorker");
  if (!version) throw new Error("makeStudentCompletor requires a committed student version");
  return async (prompt) => {
    const out = await worker.generate(String(prompt ?? ""), {
      version,
      verify: true,
      maxNewTokens,
      temperature: 0,
      topP: 1,
      seed,
      repetitionPenalty: 1.0,
      noRepeatNgramSize: 0,
    });
    return {
      text: String(out.text ?? ""),
      version: out.version,
      artifactName: out.artifactName ?? null,
      integrity: out.integrity ?? null,
      promptTokens: out.promptTokens ?? null,
      generatedTokens: out.generatedTokens ?? null,
    };
  };
}

export function makeStudentScorer({ worker, version } = {}) {
  if (!worker) throw new Error("makeStudentScorer requires a StudentWorker");
  if (!version) throw new Error("makeStudentScorer requires a committed student version");
  if (typeof worker.score !== "function") throw new Error("student worker does not support continuation scoring");
  return async (prompt, continuation) => worker.score(String(prompt ?? ""), String(continuation ?? ""), {
    version,
    verify: true,
  });
}

export async function openStudentWorker({ store = resolveStoreRoot(), device = config.studentDevice, bin = resolvePythonBin() } = {}) {
  const worker = new StudentWorker({ store, device, bin });
  await worker.start();
  return worker;
}
