import { STATUS, contentHash, isReplayPool } from "../domain/article.js";
import { LICENCE_STATUS, resolveLicence } from "../domain/licence.js";
import { assessCompleteness, preScreen } from "../domain/review-gates.js";

/**
 * Classification for legacy approved/consumed records that were retired before
 * replay eligibility was independent of review status. Pure and read-only: the
 * caller supplies the article and its review history, and receives a decision
 * that explains exactly why recovery is or is not safe.
 */
export const RETIRED_REPLAY_CLASS = Object.freeze({
  ALREADY_ELIGIBLE: "ALREADY_ELIGIBLE",
  RECOVERABLE_SAFE: "RECOVERABLE_SAFE",
  RECOVERABLE_SAFE_SHORT: "RECOVERABLE_SAFE_SHORT",
  BLOCKED_LICENCE_UNCERTAIN: "BLOCKED_LICENCE_UNCERTAIN",
  BLOCKED_LICENCE_UNKNOWN: "BLOCKED_LICENCE_UNKNOWN",
  BLOCKED_LICENCE_RESTRICTED: "BLOCKED_LICENCE_RESTRICTED",
  BLOCKED_QUALITY: "BLOCKED_QUALITY",
  BLOCKED_INTEGRITY: "BLOCKED_INTEGRITY",
  BLOCKED_NO_APPROVAL: "BLOCKED_NO_APPROVAL",
  NOT_CONSUMED_RETIRED: "NOT_CONSUMED_RETIRED",
});

export function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text ?? "").length / 4));
}

export function lastDecisiveReview(reviews = []) {
  const sorted = [...reviews].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].verdict === "approve" || sorted[i].verdict === "reject") return sorted[i];
  }
  return null;
}

export function integrity(article) {
  if (typeof article.text !== "string" || !article.text.trim()) return { ok: false, reason: "missing-text" };
  if (article.contentHash && contentHash(article.text) !== article.contentHash) return { ok: false, reason: "content-hash-mismatch" };
  return { ok: true, reason: null };
}

export function qualityGate(article) {
  return preScreen(article.text, {
    sourceUrl: article.sourceUrl ?? null,
    htmlLang: article.htmlLang ?? null,
    languageFilter: { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" },
    quality: { enabled: true, minBigramRatio: 0.15, maxMojibakeRatio: 0.02 },
    completeness: { mode: "enforce" },
  });
}

export function classifyRetiredArticle(article, reviews = []) {
  const consumed = Boolean(article.consumedAt) || (Array.isArray(article.consumption) && article.consumption.length > 0);
  const licence = article.licence ?? resolveLicence({ sourceUrl: article.sourceUrl ?? null, sourceDomain: article.sourceDomain ?? null });
  const base = {
    articleId: article.articleId,
    status: article.status,
    consumed,
    sourceUrl: article.sourceUrl ?? null,
    sourceDomain: article.sourceDomain ?? null,
    contentHash: article.contentHash ?? null,
    estimatedTokens: estimateTokens(article.text),
    licence: { id: licence.id, status: licence.status, decision: licence.decision, policyVersion: licence.policyVersion },
    licenceStatus: licence.status,
    licenceDecision: licence.decision,
  };

  if (isReplayPool(article)) return { ...base, classification: RETIRED_REPLAY_CLASS.ALREADY_ELIGIBLE, reason: "already in replay pool" };
  if (article.status !== STATUS.RETIRED) return { ...base, classification: RETIRED_REPLAY_CLASS.NOT_CONSUMED_RETIRED, reason: `status ${article.status}` };
  if (!consumed) return { ...base, classification: RETIRED_REPLAY_CLASS.NOT_CONSUMED_RETIRED, reason: "retired but never consumed" };

  const intact = integrity(article);
  if (!intact.ok) return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_INTEGRITY, reason: intact.reason };

  const decisive = lastDecisiveReview(reviews);
  if (!decisive) return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_NO_APPROVAL, reason: "no decisive review" };
  if (decisive.verdict !== "approve") return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_NO_APPROVAL, reason: "last decisive review is not approve" };

  const gate = qualityGate(article);
  if (gate.decision === "reject") {
    // A safe-licence record rejected ONLY by the completeness heuristic, and
    // only as "quarantine" (short but substantive prose, not a title/nav/citation
    // hard reject), is a policy candidate for replay — not an automatic grant.
    const completeness = assessCompleteness(article.text);
    if (licence.status === LICENCE_STATUS.SAFE && gate.gate === "completeness" && completeness.decision === "quarantine") {
      return {
        ...base,
        classification: RETIRED_REPLAY_CLASS.RECOVERABLE_SAFE_SHORT,
        reason: "safe licence, approved, intact, language/quality pass; short prose requires a replay policy decision",
        completenessDecision: completeness.decision,
        gate: gate.gate ?? null,
      };
    }
    return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_QUALITY, reason: `quality/language gate: ${gate.reason}`, gate: gate.gate ?? null, completenessDecision: completeness.decision };
  }

  if (licence.status === LICENCE_STATUS.RESTRICTED) {
    return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_LICENCE_RESTRICTED, reason: licence.reason };
  }
  if (licence.status === LICENCE_STATUS.UNCERTAIN) {
    return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_LICENCE_UNCERTAIN, reason: licence.reason };
  }
  if (licence.status !== LICENCE_STATUS.SAFE) {
    return { ...base, classification: RETIRED_REPLAY_CLASS.BLOCKED_LICENCE_UNKNOWN, reason: licence.reason };
  }

  return {
    ...base,
    classification: RETIRED_REPLAY_CLASS.RECOVERABLE_SAFE,
    reason: "approved, consumed, intact, quality-pass, safe licence",
    reviewAt: decisive.at ?? null,
    reviewScore: decisive.score ?? null,
  };
}

export function aggregateClassifications(rows = [], key = "classification") {
  const out = {};
  for (const row of rows) {
    const value = row[key] ?? "unknown";
    const entry = out[value] ?? { count: 0, estimatedTokens: 0 };
    entry.count += 1;
    entry.estimatedTokens += row.estimatedTokens ?? 0;
    out[value] = entry;
  }
  return out;
}
