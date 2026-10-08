import { StudentWorker } from "./student-worker.js";

/**
 * Brain — the ONE integration seam for the trained student model.
 *
 * There is no teacher fallback. The brain is the Python student worker and
 * nothing else: if the worker is not loaded, `respond()` rejects with an
 * explicit error instead of quietly routing the question to Ollama/DeepSeek.
 * That fallback is exactly what the README forbids — a chat turn must come from
 * the student brain or not at all.
 *
 * Version safety is delegated to the worker: it loads a version through
 * `store.resolve_version_dir`, which refuses anything without a COMMITTED
 * marker, so a partially written checkpoint can never be served. Promotion
 * swaps the active pointer and the chat server calls `reload()`.
 *
 * The chat server only ever calls `respond()`.
 */
export class Brain {
  constructor(opts = {}) {
    this.mode = "student";
    this.worker = opts.worker ?? new StudentWorker(opts);
    this.version = null;
    this.artifactName = null;
  }

  async start() {
    await this.worker.start();
    await this.loadActive();
    return this;
  }

  /** Load whichever committed version the active pointer names. */
  async loadActive() {
    const out = await this.worker.load();
    this.version = out.version;
    this.artifactName = out.artifactName ?? null;
    return out;
  }

  /** Safe switch: re-read the active pointer and swap the resident model. */
  async reload() {
    const out = await this.worker.reload();
    this.version = out.version;
    this.artifactName = out.artifactName ?? null;
    return out;
  }

  async respond(message, opts = {}) {
    const t0 = performance.now();
    if (!this.worker.available) {
      throw new Error(
        "student brain unavailable: the Python student worker is not running; " +
        "there is no teacher fallback by design",
      );
    }
    let out;
    try {
      out = await this.worker.generate(String(message), opts);
    } catch (err) {
      throw new Error(`student brain failed to answer: ${err.message}`);
    }
    return {
      reply: out.text,
      latencyMs: Math.round(performance.now() - t0),
      mode: this.mode,
      version: out.version ?? this.version,
      artifactName: out.artifactName ?? this.artifactName,
      generatedTokens: out.generatedTokens,
    };
  }

  async stop() {
    await this.worker.shutdown();
  }
}

export const chatBrain = new Brain();
