#!/usr/bin/env node
/**
 * Build, validate and report the versioned source-expansion inventory.
 *
 * Read-only with respect to production data. This script does not fetch,
 * crawl, acquire, train, or write to any ArticleStore/RegistryStore.
 *
 * Usage:
 *   node scripts/build-source-inventory.mjs
 *   node scripts/build-source-inventory.mjs --check
 *   node scripts/build-source-inventory.mjs --json
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { meta, baseline, compositionPolicy, exclusions, uncertainties } from "../inventory/source-expansion-v2/data/meta.mjs";
import { licences } from "../inventory/source-expansion-v2/data/licences.mjs";
import { sources as unrestrictedA } from "../inventory/source-expansion-v2/data/sources-unrestricted-a.mjs";
import { sources as unrestrictedB } from "../inventory/source-expansion-v2/data/sources-unrestricted-b.mjs";
import { sources as otherSources } from "../inventory/source-expansion-v2/data/sources-other.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INVENTORY_DIR = path.join(ROOT, "inventory", "source-expansion-v2");
export const SPECS_PATH = path.join(INVENTORY_DIR, "source-specs.json");
export const INVENTORY_PATH = path.join(INVENTORY_DIR, "source-inventory.json");
export const METRICS_PATH = path.join(INVENTORY_DIR, "derived-metrics.json");
export const POLICY_PATH = path.join(INVENTORY_DIR, "composition-policy.json");
export const LICENCES_PATH = path.join(INVENTORY_DIR, "licence-register.json");
export const EXCLUSIONS_PATH = path.join(INVENTORY_DIR, "exclusions.json");
export const CANDIDATE_URLS_PATH = path.join(INVENTORY_DIR, "candidate-urls.json");
export const REPORT_PATH = path.join(INVENTORY_DIR, "summary-report.md");
export const MANIFEST_PATH = path.join(INVENTORY_DIR, "manifest.json");
export const README_PATH = path.join(INVENTORY_DIR, "README.md");
export const BUILD_SCRIPT_PATH = path.join(ROOT, "scripts", "build-source-inventory.mjs");
export const TEST_PATH = path.join(ROOT, "test", "source-inventory.test.js");

const SUBJECT_KEYS = [
  "mathematics-formal-sciences",
  "physics-chemistry-biology",
  "computer-science-software",
  "engineering-applied-sciences",
  "medicine-public-health",
  "history-historical-reference",
  "humanities-philosophy-literature",
  "geography-earth-environmental",
  "economics-social-political",
  "general-reference-education",
];

const ALLOWED_STATUS = new Set(["approved", "approved-share-alike", "restricted"]);
const ALLOWED_POOLS = new Set(["unrestricted", "share-alike", "non-commercial"]);
const ALLOWED_FORMATS = new Set(["book", "article", "report", "web", "documentation", "reference", "encyclopedia", "textbook", "courseware"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const num = (value) => Number(value ?? 0);
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));

function currentSources() {
  return [...unrestrictedA, ...unrestrictedB, ...otherSources];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function licenceById(id) {
  const licence = licences[id];
  if (!licence) throw new Error(`Unknown licenceId: ${id}`);
  return licence;
}

function requireString(errors, value, field, sourceId) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${sourceId}: missing ${field}`);
}

export function validateSources(sources) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const families = new Set();
  for (const source of sources) {
    const sid = source.sourceId || "<missing-id>";
    if (ids.has(source.sourceId)) errors.push(`${sid}: duplicate sourceId`);
    ids.add(source.sourceId);
    if (families.has(source.sourceFamilyId)) errors.push(`${sid}: duplicate sourceFamilyId ${source.sourceFamilyId}`);
    families.add(source.sourceFamilyId);
    requireString(errors, source.publisherId, "publisherId", sid);
    requireString(errors, source.publisherGroupId, "publisherGroupId", sid);
    requireString(errors, source.sourceFamilyId, "sourceFamilyId", sid);
    requireString(errors, source.title, "title", sid);
    requireString(errors, source.description, "description", sid);
    if (!ALLOWED_STATUS.has(source.status)) errors.push(`${sid}: invalid status ${source.status}`);
    if (!ALLOWED_POOLS.has(source.pool)) errors.push(`${sid}: invalid pool ${source.pool}`);
    if (!ALLOWED_FORMATS.has(source.format)) errors.push(`${sid}: invalid format ${source.format}`);
    const licence = licences[source.licenceId];
    if (!licence) {
      errors.push(`${sid}: unknown licenceId ${source.licenceId}`);
    } else {
      for (const key of ["name", "version", "spdx", "url", "commercialUse", "attribution"]) {
        if (typeof licence[key] !== "string" || !licence[key].trim()) errors.push(`${sid}: licence missing ${key}`);
      }
      for (const key of ["shareAlike", "nonCommercial", "noDerivatives"]) {
        if (typeof licence[key] !== "boolean") errors.push(`${sid}: licence missing boolean ${key}`);
      }
      if (!Array.isArray(licence.conditions) || licence.conditions.length === 0) errors.push(`${sid}: licence missing conditions`);
      if (typeof licence.legalReview !== "string" || !licence.legalReview.trim()) errors.push(`${sid}: licence missing legalReview`);
    }
    const estimates = source.estimates;
    if (!estimates) {
      errors.push(`${sid}: missing estimates`);
      continue;
    }
    for (const key of ["capacityDocuments", "plannedDocuments", "tokensPerDocument"]) {
      if (!Number.isFinite(num(estimates[key])) || num(estimates[key]) < 0) errors.push(`${sid}: invalid ${key}`);
    }
    if (num(estimates.capacityDocuments) < num(estimates.plannedDocuments)) errors.push(`${sid}: capacityDocuments < plannedDocuments`);
    if (!(num(estimates.tokensPerDocument) > 0)) errors.push(`${sid}: tokensPerDocument must be > 0`);
    for (const key of ["fetchSuccess", "qualityAcceptance", "dedupRemoval", "v1Overlap", "crossSourceOverlap", "estimateUncertainty"]) {
      const value = num(estimates[key]);
      if (!(value >= 0 && value <= 1)) errors.push(`${sid}: ${key} must be in [0,1]`);
    }
    const shares = source.subjectShares || {};
    const shareKeys = Object.keys(shares);
    if (shareKeys.length === 0) errors.push(`${sid}: missing subjectShares`);
    let shareTotal = 0;
    for (const [subject, share] of Object.entries(shares)) {
      if (!SUBJECT_KEYS.includes(subject)) errors.push(`${sid}: unknown subject ${subject}`);
      if (!(Number(share) > 0)) errors.push(`${sid}: subject share must be > 0 for ${subject}`);
      shareTotal += Number(share);
    }
    if (Math.abs(shareTotal - 1) > 0.0001) errors.push(`${sid}: subjectShares sum to ${shareTotal}, expected 1`);
    if (!source.access || !source.access.method || !source.access.urlGenerationRule) errors.push(`${sid}: missing access method/rule`);
    if (!Array.isArray(source.access?.exampleUrls) || source.access.exampleUrls.length === 0) errors.push(`${sid}: missing exampleUrls`);
    if (!source.v1Overlap || typeof source.v1Overlap.method !== "string") errors.push(`${sid}: missing v1Overlap method`);
    if (!source.screening || typeof source.screening.method !== "string") errors.push(`${sid}: missing screening method`);

    if (source.pool === "unrestricted") {
      if (source.status !== "approved") errors.push(`${sid}: unrestricted source must have status approved`);
      if (!licence) continue;
      if (licence.commercialUse !== "allowed") errors.push(`${sid}: unrestricted source licence is not commercial-use allowed`);
      if (licence.nonCommercial) errors.push(`${sid}: unrestricted source has non-commercial licence`);
      if (licence.noDerivatives) errors.push(`${sid}: unrestricted source has no-derivatives licence`);
      if (licence.shareAlike) errors.push(`${sid}: unrestricted source has share-alike licence; use the share-alike pool`);
    }
    if (source.pool === "share-alike") {
      if (!licence?.shareAlike) errors.push(`${sid}: share-alike pool source must have shareAlike licence`);
      if (licence?.nonCommercial) errors.push(`${sid}: share-alike pool source must not be non-commercial`);
      if (source.status !== "approved-share-alike") errors.push(`${sid}: share-alike source must have status approved-share-alike`);
    }
    if (source.pool === "non-commercial") {
      if (!licence?.nonCommercial) errors.push(`${sid}: non-commercial pool source must have nonCommercial licence`);
      if (source.status !== "restricted") errors.push(`${sid}: non-commercial source must have status restricted`);
      if (num(estimates.plannedDocuments) !== 0) errors.push(`${sid}: non-commercial source must have plannedDocuments 0`);
    }
    if (source.pool === "unrestricted" && num(estimates.plannedDocuments) === 0) warnings.push(`${sid}: unrestricted source has no planned draw`);
    if (source.pool === "unrestricted" && num(estimates.capacityDocuments) === 0) warnings.push(`${sid}: unrestricted source has no capacity`);
  }
  if (sources.length === 0) errors.push("no sources");
  return { errors, warnings };
}

export function validatePolicy(policy) {
  const errors = [];
  if (!(policy.targetNovelTokens > 0)) errors.push("policy: targetNovelTokens must be > 0");
  if (!(policy.minimumHeadroomRatio >= 0)) errors.push("policy: minimumHeadroomRatio must be >= 0");
  for (const key of ["maxPublisherShare", "maxPublisherGroupShare", "maxSourceFamilyShare", "maxSubjectShare", "minSubjectShare", "maxFormatShare", "maxUsFederalShare"]) {
    const value = num(policy[key]);
    if (!(value > 0 && value <= 1)) errors.push(`policy: ${key} must be in (0,1]`);
  }
  if (policy.minSubjectShare > policy.maxSubjectShare) errors.push("policy: minSubjectShare > maxSubjectShare");
  if (policy.maxPublisherShare > policy.maxPublisherGroupShare) errors.push("policy: maxPublisherShare > maxPublisherGroupShare");
  if (!(policy.minIndependentPublishers > 0)) errors.push("policy: minIndependentPublishers must be > 0");
  if (!(policy.minSourceFamilies > 0)) errors.push("policy: minSourceFamilies must be > 0");
  if (policy.minSubjectCategories !== SUBJECT_KEYS.length) errors.push(`policy: minSubjectCategories must be ${SUBJECT_KEYS.length}`);
  const expectedMinimum = policy.targetNovelTokens * (1 + policy.minimumHeadroomRatio);
  if (Math.abs(num(policy.minimumPlannedNovelTokens) - expectedMinimum) > 1) {
    errors.push(`policy: minimumPlannedNovelTokens must be target * (1 + headroom) = ${Math.round(expectedMinimum)}`);
  }
  return errors;
}

export function computeSource(source) {
  const estimates = source.estimates;
  const combinedNovelty = (1 - num(estimates.v1Overlap)) * (1 - num(estimates.crossSourceOverlap));
  const calc = (documents) => {
    const gross = num(documents) * num(estimates.tokensPerDocument);
    const expected = gross * num(estimates.fetchSuccess) * num(estimates.qualityAcceptance) * (1 - num(estimates.dedupRemoval)) * combinedNovelty;
    return {
      gross,
      expected,
      conservative: expected * num(estimates.estimateUncertainty),
    };
  };
  const capacity = calc(estimates.capacityDocuments);
  const planned = calc(estimates.plannedDocuments);
  return {
    ...source,
    licence: clone(licenceById(source.licenceId)),
    computed: {
      combinedNovelty: round(combinedNovelty, 8),
      capacityCandidateUrls: num(estimates.capacityDocuments),
      plannedCandidateUrls: num(estimates.plannedDocuments),
      grossCapacityTokens: Math.round(capacity.gross),
      expectedNovelCapacityTokens: Math.round(capacity.expected),
      conservativeNovelCapacityTokens: Math.round(capacity.conservative),
      grossPlannedTokens: Math.round(planned.gross),
      expectedPlannedNovelTokens: Math.round(planned.expected),
      conservativePlannedNovelTokens: Math.round(planned.conservative),
    },
  };
}

function sumBy(items, fn) {
  return items.reduce((sum, item) => sum + num(fn(item)), 0);
}

function distribution(entries, total) {
  return [...entries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, tokens]) => ({ key, tokens: Math.round(tokens), share: total ? round(tokens / total, 8) : 0 }));
}

function herfindahl(entries, total) {
  if (!total) return 0;
  let sum = 0;
  for (const value of entries.values()) sum += (value / total) ** 2;
  return round(sum, 8);
}

function topShare(items, count, total) {
  return total ? round(items.slice(0, count).reduce((sum, item) => sum + item.tokens, 0) / total, 8) : 0;
}

export function computeMetrics(inventorySources, policy) {
  const restrictedPools = ["unrestricted", "share-alike", "non-commercial"];
  const poolSummary = {};
  for (const pool of restrictedPools) {
    const rows = inventorySources.filter((source) => source.pool === pool);
    poolSummary[pool] = {
      sources: rows.length,
      publishers: new Set(rows.map((source) => source.publisherGroupId)).size,
      sourceFamilies: new Set(rows.map((source) => source.sourceFamilyId)).size,
      capacityDocuments: sumBy(rows, (source) => source.estimates.capacityDocuments),
      plannedDocuments: sumBy(rows, (source) => source.estimates.plannedDocuments),
      grossCapacityTokens: sumBy(rows, (source) => source.computed.grossCapacityTokens),
      expectedNovelCapacityTokens: sumBy(rows, (source) => source.computed.expectedNovelCapacityTokens),
      conservativeNovelCapacityTokens: sumBy(rows, (source) => source.computed.conservativeNovelCapacityTokens),
      grossPlannedTokens: sumBy(rows, (source) => source.computed.grossPlannedTokens),
      expectedPlannedNovelTokens: sumBy(rows, (source) => source.computed.expectedPlannedNovelTokens),
      conservativePlannedNovelTokens: sumBy(rows, (source) => source.computed.conservativePlannedNovelTokens),
    };
  }

  const unrestricted = inventorySources.filter((source) => source.pool === "unrestricted");
  const planned = unrestricted;
  const plannedTotal = poolSummary.unrestricted.conservativePlannedNovelTokens;
  const capacityTotal = poolSummary.unrestricted.conservativeNovelCapacityTokens;

  const dims = {
    publishers: (source) => source.publisherId,
    publisherGroups: (source) => source.publisherGroupId,
    sourceFamilies: (source) => source.sourceFamilyId,
    formats: (source) => source.format,
    governanceGroups: (source) => source.governanceGroupId,
  };

  const concentration = {};
  for (const [name, getter] of Object.entries(dims)) {
    const plannedEntries = new Map();
    const capacityEntries = new Map();
    for (const source of planned) {
      plannedEntries.set(getter(source), (plannedEntries.get(getter(source)) ?? 0) + source.computed.conservativePlannedNovelTokens);
    }
    for (const source of unrestricted) {
      capacityEntries.set(getter(source), (capacityEntries.get(getter(source)) ?? 0) + source.computed.conservativeNovelCapacityTokens);
    }
    const plannedDist = distribution(plannedEntries, plannedTotal);
    const capacityDist = distribution(capacityEntries, capacityTotal);
    concentration[name] = {
      planned: {
        distinct: plannedEntries.size,
        top1Share: topShare(plannedDist, 1, plannedTotal),
        top5Share: topShare(plannedDist, 5, plannedTotal),
        top10Share: topShare(plannedDist, 10, plannedTotal),
        herfindahl: herfindahl(plannedEntries, plannedTotal),
        distribution: plannedDist,
      },
      capacity: {
        distinct: capacityEntries.size,
        top1Share: topShare(capacityDist, 1, capacityTotal),
        top5Share: topShare(capacityDist, 5, capacityTotal),
        top10Share: topShare(capacityDist, 10, capacityTotal),
        herfindahl: herfindahl(capacityEntries, capacityTotal),
        distribution: capacityDist.slice(0, 20),
      },
    };
  }

  const subjectEntries = new Map(SUBJECT_KEYS.map((key) => [key, 0]));
  const subjectCapacityEntries = new Map(SUBJECT_KEYS.map((key) => [key, 0]));
  for (const source of planned) {
    for (const [subject, share] of Object.entries(source.subjectShares)) {
      subjectEntries.set(subject, (subjectEntries.get(subject) ?? 0) + source.computed.conservativePlannedNovelTokens * share);
      subjectCapacityEntries.set(subject, (subjectCapacityEntries.get(subject) ?? 0) + source.computed.conservativeNovelCapacityTokens * share);
    }
  }
  const subjectDist = distribution(subjectEntries, plannedTotal);
  const subjectCapacityDist = distribution(subjectCapacityEntries, capacityTotal);
  concentration.subjects = {
    planned: {
      distinct: subjectEntries.size,
      top1Share: topShare(subjectDist, 1, plannedTotal),
      top5Share: topShare(subjectDist, 5, plannedTotal),
      top10Share: topShare(subjectDist, 10, plannedTotal),
      herfindahl: herfindahl(subjectEntries, plannedTotal),
      distribution: subjectDist,
    },
    capacity: {
      distinct: subjectCapacityEntries.size,
      top1Share: topShare(subjectCapacityDist, 1, capacityTotal),
      top5Share: topShare(subjectCapacityDist, 5, capacityTotal),
      top10Share: topShare(subjectCapacityDist, 10, capacityTotal),
      herfindahl: herfindahl(subjectCapacityEntries, capacityTotal),
      distribution: subjectCapacityDist,
    },
  };

  const candidateRows = [];
  for (const source of inventorySources) {
    for (const [subject, share] of Object.entries(source.subjectShares)) {
      const unrestrictedSource = source.pool === "unrestricted";
      candidateRows.push({
        sourceId: source.sourceId,
        publisherId: source.publisherId,
        publisherGroupId: source.publisherGroupId,
        sourceFamilyId: source.sourceFamilyId,
        subject,
        pool: source.pool,
        format: source.format,
        plannedCandidateUrls: unrestrictedSource ? round(source.estimates.plannedDocuments * share, 2) : 0,
        capacityCandidateUrls: unrestrictedSource ? round(source.estimates.capacityDocuments * share, 2) : 0,
        plannedNovelTokens: unrestrictedSource ? Math.round(source.computed.conservativePlannedNovelTokens * share) : 0,
        capacityNovelTokens: unrestrictedSource ? Math.round(source.computed.conservativeNovelCapacityTokens * share) : 0,
        exampleUrls: source.access.exampleUrls,
        urlGenerationRule: source.access.urlGenerationRule,
      });
    }
  }
  const unrestrictedCandidateRows = candidateRows.filter((row) => row.pool === "unrestricted");
  const aggregateCandidateRows = (key) => {
    const map = new Map();
    for (const row of unrestrictedCandidateRows) {
      const entry = map.get(row[key]) ?? { key: row[key], plannedCandidateUrls: 0, capacityCandidateUrls: 0, plannedNovelTokens: 0, capacityNovelTokens: 0 };
      entry.plannedCandidateUrls += row.plannedCandidateUrls;
      entry.capacityCandidateUrls += row.capacityCandidateUrls;
      entry.plannedNovelTokens += row.plannedNovelTokens;
      entry.capacityNovelTokens += row.capacityNovelTokens;
      map.set(row[key], entry);
    }
    return [...map.values()]
      .map((entry) => ({
        ...entry,
        plannedCandidateUrls: round(entry.plannedCandidateUrls, 2),
        capacityCandidateUrls: round(entry.capacityCandidateUrls, 2),
        plannedTokenShare: plannedTotal ? round(entry.plannedNovelTokens / plannedTotal, 8) : 0,
      }))
      .sort((a, b) => b.plannedNovelTokens - a.plannedNovelTokens || a.key.localeCompare(b.key));
  };
  const candidateUrls = {
    schema: "sma/source-candidate-urls@2",
    note: "Candidate URL counts are document counts allocated across subject shares. They are planning estimates, not enumerated URLs. Example URLs and URL-generation rules are in source-inventory.json.",
    rows: candidateRows,
    unrestricted: {
      byPublisherGroup: aggregateCandidateRows("publisherGroupId"),
      bySourceFamily: aggregateCandidateRows("sourceFamilyId"),
      bySubject: aggregateCandidateRows("subject"),
    },
  };

  const waterfall = {
    capacity: {
      grossTokens: poolSummary.unrestricted.grossCapacityTokens,
      afterFetch: Math.round(sumBy(unrestricted, (source) => source.computed.grossCapacityTokens * num(source.estimates.fetchSuccess))),
      afterQuality: Math.round(sumBy(unrestricted, (source) => source.computed.grossCapacityTokens * num(source.estimates.fetchSuccess) * num(source.estimates.qualityAcceptance))),
      afterDedup: Math.round(sumBy(unrestricted, (source) => source.computed.grossCapacityTokens * num(source.estimates.fetchSuccess) * num(source.estimates.qualityAcceptance) * (1 - num(source.estimates.dedupRemoval)))),
      afterNovelty: poolSummary.unrestricted.expectedNovelCapacityTokens,
      conservative: poolSummary.unrestricted.conservativeNovelCapacityTokens,
    },
    planned: {
      grossTokens: poolSummary.unrestricted.grossPlannedTokens,
      afterFetch: Math.round(sumBy(unrestricted, (source) => source.computed.grossPlannedTokens * num(source.estimates.fetchSuccess))),
      afterQuality: Math.round(sumBy(unrestricted, (source) => source.computed.grossPlannedTokens * num(source.estimates.fetchSuccess) * num(source.estimates.qualityAcceptance))),
      afterDedup: Math.round(sumBy(unrestricted, (source) => source.computed.grossPlannedTokens * num(source.estimates.fetchSuccess) * num(source.estimates.qualityAcceptance) * (1 - num(source.estimates.dedupRemoval)))),
      afterNovelty: poolSummary.unrestricted.expectedPlannedNovelTokens,
      conservative: poolSummary.unrestricted.conservativePlannedNovelTokens,
    },
  };

  const licenceEntries = new Map();
  const licenceCapacityEntries = new Map();
  for (const source of unrestricted) {
    licenceEntries.set(source.licenceId, (licenceEntries.get(source.licenceId) ?? 0) + source.computed.conservativePlannedNovelTokens);
    licenceCapacityEntries.set(source.licenceId, (licenceCapacityEntries.get(source.licenceId) ?? 0) + source.computed.conservativeNovelCapacityTokens);
  }
  const licenceBreakdown = [...licenceEntries.entries()]
    .map(([licenceId, tokens]) => ({
      licenceId,
      name: licences[licenceId]?.name ?? licenceId,
      spdx: licences[licenceId]?.spdx ?? null,
      commercialUse: licences[licenceId]?.commercialUse ?? null,
      shareAlike: licences[licenceId]?.shareAlike ?? null,
      nonCommercial: licences[licenceId]?.nonCommercial ?? null,
      documents: sumBy(unrestricted.filter((source) => source.licenceId === licenceId), (source) => source.estimates.plannedDocuments),
      plannedNovelTokens: Math.round(tokens),
      share: plannedTotal ? round(tokens / plannedTotal, 8) : 0,
      capacityNovelTokens: Math.round(licenceCapacityEntries.get(licenceId) ?? 0),
    }))
    .sort((a, b) => b.plannedNovelTokens - a.plannedNovelTokens);

  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const minimumPlanned = policy.targetNovelTokens * (1 + policy.minimumHeadroomRatio);
  check("capacity-exceeds-target", capacityTotal >= policy.targetNovelTokens, `${capacityTotal} >= ${policy.targetNovelTokens}`);
  check("capacity-headroom", capacityTotal >= minimumPlanned, `${capacityTotal} >= ${Math.round(minimumPlanned)}`);
  check("planned-exceeds-target", plannedTotal >= policy.targetNovelTokens, `${plannedTotal} >= ${policy.targetNovelTokens}`);
  check("planned-headroom", plannedTotal >= minimumPlanned, `${plannedTotal} >= ${Math.round(minimumPlanned)}`);
  const usFederal = concentration.governanceGroups.planned.distribution.find((item) => item.key === "us-federal")?.share ?? 0;
  const checksByDim = [
    ["max-publisher-share", concentration.publishers.planned.top1Share, policy.maxPublisherShare],
    ["max-publisher-group-share", concentration.publisherGroups.planned.top1Share, policy.maxPublisherGroupShare],
    ["max-source-family-share", concentration.sourceFamilies.planned.top1Share, policy.maxSourceFamilyShare],
    ["max-subject-share", concentration.subjects.planned.top1Share, policy.maxSubjectShare],
    ["max-format-share", concentration.formats.planned.top1Share, policy.maxFormatShare],
    ["max-us-federal-share", usFederal, policy.maxUsFederalShare],
  ];
  for (const [id, value, cap] of checksByDim) check(id, value <= cap + 1e-9, `${value} <= ${cap}`);
  const subjectShares = Object.fromEntries(concentration.subjects.planned.distribution.map((item) => [item.key, item.share]));
  for (const subject of SUBJECT_KEYS) {
    check(`subject-min:${subject}`, (subjectShares[subject] ?? 0) >= policy.minSubjectShare - 1e-9, `${subjectShares[subject] ?? 0} >= ${policy.minSubjectShare}`);
  }
  check("min-publishers", concentration.publisherGroups.planned.distinct >= policy.minIndependentPublishers, `${concentration.publisherGroups.planned.distinct} >= ${policy.minIndependentPublishers}`);
  check("min-source-families", concentration.sourceFamilies.planned.distinct >= policy.minSourceFamilies, `${concentration.sourceFamilies.planned.distinct} >= ${policy.minSourceFamilies}`);
  check("min-subject-categories", concentration.subjects.planned.distinct >= policy.minSubjectCategories, `${concentration.subjects.planned.distinct} >= ${policy.minSubjectCategories}`);
  check("no-restricted-in-target", unrestricted.every((source) => !source.licence.nonCommercial && !source.licence.shareAlike && !source.licence.noDerivatives && source.licence.commercialUse === "allowed"), "all unrestricted sources are commercial-use allowed, non-SA, non-NC, non-ND");

  return {
    schema: "sma/source-inventory-derived-metrics@2",
    inventoryVersion: meta.inventoryVersion,
    generatedAt: meta.createdAt,
    policy,
    counts: {
      totalSources: inventorySources.length,
      approvedUnrestricted: unrestricted.length,
      approvedShareAlike: inventorySources.filter((source) => source.pool === "share-alike").length,
      restrictedNonCommercial: inventorySources.filter((source) => source.pool === "non-commercial").length,
      excludedCandidates: exclusions.length,
      unrestrictedPublishers: concentration.publisherGroups.planned.distinct,
      unrestrictedSourceFamilies: concentration.sourceFamilies.planned.distinct,
      unrestrictedSubjects: concentration.subjects.planned.distinct,
      candidateUrlsCapacity: poolSummary.unrestricted.capacityDocuments,
      candidateUrlsPlanned: poolSummary.unrestricted.plannedDocuments,
    },
    pools: poolSummary,
    candidateUrls,
    waterfall,
    concentration,
    licenceBreakdown,
    checks,
    allChecksPassed: checks.every((item) => item.ok),
  };
}

function pct(value, digits = 1) {
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function n(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}

function m(value) {
  return `${(Number(value) / 1_000_000).toFixed(2)}M`;
}

function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, sep, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

export function renderReport(inventory, metrics, policy, baselineData) {
  const unrestricted = inventory.sources.filter((source) => source.pool === "unrestricted");
  const topSources = [...unrestricted]
    .sort((a, b) => b.computed.conservativePlannedNovelTokens - a.computed.conservativePlannedNovelTokens)
    .slice(0, 20);
  const subjectRows = metrics.concentration.subjects.planned.distribution.map((item) => [
    item.key,
    n(item.tokens),
    pct(item.share),
  ]);
  const publisherRows = metrics.concentration.publisherGroups.planned.distribution.slice(0, 15).map((item) => [
    item.key,
    n(item.tokens),
    pct(item.share),
  ]);
  const familyRows = metrics.concentration.sourceFamilies.planned.distribution.slice(0, 15).map((item) => [
    item.key,
    n(item.tokens),
    pct(item.share),
  ]);
  const formatRows = metrics.concentration.formats.planned.distribution.map((item) => [
    item.key,
    n(item.tokens),
    pct(item.share),
  ]);
  const governanceRows = metrics.concentration.governanceGroups.planned.distribution.map((item) => [
    item.key,
    n(item.tokens),
    pct(item.share),
  ]);
  const licenceRows = metrics.licenceBreakdown.map((item) => [
    item.licenceId,
    item.spdx ?? "",
    n(item.plannedNovelTokens),
    pct(item.share),
    item.commercialUse ?? "",
    item.nonCommercial ? "yes" : "no",
  ]);
  const checkRows = metrics.checks.map((item) => [item.id, item.ok ? "PASS" : "FAIL", item.detail]);
  const sourceRows = topSources.map((source) => [
    source.sourceId,
    source.publisherGroupId,
    source.format,
    n(source.estimates.plannedDocuments),
    m(source.computed.conservativePlannedNovelTokens),
    pct(metrics.concentration.publisherGroups.planned.distribution.find((item) => item.key === source.publisherGroupId)?.share ?? 0),
  ]);
  const candidatePublisherRows = metrics.candidateUrls.unrestricted.byPublisherGroup.slice(0, 15).map((item) => [
    item.key,
    n(item.plannedCandidateUrls),
    n(item.capacityCandidateUrls),
    n(item.plannedNovelTokens),
  ]);
  const candidateSubjectRows = metrics.candidateUrls.unrestricted.bySubject.map((item) => [
    item.key,
    n(item.plannedCandidateUrls),
    n(item.capacityCandidateUrls),
    n(item.plannedNovelTokens),
  ]);
  const candidateExampleRows = topSources.slice(0, 8).map((source) => [
    source.sourceId,
    source.publisherGroupId,
    n(source.estimates.plannedDocuments),
    source.access.exampleUrls[0],
  ]);

  return `# Source Expansion Inventory v2 — Summary Report

**Inventory version:** ${inventory.inventoryVersion}  
**Generated:** ${inventory.createdAt}  
**Status:** Inventory development only. No acquisition, training, production write, promotion, job, timer or corpus change was performed.

## 1. Executive summary

The expanded inventory contains **${metrics.counts.totalSources} candidate sources**. Of these, **${metrics.counts.approvedUnrestricted}** are in the unrestricted pool, drawn from **${metrics.counts.unrestrictedPublishers} independent publisher groups** and **${metrics.counts.unrestrictedSourceFamilies} source families**. A further **${metrics.counts.approvedShareAlike}** are share-alike sources and **${metrics.counts.restrictedNonCommercial}** are non-commercial/restricted sources. It also records **${metrics.counts.excludedCandidates} excluded or deferred candidates** with reasons.

After fetch, quality, deduplication, v1-overlap and cross-source-overlap allowances, and after an explicit uncertainty factor, the unrestricted pool has a **conservative novel-token capacity of ${m(metrics.pools.unrestricted.conservativeNovelCapacityTokens)}** (gross ${m(metrics.pools.unrestricted.grossCapacityTokens)}). The recommended planned draw is **${m(metrics.pools.unrestricted.conservativePlannedNovelTokens)} conservative novel tokens** from about **${n(metrics.counts.candidateUrlsPlanned)} candidate URLs**. Both figures exceed the **7.75M** target and the policy's **35% headroom floor** (${m(policy.targetNovelTokens * (1 + policy.minimumHeadroomRatio))}).

**Recommendation:** the 7.75M target is **feasible on inventory evidence**, with substantial capacity headroom. It is **not yet measured**. The next step should be a separately authorised, bounded acquisition pilot that measures real yield, v1 overlap, cross-source duplication, licence compliance and robots/terms for this expanded source set. This work package does not authorise acquisition or training.

## 2. Baseline and prior pilot

${table(["Baseline", "Documents", "Cleaned tokens", "Publishers", "Source families"], [
  ["Frozen v1 (prospective-rebalanced)", n(baselineData.frozenV1.documents), n(baselineData.frozenV1.cleanedTokens), n(baselineData.frozenV1.publishers), n(baselineData.frozenV1.sourceFamilies)],
  ["Pilot v2 (100-doc acquisition)", n(baselineData.pilotV2.acceptedDocuments), n(baselineData.pilotV2.cleanedTokens), n(baselineData.pilotV2.publishers), n(baselineData.pilotV2.sourceFamilies)],
])}

Pilot v2 found **${baselineData.pilotV2.overlappingDocuments}/${baselineData.pilotV2.acceptedDocuments}** documents overlapping frozen v1, leaving only **${baselineData.pilotV2.novelDocuments} novel documents** and **${n(baselineData.pilotV2.novelTokens)} novel tokens** (${pct(baselineData.pilotV2.novelTokenShare)}). This is why the expanded inventory explicitly records v1 overlap and cross-source overlap instead of treating new URLs as novel.

Frozen v1 identity: manifest \`${baselineData.frozenV1.manifestSha256}\`; train \`${baselineData.frozenV1.trainSha256}\`; validation \`${baselineData.frozenV1.validationSha256}\`.  
Pilot v2 identity: manifest \`${baselineData.pilotV2.manifestSha256}\`; screening \`${baselineData.pilotV2.screeningSha256}\`.

## 3. Inventory overview

${table(["Pool", "Sources", "Publishers", "Families", "Capacity docs", "Planned docs", "Gross capacity", "Conservative novel capacity", "Conservative planned novel"], [
  ...["unrestricted", "share-alike", "non-commercial"].map((pool) => {
    const item = metrics.pools[pool];
    return [pool, n(item.sources), n(item.publishers), n(item.sourceFamilies), n(item.capacityDocuments), n(item.plannedDocuments), m(item.grossCapacityTokens), m(item.conservativeNovelCapacityTokens), m(item.conservativePlannedNovelTokens)];
  }),
])}

Only the **unrestricted** pool counts toward the 7.75M target. Share-alike and non-commercial sources are reported separately and are not used to satisfy the target.

## 4. Capacity waterfall (unrestricted pool)

${table(["Stage", "Capacity draw", "Planned draw"], [
  ["Gross cleaned-token estimate", n(metrics.waterfall.capacity.grossTokens), n(metrics.waterfall.planned.grossTokens)],
  ["After fetch-success allowance", n(metrics.waterfall.capacity.afterFetch), n(metrics.waterfall.planned.afterFetch)],
  ["After quality acceptance", n(metrics.waterfall.capacity.afterQuality), n(metrics.waterfall.planned.afterQuality)],
  ["After duplicate removal", n(metrics.waterfall.capacity.afterDedup), n(metrics.waterfall.planned.afterDedup)],
  ["After v1 and cross-source novelty", n(metrics.waterfall.capacity.afterNovelty), n(metrics.waterfall.planned.afterNovelty)],
  ["Conservative (uncertainty factor)", n(metrics.waterfall.capacity.conservative), n(metrics.waterfall.planned.conservative)],
])}

The difference between capacity and planned draw is deliberate headroom. The inventory can supply more than the recommended draw; the draw is capped for composition, cost and review reasons.

## 5. Licence breakdown (unrestricted pool)

${table(["Licence", "SPDX", "Planned novel tokens", "Share", "Commercial use", "Non-commercial"], licenceRows)}

All unrestricted entries are commercial-use allowed, non-share-alike, non-non-commercial and non-no-derivatives. Share-alike and non-commercial entries are in separate pools. Licence evidence is recorded in \`licence-register.json\`; this is not legal clearance.

## 6. Composition and diversity (planned draw)

### 6.1 Subject distribution

${table(["Subject", "Conservative novel tokens", "Share"], subjectRows)}

The planned draw covers all ten requested subject areas. The thinnest area is engineering/applied sciences; the strongest are economics/social/political, humanities, physics/chemistry/biology, medicine/public health and geography/earth/environment.

### 6.2 Publisher-group distribution

${table(["Publisher group", "Conservative novel tokens", "Share"], publisherRows)}

### 6.3 Source-family distribution

${table(["Source family", "Conservative novel tokens", "Share"], familyRows)}

### 6.4 Document-format distribution

${table(["Format", "Conservative novel tokens", "Share"], formatRows)}

### 6.5 Governance-group distribution

${table(["Governance group", "Conservative novel tokens", "Share"], governanceRows)}

### 6.6 Concentration metrics

${table(["Dimension", "Distinct", "Top-1 share", "Top-5 share", "Top-10 share", "Herfindahl"], [
  ["Publisher", n(metrics.concentration.publishers.planned.distinct), pct(metrics.concentration.publishers.planned.top1Share), pct(metrics.concentration.publishers.planned.top5Share), pct(metrics.concentration.publishers.planned.top10Share), metrics.concentration.publishers.planned.herfindahl.toFixed(4)],
  ["Publisher group", n(metrics.concentration.publisherGroups.planned.distinct), pct(metrics.concentration.publisherGroups.planned.top1Share), pct(metrics.concentration.publisherGroups.planned.top5Share), pct(metrics.concentration.publisherGroups.planned.top10Share), metrics.concentration.publisherGroups.planned.herfindahl.toFixed(4)],
  ["Source family", n(metrics.concentration.sourceFamilies.planned.distinct), pct(metrics.concentration.sourceFamilies.planned.top1Share), pct(metrics.concentration.sourceFamilies.planned.top5Share), pct(metrics.concentration.sourceFamilies.planned.top10Share), metrics.concentration.sourceFamilies.planned.herfindahl.toFixed(4)],
  ["Subject", n(metrics.concentration.subjects.planned.distinct), pct(metrics.concentration.subjects.planned.top1Share), pct(metrics.concentration.subjects.planned.top5Share), pct(metrics.concentration.subjects.planned.top10Share), metrics.concentration.subjects.planned.herfindahl.toFixed(4)],
  ["Format", n(metrics.concentration.formats.planned.distinct), pct(metrics.concentration.formats.planned.top1Share), pct(metrics.concentration.formats.planned.top5Share), pct(metrics.concentration.formats.planned.top10Share), metrics.concentration.formats.planned.herfindahl.toFixed(4)],
  ["Governance group", n(metrics.concentration.governanceGroups.planned.distinct), pct(metrics.concentration.governanceGroups.planned.top1Share), pct(metrics.concentration.governanceGroups.planned.top5Share), pct(metrics.concentration.governanceGroups.planned.top10Share), metrics.concentration.governanceGroups.planned.herfindahl.toFixed(4)],
])}

Publisher diversity is not the same as source-family diversity. Related publishers (for example Wikimedia projects, Open Logic Project/forall x, NIST/NIST DLMF, and OAPEN as a host) are grouped so that mirrors, subsidiaries and closely related repositories do not inflate the independent-publisher count. Aggregators such as OAPEN and PMC are treated as one publisher group; their underlying publisher diversity must be measured from item metadata during acquisition. In the governance table, 'independent' is a residual category, not a single publisher; the policy cap applies to the largest actual government group (US federal, currently ${pct(metrics.concentration.governanceGroups.planned.distribution.find((item) => item.key === "us-federal")?.share ?? 0)}).

### 6.7 Candidate URL allocation

Candidate URL counts below are document counts allocated across subject shares. They are planning estimates, not enumerated URLs. The inventory records a URL-generation rule and example URLs for every source; the full machine-readable allocation is in \`candidate-urls.json\`.

**By publisher group (top 15)**

${table(["Publisher group", "Planned candidate URLs", "Capacity candidate URLs", "Planned novel tokens"], candidatePublisherRows)}

**By subject**

${table(["Subject", "Planned candidate URLs", "Capacity candidate URLs", "Planned novel tokens"], candidateSubjectRows)}

**Example candidate URLs for the largest planned sources**

${table(["Source", "Publisher group", "Planned docs", "Example URL"], candidateExampleRows)}

## 7. Top planned sources

${table(["Source", "Publisher group", "Format", "Planned docs", "Conservative planned novel", "Publisher-group share"], sourceRows)}

## 8. V1 overlap and cross-source overlap

Known frozen-v1 overlap is recorded per source in \`source-inventory.json\`. The main known overlaps are:

- Project Gutenberg: 2 v1 books; exclude those book IDs and titles duplicated by Standard Ebooks.
- Wikipedia: 16 v1 articles; exclude them.
- Python documentation: 24 v1 pages; exclude them.
- OpenStax: 41 v1 pages; current OpenStax is restricted (CC BY-NC-SA) and is not in the unrestricted target.
- US government agencies: small numbers of v1 pages in NASA, NIST, Census, EPA and GOV.UK; exclude those URLs.
- MIT OCW/LibreTexts: v1 pages; MIT OCW is non-commercial; LibreTexts is excluded as ambiguous.

Cross-source overlaps are modelled explicitly. The largest is PMC versus publisher-specific sources (cross-source overlap 0.55), followed by Standard Ebooks versus Project Gutenberg (0.15), OAPEN within-source (0.10), and Gutenberg boilerplate/edition overlap (0.15). These are planning discounts, not measured overlaps. They must be replaced by measured DOI/title/content overlap in the next acquisition pilot.

## 9. Exclusions and uncertainties

### 9.1 Excluded or deferred candidates

${table(["Candidate", "Status", "Reason"], inventory.exclusions.map((item) => [item.candidate, item.status, item.reason]))}

### 9.2 Outstanding uncertainties

${table(["ID", "Topic", "Action"], inventory.uncertainties.map((item) => [item.id, item.topic, item.action]))}

The full uncertainty register is in \`source-inventory.json\`.

## 10. Comparison with the previous 100-document pilot

${table(["Measure", "Pilot v2", "This inventory (planned draw)", "This inventory (capacity)"], [
  ["Documents", n(baselineData.pilotV2.acceptedDocuments), n(metrics.counts.candidateUrlsPlanned), n(metrics.counts.candidateUrlsCapacity)],
  ["Gross cleaned tokens", n(baselineData.pilotV2.cleanedTokens), n(metrics.pools.unrestricted.grossPlannedTokens), n(metrics.pools.unrestricted.grossCapacityTokens)],
  ["Novel tokens relative to v1", n(baselineData.pilotV2.novelTokens), n(metrics.pools.unrestricted.conservativePlannedNovelTokens), n(metrics.pools.unrestricted.conservativeNovelCapacityTokens)],
  ["Publishers / groups", n(baselineData.pilotV2.publishers), n(metrics.concentration.publisherGroups.planned.distinct), n(metrics.concentration.publisherGroups.capacity.distinct)],
  ["Source families", n(baselineData.pilotV2.sourceFamilies), n(metrics.concentration.sourceFamilies.planned.distinct), n(metrics.concentration.sourceFamilies.capacity.distinct)],
])}

The pilot's novel yield was about **${n(baselineData.pilotV2.novelTokens / baselineData.pilotV2.novelDocuments)} novel tokens per novel document**. The expanded inventory plans for **${n(metrics.pools.unrestricted.conservativePlannedNovelTokens / metrics.counts.candidateUrlsPlanned)} conservative novel tokens per planned URL**, because it deliberately includes more long-form books, reports and reference works. This is a planning estimate, not a measured yield.

## 11. Validation checks

${table(["Check", "Result", "Detail"], checkRows)}

## 12. Remaining gaps and recommendations

**Gaps**

1. **Measured yield is absent.** Token estimates use pilot measurements for some sources and conservative document-length assumptions for others. They must be replaced by measured cleaned-token yield.
2. **Cross-source duplication is estimated, not measured.** PMC/publisher overlap and Gutenberg/Standard Ebooks overlap need DOI/title/content measurement.
3. **V1 overlap is source/title-level for most families.** Full-text exact, normalised and MinHash screening is required before accepting documents.
4. **Engineering/applied sciences is the thinnest subject area** (near the 5% floor). If the next pilot shows weak yield from NASA/NIST/OSTI/MDPI, engineering could fall below the floor.
5. **Humanities/history depend heavily on public-domain books.** This is legitimate but creates a format and style concentration; OAPEN and open-book sources need measured yield to diversify it.
6. **Medicine/public health relies on journal publishers with material PMC overlap.** The cross-source discount is conservative but unmeasured.
7. **Licence and legal review remain incomplete.** Share-alike and non-commercial material is separated, but whether training/weights trigger those obligations requires legal advice.
8. **Access terms and robots are not yet checked at acquisition scale.** Some sources require APIs, OAI-PMH, rate limits or prior permission.
9. **Licence terms can change.** OpenStax's 2026 move to CC BY-NC-SA is a concrete example; every source must be re-verified immediately before acquisition.
10. **Underlying publisher diversity of OAPEN and PMC is not yet counted.** The current concentration metrics use the distributor as the publisher group; item-level metadata must be used in the next stage.

**Recommendations**

1. **Do not run the full 7.75M acquisition under this work package.** It is inventory development only.
2. **Authorise a separate, bounded acquisition pilot** of roughly 1.5-2.5M gross tokens (or about 500-800 accepted documents) drawn across the new families, with per-publisher caps and full v1/cross-source screening. Measure actual yield, rejection, duplication, language and licence/robots compliance.
3. **Prioritise the new unrestricted families that are least represented in v1:** arXiv CC BY, PLOS/eLife/PMC CC BY, World Bank, OECD, OWASP-like technical documentation (Python/Rust/Go/PostgreSQL/Kubernetes), OAPEN CC BY, USGS/NOAA, and Standard Ebooks.
4. **Keep OpenStax, MIT OCW, Khan Academy, WHO and FAO out of the unrestricted pool** unless non-commercial suitability is explicitly established or permission is obtained.
5. **Run legal review on share-alike and non-commercial obligations** before including those pools. Do not treat public accessibility as reuse permission.
6. **Re-run this inventory build after the pilot** with measured yield and overlap, then freeze the composition for a separately authorised training experiment.

## 13. Reproduction and hashes

Build and validate:

\`\`\`bash
node scripts/build-source-inventory.mjs
node scripts/build-source-inventory.mjs --check
node --test test/source-inventory.test.js
\`\`\`

The build reads only the versioned source data under \`inventory/source-expansion-v2/data/\`, performs no network access, and writes the inventory, derived metrics, licence register, exclusions, policy, this report and \`manifest.json\`. The manifest records SHA-256 hashes for the inventory, its supporting manifests, the build script and the test. Verify with \`--check\`.

**No acquisition, crawl, training, evaluation, promotion, production write, job/timer/service change, or frozen-corpus change occurred in producing this inventory.**
`;
}

export function buildInventory() {
  const rawSources = currentSources();
  const { errors: sourceErrors, warnings } = validateSources(rawSources);
  const policyErrors = validatePolicy(compositionPolicy);
  const errors = [...sourceErrors, ...policyErrors];
  if (errors.length > 0) {
    const error = new Error(`source inventory validation failed:\n${errors.join("\n")}`);
    error.validationErrors = errors;
    throw error;
  }
  const inventorySources = rawSources.map(computeSource);
  const metrics = computeMetrics(inventorySources, compositionPolicy);
  if (!metrics.allChecksPassed) {
    const failed = metrics.checks.filter((item) => !item.ok);
    const error = new Error(`source inventory policy checks failed:\n${failed.map((item) => `${item.id}: ${item.detail}`).join("\n")}`);
    error.policyFailures = failed;
    throw error;
  }
  const inventory = {
    schema: "sma/source-expansion-inventory@2",
    inventoryVersion: meta.inventoryVersion,
    createdAt: meta.createdAt,
    title: meta.title,
    description: meta.description,
    authorisation: meta.authorisation,
    baseline: clone(baseline),
    compositionPolicy: clone(compositionPolicy),
    licenceRegister: clone(licences),
    summary: {
      totalSources: metrics.counts.totalSources,
      approvedUnrestricted: metrics.counts.approvedUnrestricted,
      approvedShareAlike: metrics.counts.approvedShareAlike,
      restrictedNonCommercial: metrics.counts.restrictedNonCommercial,
      excludedCandidates: metrics.counts.excludedCandidates,
      unrestrictedPublishers: metrics.counts.unrestrictedPublishers,
      unrestrictedSourceFamilies: metrics.counts.unrestrictedSourceFamilies,
      unrestrictedSubjects: metrics.counts.unrestrictedSubjects,
      targetNovelTokens: compositionPolicy.targetNovelTokens,
      minimumPlannedNovelTokens: compositionPolicy.minimumPlannedNovelTokens,
      conservativeNovelCapacityTokens: metrics.pools.unrestricted.conservativeNovelCapacityTokens,
      conservativePlannedNovelTokens: metrics.pools.unrestricted.conservativePlannedNovelTokens,
      capacityHeadroomRatio: metrics.pools.unrestricted.conservativeNovelCapacityTokens / compositionPolicy.targetNovelTokens,
      plannedHeadroomRatio: metrics.pools.unrestricted.conservativePlannedNovelTokens / compositionPolicy.targetNovelTokens,
      allChecksPassed: metrics.allChecksPassed,
    },
    sources: inventorySources,
    exclusions: clone(exclusions),
    uncertainties: clone(uncertainties),
    validation: { sourceErrors: [], warnings },
  };
  return { inventory, metrics, rawSources };
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function fileHash(file) {
  return sha256(await readFile(file));
}

export async function writeOutputs() {
  const { inventory, metrics, rawSources } = buildInventory();
  const specs = {
    schema: "sma/source-inventory-specs@2",
    inventoryVersion: meta.inventoryVersion,
    createdAt: meta.createdAt,
    meta,
    baseline,
    compositionPolicy,
    licences,
    sources: rawSources,
    exclusions,
    uncertainties,
  };
  await writeJson(SPECS_PATH, specs);
  await writeJson(INVENTORY_PATH, inventory);
  await writeJson(METRICS_PATH, metrics);
  await writeJson(POLICY_PATH, compositionPolicy);
  await writeJson(LICENCES_PATH, licences);
  await writeJson(EXCLUSIONS_PATH, exclusions);
  await writeJson(CANDIDATE_URLS_PATH, metrics.candidateUrls);
  await writeFile(REPORT_PATH, renderReport(inventory, metrics, compositionPolicy, baseline), "utf8");

  const files = {
    specs: { path: SPECS_PATH, sha256: await fileHash(SPECS_PATH) },
    inventory: { path: INVENTORY_PATH, sha256: await fileHash(INVENTORY_PATH) },
    derivedMetrics: { path: METRICS_PATH, sha256: await fileHash(METRICS_PATH) },
    compositionPolicy: { path: POLICY_PATH, sha256: await fileHash(POLICY_PATH) },
    licenceRegister: { path: LICENCES_PATH, sha256: await fileHash(LICENCES_PATH) },
    exclusions: { path: EXCLUSIONS_PATH, sha256: await fileHash(EXCLUSIONS_PATH) },
    candidateUrls: { path: CANDIDATE_URLS_PATH, sha256: await fileHash(CANDIDATE_URLS_PATH) },
    summaryReport: { path: REPORT_PATH, sha256: await fileHash(REPORT_PATH) },
    buildScript: { path: BUILD_SCRIPT_PATH, sha256: await fileHash(BUILD_SCRIPT_PATH) },
    test: { path: TEST_PATH, sha256: await fileHash(TEST_PATH) },
  };
  try {
    const info = await stat(README_PATH);
    if (info.isFile()) files.readme = { path: README_PATH, sha256: await fileHash(README_PATH) };
  } catch {
    // README is optional for the manifest.
  }
  const manifest = {
    schema: "sma/source-inventory-manifest@2",
    inventoryVersion: meta.inventoryVersion,
    generatedAt: meta.createdAt,
    inventorySha256: files.inventory.sha256,
    files,
    verification: "Run `node scripts/build-source-inventory.mjs --check` to re-hash every file.",
  };
  await writeJson(MANIFEST_PATH, manifest);
  return { inventory, metrics, manifest };
}

export async function checkOutputs() {
  const { inventory, metrics } = buildInventory();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const problems = [];
  if (manifest.inventoryVersion !== meta.inventoryVersion) problems.push(`manifest version ${manifest.inventoryVersion} != ${meta.inventoryVersion}`);
  const expectedFiles = {
    specs: SPECS_PATH,
    inventory: INVENTORY_PATH,
    derivedMetrics: METRICS_PATH,
    compositionPolicy: POLICY_PATH,
    licenceRegister: LICENCES_PATH,
    exclusions: EXCLUSIONS_PATH,
    candidateUrls: CANDIDATE_URLS_PATH,
    summaryReport: REPORT_PATH,
    buildScript: BUILD_SCRIPT_PATH,
    test: TEST_PATH,
  };
  for (const [name, file] of Object.entries(expectedFiles)) {
    const actual = await fileHash(file);
    const expected = manifest.files[name]?.sha256;
    if (!expected) problems.push(`manifest missing ${name}`);
    else if (actual !== expected) problems.push(`${name} hash mismatch: ${actual} != ${expected}`);
  }
  if (manifest.files.readme) {
    const actual = await fileHash(README_PATH);
    if (actual !== manifest.files.readme.sha256) problems.push(`readme hash mismatch`);
  }
  if (manifest.inventorySha256 !== manifest.files.inventory?.sha256) problems.push("manifest inventorySha256 mismatch");
  if (!metrics.allChecksPassed) problems.push("policy checks failed");
  if (problems.length > 0) {
    const error = new Error(`source inventory check failed:\n${problems.join("\n")}`);
    error.problems = problems;
    throw error;
  }
  return { inventory, metrics, manifest, problems: [] };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check")) {
    const result = await checkOutputs();
    console.log(JSON.stringify({
      ok: true,
      inventoryVersion: result.inventory.inventoryVersion,
      sources: result.inventory.summary.totalSources,
      conservativeNovelCapacityTokens: result.inventory.summary.conservativeNovelCapacityTokens,
      conservativePlannedNovelTokens: result.inventory.summary.conservativePlannedNovelTokens,
      inventorySha256: result.manifest.inventorySha256,
    }, null, 2));
    return;
  }
  if (args.has("--json")) {
    const { inventory, metrics } = buildInventory();
    console.log(JSON.stringify({ summary: inventory.summary, counts: metrics.counts, checks: metrics.checks }, null, 2));
    return;
  }
  const { manifest } = await writeOutputs();
  console.log(JSON.stringify({
    ok: true,
    inventoryVersion: manifest.inventoryVersion,
    inventorySha256: manifest.inventorySha256,
    files: Object.fromEntries(Object.entries(manifest.files).map(([name, item]) => [name, item.sha256])),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    if (error.validationErrors) console.error(error.validationErrors.join("\n"));
    if (error.policyFailures) console.error(error.policyFailures.map((item) => `${item.id}: ${item.detail}`).join("\n"));
    process.exitCode = 1;
  });
}
