import { collectDocuments } from "../harness/crawler.js";
import { throwIfAborted } from "./cancel.js";

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
  const result = await collect(ctx.crawl ?? {});
  const rawDocs = result.documents?.length ?? 0;
  log("out", `harvest mode=${result.mode} capability=${result.capability} documents=${rawDocs} failures=${result.failures?.length ?? 0}`);

  const cap = ctx.maxRawDocs > 0 ? Math.min(rawDocs, ctx.maxRawDocs) : rawDocs;
  let ingested = 0;
  let deduped = 0;

  onPhase("curate");
  for (let i = 0; i < cap; i++) {
    throwIfAborted(signal);
    const doc = result.documents[i];
    let units;
    try {
      units = await ollama.clean(doc.text);
    } catch (err) {
      log("err", `curate failed for doc ${i + 1}: ${err.message.slice(0, 160)}`);
      continue;
    }
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
        // An operator asking this job for N *trainable* articles is explicitly
        // requesting that what it acquires enters review. Without this the
        // `selectionDecision` sampling gate (~10%) decides instead, so a small
        // acquisition is silently dropped and the job reports `trainable: 0`
        // even though it ingested everything it fetched. The critic still
        // decides every verdict — review entry is not approval.
        reviewRequested: true,
      });
      if (rec.deduped) deduped++;
      else ingested++;
    }
    onProgress({ phase: "curate", processedRawDocs: i + 1, rawDocs: cap, ingested, deduped });
  }

  onPhase("review");
  await store.selectForReview({ limit: 1000 });
  const { items } = store.reviewQueue({ limit: 1000 });
  let reviewed = 0;
  for (const article of items) {
    throwIfAborted(signal);
    const r = await scorer.scoreOffline({ text: article.text, domain: article.domain });
    await store.recordReview({
      articleId: article.articleId,
      verdict: r.verdict,
      score: r.score,
      rationale: r.rationale,
      authority: "teacher",
      reviewerModel: r.criticModel,
      reviewerVersion: r.criticVersion,
      rubricVersion: r.rubricVersion,
      guardrailResult: r.guardrailResult,
      suggestedImportance: r.suggestedImportance,
      criticTemperature: r.criticTemperature,
      criticPromptVersion: r.criticPromptVersion,
      criticScoreMissing: r.criticScoreMissing,
      criticError: r.criticError,
    });
    reviewed++;
    onProgress({ phase: "review", reviewed });
  }

  const stats = store.getStats();
  // Exhaustion is detected, never assumed: a pass that ingests nothing (all
  // deduped, no documents, or every fetch failed) has no more material to give.
  const sourceExhausted = ingested === 0 && (rawDocs === 0 || deduped > 0 || (result.failures?.length ?? 0) > 0);
  // The fixture "source" is a hard-coded document set, so its ceiling is known
  // up front. Surfacing it lets the operator see that a multi-article target is
  // unreachable on fixtures instead of reading "completed" as "acquired".
  const corpusCeiling = result.mode === "fixture" && rawDocs > 0 ? rawDocs : null;
  return {
    mode: result.mode,
    capability: result.capability,
    rawDocs,
    processedRawDocs: cap,
    ingested,
    deduped,
    reviewed,
    trainable: stats.trainable,
    corpusCeiling,
    failures: result.failures ?? [],
    sourceExhausted,
  };
}
