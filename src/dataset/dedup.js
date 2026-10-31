import { createHash } from "node:crypto";

/**
 * Deterministic duplicate/near-duplicate clustering.
 *
 * This module is intentionally cheap: exact and normalised hashes first, then
 * MinHash + LSH banding over word shingles for near-duplicates. No embeddings and
 * no semantic model are used across the whole corpus. That keeps the cost linear
 * in corpus size up to candidate-pair verification and makes every decision
 * reproducible from the recorded policy version.
 *
 * Limits are documented rather than hidden:
 *   - Near-duplicate detection is lexical. Translations, aggressive paraphrases
 *     and entirely rewritten syndication are only caught when their source
 *     identifiers (canonical URL/fetched hash/family id) also match.
 *   - Short documents (< MIN_SHINGLES words) are never clustered by Jaccard;
 *     scores on a handful of shingles are misleading.
 */
export const DEDUP_POLICY_VERSION = "lexical-minhash-lsh-v1";
export const DEFAULT_SHINGLE_SIZE = 5;
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.6;
export const MIN_SHINGLES = 8;

const NUM_HASHES = 64;
const BANDS = 16;
const ROWS = NUM_HASHES / BANDS;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeDedupText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordShingles(text, size = DEFAULT_SHINGLE_SIZE) {
  const words = normalizeDedupText(text).split(" ").filter(Boolean);
  if (words.length < size) return new Set();
  const out = new Set();
  for (let i = 0; i <= words.length - size; i += 1) out.add(words.slice(i, i + size).join(" "));
  return out;
}

export function jaccardFromSets(a, b) {
  if (!a?.size || !b?.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const value of small) if (large.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function jaccardSimilarity(textA, textB, size = DEFAULT_SHINGLE_SIZE) {
  return jaccardFromSets(wordShingles(textA, size), wordShingles(textB, size));
}

/** FNV-1a 32-bit, deterministic and fast enough for shingle hashing. */
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function makePermutations(count = NUM_HASHES) {
  let state = 0x9e3779b9 >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push([next() | 1, next()]);
  return out;
}

const PERMUTATIONS = makePermutations();

export function minhashSignature(shingles) {
  const signature = new Uint32Array(NUM_HASHES).fill(0xffffffff);
  for (const shingle of shingles) {
    const hash = fnv1a(shingle);
    for (let i = 0; i < NUM_HASHES; i += 1) {
      const [a, b] = PERMUTATIONS[i];
      const value = (Math.imul(a, hash) + b) >>> 0;
      if (value < signature[i]) signature[i] = value;
    }
  }
  return signature;
}

export function lshCandidatePairs(items) {
  const buckets = new Map();
  const pairs = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const signature = items[index].signature;
    if (!signature) continue;
    for (let band = 0; band < BANDS; band += 1) {
      const start = band * ROWS;
      const key = `${band}:${Array.from(signature.subarray(start, start + ROWS)).join(",")}`;
      const bucket = buckets.get(key) ?? [];
      for (const other of bucket) {
        const a = Math.min(index, other);
        const b = Math.max(index, other);
        pairs.add(`${a}:${b}`);
      }
      bucket.push(index);
      buckets.set(key, bucket);
    }
  }
  return [...pairs].map((pair) => pair.split(":").map(Number));
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = new Array(size).fill(0);
  }
  find(value) {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }
  union(a, b) {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return false;
    if (this.rank[rootA] < this.rank[rootB]) [rootA, rootB] = [rootB, rootA];
    this.parent[rootB] = rootA;
    if (this.rank[rootA] === this.rank[rootB]) this.rank[rootA] += 1;
    return true;
  }
}

/**
 * Cluster content records.
 *
 * @param {Array<{articleId:string,text:string,contentHash?:string,normalizedHash?:string,sourceId?:string,familyId?:string}>} items
 * @returns {{policyVersion, shingleSize, threshold, clusters:Array, clusterByArticle:Map, pairs:Array}}
 */
