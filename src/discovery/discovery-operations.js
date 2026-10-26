import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/**
 * Durable governance for discovery-adapter network operations.
 *
 * Discovery adapters (robots.txt, sitemap, feed) perform network I/O before any
 * article exists. That I/O is deliberately NOT part of article admission: it has
 * its own ledger, its own rolling window budget, per-domain limits and a
 * sequential/global concurrency limit. Every adapter request must be granted and
 * appended durably BEFORE the network call; when the budget is exhausted the
 * adapter fails closed and no request is made.
 *
 * The ledger is one append-only NDJSON file per rolling window under the
 * discovery data directory. Article admission remains in the separate SQLite
 * admission store and is never touched by this module.
 */

export const DISCOVERY_BUDGET_EXHAUSTED = "DISCOVERY_BUDGET_EXHAUSTED";
export const DISCOVERY_LEDGER_CORRUPT = "DISCOVERY_LEDGER_CORRUPT";

export class DiscoveryBudgetExhausted extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DiscoveryBudgetExhausted";
    this.code = DISCOVERY_BUDGET_EXHAUSTED;
    Object.assign(this, details);
  }
}

export class DiscoveryLedgerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DiscoveryLedgerError";
    this.code = DISCOVERY_LEDGER_CORRUPT;
    Object.assign(this, details);
  }
}

function positiveInt(value, name, { allowZero = false } = {}) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return n;
}

function iso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock returned an invalid date");
  return date.toISOString();
}

function windowStartFor(clock, windowMs) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock returned an invalid date");
  return Math.floor(date.getTime() / windowMs) * windowMs;
}

function domainOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return String(url ?? "unknown");
  }
}

function ledgerFile(dir, windowStart) {
  return path.join(dir, `operations-${windowStart}.ndjson`);
}

function appendRecord(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, "a", 0o640);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    // Durability before the adapter is allowed to touch the network.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readWindowRecords(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") records.push(record);
    } catch (err) {
      // Ignore only a torn final line from a crash. A malformed line in the
      // committed prefix is a corrupt budget ledger and must fail closed.
      const rest = lines.slice(i + 1).some((l) => l.trim());
      if (rest) {
        throw new DiscoveryLedgerError(`discovery operation ledger is corrupt at line ${i + 1}`, {
          file,
          line: i + 1,
        });
      }
      break;
    }
  }
  return records;
}

export class DiscoveryOperationGovernor {
  #dir;
  #windowMs;
  #maxPerWindow;
  #maxPerDomainPerWindow;
  #maxConcurrent;
  #clock;
  #limits;
  #logger;
  #windowStart = null;
  #windowGrants = 0;
  #domainGrants = new Map();
  #inFlight = 0;
  #waiters = [];

