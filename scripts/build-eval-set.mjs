// Build the bundled, immutable evaluation corpus `data/evaluation/eval-002.jsonl`.
//
// The frozen evaluation set is the ONLY promotion gate, so its size and
// representativeness decide whether a promotion is a real signal or noise. The
// shipped `eval-001` seed is 5 short Q/A rows (~105 tokens -> 3 blocks); loss
// measured there is dominated by sampling noise. This script fetches a broad,
// domain-stratified corpus of real English Wikipedia article extracts and writes
// one JSON row per document (raw article `text`, which is what the causal-LM
// loss is actually measured on).
//
// It is DETERMINISTIC and re-runnable: the title list, order, article ids and
// trim boundary are fixed, so the same inputs produce a byte-identical file.
// Re-run only with intent; once commit is frozen, editing the file invalidates
// comparability of the whole promotion ladder.
//
// Usage:
//   node scripts/build-eval-set.mjs [--out data/evaluation/eval-002.jsonl]
//                                  [--max-chars 4000] [--min-chars 1500]
//                                  [--dataset eval-002]
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_SET_DATE = "2026-10-18";
const API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = "SimpleMindsAI-eval-builder/1.0 (frozen evaluation corpus; local operator)";

// Domain-stratified, stable educational titles. Kept deliberately narrow to
// long-lived articles so the corpus is reproducible across rebuilds.
const DOMAINS = {
  history: ["Steam engine", "Industrial Revolution", "Roman Empire", "Silk Road", "Age of Enlightenment", "Printing press", "Byzantine Empire", "Magna Carta"],
  science: ["Photosynthesis", "Cell (biology)", "DNA", "Evolution", "Periodic table", "Atom", "Gravity", "Quantum mechanics"],
  astronomy: ["Solar System", "Black hole", "General relativity", "Electromagnetic radiation", "Speed of light", "Big Bang", "Telescope", "Milky Way"],
  technology: ["Computer", "Internet", "Algorithm", "Artificial intelligence", "Integrated circuit", "Telephone", "Semiconductor", "Compiler"],
  geography: ["Nile", "Amazon River", "Mount Everest", "Sahara", "Pacific Ocean", "Himalayas", "Andes", "Great Barrier Reef"],
  arts: ["Renaissance", "Impressionism", "Jazz", "William Shakespeare", "Orchestra", "Photography", "Architecture", "Sculpture"],
  life: ["Immune system", "Vaccine", "Human brain", "Neuron", "Antibiotic", "Enzyme", "Metabolism", "Human digestive system"],
  society: ["Democracy", "Constitution", "Economics", "Money", "Language", "Writing", "Agriculture", "Cartography"],
};

function parseArgs(argv) {
  const out = { out: "data/evaluation/eval-002.jsonl", maxChars: 4000, minChars: 1500, dataset: "eval-002" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--max-chars") out.maxChars = Number(argv[++i]);
    else if (a === "--min-chars") out.minChars = Number(argv[++i]);
    else if (a === "--dataset") out.dataset = argv[++i];
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.maxChars) || out.maxChars <= 0) throw new Error("--max-chars must be positive");
  if (!Number.isFinite(out.minChars) || out.minChars < 0) throw new Error("--min-chars must be >= 0");
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Collapse the extract to single-spaced prose and trim at a sentence boundary. */
function normalise(text, maxChars) {
  const clean = String(text ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= maxChars) return clean;
  const window = clean.slice(0, maxChars);
  const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
  return (cut > maxChars * 0.5 ? window.slice(0, cut + 1) : window).trim();
}

// `prop=extracts` returns only ONE full extract per request (exlimit is capped
// at 1 for explaintext), so we fetch one title at a time, slowly, with backoff.
async function fetchExtract(title) {
  const url =
    `${API}?action=query&format=json&prop=extracts&explaintext=1&redirects=1&exlimit=1` +
    `&titles=${encodeURIComponent(title)}`;
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const page = Object.values(json?.query?.pages ?? {})[0];
    if (page && page.missing == null && typeof page.extract === "string" && page.extract.length) {
      return page;
    }
    // A redirect may have collapsed the requested title into a canonical page.
    return null;
  }
  throw new Error("rate limited / server error after retries");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = path.resolve(REPO_ROOT, args.out);
  await mkdir(path.dirname(file), { recursive: true });

  // Resume-safe: keep already-fetched rows, keyed by articleId, and re-emit the
  // whole file in the canonical DOCDOMAIN order after every document so a
  // rate-limit kill never loses progress and rebuilds stay byte-identical.
  const order = new Map();
  let rank = 0;
  for (const titles of Object.values(DOMAINS)) for (const t of titles) order.set(t, rank++);
  const rows = new Map();
  if (existsSync(file)) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.articleId) rows.set(r.articleId, r);
      } catch {
        /* ignore corrupt tail */
      }
    }
  }
  const titleOf = (r) => (r.sourceUrl ? decodeURIComponent(r.sourceUrl.split("/wiki/")[1].replace(/_/g, " ")) : "");
  const idFor = (title) => `ev_${args.dataset}_${slug(title)}`;
  const writeOut = () =>
    writeFile(
      file,
      [...rows.values()]
        .sort((a, b) => (order.get(titleOf(a)) ?? 1e9) - (order.get(titleOf(b)) ?? 1e9))
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8"
    );

  let fetched = 0;
  let skipped = 0;
  for (const [domain, titles] of Object.entries(DOMAINS)) {
    for (const title of titles) {
      if (rows.has(idFor(title))) continue;
      let page;
      try {
        page = await fetchExtract(title);
      } catch (err) {
        skipped++;
        console.error(`SKIP ${domain}/${title}: ${err.message}`);
        await sleep(1500);
        continue;
      }
      if (!page) {
        skipped++;
        console.error(`SKIP ${domain}/${title}: no extract`);
        await sleep(1500);
        continue;
      }
      const text = normalise(page.extract, args.maxChars);
      if (text.length < args.minChars) {
        skipped++;
        console.error(`SKIP ${domain}/${title}: extract too short (${text.length} chars)`);
        await sleep(1500);
        continue;
      }
      rows.set(idFor(page.title), {
        articleId: idFor(page.title),
        promptId: idFor(page.title),
        text,
        domain,
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
        source: "wikipedia-en",
        createdAt: EVAL_SET_DATE,
      });
      fetched++;
      await writeOut();
      console.error(`ok ${domain}/${title} (${rows.size} total)`);
      await sleep(1500);
    }
  }
  if (!rows.size) throw new Error("no documents fetched; refusing to write an empty eval set");
  await writeOut();

  const list = [...rows.values()];
  const chars = list.reduce((n, r) => n + r.text.length, 0);
  const estTokens = Math.round(chars / 4);
  const byDomain = list.reduce((m, r) => ((m[r.domain] = (m[r.domain] ?? 0) + 1), m), {});
  console.log(`wrote ${list.length} document(s), ${chars} chars (~${estTokens} tokens) to ${path.relative(REPO_ROOT, file)}`);
  console.log(`skipped ${skipped}; domains: ${Object.entries(byDomain).map(([d, n]) => `${d}:${n}`).join(" ")}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
