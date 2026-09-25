import { createWriteStream, createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";

/**
 * RegistryStore — the DURABLE side of the system. Everything here is
 * append-only; nothing is ever rewritten or deleted, which is what makes the
 * answer to "what produced this model?" reconstructable forever.
 *
 *   snapshots.ndjson     dataset snapshot manifests (immutable files on disk)
 *   models.ndjson        model/checkpoint registrations
 *   model-events.ndjson  model status transitions (candidate->promoted/rejected)
 *   runs.ndjson          TrainingRun registrations (one line per run)
 *   run-events.ndjson    run status transitions (created/running/evaluating/...)
 *   evaluations.ndjson   aggregate evaluation results
 *   evaluations/*.ndjson per-example evaluation detail (for regression digging)
 *
 * Status is derived: current run status = last run-events entry; current model
 * status = last model-events entry. Historical lines are never mutated.
 */
const COLLECTIONS = {
  snapshots: "snapshots.ndjson",
  models: "models.ndjson",
  modelEvents: "model-events.ndjson",
  runs: "runs.ndjson",
  runEvents: "run-events.ndjson",
  evaluations: "evaluations.ndjson",
};

export class RegistryStore {
  static async open(dir = process.env.REGISTRY_DIR ?? path.resolve("data", "registry")) {
    const s = new RegistryStore(dir);
    await s.#loadFromDisk();
    return s;
  }

  #streams;

  constructor(dir) {
    this.dir = dir;
    mkdirSync(`${dir}/evaluations`, { recursive: true });
    this.snapshots = [];
    this.models = new Map(); // modelId -> static registration record
    this.modelEvents = new Map();
    this.runs = new Map();
    this.runEvents = new Map();
    this.evaluations = [];

    this.#streams = {};
    for (const name of Object.keys(COLLECTIONS)) {
      this.#streams[name] = createWriteStream(path.join(dir, COLLECTIONS[name]), { flags: "a" });
    }
  }

  async #loadFromDisk() {
    const lines = async (file) => {
      const p = path.join(this.dir, file);
      const out = [];
      if (!existsSync(p)) return out;
      const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (!raw.trim()) continue;
        try { out.push(JSON.parse(raw)); } catch {}
      }
      return out;
    };
    for (const rec of await lines(COLLECTIONS.snapshots)) this.snapshots.push(rec);
    for (const rec of await lines(COLLECTIONS.models)) this.models.set(rec.modelId, rec);
    for (const rec of await lines(COLLECTIONS.modelEvents)) {
      const arr = this.modelEvents.get(rec.modelId) ?? [];
      arr.push(rec);
      this.modelEvents.set(rec.modelId, arr);
    }
    for (const rec of await lines(COLLECTIONS.runs)) this.runs.set(rec.runId, rec);
    for (const rec of await lines(COLLECTIONS.runEvents)) {
      const arr = this.runEvents.get(rec.runId) ?? [];
      arr.push(rec);
      this.runEvents.set(rec.runId, arr);
    }
    for (const rec of await lines(COLLECTIONS.evaluations)) this.evaluations.push(rec);
  }

  #awaitWrite(ws, chunk) {
    return new Promise((resolve, reject) => {
      if (ws.write(chunk)) return resolve();
      ws.once("drain", resolve);
      ws.once("error", reject);
    });
  }

  #persist(name, record) {
    return this.#awaitWrite(this.#streams[name], JSON.stringify(record) + "\n");
  }

  async close() {
    const wait = (ws) =>
      new Promise((resolve) => { ws.once("finish", resolve); ws.once("error", resolve); ws.end(); });
    await Promise.all(Object.values(this.#streams).filter((ws) => !ws.writableEnded).map(wait));
  }

  // ---------------------------------------------------------------- ids
  nextModelId() { return `model-${this.models.size + 1}`; }
  nextRunId() { return `run-${this.runs.size + 1}`; }
  nextEvalId() { return `eval-${this.evaluations.length + 1}`; }
  nextDatasetId() {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const seq = this.snapshots.filter((s) => s.datasetId.includes(stamp)).length + 1;
    return `dataset-${stamp}-${String(seq).padStart(3, "0")}`;
  }
  static hashFile(filePath, content) {
    const data = content ?? undefined;
    if (data !== undefined) return createHash("sha256").update(Buffer.isBuffer(data) ? data : data).digest("hex");
    return createHash("sha256").update(filePath).digest("hex");
  }

  // ------------------------------------------------------- snapshots
  async createSnapshot(manifest) {
    const rec = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...manifest };
    this.snapshots.push(rec);
    await this.#persist("snapshots", rec);
    return rec;
  }
  listSnapshots() { return [...this.snapshots]; }
  getSnapshot(datasetId) { return this.snapshots.find((s) => s.datasetId === datasetId) ?? null; }

  // ---------------------------------------------------------- models
  async registerModel({ kind, baseModel, parentModelId = null, trainingRunId = null, datasetId = null, checkpointPath = null, meta = {} }) {
    const modelId = this.nextModelId();
    const rec = { modelId, kind, baseModel, parentModelId, trainingRunId, datasetId, checkpointPath, meta, createdAt: new Date().toISOString(), status: "candidate" };
    this.models.set(modelId, rec);
    await this.#persist("models", rec);
    return this.getModel(modelId);
  }

  async modelEvent(modelId, { status = "candidate", evaluationScore = null, evalRunId = null, note = null }) {
    if (!this.models.has(modelId)) throw new Error(`unknown model ${modelId}`);
    const rec = { modelId, status, evaluationScore, evalRunId, at: new Date().toISOString(), note };
    const arr = this.modelEvents.get(modelId) ?? [];
    arr.push(rec);
    this.modelEvents.set(modelId, arr);
    await this.#persist("modelEvents", rec);
    return rec;
  }

  getModel(modelId) {
    const base = this.models.get(modelId);
    if (!base) return null;
    const events = this.modelEvents.get(modelId) ?? [];
    const last = events.at(-1);
    let evaluationScore = last?.evaluationScore ?? null;
    let evalRunId = last?.evalRunId ?? null;
    let status = last?.status ?? "candidate";
    // A registered model without any event is a candidate by definition.
    if (!events.length) status = "candidate";
    return { ...base, status, evaluationScore, evalRunId };
  }

  listModels() { return [...this.models.keys()].map((id) => this.getModel(id)); }

  /** The current brain: latest model that reached status "promoted". */
  getActiveModel() {
    const promoted = this.listModels().filter((m) => m.status === "promoted");
    if (!promoted.length) return null;
    return promoted.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)).at(-1);
  }

  // ------------------------------------------------------------ runs
  async createRun(input) {
    const runId = this.nextRunId();
    const rec = { runId, status: "created", startedAt: new Date().toISOString(), completedAt: null, ...input };
    this.runs.set(runId, rec);
    await this.#persist("runs", rec);
    await this.runEvent(runId, { status: "created" });
    return this.getRun(runId);
  }

  async runEvent(runId, { status, note = null }) {
    if (!this.runs.has(runId)) throw new Error(`unknown run ${runId}`);
    const rec = { runId, status, at: new Date().toISOString(), note };
    const arr = this.runEvents.get(runId) ?? [];
    arr.push(rec);
    this.runEvents.set(runId, arr);
    await this.#persist("runEvents", rec);
    return rec;
  }

  async completeRun(runId, { status, ...patch }) {
    // Patch the static registration line's mutable-fields view but ALWAYS
    // record the terminal state as an event — the historical line is untouched.
    const base = this.runs.get(runId);
    if (!base) throw new Error(`unknown run ${runId}`);
    this.runs.set(runId, { ...base, status, completedAt: new Date().toISOString(), ...patch });
    await this.runEvent(runId, { status, note: `run ${status}` });
    return this.getRun(runId);
  }

  getRun(runId) {
    const base = this.runs.get(runId);
    if (!base) return null;
    const events = this.runEvents.get(runId) ?? [];
    const status = events.at(-1)?.status ?? base.status;
    return { ...base, status, events };
  }
  listRuns() { return [...this.runs.keys()].map((id) => this.getRun(id)); }

  /**
   * Crash recovery: any run stuck in created/running/evaluating with no
   * completion within `graceMs` is marked failed (interrupted). This is a status
   * transition, not a rewrite — the historical creation line stays intact.
   */
  async recoverStaleRuns(graceMs = 10 * 60 * 1000) {
    const now = Date.now();
    const staleIds = [];
    for (const run of this.listRuns()) {
      if (run.status === "promoted" || run.status === "rejected" || run.status === "failed") continue;
      const started = new Date(run.startedAt).getTime();
      if (now - started > graceMs) staleIds.push(run.runId);
    }
    for (const id of staleIds) {
      await this.runEvent(id, { status: "failed", note: "interrupted (no completion within grace) — recovered on restart" });
    }
    return staleIds;
  }

  // ------------------------------------------------------ evaluation
  async recordEvaluation(rec) {
    this.evaluations.push(rec);
    await this.#persist("evaluations", rec);
    return rec;
  }
  listEvaluations() { return [...this.evaluations]; }
  getEvaluation(id) { return this.evaluations.find((e) => e.evalRunId === id) ?? null; }

  // ------------------------------------------------------------ lock
  /**
   * Single-trainer lock. `openSync(path, 'wx')` is atomic — a second lifecycle
   * aborts instead of racing the same dataset. Stale locks (age > staleMs) can
   * be force-broken with `breakLock()`.
   */
  lockPath() { return path.join(this.dir, "RUN.lock"); }
  async acquireRunLock(staleMs = 10 * 60 * 1000) {
    try {
      writeFileSync(this.lockPath(), `${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        const raw = this.#readLock();
        const age = Date.now() - Number(raw.trim().split("\n")[0] || "0");
        if (Number.isFinite(age) && age > staleMs) {
          this.breakRunLock();
          return this.acquireRunLock(staleMs);
        }
        return false;
      }
      throw err;
    }
  }
  #readLock() {
    try { return readFileSync(this.lockPath(), "utf8"); } catch { return "0"; }
  }
  breakRunLock() { if (existsSync(this.lockPath())) unlinkSync(this.lockPath()); }
  releaseRunLock() { this.breakRunLock(); }
}