  constructor({
    dir,
    windowMs = 24 * 60 * 60 * 1000,
    maxPerWindow = 50_000,
    maxPerDomainPerWindow = 1_000,
    maxConcurrent = 1,
    clock = () => new Date(),
    limits = {},
    logger = null,
  } = {}) {
    if (typeof dir !== "string" || !dir.trim()) throw new TypeError("discovery operation dir is required");
    this.#dir = dir;
    this.#windowMs = positiveInt(windowMs, "windowMs");
    this.#maxPerWindow = positiveInt(maxPerWindow, "maxPerWindow");
    this.#maxPerDomainPerWindow = positiveInt(maxPerDomainPerWindow, "maxPerDomainPerWindow");
    this.#maxConcurrent = positiveInt(maxConcurrent, "maxConcurrent");
    this.#clock = clock;
    this.#limits = Object.freeze({ ...limits });
    this.#logger = logger;
    mkdirSync(this.#dir, { recursive: true });
    this.#prepareWindow();
  }

  get dir() {
    return this.#dir;
  }

  #prepareWindow() {
    const next = windowStartFor(this.#clock, this.#windowMs);
    if (next === this.#windowStart) return;
    this.#windowStart = next;
    this.#windowGrants = 0;
    this.#domainGrants = new Map();
    const file = ledgerFile(this.#dir, next);
    for (const record of readWindowRecords(file)) {
      if (record.type !== "grant" || record.windowStart !== next) continue;
      this.#windowGrants++;
      const domain = String(record.domain ?? "unknown");
      this.#domainGrants.set(domain, (this.#domainGrants.get(domain) ?? 0) + 1);
    }
  }

  #grant({ adapter, url, purpose }) {
    this.#prepareWindow();
    const windowStart = this.#windowStart;
    const domain = domainOf(url);
    const domainUsed = this.#domainGrants.get(domain) ?? 0;
    if (this.#windowGrants >= this.#maxPerWindow) {
      throw new DiscoveryBudgetExhausted(
        `discovery-operation budget exhausted for window ${new Date(windowStart).toISOString()} ` +
          `(${this.#windowGrants}/${this.#maxPerWindow})`,
        { windowStart, used: this.#windowGrants, limit: this.#maxPerWindow, domain, adapter, url },
      );
    }
    if (domainUsed >= this.#maxPerDomainPerWindow) {
      throw new DiscoveryBudgetExhausted(
        `discovery-operation per-domain budget exhausted for ${domain} in the current window ` +
          `(${domainUsed}/${this.#maxPerDomainPerWindow})`,
        {
          windowStart,
          used: this.#windowGrants,
          limit: this.#maxPerWindow,
          domain,
          domainUsed,
          domainLimit: this.#maxPerDomainPerWindow,
          adapter,
          url,
        },
      );
    }

    const record = {
      type: "grant",
      opId: `dop_${randomUUID().slice(0, 12)}`,
      at: iso(this.#clock),
      windowStart,
      adapter,
      purpose,
      domain,
      url: String(url),
      limits: this.#limits,
    };
    appendRecord(ledgerFile(this.#dir, windowStart), record);
    this.#windowGrants++;
    this.#domainGrants.set(domain, domainUsed + 1);
    return record;
  }

  #acquireSlot() {
    if (this.#inFlight < this.#maxConcurrent) {
      this.#inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #releaseSlot() {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#inFlight = Math.max(0, this.#inFlight - 1);
  }

  /**
   * Run one adapter network operation under a durable grant.
   *
   * The grant is written before `fn()`. A budget failure therefore cannot make a
   * network request. Completion/error records are appended for audit; the grant
   * remains the consumed unit even if the request fails.
   */
  async run({ adapter = "discovery", url, purpose = null } = {}, fn) {
    if (typeof fn !== "function") throw new TypeError("discovery operation requires a function");
    await this.#acquireSlot();
    let grant;
    try {
      grant = this.#grant({ adapter, url, purpose: purpose ?? adapter });
    } catch (err) {
      this.#releaseSlot();
      throw err;
    }
    try {
      const result = await fn(grant);
      appendRecord(ledgerFile(this.#dir, grant.windowStart), {
        type: "complete",
        opId: grant.opId,
        at: iso(this.#clock),
        windowStart: grant.windowStart,
        adapter,
        domain: grant.domain,
        url: grant.url,
        status: "ok",
      });
      return result;
    } catch (err) {
      appendRecord(ledgerFile(this.#dir, grant.windowStart), {
        type: "error",
        opId: grant.opId,
        at: iso(this.#clock),
        windowStart: grant.windowStart,
        adapter,
        domain: grant.domain,
        url: grant.url,
        status: "error",
        error: err?.code ?? err?.name ?? "ERROR",
        message: String(err?.message ?? err).slice(0, 500),
      });
      throw err;
    } finally {
      this.#releaseSlot();
    }
  }

  status() {
    this.#prepareWindow();
    return {
      dir: this.#dir,
      windowStart: new Date(this.#windowStart).toISOString(),
      windowMs: this.#windowMs,
      used: this.#windowGrants,
      limit: this.#maxPerWindow,
      remaining: Math.max(0, this.#maxPerWindow - this.#windowGrants),
      maxPerDomainPerWindow: this.#maxPerDomainPerWindow,
      domains: Object.fromEntries([...this.#domainGrants.entries()].sort()),
      maxConcurrent: this.#maxConcurrent,
      inFlight: this.#inFlight,
      exhausted: this.#windowGrants >= this.#maxPerWindow,
    };
  }
}

/** Wrap an adapter `fetchText` so every request needs a durable discovery grant. */
export function createGovernedFetchText({ fetchText, governor }) {
  if (typeof fetchText !== "function") throw new TypeError("fetchText is required");
  if (!governor || typeof governor.run !== "function") throw new TypeError("discovery governor is required");
  return async function governedFetchText(url, opts = {}) {
    const adapter = opts.adapter ?? "discovery";
    const purpose = opts.isRobots ? "robots" : adapter;
    return governor.run({ adapter, url, purpose }, () => fetchText(url, opts));
  };
}

export function createDiscoveryOperationGovernor(opts = {}) {
  return new DiscoveryOperationGovernor(opts);
}
