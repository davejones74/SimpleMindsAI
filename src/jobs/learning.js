import { collectDocuments } from "../harness/crawler.js";
import { config } from "../config.js";
import { throwIfAborted } from "./cancel.js";
import { reviewPendingArticles } from "./review-pass.js";
import { classifyAcquisition } from "../discovery/acquisition-state.js";

/**
 * One acquisition cycle: harvest configured sources → curate (teacher) →
 * ingest → review. Nothing here discovers sources: `collectDocuments` fetches
 * ONLY the explicitly configured URLs (real mode) or the built-in fixtures, and
 * fails closed if real mode is requested without sources.
 *
 * The cycle reports source exhaustion honestly: if a pass ingests nothing new
 * (everything deduped, or the fetches failed), `sourceExhausted` is true and the
 * caller must NOT claim the target was reached.
 */
export async function runLearningCycle(ctx) {
  const { store, ollama, scorer, signal } = ctx;
  const onPhase = ctx.onPhase ?? (() => {});
  const onProgress = ctx.onProgress ?? (() => {});
  const log = ctx.log ?? (() => {});
  const collect = ctx.collectDocuments ?? collectDocuments;

  throwIfAborted(signal);
  onPhase("harvest");
  // Resolve the acquisition context. When the caller (a discovery service) has
  // not supplied one, fall back to the CONFIGURED crawl mode — never a hard-coded
  // fixture. This is the integration seam that previously ran every production
  // cycle against the built-in fixtures while config claimed `real`.
  const crawlCtx = ctx.crawl ?? {
    mode: config.crawlMode,
    urls: config.crawlUrls,
    allowPrivate: config.crawlAllowPrivate,
    respectRobots: config.crawlRespectRobots,
    userAgent: config.crawlUserAgent,
    languageFilter: config.languageFilter,
  };
  const result = await collect(crawlCtx);
  const rawDocs = result.documents?.length ?? 0;
  // `result.discovery` is present only when a DiscoveryService produced the docs.
  // It distinguishes "the frontier is momentarily empty" from "no discovery
  // capability is configured at all" so the caller never conflates the two.
  const discoveryStatus = result.discovery?.status ?? null;
  log(
    "out",
    `harvest mode=${result.mode} capability=${result.capability} documents=${rawDocs} failures=${result.failures?.length ?? 0}${discoveryStatus ? ` discovery=${discoveryStatus}` : ""}`,
  );

  const cap = ctx.maxRawDocs > 0 ? Math.min(rawDocs, ctx.maxRawDocs) : rawDocs;
  let ingested = 0;
  let deduped = 0;
  let skippedUnchanged = 0;
  let languageSkipped = 0;

  onPhase("curate");
  for (let i = 0; i < cap; i++) {
    throwIfAborted(signal);
    const doc = result.documents[i];
    // Skip curation if this source's fetched content hash was already
    // processed — the article ledger records the provenance, and the same
    // raw material does not need re-curation.
    if (doc.contentHash && store.hasRawSource(doc.contentHash)) {
      skippedUnchanged++;
      log("out", `skip unchanged source ${doc.url ?? doc.contentHash.slice(0, 12)}`);
      continue;
    }
    let units;
    try {
      units = await ollama.clean(doc.text);
    } catch (err) {
      log("err", `curate failed for doc ${i + 1}: ${err.message.slice(0, 160)}`);
      continue;
    }
    const newArticleIds = [];
    for (const unit of units) {
      throwIfAborted(signal);
      const text = unit?.text ?? (unit?.prompt ? `${unit.prompt}\n\n${unit.completion ?? ""}`.trim() : null);
      if (!text) continue;
      const rec = await store.ingestArticle({
        text,
        domain: unit.domain ?? doc.domain ?? "general",
        source: doc.source ?? "harvest",
        model: ollama.model,
        rawText: doc.text,
        sourceUrl: doc.url ?? null,
        fetchedContentHash: doc.contentHash ?? null,
        fetchedAt: doc.fetchedAt ?? null,
        htmlLang: doc.htmlLang ?? null,
        extraction: doc.extraction ?? null,
        reviewRequested: true,
      });
      if (rec.skipped) {
        languageSkipped++;
        log("out", `skip non-english/unknown source ${doc.url ?? ""}`);
        continue;
      }
      if (rec.deduped) deduped++;
      else {
        ingested++;
        newArticleIds.push(rec.articleId);
      }
    }
    // Record this source in the durable provenance ledger so future cycles
    // can skip re-curating identical fetched material.
    if (doc.contentHash) {
      await store.recordRawSource({
        fetchedContentHash: doc.contentHash,
        sourceUrl: doc.url ?? null,
        articleIds: newArticleIds,
      });
    }
    onProgress({ phase: "curate", processedRawDocs: i + 1, rawDocs: cap, ingested, deduped, skippedUnchanged });
  }

  onPhase("review");
  // Autonomously queue anything the policy selects, then run the SHARED bounded
  // review pass: cooldowns, attempt caps, auditable retires and cross-process
  // locking all live in one place (see jobs/review-pass.js).
  const reviewResult = await reviewPendingArticles(store, scorer, {
    config: ctx.reviewConfig ?? config,
    log,
    onProgress: (p) => onProgress(p),
    signal,
  });
  const reviewed = reviewResult.reviewed;
  const reviewWaiting = reviewResult.locked || reviewResult.waiting;

  const stats = store.getStats();
  // Exhaustion is detected, never assumed: a pass that ingests nothing (all
  // deduped, no documents, or every fetch failed) has no more material to give.
  const sourceExhausted =
    ingested === 0 && (rawDocs === 0 || deduped > 0 || (result.failures?.length ?? 0) > 0 || skippedUnchanged > 0);
  // The fixture "source" is a hard-coded document set, so its ceiling is known
  // up front. Surfacing it lets the operator see that a multi-article target is
  // unreachable on fixtures instead of reading "completed" as "acquired".
  const corpusCeiling = result.mode === "fixture" && rawDocs > 0 ? rawDocs : null;

  // Recovery-driven progress (Slice 6). Training material is ONLY reviewed,
  // unconsumed, non-retired articles — the corpus is never replayed. When there
  // is none, report honestly whether the pipeline can still RECOVER material
  // (ingested/pending/quarantined) or has genuinely run dry.
  const recovery = {
    trainable: stats.trainable,
    pendingReview: stats.pendingReview,
    ingested: stats.ingested,
    quarantined: stats.quarantined,
    recoverable: stats.recoverable ?? 0,
    released: stats.quarantineReleased ?? 0,
    consumed: stats.uniqueConsumed,
  };
  const progress =
    ingested > 0 || reviewed > 0
      ? "acquisition"
      : stats.trainable > 0
        ? "eligible"
        : recovery.recoverable > 0
          ? "recovery"
          : "no-eligible-unconsumed";
  return {
    mode: result.mode,
    capability: result.capability,
    rawDocs,
    processedRawDocs: cap,
    ingested,
    deduped,
    reviewed,
    reviewRetired: reviewResult.retired,
    reviewFailed: reviewResult.failed,
    reviewSkippedCooldown: reviewResult.skippedCooldown,
    reviewPendingBefore: reviewResult.pendingBefore,
    reviewPendingAfter: reviewResult.pendingAfter,
    reviewWaiting,
    trainable: stats.trainable,
    corpusCeiling,
    failures: result.failures ?? [],
    sourceExhausted,
    // A full admission epoch is a lifecycle wait, never a reason to mark the
    // frontier URL rejected. The supervisor parks until a rollover is activated.
    admissionCapExhausted: result.capExhausted === true,
    admissionCapDeferred: result.admissionCapDeferred ?? 0,
    admissionCapEpoch: result.capEpoch ?? null,
    // Recovery-driven progress: what can still become training material without
    // replaying the corpus, and the honest "no eligible unconsumed" signal.
    recovery,
    progress,
    skippedUnchanged,
    languageSkipped,
    // Pass the discovery report through so the supervisor can tell an empty
    // queue from a genuinely unconfigured discovery source.
    discovery: result.discovery ?? null,
    // The persistent frontier's state, and the authoritative acquisition
    // classification derived from it — the single source of truth the supervisor
    // and UI use to decide "work / wait / exhausted".
    frontier: result.frontier ?? null,
    acquisition: classifyAcquisition({ frontier: result.frontier ?? null, discovery: result.discovery ?? null, ingested }),
  };
}
