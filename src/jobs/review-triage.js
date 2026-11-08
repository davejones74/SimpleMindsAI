import { config } from "../config.js";
import { preScreen } from "../domain/review-gates.js";
import { AUTHORITY } from "../domain/article.js";

/**
 * Deterministic backlog triage.
 *
 * This is not a teacher. It applies the SAME review-time gates used by the
 * normal review pass and records an auditable automation rejection for text that
 * is clearly not article prose (reference lists, navigation shells, list/table
 * fragments, tiny citations, corruption, or confidently non-English text). It
 * never approves anything.
 */
export async function triagePendingArticles(store, {
  limit = 0,
  dryRun = false,
  log = () => {},
  config: cfg = config,
} = {}) {
  const review = cfg.review ?? {};
  const pageSize = 200;
  const counts = {
    examined: 0,
    rejected: 0,
    kept: 0,
    byGate: {},
    dryRun: Boolean(dryRun),
  };
  let after = null;
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.POSITIVE_INFINITY;

  for (;;) {
    if (counts.examined >= max) break;
    const { items, nextCursor } = store.reviewQueue({ after, limit: pageSize });
    if (!items.length) break;
    for (const article of items) {
      if (counts.examined >= max) break;
      counts.examined++;
      const gate = preScreen(article.text, {
        sourceUrl: article.sourceUrl ?? null,
        htmlLang: article.htmlLang ?? null,
        languageFilter: review.gateLanguage === false ? null : cfg.languageFilter ?? null,
        quality: {
          enabled: review.gateQuality !== false,
          minBigramRatio: review.qualityMinBigramRatio,
          maxMojibakeRatio: review.qualityMaxMojibakeRatio,
        },
        completeness: { mode: review.completenessMode ?? "shadow" },
        pageChrome: { enabled: review.gatePageChrome !== false },
        content: {
          enabled: review.gateContent !== false,
          minWords: review.contentMinWords,
          referenceLineRatio: review.contentReferenceLineRatio,
          listLineRatio: review.contentListLineRatio,
          navDensity: review.contentNavDensity,
        },
      });
      if (gate.decision !== "reject") {
        counts.kept++;
        continue;
      }
      counts.rejected++;
      counts.byGate[gate.gate ?? "unknown"] = (counts.byGate[gate.gate ?? "unknown"] ?? 0) + 1;
      log("out", `triage ${article.articleId} -> reject (${gate.gate}: ${gate.reason})`);
      if (dryRun) continue;
      await store.recordReview({
        articleId: article.articleId,
        verdict: "reject",
        score: 0,
        rationale: gate.reason,
        authority: AUTHORITY.AUTOMATION,
        gate: gate.gate,
        reason: gate.reason,
        completeness: gate.completeness ?? gate.metrics ?? null,
      });
    }
    if (!nextCursor || nextCursor === after) break;
    after = nextCursor;
  }
  return counts;
}
