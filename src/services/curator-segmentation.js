/**
 * Source segmentation for curation.
 *
 * The historical curator sends only `rawText.slice(0, 14_000)` to the teacher.
 * For long-form sources that silently discards most of the fetched document
 * before the model ever sees it, and the units the teacher returns are often
 * far shorter than a 128-token training block.
 *
 * This module is deliberately pure and tokenizer-free: it decides *how much
 * source text to show the teacher* and *how adjacent teacher units are merged*.
 * Actual token counts are measured later by the Python tokenizer. The default
 * strategy preserves the whole source in bounded, sentence-aligned chunks and
 * merges adjacent units only within the same source/domain.
 */

export const CURATOR_STRATEGIES = Object.freeze(["legacy", "segmented"]);

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;
const PARAGRAPH_BOUNDARY = /\n\s*\n/;

export function normalizeSourceText(rawText) {
  return String(rawText ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongBlock(block, maxChars) {
  if (block.length <= maxChars) return [block];
  const sentences = block.split(SENTENCE_BOUNDARY).filter((s) => s.trim());
  const out = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    if (current.length + 1 + sentence.length <= maxChars) {
      current += ` ${sentence}`;
    } else {
      out.push(current);
      current = sentence;
    }
  }
  if (current) out.push(current);
  // A pathological single sentence can still exceed maxChars. Hard-split only
  // that remainder so the source is never silently dropped.
  return out.flatMap((piece) => {
    if (piece.length <= maxChars) return [piece];
    const hard = [];
    for (let i = 0; i < piece.length; i += maxChars) hard.push(piece.slice(i, i + maxChars));
    return hard;
  });
}

function mergeSmallBlocks(blocks, { minChars, maxChars }) {
  const out = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxChars && (current.length < minChars || block.length < minChars)) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    current = block;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split source text into coherent chunks. Coverage is complete: concatenating
 * the returned chunks (with paragraph separators) reconstructs every non-
 * whitespace character of the source. Nothing is silently truncated.
 */
export function segmentSourceText(rawText, {
  maxChars = 12_000,
  minChars = 1_000,
  targetChars = 4_000,
} = {}) {
  const text = normalizeSourceText(rawText);
  if (!text) return [];
  const max = Math.max(500, Number(maxChars) || 12_000);
  const min = Math.max(0, Math.min(Number(minChars) || 0, max));
  const target = Math.max(min || 1, Math.min(Number(targetChars) || max, max));

  const paragraphs = text.split(PARAGRAPH_BOUNDARY).map((p) => p.trim()).filter(Boolean);
  const blocks = paragraphs.flatMap((p) => splitLongBlock(p, max));
  const merged = mergeSmallBlocks(blocks, { minChars: Math.min(min, target), maxChars: max });

  // Coalesce adjacent chunks that are still below target without exceeding max.
  const chunks = [];
  let current = "";
  for (const block of merged) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (current && candidate.length <= Math.min(max, Math.max(target, min))) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = block;
  }
  if (current) chunks.push(current);

  return chunks.map((chunk, index) => ({
    index,
    strategy: "segmented",
    text: chunk,
    chars: chunk.length,
    totalChunks: chunks.length,
    truncated: false,
  }));
}

/**
 * Plan the teacher calls for one source. `legacy` reproduces the historical
 * single 14k slice; `segmented` returns every chunk of the full source.
 */
export function planCuration(rawText, {
  strategy = "segmented",
  legacyMaxChars = 14_000,
  maxChars = 12_000,
  minChars = 1_000,
  targetChars = 4_000,
} = {}) {
  const text = String(rawText ?? "");
  if (strategy === "legacy") {
    const slice = text.slice(0, Math.max(1, Number(legacyMaxChars) || 14_000));
    return [{
      index: 0,
      strategy: "legacy",
      text: slice,
      chars: slice.length,
      totalChunks: 1,
      truncated: text.length > slice.length,
      sourceChars: text.length,
    }];
  }
  const chunks = segmentSourceText(text, { maxChars, minChars, targetChars });
  return chunks.map((chunk) => ({ ...chunk, sourceChars: text.length }));
}

/**
 * Merge adjacent teacher units that are too small to be a useful training
 * block. Merging never crosses a domain or exceeds maxChars, so a merge cannot
 * silently mix unrelated material.
 */
export function mergeAdjacentUnits(units, { minChars = 800, maxChars = 6_000, mergeAcrossDomains = false } = {}) {
  const list = (Array.isArray(units) ? units : []).filter((u) => u && typeof u.text === "string" && u.text.trim());
  const out = [];
  let current = null;
  for (const unit of list) {
    const text = String(unit.text).trim();
    const domain = unit.domain ?? "general";
    if (!current) {
      current = { ...unit, text, domain };
      continue;
    }
    const combined = `${current.text}\n\n${text}`;
    const domainCompatible = mergeAcrossDomains || current.domain === domain;
    if (domainCompatible && current.text.length < minChars && combined.length <= maxChars) {
      current = { ...current, text: combined, mergedUnits: (current.mergedUnits ?? 1) + 1 };
      continue;
    }
    out.push(current);
    current = { ...unit, text, domain };
  }
  if (current) out.push(current);
  return out;
}

export function segmentationStats(plan, rawText) {
  const sourceChars = String(rawText ?? "").length;
  const visibleChars = (plan ?? []).reduce((sum, chunk) => sum + (chunk.chars ?? 0), 0);
  return {
    strategy: plan?.[0]?.strategy ?? "legacy",
    sourceChars,
    visibleChars,
    coverage: sourceChars ? Math.min(1, visibleChars / sourceChars) : 0,
    chunks: plan?.length ?? 0,
    truncated: Boolean(plan?.[0]?.truncated),
  };
}
