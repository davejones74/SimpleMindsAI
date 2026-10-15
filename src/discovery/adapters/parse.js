/**
 * Minimal, dependency-free scanners for the discovery adapters.
 *
 * These are deliberately NOT a general XML parser. Sitemaps and feeds have a
 * tiny, well-specified shape, and a bounded scan cannot be talked into entity
 * expansion or deep nested parsing, so it is the safe choice for untrusted
 * remote input. Every helper operates on a string the fetch layer already
 * bounded by the byte cap and never throws on malformed input — it returns
 * "nothing found" so a bad document can never take a discovery pass down.
 */

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ""; }
    })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function stripCdata(s) {
  if (s == null) return null;
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s);
  return m ? m[1] : s;
}

/** Text content of the first `<tag>` inside a block, entity-decoded and trimmed. */
function textOf(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeXmlEntities(stripCdata(m[1])).trim() : null;
}

/** Value of `name="…"` (or single-quoted) on a tag string, entity-decoded. */
function attrOf(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(String(tag ?? ""));
  const raw = m ? (m[1] ?? m[2] ?? "") : null;
  return raw == null ? null : decodeXmlEntities(raw);
}

/**
 * Resolve a possibly-relative reference against a base URL. Only http(s) is
 * accepted; fragments are dropped. Returns null for anything unusable.
 */
export function resolveHttpUrl(ref, base = null) {
  const raw = String(stripCdata(ref) ?? "").trim().replace(/&amp;/gi, "&");
  if (!raw) return null;
  let u;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  return u.href;
}

/**
 * Parse a sitemap document.
 * Returns `{ type, urls, sitemaps }`:
 *   - `<sitemapindex>` => type "sitemapindex", `sitemaps` = child sitemap URLs
 *   - `<urlset>`       => type "urlset", `urls` = page URLs
 * Anything else => type "unknown" with no entries. Never throws.
 */
export function parseSitemap(xml, baseUrl = null) {
  const src = String(xml ?? "");
  const isIndex = /<sitemapindex\b/i.test(src);
  const isUrlset = /<urlset\b/i.test(src);
  if (!isIndex && !isUrlset) return { type: "unknown", urls: [], sitemaps: [] };

  const urls = [];
  const sitemaps = [];
  const blockRe = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    const loc = textOf(m[2], "loc");
    const resolved = resolveHttpUrl(loc, baseUrl);
    if (!resolved) continue;
    if (m[1].toLowerCase() === "sitemap") sitemaps.push(resolved);
    else urls.push(resolved);
  }
  return isIndex
    ? { type: "sitemapindex", urls: [], sitemaps }
    : { type: "urlset", urls, sitemaps: [] };
}

/** Extract `Sitemap:` directives from a robots.txt body. */
export function sitemapsFromRobots(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(raw);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Parse an RSS 2.0 or Atom feed into absolute http(s) item/entry links.
 * RSS uses `<item><link>URL</link>`; Atom uses `<entry><link href="URL"/>`.
 * Also tolerates a bare `<link href>` on RSS items. Never throws.
 */
export function parseFeed(xml, baseUrl = null) {
  const src = String(xml ?? "");
  const links = [];

  const add = (raw) => {
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved) links.push(resolved);
  };

  const items = src.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const text = textOf(item, "link"); // RSS 2.0
    add(text ?? attrOf(item, "link"));
  }

  const entries = src.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? [];
  for (const entry of entries) {
    // Atom: prefer rel="alternate", else the first href in the entry.
    const alt = entry.match(/<link\b[^>]*rel\s*=\s*["']alternate["'][^>]*>/i);
    add(attrOf(alt ? alt[0] : entry, "href"));
  }

  return links;
}

/**
 * Extract RSS/Atom `<link rel="alternate">` feed URLs advertised by an HTML
 * page. Only `type` values that look like a feed are considered.
 */
export function extractFeedLinksFromHtml(html, baseUrl = null) {
  const out = [];
  const tags = String(html ?? "").match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const type = attrOf(tag, "type") ?? "";
    if (!/\b(rss|atom|feed)\b/i.test(type)) continue;
    const resolved = resolveHttpUrl(attrOf(tag, "href"), baseUrl);
    if (resolved) out.push(resolved);
  }
  return out;
}
