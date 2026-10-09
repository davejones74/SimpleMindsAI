import { createWriteStream, existsSync, createReadStream, mkdirSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";

/**
 * GovernanceStore — append-only NDJSON log for mission/strategy versions, review
 * cycles and AI change proposals. Deliberately the same shape as RegistryStore:
 * every state change is an immutable line; the current view is derived by
 * replaying the log, so history is complete and a change is auditable.
 *
 * Nothing here is ever rewritten. Reverting means appending a new version that
 * points back at an earlier text — never deleting a line.
 */
const COLLECTIONS = {
  missions: "missions.ndjson",
  strategies: "strategies.ndjson",
  reviewCycles: "review-cycles.ndjson",
  proposals: "proposals.ndjson",
  events: "governance-events.ndjson",
};

export class GovernanceStore {
  static async open(dir = path.resolve("data", "registry")) {
    const s = new GovernanceStore(dir);
    await s.#load();
    return s;
  }

  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.data = Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, []]));
    this.#streams = {};
    for (const [key, file] of Object.entries(COLLECTIONS)) {
      this.#streams[key] = createWriteStream(path.join(this.dir, file), { flags: "a" });
    }
  }

  #streams;

  async #load() {
    for (const [key, file] of Object.entries(COLLECTIONS)) {
      const p = path.join(this.dir, file);
      if (!existsSync(p)) continue;
      const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (!raw.trim()) continue;
        try {
          this.data[key].push(JSON.parse(raw));
        } catch {
          /* skip corrupt tail */
        }
      }
    }
  }

  async append(collection, record) {
    if (!this.data[collection]) throw new Error(`unknown governance collection: ${collection}`);
    const full = { at: new Date().toISOString(), ...record };
    this.data[collection].push(full);
    await new Promise((resolve, reject) => {
      const ws = this.#streams[collection];
      const ok = ws.write(JSON.stringify(full) + "\n");
      if (ok) return resolve();
      ws.once("drain", resolve);
      ws.once("error", reject);
    });
    return full;
  }

  list(collection) {
    return [...(this.data[collection] ?? [])];
  }

  async logEvent(type, data = {}) {
    return this.append("events", { type, ...data });
  }

  async close() {
    await Promise.all(
      Object.values(this.#streams)
        .filter((ws) => !ws.writableEnded)
        .map(
          (ws) =>
            new Promise((resolve) => {
              ws.once("finish", resolve);
              ws.once("error", resolve);
              ws.end();
            }),
        ),
    );
  }
}
