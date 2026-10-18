import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";

const CONSUME = `
  query Consume($input: ConsumeInput!) {
    consumeBatch(input: $input) {
      items { id text domain rewardScore createdAt completions { id text model origin rewardScore } }
      nextCursor
    }
  }
`;
const COMMIT = `
  mutation Commit($input: CommitInput!) { commitConsumption(input: $input) }
`;
const RUN = `
  mutation RecordRun($input: RunInput!) { recordTrainingRun(input: $input) { runId } }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(query, variables, retries = 4) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const body = await res.json();
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
      return body.data;
    } catch (err) {
      lastErr = err;
      await sleep(300 * (attempt + 1)); // linear backoff; a GraphQL hiccup != dead pipe
    }
  }
  throw lastErr;
}

/**
 * graphqlStream — ONE page in flight at a time, pulled by cursor.
 *
 * This is the answer to "don't lock up the event loop": the trainer never holds
 * the whole dataset. Each page is bounded by `batchSize`; between pages there is
 * an `await` that yields to the loop for harvester/planner work. Memory is O(batch)
 * no matter how many gigabytes sit in the buffer.
 *
 * Page shape also carries the completion → training-pair expansion later.
 */
export async function* graphqlStream({ batchSize = 128, after = null } = {}) {
  let cursor = after;
  for (;;) {
    const data = await gql(CONSUME, { input: { limit: batchSize, after: cursor } });
    const { items, nextCursor } = data.consumeBatch;
    if (!items.length) return;
    yield { items, nextCursor };
    if (nextCursor == null) return;
    cursor = nextCursor;
  }
}

/** After a page is safely persisted, mark it consumed → exactly-once resume. */
export async function commitPage(runId, promptIds) {
  if (!promptIds.length) return;
  await gql(COMMIT, { input: { ids: promptIds, runId } });
}

export async function recordRun(input) {
  await gql(RUN, { input });
}

/**
 * streamToFile — pipe the buffer → NDJSON run file using stream backpressure.
 * The payload is handed to the ML runtime as a file (re-read/restart safe);
 * worker threads (below) handle any CPU-ish preprocessing.
 */
export async function streamToFile({ runId, batchSize = 128, outDir = "data/train-runs" }) {
  await mkdir(outDir, { recursive: true });
  let records = 0;
  const line = JSON.stringify;
  const toNdjson = new Transform({
    objectMode: true,
    transform(page, _enc, cb) {
      const ids = [];
      for (const p of page.items) {
        ids.push(p.id);
        const comps = p.completions?.length ? p.completions : [{ id: null, text: "", model: null, origin: null }];
        for (const c of comps) {
          this.push(line({ promptId: p.id, prompt: p.text, completion: c.text, reward: p.rewardScore, domain: p.domain, runId, origin: c.origin }, ) + "\n");
          records++;
        }
      }
      page.commitIds = ids;
      cb();
    },
  });

  const file = path.join(outDir, `${runId}.jsonl`);
  await pipeline(graphqlStream({ batchSize }), toNdjson, createWriteStream(file));
  return { file, records };
}

/**
 * WorkerPool — round-robin batches to `trainer-worker.js` threads.
 *
 * Two good reasons to offload here even in a prototype:
 *  1. Future tokenization / JSONL row building is CPU work — never on the main loop.
 *  2. It forces the trainer into an explicit message protocol, which is exactly
 *     the seam you later point at ONNX Runtime or a PyTorch socket.
 */
export class WorkerPool {
  constructor({ size = Math.max(1, availableParallelism() - 1), workerPath = new URL("./trainer-worker.js", import.meta.url) } = {}) {
    this.size = size;
    this.workerPath = workerPath;
    this.workers = [];
    this.pending = new Map(); // seq -> { resolve, reject }
    this.seq = 0;
  }

  start() {
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(this.workerPath);
      w.on("message", (msg) => {
        if (!msg?.type || msg.type !== "result") return;
        const p = this.pending.get(msg.seq);
        if (p) {
          this.pending.delete(msg.seq);
          p.resolve(msg.result);
        }
      });
      w.on("error", (err) => {
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      });
      this.workers.push(w);
    }
  }

  submit(batch, runId) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      const w = this.workers[(seq - 1) % this.workers.length];
      w.postMessage({ type: "batch", seq, runId, batch });
    });
  }

  async stop() {
    for (const w of this.workers) await w.terminate();
    this.workers = [];
  }
}