import { createWriteStream, existsSync, createReadStream, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import {
  AUTHORITY,
  QUARANTINE_REASON,
  STATUS,
  VERDICT,
  contentHash,
  inDeferralCooldown,
  isImportance,
  isQuarantineReason,
  isStatus,
  isTrainable,
  normalizeImportance,
} from "../domain/article.js";
import { canonicalDomain } from "../storage/domain-registry.js";
import { DEFAULT_POLICY, evaluateVerdict, selectionDecision } from "../domain/review-policy.js";
import { assess } from "../domain/language.js";
import { scoreMissionRelevance } from "../domain/mission-relevance.js";
import { config } from "../config.js";

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
  // Durable provenance ledger for FETCHED sources, keyed by the fetched
  // content hash. Lets the acquisition path skip re-curating an unchanged
  // source, and records which article(s) each raw source produced.
  rawSources: "raw-sources.ndjson",
  // Durable learning-contribution ledger: one row per COMPLETED training run
  // recording which articles contributed (fresh vs replay) and the decision.
  // This is what makes "cumulative exposure across promoted models" a measurable
  // fact rather than a claim that "the article appeared in a batch".
  contributions: "training-contribution.ndjson",
};

/** Old pair-based files. Detected read-only, never loaded as a source of truth. */
const LEGACY_FILES = ["prompts.ndjson", "completions.ndjson", "rewards.ndjson", "state.ndjson", "runs.ndjson"];

export class ArticleStore {
  static async open(dir = process.env.ARTICLE_DIR ?? process.env.BUFFER_DIR ?? path.resolve("data", "articles"), { readOnly = false, policy = DEFAULT_POLICY, domainRegistry = null, languageFilter = config.languageFilter, missionTexts = [], missionRelevanceEnabled = config.missionRelevanceEnabled } = {}) {
    const s = new ArticleStore(dir, { readOnly, policy, domainRegistry, languageFilter, missionTexts, missionRelevanceEnabled });
    await s.#loadFromDisk();
    return s;
  }

  static contentHash(text) {
    return contentHash(text);
  }

  /**
   * `readOnly: true` opens an inspection view: no directory is created and no
   * append streams are opened, so merely reading a store (e.g. another
   * workspace's completed trial) can never create or mutate a file. Every
   * mutating method throws.
   */
  constructor(dir, { policy = DEFAULT_POLICY, readOnly = false, domainRegistry = null, languageFilter = config.languageFilter, missionTexts = [], missionRelevanceEnabled = config.missionRelevanceEnabled } = {}) {
    this.dir = dir;
    this.policy = policy;
    this.readOnly = readOnly;
    this.domainRegistry = domainRegistry;
    // Ingest-time language backstop. When no filter is supplied it is resolved
    // from `config.languageFilter`, so every entry point (server, CLI,
    // chat-server, future callers) enforces the same policy without having to
    // remember to thread it through. Passing `null` explicitly disables the
    // backstop; `{ enabled: false }` is also a no-op. Enforcement only ever
    // EXCLUDES: an English verdict, or an unknown verdict under the fail-open
    // policy, always ingests. With the default config the filter is disabled,
    // so existing callers and tests keep their current behaviour.
    this.languageFilter = languageFilter;
    this.languageSkipped = 0;
    // Advisory mission relevance: computed at ingest when enabled and a mission
    // reference is present. Never a rejection rule.
    this.missionTexts = Array.isArray(missionTexts) ? missionTexts : [];
    this.missionRelevanceEnabled = Boolean(missionRelevanceEnabled);
    if (!readOnly) mkdirSync(dir, { recursive: true });

    this.articles = new Map();
    this.articleOrder = [];
    this.byHash = new Map();
    this.reviews = new Map(); // articleId -> [review]
    this.events = []; // audit trail
    this.consumption = []; // durable appearances
    this.rawSources = new Map(); // fetchedContentHash -> { sourceUrl, firstSeenAt, curatedAt, articleIds:[] }
    this.contributions = []; // durable per-run learning-contribution ledger

    this.#streams = {};
    if (!readOnly) {
      for (const name of Object.keys(COLLECTIONS)) {
        this.#streams[name] = createWriteStream(path.join(this.dir, COLLECTIONS[name]), { flags: "a" });
      }
    }
  }

