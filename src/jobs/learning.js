import { collectDocuments } from "../harness/crawler.js";
import { config } from "../config.js";
import { throwIfAborted } from "./cancel.js";
import { reviewPendingArticles } from "./review-pass.js";
import { ACQUISITION_STATE, classifyAcquisition } from "../discovery/acquisition-state.js";
import { mergeAdjacentUnits, planCuration, segmentationStats } from "../services/curator-segmentation.js";
import { prefilterReview } from "../domain/review-prefilter.js";
import { cleanRawText } from "../dataset/corpus-text.js";

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
    // Segment the FULL source before curation. The historical path sent only
    // the first 14k chars and silently discarded the rest of long documents.
    const plan = planCuration(doc.text, {
      strategy: config.curatorStrategy,
      legacyMaxChars: config.curatorLegacyMaxChars,
      maxChars: config.curatorChunkMaxChars,
      minChars: config.curatorChunkMinChars,
      targetChars: config.curatorChunkTargetChars,
    });
    const stats = segmentationStats(plan, doc.text);
    let units = [];
    let chunkErrors = 0;
    for (const chunk of plan) {
      throwIfAborted(signal);
      try {
        const cleaned = await ollama.clean(chunk.text);
        for (const unit of cleaned) units.push({ ...unit, sourceChunk: chunk.index });
      } catch (err) {
        chunkErrors += 1;
        log("err", `curate failed for doc ${i + 1} chunk ${chunk.index + 1}/${plan.length}: ${err.message.slice(0, 140)}`);
      }
    }
    if (!units.length) continue;
    if (config.curatorMergeUnits) {
      units = mergeAdjacentUnits(units, {
        minChars: config.curatorMergeMinChars,
        maxChars: config.curatorMergeMaxChars,
        // Teacher units from one source often carry different domain labels;
        // merging them is still coherent and prevents the source from remaining
        // a pile of sub-block fragments.
        mergeAcrossDomains: config.curatorMergeAcrossDomains !== false,
      });
    }
    // If the teacher still returned only sub-block fragments for a long source,
    // fall back to the cleaned source text for this source. This preserves the
    // full-source work instead of throwing it away; the normal language,
    // quality and review gates still run on the resulting unit. It is NOT
    // raw-text corpus mode: it only applies at curation when teacher output is
    // unusably fragmented.
    const teacherChars = units.reduce((sum, unit) => sum + String(unit?.text ?? "").length, 0);
    if (config.curatorFallbackToSource !== false && teacherChars < config.curatorFallbackMinChars && doc.text.length >= config.curatorFallbackMinChars) {
      const cleaned = cleanRawText(doc.text, {
        minChars: config.trainCorpusMinChars,
        minSentenceRatio: config.trainCorpusMinSentenceRatio,
      });
      const fallbackText = cleaned.accepted ? cleaned.text : doc.text;
      if (fallbackText.length >= config.curatorFallbackMinChars) {
        units = [{
          text: fallbackText,
          domain: units[0]?.domain ?? doc.domain ?? "general",
          fallbackSource: true,
        }];
        log("out", `curation fallback to source ${doc.url ?? doc.contentHash}: teacher units were only ${teacherChars} chars`);
      }
    }
    if (segmentationStats(plan, doc.text).chunks > 1) {
      log("out", `curated full source ${doc.url ?? ""} chunks=${plan.length} coverage=${(stats.coverage * 100).toFixed(1)}%`);
    }
    const newArticleIds = [];
    for (const unit of units) {
      throwIfAborted(signal);
      const text = unit?.text ?? (unit?.prompt ? `${unit.prompt}\n\n${unit.completion ?? ""}`.trim() : null);
      if (!text) continue;
      // In enforce mode, obvious non-prose is still retained for audit but is
      // not immediately queued for the expensive teacher. Shadow mode (the
      // default) keeps the historical review-all behaviour.
      const prefilter = prefilterReview(text, {
        mode: config.review.prefilterMode,
        minChars: config.review.prefilterMinChars,
        minWords: config.review.prefilterMinWords,
      });
      const requestReview = !(config.review.prefilterMode === "enforce" && prefilter.wouldReject);
      const rec = await store.ingestArticle({
        text,
        domain: unit.domain ?? doc.domain ?? "general",
        source: doc.source ?? "harvest",
        model: ollama.model,
        rawText: doc.text,
        // The requested source page (discovery) is authoritative provenance;
        // the fetched URL is the resolved download when a resolver ran.
        sourceUrl: doc.requestedUrl ?? doc.url ?? null,
        fetchedUrl: doc.fetchedUrl ?? doc.url ?? null,
        fetchedContentHash: doc.contentHash ?? null,
        fetchedAt: doc.fetchedAt ?? null,
        htmlLang: doc.htmlLang ?? null,
        extraction: doc.extraction ?? null,
        licenceId: doc.licenceId ?? null,
        licenceUrl: doc.licenceUrl ?? null,
        licenceAttribution: doc.licenceAttribution ?? doc.attribution ?? null,
        reviewRequested: requestReview,
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
    // Record the source as curated only when every chunk succeeded. A partial
    // pass is retried later; content-hash dedup prevents the successful chunks
    // from being ingested twice.
    if (doc.contentHash && chunkErrors === 0) {
      await store.recordRawSource({
        fetchedContentHash: doc.contentHash,
        sourceUrl: doc.requestedUrl ?? doc.url ?? null,
        fetchedUrl: doc.fetchedUrl ?? doc.url ?? null,
        articleIds: newArticleIds,
      });
    } else if (chunkErrors > 0) {
      log("out", `partial curation for ${doc.url ?? doc.contentHash}: ${chunkErrors}/${plan.length} chunk(s) failed; source not marked complete`);
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
  // The AUTHORITATIVE acquisition classification, derived from the frontier +
  // discovery report. This — not a raw-document count — is what decides whether
  // we are out of sources. Collectors that do not participate in the
  // frontier/discovery pipeline (fixtures, injected test harvesters) provide no
  // report at all, so there is genuinely nothing to classify: leave it null and
  // let the supervisor's no-progress guard handle a stalled fixture source.
  const hasAcquisitionReport = Boolean(result.frontier || result.discovery);
  const acquisition = hasAcquisitionReport
    ? classifyAcquisition({
        frontier: result.frontier ?? null,
        discovery: result.discovery ?? null,
        ingested,
      })
    : null;
  // Distinct, non-overlapping conditions:
  //   - sourceExhausted      : the authoritative classifier says EXHAUSTED (no
  //                            claimable work and no viable discovery provider).
  //                            A pass that merely fetched no useful documents
  //                            while claimable work remains is NOT exhaustion.
  //   - admission*Exhausted  : a transient quota/epoch wait (tracked separately;
  //                            never reported as source death).
  //   - noUsefulDocuments    : work is claimable but this pass produced nothing
  //                            usable (e.g. all skipped/deferred) — a transient
  //                            harvest state, not exhaustion.
  const admissionQuotaExhausted = result.quotaExhausted === true;
  const admissionCapExhausted = result.capExhausted === true || admissionQuotaExhausted;
  // A pass that fetched at least one document is never "exhausted" — the source
  // just yielded nothing NEW this cycle, which the no-progress guard handles.
  const sourceExhausted =
    Boolean(acquisition) &&
    acquisition.state === ACQUISITION_STATE.EXHAUSTED &&
    rawDocs === 0 &&
    !admissionCapExhausted &&
    !admissionQuotaExhausted;
  const noUsefulDocuments =
    Boolean(acquisition) && acquisition.state === ACQUISITION_STATE.WORK && rawDocs === 0 && ingested === 0;
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
    // Claimable work exists but this pass produced no usable documents: a
    // transient harvest state, reported separately from source exhaustion.
    noUsefulDocuments,
    // A full admission quota/epoch is a lifecycle wait, never a reason to mark
    // the frontier URL rejected. Rolling quota exhaustion is transient.
    admissionCapExhausted,
    admissionCapDeferred: result.admissionCapDeferred ?? result.admissionDeferred ?? 0,
    admissionCapEpoch: result.capEpoch ?? null,
    admissionQuotaExhausted,
    admissionQuotaDeferred: result.admissionQuotaDeferred ?? result.admissionDeferred ?? 0,
    admissionQuotaUsed: result.quotaUsed ?? null,
    admissionQuotaLimit: result.quotaLimit ?? null,
    admissionQuotaRetryAfterMs: result.quotaRetryAfterMs ?? null,
    admissionQuotaPolicyVersion: result.quotaPolicyVersion ?? null,
    // Recovery-driven progress: what can still become training material without
    // replaying the corpus, and the honest "no eligible unconsumed" signal.
    recovery,
    progress,
    skippedUnchanged,
    languageSkipped,
    archiveResolved: result.archiveResolved ?? 0,
    archiveNonEnglish: result.archiveNonEnglish ?? 0,
    archiveNoFullText: result.archiveNoFullText ?? 0,
    archiveRestricted: result.archiveRestricted ?? 0,
    archiveUnverifiedLanguage: result.archiveUnverifiedLanguage ?? 0,
    archiveResolutionRetries: result.archiveResolutionRetries ?? 0,
    sourceRejections: result.sourceRejections ?? [],
    // Pass the discovery report through so the supervisor can tell an empty
    // queue from a genuinely unconfigured discovery source.
    discovery: result.discovery ?? null,
    // The persistent frontier's state, and the authoritative acquisition
    // classification derived from it — the single source of truth the supervisor
    // and UI use to decide "work / wait / exhausted".
    frontier: result.frontier ?? null,
    acquisition,
  };
}
