import { createHash } from "node:crypto";
import { buildContentClusters, DEDUP_POLICY_VERSION } from "./dedup.js";

/**
 * Deterministic document/source-disjoint partition.
 *
 * Identity is never conflated:
 *   articleId      — one row in the snapshot (a curated chunk)
 *   contentCluster — exact/normalised/near-duplicate content
 *   sourceId       — the original fetched source (fetchedContentHash or canonical URL)
 *   publisherId    — the host/domain; used for diversity reporting, never for dedup
 *   familyId       — known syndication/translation family supplied by the caller
 *
 * All members of a content/source/family cluster are assigned together. Two
 * unrelated articles from the same publisher are NOT clustered merely because
 * they share a publisher.
 */
export const SPLIT_POLICY_VERSION = "document-source-disjoint-v1";
export const CLUSTER_POLICY_VERSION = DEDUP_POLICY_VERSION;

export class InsufficientValidationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "InsufficientValidationError";
    this.code = "INSUFFICIENT_VALIDATION";
    Object.assign(this, detail);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSourceUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = "";
    const drop = [];
    for (const key of url.searchParams.keys()) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) drop.push(key);
    }
    for (const key of drop) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname) pathname = "/";
    return `${url.protocol}//${url.hostname}${pathname}${url.search}`;
  } catch {
    return raw.toLowerCase();
  }
}

export function publisherFromUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function articleIdentity(row, index = 0) {
  const articleId = String(row?.articleId ?? `row-${index}`);
  const sourceUrl = row?.sourceUrl ?? null;
  const sourceId = row?.sourceId
    ?? row?.fetchedContentHash
    ?? normalizeSourceUrl(sourceUrl)
    ?? articleId;
  const publisherId = row?.publisherId
    ?? row?.sourceDomain
    ?? publisherFromUrl(sourceUrl)
    ?? "unknown";
  return {
    articleId,
    contentHash: row?.contentHash ?? null,
    familyId: row?.familyId ?? null,
    sourceId,
    publisherId,
    sourceUrl,
  };
}

function estimateTokens(row) {
  if (Number.isFinite(Number(row?.estimatedTokens))) return Number(row.estimatedTokens);
  return Math.max(1, Math.ceil(String(row?.text ?? "").length / 4));
}

function bucketFor(seed, clusterId) {
  return sha256(`${seed}:${clusterId}`);
}

/**
 * Build a deterministic partition.
 *
 * @param {object} options
 * @param {Array<object>} options.rows snapshot rows
 * @param {number} options.splitSeed
 * @param {number} options.validationFraction
 * @param {number} options.validationTargetTokens 0 => fraction-derived
 * @param {number} options.minValidationTokens
 * @param {number} options.minValidationClusters
 * @param {Set<string>} options.historicalArticleIds
 * @param {Set<string>} options.historicalSourceIds
 * @param {boolean} options.requireProspective
 * @param {boolean} options.allowHistoricalValidation
 */