export function buildContentClusters(items, {
  shingleSize = DEFAULT_SHINGLE_SIZE,
  threshold = DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  minShingles = MIN_SHINGLES,
} = {}) {
  const uf = new UnionFind(items.length);
  const exact = new Map();
  const normalized = new Map();
  const sources = new Map();
  const families = new Map();
  const prepared = items.map((item, index) => {
    const normalizedText = normalizeDedupText(item.text);
    const contentHash = item.contentHash || sha256(normalizedText);
    const normalizedHash = item.normalizedHash || sha256(normalizedText);
    const shingles = wordShingles(normalizedText, shingleSize);
    return {
      ...item,
      index,
      contentHash,
      normalizedHash,
      shingles,
      signature: shingles.size >= minShingles ? minhashSignature(shingles) : null,
    };
  });

  for (const item of prepared) {
    for (const [map, key] of [
      [exact, item.contentHash],
      [normalized, item.normalizedHash],
      [sources, item.sourceId],
      [families, item.familyId],
    ]) {
      if (!key) continue;
      if (map.has(key)) uf.union(item.index, map.get(key));
      else map.set(key, item.index);
    }
  }

  const candidates = lshCandidatePairs(prepared);
  const nearPairs = [];
  for (const [a, b] of candidates) {
    if (a === b) continue;
    if (!prepared[a].signature || !prepared[b].signature) continue;
    const similarity = jaccardFromSets(prepared[a].shingles, prepared[b].shingles);
    if (similarity >= threshold) {
      uf.union(a, b);
      nearPairs.push({ a: prepared[a].articleId, b: prepared[b].articleId, similarity: +similarity.toFixed(6) });
    }
  }

  const byRoot = new Map();
  for (const item of prepared) {
    const root = uf.find(item.index);
    const members = byRoot.get(root) ?? [];
    members.push(item);
    byRoot.set(root, members);
  }

  const clusters = [];
  const clusterByArticle = new Map();
  for (const members of byRoot.values()) {
    const sorted = [...members].sort((a, b) => String(a.articleId).localeCompare(String(b.articleId)));
    const identity = sorted.map((m) => m.contentHash).sort().join("|");
    const clusterId = sha256(identity).slice(0, 16);
    const cluster = {
      clusterId,
      articleIds: sorted.map((m) => m.articleId),
      contentHashes: sorted.map((m) => m.contentHash).sort(),
      sourceIds: [...new Set(sorted.map((m) => m.sourceId).filter(Boolean))].sort(),
      familyIds: [...new Set(sorted.map((m) => m.familyId).filter(Boolean))].sort(),
      exactDuplicate: new Set(sorted.map((m) => m.contentHash)).size < sorted.length,
      nearDuplicate: nearPairs.some((pair) => sorted.some((m) => m.articleId === pair.a) && sorted.some((m) => m.articleId === pair.b)),
      shortDocuments: sorted.filter((m) => m.shingles.size < minShingles).map((m) => m.articleId),
    };
    clusters.push(cluster);
    for (const member of sorted) clusterByArticle.set(member.articleId, clusterId);
  }

  return {
    policyVersion: DEDUP_POLICY_VERSION,
    shingleSize,
    threshold,
    minShingles,
    clusters,
    clusterByArticle,
    pairs: nearPairs,
  };
}


/** Streaming MinHash signature: O(1) memory per document. */
export function minhashSignatureForText(text, { shingleSize = DEFAULT_SHINGLE_SIZE, hashCount = 32 } = {}) {
  const words = normalizeDedupText(text).split(" ").filter(Boolean);
  const count = Math.max(1, Math.min(NUM_HASHES, Number(hashCount) || 32));
  const signature = new Uint32Array(count).fill(0xffffffff);
  if (words.length < shingleSize) return signature;
  for (let i = 0; i <= words.length - shingleSize; i += 1) {
    const hash = fnv1a(words.slice(i, i + shingleSize).join(" "));
    for (let j = 0; j < count; j += 1) {
      const [a, b] = PERMUTATIONS[j];
      const value = (Math.imul(a, hash) + b) >>> 0;
      if (value < signature[j]) signature[j] = value;
    }
  }
  return signature;
}

/** LSH band keys for a MinHash signature (default 8 bands x 4 rows for 32 hashes). */
export function lshBandKeys(signature, { bands = Math.floor((signature?.length ?? 0) / 4) } = {}) {
  if (!signature || !signature.length) return [];
  const rows = Math.floor(signature.length / Math.max(1, bands));
  const out = [];
  for (let band = 0; band < bands; band += 1) {
    const values = [];
    for (let row = 0; row < rows; row += 1) values.push(signature[band * rows + row]);
    out.push(`${band}:${values.join(",")}`);
  }
  return out;
}