  #streams;

  #assertWritable() {
    if (this.readOnly) throw new Error("ArticleStore is read-only (inspection workspace)");
  }

  /**
   * Supply the active mission reference for advisory relevance scoring. The
   * server calls this after governance is loaded, because the store is opened
   * before the mission service has seeded (or is able to read) the missions.
   * Idempotent and cheap; passing no args changes nothing.
   */
  setMissionContext({ missionTexts = null, enabled = undefined } = {}) {
    if (Array.isArray(missionTexts)) this.missionTexts = missionTexts;
    if (enabled !== undefined) this.missionRelevanceEnabled = Boolean(enabled);
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
    for (const rec of await lines(COLLECTIONS.rawSources)) {
      this.rawSources.set(rec.fetchedContentHash, {
        sourceUrl: rec.sourceUrl,
        firstSeenAt: rec.firstSeenAt,
        curatedAt: rec.curatedAt,
        articleIds: rec.articleIds ?? [],
      });
    }
    for (const rec of await lines(COLLECTIONS.contributions)) {
      this.contributions.push(rec);
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
    this.#assertWritable();
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
    } else if (rec.type === "deferral") {
      // Replayed from the log, so a restart reconstructs the same retry
      // counters: the event carries the resulting count, never a delta.
      a.deferralRetries = Number.isFinite(rec.retries) ? rec.retries : (a.deferralRetries ?? 0) + 1;
      a.deferredRunId = rec.retired ? null : rec.runId ?? null;
      a.deferredReason = rec.reason ?? null;
      a.deferredUntil = rec.deferredUntil ?? null;
    } else if (rec.type === "replay-only") {
      // Fresh retries exhausted: the article is moved OUT of the fresh delta
      // and INTO the replay pool. It is never deleted and never RETIRED — a
      // rejected candidate's source knowledge survives for future replay under
      // an improved training strategy.
      a.replayOnly = true;
      a.deferralRetries = Number.isFinite(rec.retries) ? rec.retries : (a.deferralRetries ?? 0);
      a.deferredReason = rec.reason ?? a.deferredReason ?? null;
      a.deferredUntil = null;
    } else if (rec.type === "deferral-cleared") {
      a.deferralRetries = 0;
      a.deferredRunId = null;
      a.deferredReason = null;
      a.deferredUntil = null;
    } else if (rec.type === "quarantine") {
      // Reversible holding state. The reason is carried ON the event so a
      // replay reconstructs the audit trail without any in-memory-only field,
      // and the PREVIOUS status is captured so a release can restore it.
      a.quarantined = true;
      a.quarantineReason = rec.reason ?? null;
      a.quarantineDetail = rec.detail ?? null;
      a.quarantinePrevStatus = rec.from ?? a.quarantinePrevStatus ?? null;
      a.quarantineAt = rec.at ?? null;
    } else if (rec.type === "quarantine-released") {
      a.quarantined = false;
      a.quarantineReleasedAt = rec.at ?? null;
    }
  }

  async #event(rec) {
    const full = { at: new Date().toISOString(), ...rec };
    this.events.push(full);
    this.#applyEvent(full);
    await this.#persist("events", full);
    return full;
  }

  /** Is there already a curated article with this fetchedContentHash? */
  hasRawSource(fetchedContentHash) {
    if (!fetchedContentHash) return false;
    return this.rawSources.has(fetchedContentHash);
  }

  /** Record that fetchedContentHash was curated, noting its source and which articleIds it produced. */
  recordRawSource({ fetchedContentHash, sourceUrl, articleIds = [] }) {
    if (!fetchedContentHash) return;
    const now = new Date().toISOString();
    const entry = {
      fetchedContentHash,
      sourceUrl,
      firstSeenAt: now,
      curatedAt: now,
      articleIds: articleIds ?? [],
    };
    // Append to the durable ledger
    this.#persist("rawSources", entry);
    // In-memory cache
    this.rawSources.set(fetchedContentHash, {
      sourceUrl,
      firstSeenAt: now,
      curatedAt: now,
      articleIds: articleIds ?? [],
    });
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
    // Source→curated provenance: the original fetched identity is kept
    // independently of `text`, which the curator may have transformed.
    sourceUrl = null,
    fetchedContentHash = null,
    fetchedAt = null,
    htmlLang = null,
    extraction = null,
    uncertainty = null,
    missionRelevance = null,
    reviewRequested = false,
  } = {}) {
    this.#assertWritable();
    if (!text || !String(text).trim()) throw new Error("article text is required");

    // Language backstop: the harvest seam already filters fetched pages, but a
    // curator (teacher model) can still emit a non-English unit, or a caller may
    // bypass the crawler entirely. We re-check here so the ledger can never gain
    // a non-English article when the feature is enforced.
    //
    // The feature is opt-in and enforcement-only:
    //   disabled                -> no assessment at all (existing behaviour)
    //   enabled + shadow        -> assess, behaviour UNCHANGED (report only)
    //   enabled + !shadow       -> exclude non-English (and unknown under `reject`)
    // An English verdict, or unknown under the fail-open policy, always ingests.
    let languageVerdict = null;
    if (this.languageFilter?.enabled) {
      const decision = assess(text, {
        minConfidence: this.languageFilter.minConfidence,
        htmlLang,
        sourceUrl,
      });
      const wouldSkip =
        decision.verdict === "non-english" ||
        (decision.verdict === "unknown" && this.languageFilter.unknownPolicy === "reject");
      if (wouldSkip && !this.languageFilter.shadow) {
        this.languageSkipped += 1;
        return {
          skipped: true,
          deduped: false,
          reason: decision.verdict === "unknown" ? "unknown-language" : "non-english",
          language: decision.detection.language,
          script: decision.detection.script ?? null,
          confidence: decision.detection.confidence,
        };
      }
      if (this.languageFilter.shadow && decision.verdict !== "english") {
        languageVerdict = {
          verdict: decision.verdict,
          language: decision.detection.language,
          confidence: decision.detection.confidence,
        };
      }
    }

    const hash = contentHash(text);
    const dup = this.byHash.get(hash);
    if (dup) return { ...this.articles.get(dup), deduped: true, ...(languageVerdict ? { languageVerdict } : {}) };

    const articleId = `art_${randomUUID().slice(0, 12)}`;
    const imp = normalizeImportance(importance);
    const now = new Date().toISOString();
    // Advisory mission relevance: compute only when the caller did NOT already
    // supply a score, the feature is enabled, and a mission reference exists.
    // A low (or null) score NEVER rejects — it only (de)selects for review.
    if (missionRelevance == null && this.missionRelevanceEnabled && this.missionTexts.length) {
      missionRelevance = scoreMissionRelevance(text, this.missionTexts);
    }
    const draft = {
      articleId,
      importance: imp,
      uncertainty,
      missionRelevance,
      reviewRequested,
    };
    const { selected, reasons } = selectionDecision(draft, this.policy, this.domainRegistry);

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
      sourceDomain: sourceUrl ? canonicalDomain(sourceUrl) : null,
      model,
      rawText,
      // Only present when the caller supplied them, so records from the
      // GraphQL/curator path (and every existing test) stay byte-identical.
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(htmlLang ? { htmlLang } : {}),
      ...(fetchedContentHash ? { fetchedContentHash } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
      ...(extraction ? { extraction } : {}),
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
    return { ...rec, deduped: false, ...(languageVerdict ? { languageVerdict } : {}) };
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
  articlesPage({ after = null, limit = 100, status, importance, consumed, domain, replayOnly, trainableOnly = false, order = "asc" } = {}) {
    // Insertion order is recency order (articles are appended as they are
    // curated), so `order: "desc"` walks the tail first to surface the newest
    // material. The cursor is the last id returned; the next page resumes on
    // the adjacent index in the same direction, which keeps `after` stable
    // under the same skips-and-continue filtering as the ascending default.
    const desc = order === "desc";
    const total = this.articleOrder.length;
    let i;
    if (!after) {
      i = desc ? total - 1 : 0;
    } else {
      const idx = this.articleOrder.indexOf(after);
      i = idx === -1 ? (desc ? total - 1 : 0) : desc ? idx - 1 : idx + 1;
    }
    const items = [];
    let nextCursor = null;
    for (; i >= 0 && i < total && items.length < limit; i += desc ? -1 : 1) {
      const rec = { ...this.articles.get(this.articleOrder[i]) };
      if (status && rec.status !== status) continue;
      if (importance && rec.importance !== importance) continue;
      if (consumed !== undefined && Boolean(rec.consumedAt) !== consumed) continue;
      if (replayOnly !== undefined && Boolean(rec.replayOnly) !== replayOnly) continue;
      if (domain && rec.domain !== domain) continue;
      rec.reviewCount = (this.reviews.get(rec.articleId) ?? []).length;
      rec.trainable = isTrainable(rec);
      if (trainableOnly && !rec.trainable) continue;
      items.push(rec);
      nextCursor = rec.articleId;
    }
    return { items, nextCursor: items.length ? nextCursor : null };
  }

  trainablePage({ after = null, limit = 100 } = {}) {
    return this.articlesPage({ after, limit, status: STATUS.REVIEWED, consumed: false, trainableOnly: true });
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
    criticTemperature = null,
    criticPromptVersion = null,
    criticScoreMissing = false,
    criticError = null,
    gate = null,
    completeness = null,
    reason = null,
  } = {}) {
    this.#assertWritable();
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    const decision = evaluateVerdict(article, { verdict, score, authority, reason }, this.policy);

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
      criticTemperature,
      criticPromptVersion,
      criticScoreMissing: Boolean(criticScoreMissing),
      criticError: criticError ?? null,
      completeness: completeness ?? null,
      // Which deterministic review-time gate (if any) produced this review —
      // null for an LLM/teacher or human review.
      gate: gate ?? null,
      applied: decision.apply,
      resultingStatus: decision.status,
      reason: decision.reason,
      deferralReason: decision.deferralReason,
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
  async selectForReview({ limit = 500, domainRegistry = null } = {}) {
    this.#assertWritable();
    const selected = [];
    for (const id of this.articleOrder) {
      if (selected.length >= limit) break;
      const a = this.articles.get(id);
      if (a.status !== STATUS.INGESTED) continue;
      const { selected: yes, reasons } = selectionDecision(a, this.policy, domainRegistry);
      if (!yes) continue;
      await this.#event({ type: "status", articleId: id, from: a.status, to: STATUS.PENDING_REVIEW, actor: AUTHORITY.AUTOMATION, reason: reasons.join(",") });
      selected.push(id);
    }
    return selected;
  }

  // --------------------------------------------------------- operator acts
  async setImportance(articleId, importance, { actor = AUTHORITY.HUMAN } = {}) {
    this.#assertWritable();
    if (!isImportance(importance)) throw new Error(`invalid importance: ${importance}`);
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    await this.#event({ type: "importance", articleId, from: article.importance, to: importance, actor });
    article.updatedAt = new Date().toISOString();
    return { ...article };
  }

  async setStatus(articleId, status, { actor = AUTHORITY.HUMAN, reason = null } = {}) {
    this.#assertWritable();
    if (!isStatus(status)) throw new Error(`invalid status: ${status}`);
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    await this.#event({ type: "status", articleId, from: article.status, to: status, actor, reason });
    article.updatedAt = new Date().toISOString();
    return { ...article };
  }

  async requestReview(articleId, { actor = AUTHORITY.HUMAN, reason = null } = {}) {
    this.#assertWritable();
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    await this.#event({ type: "review-requested", articleId, actor, reason });
    article.updatedAt = new Date().toISOString();
    return { ...article };
  }

  /**
   * Attempt accounting for bounded autonomous review.
   *
   * Everything is derived from the immutable REVIEW HISTORY + the review-request
   * event log, so a restart reconstructs exactly the same counters (no
   * in-memory-only state). Semantics, stated once:
   *
   *   - Only TEACHER reviews count as autonomous attempts. A human review is a
   *     final decision and is never re-attempted.
   *   - `inconclusiveAttempts` counts teacher verdicts that did NOT change the
   *     article's status (uncertain, or an approve below the score gate).
   *   - `technicalAttempts` counts reviews whose critic failed technically
   *     (no JSON / transport error). Technical failures never consume the
   *     inconclusive allowance — the text was never actually judged.
   *   - A `review-requested` event is an explicit human/operator OVERRIDE: it
   *     bypasses the cooldown and resets the attempt baseline, so a human can
   *     force a re-review of an article that was about to be (or already is)
   *     retired. Overrides are consumed naturally once a teacher review lands
   *     after them.
   */
  reviewAttempts(articleId, { cooldownMs = 0, maxAttempts = 0, maxTechnicalAttempts = 0, now = Date.now() } = {}) {
    const article = this.articles.get(articleId);
    if (!article) return null;
    const teacher = (this.reviews.get(articleId) ?? []).filter((r) => r.authority === AUTHORITY.TEACHER);

    let lastOverrideAt = Number.NEGATIVE_INFINITY;
    for (const e of this.events) {
      if (e.articleId !== articleId || e.type !== "review-requested") continue;
      const t = Date.parse(e.at);
      if (Number.isFinite(t) && t > lastOverrideAt) lastOverrideAt = t;
    }
    const overridePending =
      Number.isFinite(lastOverrideAt) && !teacher.some((r) => Date.parse(r.at) > lastOverrideAt);

    // Attempts are counted since the most recent human override (baseline reset).
    const considered = overridePending ? [] : teacher.filter((r) => Date.parse(r.at) > lastOverrideAt);
    const inconclusiveAttempts = considered.filter((r) => !r.criticError && r.verdict === VERDICT.UNCERTAIN).length;
    const technicalAttempts = considered.filter((r) => Boolean(r.criticError)).length;
    const conclusiveAttempts = considered.filter((r) => r.applied === true).length;

    let lastTeacherAt = Number.NEGATIVE_INFINITY;
    for (const r of teacher) {
      const t = Date.parse(r.at);
      if (Number.isFinite(t) && t > lastTeacherAt) lastTeacherAt = t;
    }

    const cooldownRemainingMs =
      !overridePending && Number.isFinite(lastTeacherAt) && cooldownMs > 0
        ? Math.max(0, cooldownMs - (now - lastTeacherAt))
        : 0;
    const inCooldown = cooldownRemainingMs > 0;
    const capReached = maxAttempts > 0 && inconclusiveAttempts >= maxAttempts;
    const technicalCapReached = maxTechnicalAttempts > 0 && technicalAttempts >= maxTechnicalAttempts;
    const pending = article.status === STATUS.PENDING_REVIEW;
    const eligible = pending && !inCooldown && !capReached && !technicalCapReached;

    return {
      status: article.status,
      pending,
      overridePending,
      inconclusiveAttempts,
      technicalAttempts,
      conclusiveAttempts,
      lastTeacherAt: Number.isFinite(lastTeacherAt) ? new Date(lastTeacherAt).toISOString() : null,
      lastOverrideAt: Number.isFinite(lastOverrideAt) ? new Date(lastOverrideAt).toISOString() : null,
      inCooldown,
      cooldownRemainingMs,
      capReached,
      technicalCapReached,
      eligible,
    };
  }

  /**
   * Deliberately retire an article after bounded inconclusive review. This is a
   * real, auditable state transition (two appended events: the explicit
   * `review-retired` marker carrying the attempt count, then the `status` change)
   * — never a silent count manipulation. Review history is preserved untouched;
   * a retired article can still be reopened by an explicit human override
   * (`requestReview`), which records its own audit event.
   */
  async retireArticle(articleId, { reason = null, attempts = null, actor = AUTHORITY.AUTOMATION } = {}) {
    this.#assertWritable();
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    if (article.status === STATUS.RETIRED) return { ...article, retired: false, alreadyRetired: true };
    await this.#event({ type: "review-retired", articleId, attempts, reason, actor });
    await this.#event({
      type: "status",
      articleId,
      from: article.status,
      to: STATUS.RETIRED,
      actor,
      reason: reason ?? "review: inconclusive attempts exhausted",
    });
    article.updatedAt = new Date().toISOString();
    return { ...article, retired: true };
  }

  // ------------------------------------------------------------- quarantine
  /**
   * Move an article into the reversible QUARANTINED holding state.
   *
   * This is deliberately SEPARATE from retirement: retirement is the terminal
   * outcome of bounded teacher review, whereas quarantine is an out-of-band,
   * independently RELEASABLE action that records WHY (a closed reason category
   * plus free-text detail) so the historical junk can be audited. Nothing is
   * deleted; the article body and its full review history are preserved.
   *
   * Idempotent: quarantining an already-quarantined article appends no events.
   */
  async quarantineArticle(articleId, { reason = null, detail = null, actor = AUTHORITY.AUTOMATION } = {}) {
    this.#assertWritable();
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    if (!isQuarantineReason(reason)) throw new Error(`invalid quarantine reason: ${reason}`);
    if (article.status === STATUS.QUARANTINED) {
      return { ...article, quarantined: true, alreadyQuarantined: true };
    }
    const from = article.status;
    await this.#event({ type: "quarantine", articleId, from, reason, detail, actor });
    await this.#event({
      type: "status",
      articleId,
      from,
      to: STATUS.QUARANTINED,
      actor,
      reason: detail ? `quarantine: ${reason} — ${detail}` : `quarantine: ${reason}`,
    });
    article.updatedAt = new Date().toISOString();
    return { ...article, quarantined: true };
  }

  /**
   * Release an article from quarantine, restoring the status it held before it
   * was quarantined (PENDING_REVIEW when that is unknown). Reversible by design;
   * appends its own audit event and is a no-op for a non-quarantined article.
   */
  async releaseQuarantine(articleId, { actor = AUTHORITY.HUMAN, reason = null } = {}) {
    this.#assertWritable();
    const article = this.articles.get(articleId);
    if (!article) throw new Error(`unknown article: ${articleId}`);
    if (article.status !== STATUS.QUARANTINED) return { ...article, released: false, notQuarantined: true };
    const to = isStatus(article.quarantinePrevStatus) ? article.quarantinePrevStatus : STATUS.PENDING_REVIEW;
    await this.#event({ type: "quarantine-released", articleId, to, actor, reason });
    await this.#event({
      type: "status",
      articleId,
      from: STATUS.QUARANTINED,
      to,
      actor,
      reason: reason ?? "quarantine released",
    });
    article.updatedAt = new Date().toISOString();
    return { ...article, released: true, status: to };
  }

  /** Audit report: the quarantined articles, grouped by reason, with detail. */
  quarantineReport() {
    const byReason = {};
    const articles = [];
    for (const id of this.articleOrder) {
      const a = this.articles.get(id);
      if (a.status !== STATUS.QUARANTINED) continue;
      const reason = a.quarantineReason ?? "unspecified";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      articles.push({
        articleId: a.articleId,
        reason,
        detail: a.quarantineDetail ?? null,
        previousStatus: a.quarantinePrevStatus ?? null,
        quarantinedAt: a.quarantineAt ?? null,
        source: a.source ?? null,
        sourceUrl: a.sourceUrl ?? null,
      });
    }
    return { total: articles.length, byReason, articles };
  }

  // --------------------------------------------------------- consumption
  /**
   * Exactly-once consumption. A repeat without `allowReuse` is skipped and
   * recorded — that is the accidental-duplicate guard. `allowReuse` records an
   * explicit historical re-appearance without pretending it is the first.
   */
  async markConsumed(articleIds, { runId, allowReuse = false } = {}) {
    this.#assertWritable();
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

  /**
   * Record one training run's actual learning contribution, durably.
   *
   * This is the ledger that lets the system REPORT exposure honestly: "this
   * article appeared in a training batch" (any decision) vs "this article
   * contributed to a promoted model" (decision === "promoted"). Both are
   * measurable here; neither is inferred from consumption alone (replay rows are
   * never re-consumed, so consumption understates what a run actually trained
   * on). Appended, never mutated; idempotent per run.
   */
  async recordTrainingContribution({
    runId,
    decision,
    version = null,
    parentVersion = null,
    freshArticleIds = [],
    replayArticleIds = [],
    trainTokensSeen = null,
    replayTokensSeen = null,
    validationTokensSeen = null,
  } = {}) {
    this.#assertWritable();
    if (!runId) throw new Error("recordTrainingContribution requires a runId");
    if (this.contributions.some((c) => c.runId === runId && c.decision === decision)) {
      return { recorded: false, duplicate: true };
    }
    const rec = {
      schema: "sma/training-contribution@1",
      runId,
      decision: decision ?? null,
      version: version ?? null,
      parentVersion: parentVersion ?? null,
      freshArticleIds: Array.isArray(freshArticleIds) ? freshArticleIds : [],
      replayArticleIds: Array.isArray(replayArticleIds) ? replayArticleIds : [],
      trainTokensSeen: Number.isFinite(Number(trainTokensSeen)) ? Number(trainTokensSeen) : null,
      replayTokensSeen: Number.isFinite(Number(replayTokensSeen)) ? Number(replayTokensSeen) : null,
      validationTokensSeen: Number.isFinite(Number(validationTokensSeen)) ? Number(validationTokensSeen) : null,
      at: new Date().toISOString(),
    };
    this.contributions.push(rec);
    await this.#persist("contributions", rec);
    return { recorded: true, duplicate: false };
  }

  /** The durable per-run learning-contribution ledger (read-only view). */
  listContributions() {
    return [...this.contributions];
  }

  // ----------------------------------------------------- deferral / retire
  /**
   * Durable deferral of a batch a training run rejected.
   *
   * A rejected run must NOT consume its articles — they stay eligible so a
   * later run can retry them alongside new material. Each deferral is an
   * appended event carrying the RESULTING retry count and a cooldown deadline,
   * so replaying the log after a restart reconstructs exactly the same counters
   * and timers (no in-memory-only state).
   *
   * Rejection of candidate WEIGHTS is never a rejection of SOURCE KNOWLEDGE:
   * once `maxRetries` is reached the article is NOT retired. It is moved to the
   * replay pool (`replayOnly`) — still REVIEWED, still addressable, excluded
   * from the fresh delta but still sampled as historical material so it can
   * contribute again under an improved training strategy. Retiring on a
   * training rejection was the exact bug this replaces.
   *
   * Idempotent per run: re-driving the same rejected run (crash recovery)
   * finds `deferredRunId === runId` and does nothing, so a retry can never
   * inflate the counter or escalate an article early.
   */
  async deferArticles(
    articleIds = [],
    { runId = null, reason = null, maxRetries = 2, cooldownBaseMs = 6 * 60 * 60 * 1000, cooldownMaxMs = 24 * 60 * 60 * 1000, now = Date.now() } = {},
  ) {
    this.#assertWritable();
    const limit = Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 0;
    const base = Number.isFinite(Number(cooldownBaseMs)) ? Number(cooldownBaseMs) : 0;
    const cap = Number.isFinite(Number(cooldownMaxMs)) ? Number(cooldownMaxMs) : base;
    const deferred = [];
    const replayPool = [];
    const skipped = [];
    for (const articleId of articleIds ?? []) {
      const article = this.articles.get(articleId);
      if (!article) {
        skipped.push({ articleId, reason: "unknown-article" });
        continue;
      }
      if (article.status === STATUS.RETIRED) {
        skipped.push({ articleId, reason: "already-retired" });
        continue;
      }
      if (article.replayOnly === true) {
        skipped.push({ articleId, reason: "already-replay-pool" });
        continue;
      }
      if (runId && article.deferredRunId === runId) {
        skipped.push({ articleId, reason: "already-deferred-by-run" });
        continue;
      }
      const retries = (article.deferralRetries ?? 0) + 1;
      const exhausted = limit > 0 && retries >= limit;
      if (exhausted) {
        await this.#event({
          type: "replay-only",
          articleId,
          runId: runId ?? null,
          retries,
          reason: reason ?? "rejected by training run",
          actor: AUTHORITY.AUTOMATION,
        });
        replayPool.push(articleId);
      } else {
        const delay = Math.min(base * 2 ** (retries - 1), cap || base || 0);
        const deferredUntil = new Date(now + delay).toISOString();
        await this.#event({
          type: "deferral",
          articleId,
          runId: runId ?? null,
          retries,
          retired: false,
          reason: reason ?? "rejected by training run",
          deferredUntil,
          actor: AUTHORITY.AUTOMATION,
        });
        deferred.push(articleId);
      }
      article.updatedAt = new Date().toISOString();
    }
    return { deferred, replayPool, skipped };
  }

  /**
   * Clear deferral state for articles a promoted run consumed. Appended (not
   * mutated) so the clearing survives a restart; a no-op for articles that
   * carry no deferral state, which keeps a re-driven promotion idempotent.
   */
  async clearDeferral(articleIds = [], { runId = null } = {}) {
    this.#assertWritable();
    const cleared = [];
    for (const articleId of articleIds ?? []) {
      const article = this.articles.get(articleId);
      if (!article) continue;
      const hasState = Boolean(article.deferredRunId) || Boolean(article.deferredReason) || (article.deferralRetries ?? 0) > 0 || Boolean(article.deferredUntil);
      if (!hasState) continue;
      await this.#event({
        type: "deferral-cleared",
        articleId,
        runId: runId ?? null,
        reason: "consumed by a promoted run",
        actor: AUTHORITY.AUTOMATION,
      });
      article.updatedAt = new Date().toISOString();
      cleared.push(articleId);
    }
    return { cleared };
  }

  // --------------------------------------------------------------- stats
  getStats() {
    const byStatus = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    const byImportance = Object.fromEntries(["Normal", "Important", "Critical"].map((i) => [i, 0]));
    const byDomain = new Map();
    let trainable = 0;
    let deferredFresh = 0;
    let retainedForReplay = 0;
    let quarantineReleased = 0;
    for (const a of this.articles.values()) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      byImportance[a.importance] = (byImportance[a.importance] ?? 0) + 1;
      byDomain.set(a.domain, (byDomain.get(a.domain) ?? 0) + 1);
      if (isTrainable(a)) trainable++;
      if (a.replayOnly === true) retainedForReplay++;
      if (inDeferralCooldown(a)) deferredFresh++;
      if (a.quarantineReleasedAt) quarantineReleased++;
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
      // Retired material stays visible as its own historical category; it is
      // excluded from `trainable` by the single trainability predicate.
      retired: byStatus[STATUS.RETIRED] ?? 0,
      // Quarantined material is likewise visible as its own reversible category.
      quarantined: byStatus[STATUS.QUARANTINED] ?? 0,
      trainable,
      // Articles currently in a rejected-run cooldown (still REVIEWED, not yet
      // re-selectable as fresh), and articles whose fresh retries are exhausted
      // and now live in the replay pool (never retired, never deleted).
      deferredFresh,
      retainedForReplay,
      // Progress accounting (Slice 6). `trainable` is the ONLY source of training
      // material (reviewed + unconsumed + not retired); the corpus is never
      // replayed. `recoverable` is the size of the pipeline that can still become
      // trainable without replay: ingested-but-unreviewed, pending review, and
      // quarantined (releasable) material. `noEligibleUnconsumed` is the honest
      // "there is nothing to train on right now" signal.
      noEligibleUnconsumed: trainable === 0,
      recoverable:
        (byStatus[STATUS.INGESTED] ?? 0) +
        (byStatus[STATUS.PENDING_REVIEW] ?? 0) +
        (byStatus[STATUS.QUARANTINED] ?? 0),
      quarantineReleased,
      reviewCount: scores.length,
      avgReviewScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      uniqueConsumed,
      totalAppearances: this.consumption.length,
      // Session-scoped count of ingests the language backstop refused. Only
      // non-zero when the feature is enabled and enforcing.
      languageSkipped: this.languageSkipped,
      duplicationIndex: total ? 1 - this.byHash.size / total : 0,
      distinctSourceUrls: (() => {
        const urls = [...this.articles.values()].map((a) => a.sourceUrl).filter((u) => u && u.trim().length > 0);
        return new Set(urls).size;
      })(),
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
    this.#assertWritable();
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
    this.#assertWritable();
    for (const name of ["articles", "reviews", "events"]) await this.#reopen(name);
    this.articles.clear();
    this.articleOrder.length = 0;
    this.byHash.clear();
    this.reviews.clear();
    this.events.length = 0;
  }

  /** Wipe transient collections. The durable consumption ledger survives. */
  async purgeBuffer() {
    this.#assertWritable();
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
