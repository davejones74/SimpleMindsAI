import { createHash } from "node:crypto";

/**
 * Sealed evaluation cohorts.
 *
 * Two measurement cohorts are deliberately separate from the stable promotion
 * gate (`eval-002`) and from each other:
 *
 *   prospective — never trained, source/document-disjoint, fixed content hashes.
 *                 Measures generalisation to genuinely unseen knowledge.
 *   retention   — represents knowledge learned in earlier cycles. It must be
 *                 fixed and source-disjoint from the prospective cohort; it is
 *                 evaluated across later checkpoints to measure forgetting.
 *
 * A cohort is sealed when its manifest records the content hashes and the
 * training-exposure guard proves none of its rows has entered a snapshot or the
 * consumption ledger. This module does not train or score; it only builds and
 * verifies the immutable cohort identity so the measurement cannot drift.
 */

export const SEALED_COHORT_SCHEMA = "sma/sealed-cohort@1";
export const SEALED_COHORT_KINDS = Object.freeze(["prospective", "retention"]);

export function contentHashOf(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function createSealedCohort({
  id,
  kind,
  rows = [],
  source = null,
  createdAt = new Date().toISOString(),
  notes = null,
  trainedInVersions = null,
} = {}) {
  if (!id) throw new Error("sealed cohort id is required");
  if (!SEALED_COHORT_KINDS.includes(kind)) throw new Error(`unknown sealed cohort kind: ${kind}`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("sealed cohort must contain at least one row");
  const items = rows.map((row, index) => {
    const text = String(row?.text ?? row?.completion ?? "");
    if (!text.trim()) throw new Error(`sealed cohort row ${index} has no text`);
    const contentHash = contentHashOf(text);
    return {
      itemId: row?.itemId ?? row?.articleId ?? `${id}-${index}`,
      contentHash,
      sourceUrl: row?.sourceUrl ?? null,
      chars: text.length,
    };
  });
  const duplicate = items.find((item, index) => items.findIndex((other) => other.contentHash === item.contentHash) !== index);
  if (duplicate) throw new Error(`sealed cohort contains duplicate content: ${duplicate.contentHash.slice(0, 12)}`);

  const datasetHash = sha256(stableJson(items.map((item) => [item.itemId, item.contentHash])));
  return {
    schema: SEALED_COHORT_SCHEMA,
    id,
    kind,
    createdAt,
    sealed: true,
    neverTrain: true,
    source,
    notes,
    trainedInVersions: Array.isArray(trainedInVersions) ? trainedInVersions : null,
    itemCount: items.length,
    chars: items.reduce((sum, item) => sum + item.chars, 0),
    datasetHash,
    items,
  };
}

/**
 * Verify that a cohort has not leaked into training material.
 *
 * @param {object} cohort sealed cohort manifest
 * @param {object} options
 * @param {Set<string>|string[]} [options.seenContentHashes]
 * @param {Set<string>|string[]} [options.seenSourceUrls]
 */
export function verifySealedCohort(cohort, { seenContentHashes = [], seenSourceUrls = [] } = {}) {
  if (!cohort || cohort.schema !== SEALED_COHORT_SCHEMA) {
    return { ok: false, reason: "invalid-cohort-manifest", leaks: [] };
  }
  if (cohort.sealed !== true || cohort.neverTrain !== true) {
    return { ok: false, reason: "cohort-is-not-sealed", leaks: [] };
  }
  const hashes = seenContentHashes instanceof Set ? seenContentHashes : new Set(seenContentHashes);
  const urls = seenSourceUrls instanceof Set ? seenSourceUrls : new Set(seenSourceUrls);
  const leaks = [];
  for (const item of cohort.items ?? []) {
    if (hashes.has(item.contentHash)) leaks.push({ itemId: item.itemId, kind: "content-hash" });
    if (item.sourceUrl && urls.has(item.sourceUrl)) leaks.push({ itemId: item.itemId, kind: "source-url" });
  }
  return {
    ok: leaks.length === 0,
    reason: leaks.length ? "sealed-cohort-leaked" : null,
    itemCount: cohort.itemCount ?? cohort.items?.length ?? 0,
    datasetHash: cohort.datasetHash ?? null,
    leaks,
  };
}

/**
 * Verify the two cohorts are disjoint from each other by content hash and
 * source URL. A retention probe that overlaps the prospective benchmark can
 * make both measurements lie in opposite directions.
 */
export function verifyCohortDisjointness(prospective, retention) {
  if (!prospective?.items || !retention?.items) {
    return { ok: false, reason: "missing-cohort-items", overlaps: [] };
  }
  const p = new Map(prospective.items.map((item) => [item.contentHash, item]));
  const overlaps = [];
  for (const item of retention.items) {
    if (p.has(item.contentHash)) overlaps.push({ kind: "content-hash", itemId: item.itemId, otherId: p.get(item.contentHash).itemId });
  }
  const ps = new Map((prospective.items ?? []).filter((i) => i.sourceUrl).map((i) => [i.sourceUrl, i]));
  for (const item of retention.items) {
    if (item.sourceUrl && ps.has(item.sourceUrl)) overlaps.push({ kind: "source-url", itemId: item.itemId, otherId: ps.get(item.sourceUrl).itemId });
  }
  return { ok: overlaps.length === 0, reason: overlaps.length ? "cohorts-overlap" : null, overlaps };
}
