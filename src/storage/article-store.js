import { createWriteStream, existsSync, createReadStream, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import {
  AUTHORITY,
  STATUS,
  contentHash,
  isImportance,
  isStatus,
  isTrainable,
  normalizeImportance,
} from "../domain/article.js";
import { DEFAULT_POLICY, evaluateVerdict, selectionDecision } from "../domain/review-policy.js";

/**
 * ArticleStore — the authoritative article ledger (append-only NDJSON).
 *
 * Replaces the old Prompt/Completion/RewardScore BufferStore. One collection is
 * the article records themselves; review verdicts are separate records; the
 * consumption ledger is DURABLE (articles are never lost after training) while
 * articles/reviews/events are transient and purgeable, exactly as the README's
 * Architecture diagram specifies.
 *
 *   articles.ndjson     transient: article records (content, identity, tags,
 *                       category, importance, status, provenance)
 *   reviews.ndjson      transient: ReviewVerdict records (teacher + human)
 *   article-events.ndjson  transient: audit of status/importance transitions
 *   consumption.ndjson  durable: one line per training appearance
 *
 * Status/importance/decidedBy are reconstructed on load by replaying events
 * over the creation records, mirroring RegistryStore's "derive from the log"
 * rule, so a partially flushed file never corrupts the current view.
 */

const COLLECTIONS = {
  articles: "articles.ndjson",
  reviews: "reviews.ndjson",
  events: "article-events.ndjson",
  consumption: "consumption.ndjson",
};

/** Old pair-based files. Detected read-only, never loaded as a source of truth. */
const LEGACY_FILES = ["prompts.ndjson", "completions.ndjson", "rewards.ndjson", "state.ndjson", "runs.ndjson"];

export class ArticleStore {
  static async open(dir = process.env.ARTICLE_DIR ?? process.env.BUFFER_DIR ?? path.resolve("data", "articles")) {
    const s = new ArticleStore(dir);
    await s.#loadFromDisk();
    return s;
  }

  static contentHash(text) {
    return contentHash(text);
  }

  constructor(dir, { policy = DEFAULT_POLICY } = {}) {
    this.dir = dir;
    this.policy = policy;
    mkdirSync(dir, { recursive: true });

    this.articles = new Map();
    this.articleOrder = [];
    this.byHash = new Map();
    this.reviews = new Map(); // articleId -> [review]
    this.events = []; // audit trail
    this.consumption = []; // durable appearances

    this.#streams = {};
    for (const name of Object.keys(COLLECTIONS)) {
      this.#streams[name] = createWriteStream(path.join(this.dir, COLLECTIONS[name]), { flags: "a" });
    }
  }

  #streams;

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
          /* skip corrupt tail */
        }
      }
      return out;
    };

    for (const rec of await lines(COLLECTIONS.articles)) {
      this.articles.set(rec.articleId, rec);
      this.articleOrder.push(rec.articleId);
      this.byHash.set(rec.contentHash, rec.articleId);
    }
    for (const rec of await lines(COLLECTIONS.reviews)) {
      const arr = this.reviews.get(rec.articleId) ?? [];
      arr.push(rec);
      this.reviews.set(rec.articleId, arr);
    }
    for (const rec of await lines(COLLECTIONS.events)) {
      this.events.push(rec);
      this.#applyEvent(rec);
    }
    for (const rec of await lines(COLLECTIONS.consumption)) {
      this.consumption.push(rec);
      const a = this.articles.get(rec.articleId);
      if (a) {
        if (!a.consumedAt) a.consumedAt = rec.at;
        a.consumedRef = rec.runId;
      }
    }
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

  #applyEvent(rec) {
    const a = this.articles.get(rec.articleId);
    if (!a) return;
    if (rec.type === "status") {
      a.status = rec.to;
      if (rec.actor) a.decidedBy = rec.actor === AUTHORITY.AUTOMATION ? a.decidedBy : rec.actor;
    } else if (rec.type === "importance") {
      a.importance = rec.to;
      a.importanceSource = rec.actor === AUTHORITY.TEACHER ? a.importanceSource : "operator";
    } else if (rec.type === "suggested-importance") {
      a.suggestedImportance = rec.to;
    } else if (rec.type === "review-requested") {
      a.reviewRequested = true;
      a.status = STATUS.PENDING_REVIEW;
    }
  }

  async #event(rec) {
    const full = { at: new Date().toISOString(), ...rec };
    this.events.push(full);
    this.#applyEvent(full);
    await this.#persist("events", full);
    return full;
  }

  // ------------------------------------------------------------- ingest
  async ingestArticle({
    text,
    domain = null,
    tags = [],
    category = null,
    importance = null,
    origin = "curated",
    source = null,
    model = null,
    rawText = null,
    uncertainty = null,
    missionRelevance = null,
    reviewRequested = false,
  } = {}) {
    if (!text || !String(text).trim()) throw new Error("article text is required");
    const hash = contentHash(text);
    const dup = this.byHash.get(hash);
    if (dup) return { ...this.articles.get(dup), deduped: true };

    const articleId = `art_${randomUUID().slice(0, 12)}`;
    const imp = normalizeImportance(importance);
    const now = new Date().toISOString();
    const draft = {
      articleId,
      importance: imp,
      uncertainty,
      missionRelevance,
      reviewRequested,
    };
    const { selected, reasons } = selectionDecision(draft, this.policy);

    const rec = {
      articleId,
      contentHash: hash,
      text,
      domain: domain ?? category ?? "general",
      category: category ?? domain ?? "general",
      tags: Array.isArray(tags) ? tags : [],
      importance: imp,
      importanceSource: importance ? "operator" : "default",
      suggestedImportance: null,
      status: selected ? STATUS.PENDING_REVIEW : STATUS.INGESTED,
      origin,
      source,
      model,
      rawText,
      uncertainty,
      missionRelevance,
      reviewRequested,
      selectionReasons: reasons,
      decidedBy: null,
      reviewCycleId: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: null,
      consumedRef: null,
    };
    this.articles.set(articleId, rec);
    this.articleOrder.push(articleId);
    this.byHash.set(hash, articleId);
    await this.#persist("articles", rec);
    await this.#event({ type: "status", articleId, to: rec.status, actor: AUTHORITY.AUTOMATION, reason: reasons.join(",") || "ingested" });
    return { ...rec, deduped: false };
  }

  // --------------------------------------------------------------- reads
  getArticle(articleId) {
    return this.articles.get(articleId) ?? null;
  }

  getArticleByHash(hash) {
    const id = this.byHash.get(hash);
    return id ? this.articles.get(id) : null;
  }

  reviewsFor(articleId) {
    return [...(this.reviews.get(articleId) ?? [])];
  }

  /**
   * Paginated read with optional filters. Cursor is an articleId; filtering may
   * skip pages, which is acceptable for a prototype and flagged in the README.
   */
  articlesPage({ after = null, limit = 100, status, importance, consumed, domain } = {}) {
    const startIdx = after ? this.articleOrder.indexOf(after) + 1 : 0;
    const items = [];
    let nextCursor = null;
    for (let i = startIdx; i < this.articleOrder.length && items.length < limit; i++) {
      const rec = { ...this.articles.get(this.articleOrder[i]) };
      if (status && rec.status !== status) continue;
      if (importance && rec.importance !== importance) continue;
      if (consumed !== undefined && Boolean(rec.consumedAt) !== consumed) continue;
      if (domain && rec.domain !== domain) continue;
      rec.reviewCount = (this.reviews.get(rec.articleId) ?? []).length;
      rec.trainable = isTrainable(rec);
      items.push(rec);
      nextCursor = rec.articleId;
    }
    return { items, nextCursor: items.length ? nextCursor : null };
  }

  trainablePage({ after = null, limit = 100 } = {}) {
    return this.articlesPage({ after, limit, status: STATUS.REVIEWED, consumed: false });
  }

  reviewQueue({ after = null, limit = 100 } = {}) {
    return this.articlesPage({ after, limit, status: STATUS.PENDING_REVIEW });
  }

  consumptionFor(articleId) {
    return this.consumption.filter((c) => c.articleId === articleId);
  }

  isConsumed(articleId) {
    return Boolean(this.articles.get(articleId)?.consumedAt);
  }

  // ------------------------------------------------------------- review
  async recordReview({
    articleId,
    verdict,
    score = null,
    rationale = null,
    authority = AUTHORITY.TEACHER,
    reviewerModel = null,
    reviewerVersion = null,
    rubricVersion = null,
    guardrailResult = null,
    suggestedImportance = null,
    reviewCycleId = null,
  } = {}) {
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    const decision = evaluateVerdict(article, { verdict, score, authority }, this.policy);

    const review = {
      reviewId: `rv_${randomUUID().slice(0, 12)}`,
      articleId,
      verdict,
      score: Number.isFinite(Number(score)) ? Number(score) : null,
      rationale,
      authority,
      reviewerModel,
      reviewerVersion,
      rubricVersion,
      guardrailResult,
      suggestedImportance: suggestedImportance ?? null,
      reviewCycleId,
      applied: decision.apply,
      resultingStatus: decision.status,
      reason: decision.reason,
      at: new Date().toISOString(),
    };
    const arr = this.reviews.get(articleId) ?? [];
    arr.push(review);
    this.reviews.set(articleId, arr);
    await this.#persist("reviews", review);

    // A suggested importance is advisory for teachers, authoritative for humans.
    if (isImportance(suggestedImportance) && authority !== AUTHORITY.HUMAN) {
      await this.#event({ type: "suggested-importance", articleId, to: suggestedImportance, actor: AUTHORITY.TEACHER });
    }

    if (decision.apply) {
      await this.#event({
        type: "status",
        articleId,
        from: article.status,
        to: decision.status,
        actor: decision.decidedBy ?? authority,
        reason: decision.reason,
      });
    }
    article.reviewCycleId = reviewCycleId ?? article.reviewCycleId;
    article.updatedAt = review.at;
    return { review, article: { ...article }, applied: decision.apply };
  }

  /** Deterministic autonomous pass: queue INGESTED articles that policy selects. */
  async selectForReview({ limit = 500 } = {}) {
    const selected = [];
    for (const id of this.articleOrder) {
      if (selected.length >= limit) break;
      const a = this.articles.get(id);
      if (a.status !== STATUS.INGESTED) continue;
      const { selected: yes, reasons } = selectionDecision(a, this.policy);
      if (!yes) continue;
      await this.#event({ type: "status", articleId: id, from: a.status, to: STATUS.PENDING_REVIEW, actor: AUTHORITY.AUTOMATION, reason: reasons.join(",") });
      selected.push(id);
    }
    return selected;
  }

  // --------------------------------------------------------- operator acts
  async setImportance(articleId, importance, { actor = AUTHORITY.HUMAN } = {}) {
    if (!isImportance(importance)) throw new Error(`invalid importance: ${importance}`);
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    await this.#event({ type: "importance", articleId, from: article.importance, to: importance, actor });
    article.updatedAt = new Date().toISOString();
    return { ...article };
  }

  async setStatus(articleId, status, { actor = AUTHORITY.HUMAN, reason = null } = {}) {
    if (!isStatus(status)) throw new Error(`invalid status: ${status}`);
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    await this.#event({ type: "status", articleId, from: article.status, to: status, actor, reason });
    article.updatedAt = new Date().toISOString();
    return { ...article };
  }

  async requestReview(articleId, { actor = AUTHORITY.HUMAN, reason = null } = {}) {
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    await this.#event({ type: "review-requested", articleId, actor, reason });
    article.updatedAt = new Date().toISOString();
    return { ...article };
  }

  // --------------------------------------------------------- consumption
  /**
   * Exactly-once consumption. A repeat without `allowReuse` is skipped and
   * recorded — that is the accidental-duplicate guard. `allowReuse` records an
   * explicit historical re-appearance without pretending it is the first.
   */
  async markConsumed(articleIds, { runId, allowReuse = false } = {}) {
    const consumed = [];
    const skipped = [];
    for (const articleId of articleIds) {
      const article = this.articles.get(articleId);
      if (!article) {
        skipped.push({ articleId, reason: "unknown-article" });
        continue;
      }
      if (article.consumedAt && !allowReuse) {
        skipped.push({ articleId, reason: "already-consumed", runId: article.consumedRef });
        continue;
      }
      const rec = {
        articleId,
        contentHash: article.contentHash,
        runId: runId ?? null,
        reused: Boolean(article.consumedAt) && allowReuse,
        at: new Date().toISOString(),
      };
      this.consumption.push(rec);
      await this.#persist("consumption", rec);
      if (!article.consumedAt) article.consumedAt = rec.at;
      article.consumedRef = runId ?? article.consumedRef;
      consumed.push(rec);
    }
    return { consumed, skipped };
  }

  // --------------------------------------------------------------- stats
  getStats() {
    const byStatus = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    const byImportance = Object.fromEntries(["Normal", "Important", "Critical"].map((i) => [i, 0]));
    const byDomain = new Map();
    let trainable = 0;
    for (const a of this.articles.values()) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      byImportance[a.importance] = (byImportance[a.importance] ?? 0) + 1;
      byDomain.set(a.domain, (byDomain.get(a.domain) ?? 0) + 1);
      if (isTrainable(a)) trainable++;
    }
    const scores = [];
    for (const arr of this.reviews.values()) for (const r of arr) if (Number.isFinite(r.score)) scores.push(r.score);
    const uniqueConsumed = new Set(this.consumption.map((c) => c.articleId)).size;
    const total = this.articles.size;
    return {
      totalArticles: total,
      byStatus,
      byImportance,
      byDomain: [...byDomain.entries()].sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count })),
      pendingReview: byStatus[STATUS.PENDING_REVIEW] ?? 0,
      reviewed: byStatus[STATUS.REVIEWED] ?? 0,
      rejected: byStatus[STATUS.REJECTED] ?? 0,
      ingested: byStatus[STATUS.INGESTED] ?? 0,
      trainable,
      reviewCount: scores.length,
      avgReviewScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      uniqueConsumed,
      totalAppearances: this.consumption.length,
      duplicationIndex: total ? 1 - this.byHash.size / total : 0,
    };
  }

  // -------------------------------------------------------------- legacy
  /**
   * Detect (never load) pre-migration pair files. Retained data is reported as
   * legacy and is explicitly NOT a source of truth for the article domain.
   */
  legacyInfo() {
    const present = [];
    for (const file of LEGACY_FILES) {
      const p = path.join(this.dir, file);
      if (!existsSync(p)) continue;
      let count = 0;
      try {
        count = readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
      } catch {
        count = null;
      }
      present.push({ file, path: p, count });
    }
    return { supported: true, present, source: "legacy-pair-buffer", authoritative: false };
  }

  // --------------------------------------------------------------- purge
  async #reopen(name) {
    const p = path.join(this.dir, COLLECTIONS[name]);
    if (!this.#streams[name].writableEnded) await this.#end(name);
    await this.#persistEmpty(p);
    this.#streams[name] = createWriteStream(p, { flags: "a" });
  }

  #persistEmpty(p) {
    return new Promise((resolve, reject) => {
      const ws = createWriteStream(p, { flags: "w" });
      ws.once("finish", resolve);
      ws.once("error", reject);
      ws.end();
    });
  }

  #end(name) {
    const ws = this.#streams[name];
    return new Promise((resolve) => {
      ws.once("finish", resolve);
      ws.once("error", resolve);
      ws.end();
    });
  }

  /** Wipe transient collections. The durable consumption ledger survives. */
  async purgeBuffer() {
    for (const name of ["articles", "reviews", "events"]) await this.#reopen(name);
    this.articles.clear();
    this.articleOrder.length = 0;
    this.byHash.clear();
    this.reviews.clear();
    this.events.length = 0;
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
