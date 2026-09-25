import { readFile } from "node:fs/promises";
import { OllamaClient } from "../services/ollama-client.js";

const SYSTEM_BIAS = [
  "You are SimpleMindsAI's current brain.",
  "Answer helpfully, factually, and briefly. Do not output chain-of-thought.",
].join(" ");

/**
 * Brain — the ONE integration seam for whatever model you end up training.
 *
 * Right now it has two modes:
 *   "ollama"   → prototype fallback: routes chat through deepseek-r1 so the UI
 *                and the loop are testable before the vanilla model exists.
 *   "vanilla"  → your trained model. `load()` reads a checkpoint JSONL/weights
 *                file; `respond()` is where your tokenizer + sampler + forward
 *                pass plug in. The chat server only ever calls `respond()`.
 *
 * When the vanilla model is live, the reinforcement loop's critic scores its
 * completions — and ONLY high-scoring ones (origin: "synthetic") feed back into
 * the buffer as extra targets, capped by the planner's maxSyntheticShare. That
 * cap lives in run-train/planner, not here.
 */
export class Brain {
  constructor(opts = {}) {
    this.mode = opts.mode ?? process.env.BRAIN_MODE ?? "ollama";
    this.ollama = new OllamaClient(opts.ollama ?? {});
    this.weights = null;
    this.checkpointPath = opts.checkpointPath ?? null;
  }

  async load(checkpointPath = this.checkpointPath) {
    if (!checkpointPath) return false;
    this.weights = JSON.parse(await readFile(checkpointPath, "utf8"));
    this.checkpointPath = checkpointPath;
    return true;
  }

  async respond(message) {
    const t0 = performance.now();
    if (this.mode === "ollama") {
      const { text } = await this.ollama.chat({ messages: [
        { role: "system", content: SYSTEM_BIAS },
        { role: "user", content: message },
      ] });
      return { reply: text, latencyMs: Math.round(performance.now() - t0), mode: this.mode };
    }

    // ---- VANILLA BRAIN PLACEHOLDER -------------------------------------
    // Replace: tokenize(message) -> forward() -> sample(top-k) -> detokenize.
    // `this.weights` is whatever you persisted; keep the contract: return string.
    const hash = String([...message].reduce((a, c) => a + c.charCodeAt(0), 0));
    const reply = `[brain:${this.mode} | ckpt:${this.checkpointPath ?? "none"} | id#${hash}] ` +
      `weights loaded=${!!this.weights}. No vanilla inference wired yet — patch src/brain/brain.js respond().`;
    return { reply, latencyMs: Math.round(performance.now() - t0), mode: this.mode };
  }
}

export const chatBrain = new Brain();