import { createWriteStream, existsSync, createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";

/**
 * BufferStore — the "temporary buffer database" behind the GraphQL endpoint.
 *
 * Deliberately dependency-free (append-only NDJSON files, no native build needed
 * on Windows). It models exactly the contract you asked for:
 *
 *   - PROMPT / COMPLETION / REWARD data is TRANSIENT. `purgeBuffer()`
 *     (or deleting the files) wipes it and terabytes of it won't hurt anything.
 *   - TRAINING LOGS are DURABLE and separate: `runs.ndjson` (runId, dates,
 *     datasetRefs) and `state.ndjson` (which prompt ids a run consumed).
 *
 * Swap-in plan if you outgrow it: SQLite (better-sqlite3) or a small Postgres/Mongo
 * — the rest of the code only talks to this class, so swap = new implementation,
 * not a rewrite. Cursor pagination is id-based so it is stable across the buffer
 * being appended to mid-stream.
 */

const COLLECTIONS = {
  prompts: "prompts.ndjson", // transient: factual training input
  completions: "completions.ndjson", // transient: target + provenance (origin)
  rewards: "rewards.ndjson", // transient: RLAIF critic scores
  state: "state.ndjson", // durable: promptId -> trainedAt/trainedRef marks
  runs: "runs.ndjson", // durable: training-run log (date + dataset reference)
};

export class BufferStore {
  static async open(dir = process.env.BUFFER_DIR ?? path.resolve("data", "buffer")) {
    const s = new BufferStore(dir);
    await s.#loadFromDisk();
    return s;
  }

  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });

    this.prompts = new Map(); // id -> prompt record
    this.promptOrder = []; // insertion order, drives cursors
    this.byHash = new Map(); // dedup: text hash -> prompt id
    this.completions = new Map(); // id -> completion record
    this.compsByPrompt = new Map(); // promptId -> Set<completionId>
    this.rewards = new Map(); // completionId -> RewardScore[]
    this.runs = []; // durable run log

    this.#streams = {};
    for (const name of Object.keys(COLLECTIONS)) {
      this.#streams[name] = createWriteStream(path.join(this.dir, COLLECTIONS[name]), { flags: "a" });
    }
  }

  #streams; // collection name -> append WriteStream

  static hashText(text) {
    return createHash("sha1")
      .update(String(text).replace(/\s+/g, " ").trim().toLowerCase())
      .digest("hex")
      .slice(0, 16);
  }

  async #loadFromDisk() {
    const lines = async (file) => {
      const p = path.join(this.dir, file);
      const out = [];
      if (!existsSync(p)) return out;
      const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (!raw.trim()) continue;
        try {
          out.push(JSON.parse(raw));
        } catch {
          /* skip corrupt tail lines */
        }
      }
      return out;
    };

    for (const rec of await lines(COLLECTIONS.prompts)) {
      this.prompts.set(rec.id, rec);
      this.promptOrder.push(rec.id);
      this.byHash.set(rec.hash, rec.id);
    }
    for (const rec of await lines(COLLECTIONS.completions)) {
      this.completions.set(rec.id, rec);
      const set = this.compsByPrompt.get(rec.promptId) ?? new Set();
      set.add(rec.id);
      this.compsByPrompt.set(rec.promptId, set);
    }
    for (const rec of await lines(COLLECTIONS.rewards)) {
      const arr = this.rewards.get(rec.completionId) ?? [];
      arr.push(rec);
      this.rewards.set(rec.completionId, arr);
    }
    for (const rec of await lines(COLLECTIONS.state)) {
      const p = this.prompts.get(rec.promptId);
      if (p) {
        p.trainedAt = rec.trainedAt;
        p.trainedRef = rec.runId;
      }
    }
    for (const rec of await lines(COLLECTIONS.runs)) this.runs.push(rec);
  }

  #awaitWrite(ws, chunk) {
    return new Promise((resolve, reject) => {
      const ok = ws.write(chunk);
      if (ok) return resolve();
      ws.once("drain", resolve);
      ws.once("error", reject);
    });
  }

  #persist(name, record) {
    return this.#awaitWrite(this.#streams[name], JSON.stringify(record) + "\n");
  }

  async ingestPrompt({ text, domain = null, source = null, rawText = null }) {
    if (!text || !text.trim()) throw new Error("prompt text is required");
    const hash = BufferStore.hashText(text);
    const dup = this.byHash.get(hash);
    if (dup) {
      const rec = this.prompts.get(dup);
      return { ...rec, deduped: true };
    }
    const id = `p_${randomUUID().slice(0, 12)}`;
    const rec = { id, text, domain, source, rawText, hash, createdAt: new Date().toISOString(), trainedAt: null, trainedRef: null };
    this.prompts.set(id, rec);
    this.promptOrder.push(id);
    this.byHash.set(hash, id);
    await this.#persist("prompts", rec);
    return { ...rec, deduped: false };
  }

  async ingestCompletion({ promptId, text, model = "unknown", origin = "raw" }) {
    if (!this.prompts.has(promptId)) throw new Error(`unknown prompt: ${promptId}`);
    const id = `c_${randomUUID().slice(0, 12)}`;
    const rec = { id, promptId, text, model, origin, createdAt: new Date().toISOString() };
    this.completions.set(id, rec);
    const set = this.compsByPrompt.get(promptId) ?? new Set();
    set.add(id);
    this.compsByPrompt.set(promptId, set);
    await this.#persist("completions", rec);
    return rec;
  }

  async scoreCompletion({ completionId, score, rationale = null, criticModel = "deepseek-r1", criticVersion = null, rubricVersion = null, guardrailResult = null }) {
    const c = this.completions.get(completionId);
    if (!c) throw new Error(`unknown completion: ${completionId}`);
    const s = Number(score);
    if (!Number.isFinite(s) || s < 0 || s > 10) throw new Error("score must be 0..10");
    const rec = { id: `r_${randomUUID().slice(0, 12)}`, completionId, score: s, rationale, criticModel, criticVersion, rubricVersion, guardrailResult, createdAt: new Date().toISOString() };
    const arr = this.rewards.get(completionId) ?? [];
    arr.push(rec);
    this.rewards.set(completionId, arr);
    await this.#persist("rewards", rec);
    return rec;
  }

  /** Best (max) reward across all completions of a prompt; null when unscored. */
  bestScore(promptId) {
    let best = null;
    for (const cid of this.compsByPrompt.get(promptId) ?? []) {
      for (const r of this.rewards.get(cid) ?? []) best = best === null ? r.score : Math.max(best, r.score);
    }
    return best;
  }

  completionRecord(cid) {
    const rec = { ...this.completions.get(cid) };
    if (!rec) return null;
    let best = null;
    for (const r of this.rewards.get(cid) ?? []) best = best === null ? r.score : Math.max(best, r.score);
    return { ...rec, rewardScore: best };
  }

  completionsFor(promptId) {
    return [...(this.compsByPrompt.get(promptId) ?? [])].map((cid) => this.completionRecord(cid));
  }

  /**
   * Cursor-paginated read. `trained` tri-state: undefined = all, true/false = filter.
   * Note: filtering + cursor can skip pages if many rows are filtered — acceptable
   * for a prototype, flagged in README as a place to move to a keyed cursor.
   */
  promptsPage({ after = null, limit = 100, trained }) {
    const startIdx = after ? this.promptOrder.indexOf(after) + 1 : 0;
    const items = [];
    let nextCursor = null;
    for (let i = startIdx; i < this.promptOrder.length && items.length < limit; i++) {
      const rec = { ...this.prompts.get(this.promptOrder[i]) };
      if (trained !== undefined && !!rec.trainedAt !== trained) continue;
      rec.rewardScore = this.bestScore(rec.id);
      rec.completions = this.completionsFor(rec.id);
      items.push(rec);
      nextCursor = rec.id;
    }
    return { items, nextCursor: items.length ? nextCursor : null };
  }

  /** Trainer pulls ONLY untrained rows. Safe to call repeatedly (idempotent). */
  consumeBatch({ limit = 128, after = null }) {
    return this.promptsPage({ after, limit, trained: false });
  }

  /** Marks prompts consumed by a run — append-only durable state. */
  async markTrained(promptIds, runId) {
    for (const pid of promptIds) {
      const rec = this.prompts.get(pid);
      if (!rec || rec.trainedAt) continue;
      rec.trainedAt = new Date().toISOString();
      rec.trainedRef = runId;
      await this.#persist("state", { promptId: pid, runId, trainedAt: rec.trainedAt });
    }
  }

  /** The "log of what has been trained on" — date + dataset reference. */
  async recordTrainingRun({ runId, startedAt, finishedAt = null, datasetRefs = [], recordsTrained = null, avgLoss = null, avgReward = null, note = null }) {
    const rec = { id: `run_${randomUUID().slice(0, 12)}`, runId, startedAt, finishedAt, datasetRefs, recordsTrained, avgLoss, avgReward, note };
    this.runs.push(rec);
    await this.#persist("runs", rec);
    return rec;
  }

  getStats() {
    const byDomain = new Map();
    let trained = 0;
    for (const rec of this.prompts.values()) {
      if (rec.trainedAt) trained++;
      const d = rec.domain ?? "unknown";
      byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
    }
    let rewardSum = 0, rewardCount = 0;
    for (const arr of this.rewards.values()) {
      rewardSum += arr.reduce((a, r) => a + r.score, 0);
      rewardCount += arr.length;
    }
    const total = this.prompts.size;
    return {
      totalPrompts: total,
      trainedPrompts: trained,
      untrainedPrompts: total - trained,
      totalCompletions: this.completions.size,
      byDomain: [...byDomain.entries()].sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count })),
      avgReward: rewardCount ? rewardSum / rewardCount : null,
      rewardCount,
      // 0 = no duplicates, 1 = total duplication. Critical feedback-loop metric.
      duplicationIndex: total ? 1 - this.byHash.size / total : 0,
    };
  }

  /** Wipe the TRANSIENT collections. Training log + trained-marks survive. */
  async #reopen(name) {
    const p = path.join(this.dir, COLLECTIONS[name]);
    if (!this.#streams[name].writableEnded) await this.#end(name);
    writeFileSync(p, "");
    this.#streams[name] = createWriteStream(p, { flags: "a" });
  }

  #end(name) {
    const ws = this.#streams[name];
    return new Promise((resolve) => {
      ws.once("finish", resolve);
      ws.once("error", resolve);
      ws.end();
    });
  }

  async purgeBuffer() {
    for (const name of ["prompts", "completions", "rewards"]) {
      await this.#reopen(name);
    }
    this.prompts.clear();
    this.promptOrder.length = 0;
    this.byHash.clear();
    this.completions.clear();
    this.compsByPrompt.clear();
    this.rewards.clear();
  }

  async close() {
    const wait = (ws) =>
      new Promise((resolve) => {
        ws.once("finish", resolve);
        ws.once("error", resolve);
        ws.end();
      });
    await Promise.all(Object.values(this.#streams).filter((ws) => !ws.writableEnded).map(wait));
  }
}