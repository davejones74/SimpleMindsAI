#!/usr/bin/env node
/**
 * Historical replay-eligibility migration/classification.
 *
 * Default is DRY RUN. It reads the article store read-only, classifies RETIRED
 * records using review history, text integrity, deterministic quality gates and
 * a conservative source-licence policy, and writes a machine-readable report.
 *
 * `--apply` is intentionally refused against production paths. It may only be
 * used against an isolated pilot store after review of the dry-run report.
 *
 * This script never deletes text, reviews, consumption records or events.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ArticleStore } from "../../src/storage/article-store.js";
import { AUTHORITY, STATUS, contentHash, isReplayPool } from "../../src/domain/article.js";
import { preScreen } from "../../src/domain/review-gates.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = path.join(ROOT, "scripts", "knowledge-pilot", "replay-licence-policy.json");
const PRODUCTION_PREFIXES = ["/var/lib/simpleminds", "/opt/simpleminds"];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const tokenEstimate = (text) => Math.ceil(String(text ?? "").length / 4);

function parseArgs(argv) {
  const opts = {
    store: process.env.ARTICLE_DIR ?? path.resolve("data/articles"),
    apply: false,
    confirm: false,
    out: null,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--store") opts.store = argv[++i];
    else if (arg.startsWith("--store=")) opts.store = arg.slice("--store=".length);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--limit") opts.limit = Number(argv[++i]) || 0;
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--confirm") opts.confirm = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/knowledge-pilot/classify-replay.mjs --store <article-dir> [--out report.json] [--limit n] [--apply --confirm]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function hostOf(article) {
  if (article.sourceDomain) return String(article.sourceDomain).toLowerCase();
  try {
    return new URL(article.sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchesDomain(host, domains) {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function licenceFor(article, policy) {
  const host = hostOf(article);
  if (!host) return { status: "unknown", host, reason: "missing source host" };
  if (matchesDomain(host, policy.safeDomains)) return { status: "safe", host, reason: "source family is on the conservative safe list" };
  if (matchesDomain(host, policy.uncertainDomains)) return { status: "uncertain", host, reason: "source family requires item-level licence review" };
  return { status: "unknown", host, reason: "source family is not in the pilot licence policy" };
}

function lastDecisiveReview(reviews) {
  const sorted = [...reviews].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].verdict === "approve" || sorted[i].verdict === "reject") return sorted[i];
  }
  return null;
}

function integrity(article) {
  if (typeof article.text !== "string" || !article.text.trim()) {
    return { ok: false, reason: "missing-text" };
  }
  if (article.contentHash && contentHash(article.text) !== article.contentHash) {
    return { ok: false, reason: "content-hash-mismatch" };
  }
  return { ok: true, reason: null };
}

function quality(article) {
  const gate = preScreen(article.text, {
    sourceUrl: article.sourceUrl ?? null,
    htmlLang: article.htmlLang ?? null,
    languageFilter: { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" },
    quality: { enabled: true, minBigramRatio: 0.15, maxMojibakeRatio: 0.02 },
    completeness: { mode: "enforce" },
  });
  return gate;
}

function classify(article, reviews, policy) {
  const consumed = Boolean(article.consumedAt) || (Array.isArray(article.consumption) && article.consumption.length > 0);
  const base = {
    articleId: article.articleId,
    status: article.status,
    consumed,
    replayEligible: isReplayPool(article),
    sourceUrl: article.sourceUrl ?? null,
    sourceDomain: hostOf(article),
    contentHash: article.contentHash ?? null,
    estimatedTokens: tokenEstimate(article.text),
  };

  if (isReplayPool(article)) {
    return { ...base, classification: "ALREADY_ELIGIBLE", reason: "already in replay pool", reasonCode: "already-eligible" };
  }
  if (article.status === STATUS.REJECTED) return { ...base, classification: "INELIGIBLE", reason: "explicitly rejected", reasonCode: "explicit-rejected" };
  if (article.status === STATUS.QUARANTINED || article.quarantined === true) return { ...base, classification: "INELIGIBLE", reason: "quarantined", reasonCode: "quarantined" };
  if (article.excludedReason) return { ...base, classification: "INELIGIBLE", reason: `excluded: ${article.excludedReason}`, reasonCode: `excluded-${article.excludedReason}` };
  if (article.status !== STATUS.RETIRED) return { ...base, classification: "NOT_TARGET", reason: `status ${article.status}`, reasonCode: "not-retired" };

  const text = integrity(article);
  if (!text.ok) return { ...base, classification: "INELIGIBLE", reason: text.reason, reasonCode: text.reason };

  const decisive = lastDecisiveReview(reviews);
  if (!decisive) return { ...base, classification: "UNRESOLVED", reason: "no decisive review history", reasonCode: "no-decisive-review" };
  if (decisive.verdict === "reject") return { ...base, classification: "INELIGIBLE", reason: "last decisive review is reject", reasonCode: "last-review-reject" };

  const gate = quality(article);
  if (gate.decision === "reject") {
    return { ...base, classification: "INELIGIBLE", reason: `quality/language gate: ${gate.reason}`, reasonCode: `gate-${gate.gate ?? "quality"}` };
  }

  const licence = licenceFor(article, policy);
  if (licence.status === "uncertain" || licence.status === "unknown") {
    return { ...base, classification: "UNRESOLVED", reason: `licence ${licence.status}: ${licence.reason}`, reasonCode: `licence-${licence.status}`, licence };
  }
  if (licence.status !== "safe") {
    return { ...base, classification: "INELIGIBLE", reason: `licence ${licence.status}: ${licence.reason}`, reasonCode: `licence-${licence.status}`, licence };
  }

  return {
    ...base,
    classification: "ELIGIBLE",
    reasonCode: "eligible",
    reason: "approved review, valid text, quality/language pass, safe licence family",
    licence,
    reviewAt: decisive.at ?? null,
    reviewScore: decisive.score ?? null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.apply) {
    if (!opts.confirm) throw new Error("--apply requires --confirm");
    if (PRODUCTION_PREFIXES.some((prefix) => path.resolve(opts.store).startsWith(prefix))) {
      throw new Error(`refusing --apply against a production path: ${opts.store}`);
    }
  }
  const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  const policyHash = sha256(JSON.stringify(policy));
  const store = await ArticleStore.open(opts.store, { readOnly: !opts.apply });
  const results = [];
  let after = null;
  let scanned = 0;
  try {
    for (;;) {
      const page = store.articlesPage({ after, limit: 200 });
      if (!page.items.length) break;
      for (const article of page.items) {
        if (opts.limit > 0 && scanned >= opts.limit) break;
        scanned += 1;
        const reviews = store.reviewsFor(article.articleId);
        results.push(classify(article, reviews, policy));
      }
      after = page.nextCursor;
      if (!after || (opts.limit > 0 && scanned >= opts.limit)) break;
    }

    const byClass = results.reduce((acc, row) => {
      acc[row.classification] = (acc[row.classification] ?? 0) + 1;
      return acc;
    }, {});
    const aggregate = (rows, key) => rows.reduce((acc, row) => {
      const value = row[key] ?? "unknown";
      const entry = acc[value] ?? { count: 0, estimatedTokens: 0 };
      entry.count += 1;
      entry.estimatedTokens += row.estimatedTokens ?? 0;
      acc[value] = entry;
      return acc;
    }, {});
    const byReasonCode = aggregate(results, "reasonCode");
    const bySourceDomain = aggregate(results, "sourceDomain");
    const unresolvedByReasonCode = aggregate(results.filter((row) => row.classification === "UNRESOLVED"), "reasonCode");
    const unresolvedBySourceDomain = aggregate(results.filter((row) => row.classification === "UNRESOLVED"), "sourceDomain");
    const eligible = results.filter((row) => row.classification === "ELIGIBLE");
    const unresolved = results.filter((row) => row.classification === "UNRESOLVED");
    const ineligible = results.filter((row) => row.classification === "INELIGIBLE");
    const applied = [];
    if (opts.apply) {
      for (const row of eligible) {
        const out = await store.setReplayEligibility(row.articleId, {
          eligible: true,
          reason: `migration: ${row.reason}`,
          actor: AUTHORITY.AUTOMATION,
        });
        applied.push({ articleId: row.articleId, updated: out.updated === true });
      }
    }
    const report = {
      schema: "sma/replay-migration-report@1",
      at: new Date().toISOString(),
      mode: opts.apply ? "apply" : "dry-run",
      store: opts.store,
      policyPath: POLICY_PATH,
      policySha256: policyHash,
      scanned,
      counts: byClass,
      targetRetired: results.filter((row) => row.classification !== "NOT_TARGET" && row.classification !== "ALREADY_ELIGIBLE").length,
      eligibleCount: eligible.length,
      eligibleEstimatedTokens: eligible.reduce((sum, row) => sum + row.estimatedTokens, 0),
      unresolvedCount: unresolved.length,
      unresolvedEstimatedTokens: unresolved.reduce((sum, row) => sum + row.estimatedTokens, 0),
      ineligibleCount: ineligible.length,
      ineligibleEstimatedTokens: ineligible.reduce((sum, row) => sum + row.estimatedTokens, 0),
      restoredInApply: applied.filter((row) => row.updated).length,
      alreadyEligible: results.filter((row) => row.classification === "ALREADY_ELIGIBLE").length,
      byReasonCode,
      bySourceDomain,
      unresolvedByReasonCode,
      unresolvedBySourceDomain,
      samples: {
        eligible: eligible.slice(0, 50),
        unresolved: unresolved.slice(0, 50),
        ineligible: ineligible.slice(0, 50),
      },
      applied: applied.slice(0, 100),
      note: "Token counts are character/4 estimates for planning. No article text is included in this report.",
    };
    const bytes = JSON.stringify(report, null, 2) + "\n";
    if (opts.out) await writeFile(opts.out, bytes, "utf8");
    else process.stdout.write(bytes);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
