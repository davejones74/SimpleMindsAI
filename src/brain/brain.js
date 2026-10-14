import { StudentWorker } from "./student-worker.js";
import { readActiveVersion } from "./python-cli.js";

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
 * `respond()` without a version is served by the CURRENT active model: before
 * each turn it re-reads `active.json` and reloads the resident worker when the
 * pointer moved (a promotion from another process — `npm run train`, the
 * perpetual loop — must not require a server restart to take effect). An
 * unreadable or absent pointer leaves the resident brain untouched.
 *
 * `respond(message, { version })` is served by that EXACT committed version. The
 * worker loads it inside the generate request (verified against its manifest),
 * so the active pointer is never consulted or changed, and overlapping requests
 * cannot observe each other's weights. A missing/corrupt version fails loudly;
 * it is never silently swapped for the active checkpoint.
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
    const out = await this.worker.load(null, { verify: true });
    this.version = out.version;
    this.artifactName = out.artifactName ?? null;
    return out;
  }

  /** Safe switch: re-read the active pointer and swap the resident model. */
  async reload() {
    const out = await this.worker.reload({ verify: true });
    this.version = out.version;
    this.artifactName = out.artifactName ?? null;
    return out;
  }

  /** Swap the resident model when `active.json` names a different version. */
  async resyncActive() {
    if (!this.worker.available) return;
    const wanted = readActiveVersion(this.worker.store);
    if (!wanted || wanted === this.version) return;
    try {
      await this.reload();
    } catch {
      // The worker dropped mid-swap; respond() surfaces the honest
      // "student brain unavailable" error instead of a teacher fallback.
    }
  }

  async respond(message, opts = {}) {
    const t0 = performance.now();
    const { version = null, ...genOpts } = opts;
    // A pinned version is loaded as part of the generate request itself (in the
    // Python worker), so overlapping requests can never share mis-loaded
    // weights and the active pointer is never read or moved. An unpinned turn
    // follows the active pointer, resyncing when a promotion moved it.
    if (!version) await this.resyncActive();
    if (!this.worker.available) {
      throw new Error(
        "student brain unavailable: the Python student worker is not running; " +
        "there is no teacher fallback by design",
      );
    }
    let out;
    try {
      out = await this.worker.generate(String(message), version ? { ...genOpts, version, verify: true } : genOpts);
    } catch (err) {
      throw new Error(`student brain failed to answer: ${err.message}`);
    }
    if (out.version) this.version = out.version;
    if (out.artifactName) this.artifactName = out.artifactName;
    return {
      reply: out.text,
      latencyMs: Math.round(performance.now() - t0),
      mode: this.mode,
      version: out.version ?? this.version,
      artifactName: out.artifactName ?? this.artifactName,
      integrity: out.integrity ?? null,
      generatedTokens: out.generatedTokens,
    };
  }

  async stop() {
    await this.worker.shutdown();
  }
}

export const chatBrain = new Brain();