export function buildPartition({
  rows,
  splitSeed = 0,
  validationFraction = 0.05,
  validationTargetTokens = 0,
  minValidationTokens = 1,
  minValidationClusters = 1,
  historicalArticleIds = new Set(),
  historicalSourceIds = new Set(),
  requireProspective = false,
  allowHistoricalValidation = true,
  maxValidationFraction = 0.5,
  dedupOptions = {},
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new InsufficientValidationError("cannot partition an empty corpus", { requested: "validation" });
  }

  const items = rows.map((row, index) => {
    const identity = articleIdentity(row, index);
    return {
      ...identity,
      text: String(row.text ?? ""),
      estimatedTokens: estimateTokens(row),
      row,
    };
  });
  const clustering = buildContentClusters(items, dedupOptions);

  const membersByCluster = new Map();
  for (const item of items) {
    const clusterId = clustering.clusterByArticle.get(item.articleId);
    const list = membersByCluster.get(clusterId) ?? [];
    list.push(item);
    membersByCluster.set(clusterId, list);
  }

  const totalTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const requestedTarget = Number(validationTargetTokens) > 0
    ? Number(validationTargetTokens)
    : Math.ceil(totalTokens * Math.max(0, Math.min(1, Number(validationFraction) || 0)));
  const maxTarget = Math.max(0, Math.floor(totalTokens * Math.max(0, Math.min(1, maxValidationFraction))));
  // A target larger than the corpus can support is not a reason to take half the
  // corpus. Keep the minimum cohort; the trainer's block minimum is the hard
  // check. This also makes small fixtures deterministic.
  const target = requestedTarget > maxTarget
    ? Math.min(Math.max(Number(minValidationTokens) || 0, 0), maxTarget)
    : Math.min(Math.max(requestedTarget, Number(minValidationTokens) || 0), maxTarget);

  const clusterRecords = [...membersByCluster.entries()].map(([clusterId, members]) => {
    const historicalMembers = members.filter(
      (member) => historicalArticleIds.has(member.articleId) || historicalSourceIds.has(member.sourceId),
    );
    const prospective = historicalMembers.length === 0;
    const sourceIds = [...new Set(members.map((member) => member.sourceId))].sort();
    return {
      clusterId,
      members,
      tokens: members.reduce((sum, member) => sum + member.estimatedTokens, 0),
      sourceIds,
      publishers: [...new Set(members.map((member) => member.publisherId))].sort(),
      prospective,
      historicalMemberCount: historicalMembers.length,
      bucket: bucketFor(splitSeed, clusterId),
    };
  });

  const ordered = [...clusterRecords].sort((a, b) => {
    if (a.prospective !== b.prospective) return a.prospective ? -1 : 1;
    return a.bucket.localeCompare(b.bucket) || a.clusterId.localeCompare(b.clusterId);
  });

  const eligible = requireProspective ? ordered.filter((cluster) => cluster.prospective) : ordered;
  if (!eligible.length) {
    throw new InsufficientValidationError(
      "no prospective validation clusters are available; historical exposure cannot be reversed",
      { requested: "validation", requireProspective: true, totalClusters: clusterRecords.length },
    );
  }

  const selected = [];
  let selectedTokens = 0;
  for (const cluster of eligible) {
    if (selected.length > 0 && selectedTokens >= target && selected.length >= minValidationClusters) break;
    if (!cluster.prospective && !allowHistoricalValidation) continue;
    selected.push(cluster);
    selectedTokens += cluster.tokens;
  }

  if (selected.length < minValidationClusters || selectedTokens < minValidationTokens) {
    throw new InsufficientValidationError(
      `insufficient validation material: ${selected.length} cluster(s), ${selectedTokens} estimated token(s); ` +
        `need ${minValidationClusters} cluster(s) and ${minValidationTokens} token(s)`,
      {
        requested: "validation",
        selectedClusters: selected.length,
        selectedTokens,
        minValidationClusters,
        minValidationTokens,
        totalClusters: clusterRecords.length,
        totalTokens,
      },
    );
  }

  const validationClusterIds = new Set(selected.map((cluster) => cluster.clusterId));
  const assignments = items
    .map((item) => {
      const cluster = clusterRecords.find((record) => record.clusterId === clustering.clusterByArticle.get(item.articleId));
      const partition = validationClusterIds.has(cluster.clusterId) ? "validation" : "train";
      return {
        articleId: item.articleId,
        clusterId: cluster.clusterId,
        sourceId: item.sourceId,
        publisherId: item.publisherId,
        familyId: item.familyId,
        partition,
        estimatedTokens: item.estimatedTokens,
        historicalExposure: !cluster.prospective,
      };
    })
    .sort((a, b) => a.articleId.localeCompare(b.articleId));

  const validation = assignments.filter((row) => row.partition === "validation");
  const train = assignments.filter((row) => row.partition === "train");
  if (!train.length) {
    const err = new InsufficientValidationError("partition would leave no training clusters", {
      requested: "training",
      validationClusters: selected.length,
    });
    // Too little material to form both sides is an INSUFFICIENT_CORPUS wait
    // condition, not a validation-policy failure.
    err.code = "INSUFFICIENT_CORPUS";
    throw err;
  }

  const exposure = {
    coverage: "snapshots-roles-consumption-contributions",
    prospectiveClusters: clusterRecords.filter((cluster) => cluster.prospective).length,
    historicalClusters: clusterRecords.filter((cluster) => !cluster.prospective).length,
    validationProspectiveArticles: validation.filter((row) => !row.historicalExposure).length,
    validationHistoricalArticles: validation.filter((row) => row.historicalExposure).length,
    trainProspectiveArticles: train.filter((row) => !row.historicalExposure).length,
    trainHistoricalArticles: train.filter((row) => row.historicalExposure).length,
    validationExposureMode: validation.every((row) => !row.historicalExposure)
      ? "prospective-only"
      : validation.every((row) => row.historicalExposure)
        ? "historical-only"
        : "mixed",
    uncertainty: "Historical coverage is reconstructed from recorded snapshots, roles and contribution records; absent records are reported, not assumed absent.",
  };

  const splitPayload = {
    policyVersion: SPLIT_POLICY_VERSION,
    clusterPolicyVersion: CLUSTER_POLICY_VERSION,
    seed: Number(splitSeed) || 0,
    assignments: assignments.map((row) => [row.articleId, row.clusterId, row.partition]),
  };
  const splitHash = sha256(stable(splitPayload));

  return {
    policyVersion: SPLIT_POLICY_VERSION,
    clusterPolicyVersion: CLUSTER_POLICY_VERSION,
    splitSeed: Number(splitSeed) || 0,
    targetTokens: target,
    requestedTargetTokens: requestedTarget,
    splitHash,
    assignments,
    assignmentByArticle: new Map(assignments.map((row) => [row.articleId, row])),
    validationArticleIds: validation.map((row) => row.articleId),
    trainArticleIds: train.map((row) => row.articleId),
    validationClusterIds: [...validationClusterIds].sort(),
    trainClusterIds: clusterRecords
      .filter((cluster) => !validationClusterIds.has(cluster.clusterId))
      .map((cluster) => cluster.clusterId)
      .sort(),
    clusters: clusterRecords.map((cluster) => ({
      clusterId: cluster.clusterId,
      articleIds: cluster.members.map((member) => member.articleId).sort(),
      sourceIds: cluster.sourceIds,
      publishers: cluster.publishers,
      tokens: cluster.tokens,
      prospective: cluster.prospective,
      partition: validationClusterIds.has(cluster.clusterId) ? "validation" : "train",
    })),
    nearDuplicatePairs: clustering.pairs,
    exposure,
    stats: {
      totalDocuments: items.length,
      totalClusters: clusterRecords.length,
      totalEstimatedTokens: totalTokens,
      trainDocuments: train.length,
      validationDocuments: validation.length,
      trainEstimatedTokens: totalTokens - selectedTokens,
      validationEstimatedTokens: selectedTokens,
      splitHash,
    },
  };
}
