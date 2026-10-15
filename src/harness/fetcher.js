import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";

/**
 * Bounded, SSRF-aware single-document fetcher.
 *
 * This is deliberately NOT a crawler: it fetches ONE configured URL at a time
 * with hard limits (timeout, byte cap, content-type allow-list, redirect cap,
 * robots.txt) and returns extracted plain text. It never follows links, never
 * searches, and never invents sources. The Node data plane only ever reads the
 * configured-source URLs an operator supplied (CRAWL_URLS).
 */

export class FetchError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "FetchError";
    this.code = code;
    Object.assign(this, meta);
  }
}

const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;
const TEXT_TYPE = /^text\/[a-z0-9.+-]+\b/i;
// Sitemaps and RSS/Atom feeds are XML. Discovery adapters fetch them through
// this same bounded, SSRF-checked path, so the allow-list must admit them as
// text — but they are NOT HTML, so link-extraction must not be run on them.
const XML_TYPE = /^(application|text)\/(xml|atom\+xml|rss\+xml)\b/i;

/** Canonical content hash — MUST equal domain/article.js contentHash (sha256 utf8). */
export function contentHashFor(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** True for loopback / link-local / private / CGNAT / reserved addresses. */
export function isPrivateIp(ip) {
  if (typeof ip !== "string" || !ip) return true;
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd")) return true; // link-local / ULA
    const mapped = l.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed => block
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

/**
 * Enforce scheme + (unless explicitly allowed) public-address rules.
 * @returns {Promise<URL>}
 */
export async function assertUrlAllowed(urlString, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(urlString); }
  catch { throw new FetchError("FETCH_BAD_URL", `not a valid URL: ${urlString}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchError("FETCH_BAD_SCHEME", `only http/https allowed, got ${u.protocol}`, { url: u.href });
  }
  if (allowPrivate) return u;
  if (/^(localhost)$/i.test(u.hostname) || /\.(local|internal)$/i.test(u.hostname)) {
    throw new FetchError("FETCH_PRIVATE_ADDRESS", `refusing private hostname ${u.hostname}`, { url: u.href });
  }
  let addrs;
  try { addrs = await lookup(u.hostname, { all: true }); }
  catch { throw new FetchError("FETCH_DNS", `cannot resolve ${u.hostname}`, { url: u.href }); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new FetchError("FETCH_PRIVATE_ADDRESS", `refusing private/reserved address for ${u.hostname}`, { url: u.href });
  }
  return u;
}

// ------------------------------------------------------------------ robots
/** Parse a robots.txt into groups `{ agents, allow[], disallow[] }`. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue;
      if (value) current[field].push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** Longest-match robots decision for `path` given a user-agent token. */
export function robotsAllows(groups, path, userAgent = "") {
  const token = String(userAgent).toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && a && token.includes(a)));
  const pool = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of pool) {
    for (const rule of g.disallow) if (path.startsWith(rule) && (!best || rule.length > best.len)) best = { len: rule.length, allow: false };
    for (const rule of g.allow) if (path.startsWith(rule) && (!best || rule.length >= best.len)) best = { len: rule.length, allow: true };
  }
  return best ? best.allow : true;
}

// ------------------------------------------------------------------- html
function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function collapse(s) {
  return String(s).replace(/[ \t\f\v\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** Strip tags/scripts/styles and decode entities into readable plain text. */
export function htmlToText(html) {
  const src = String(html ?? "");
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const body = src
    .replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return {
    title: titleMatch ? collapse(decodeEntities(titleMatch[1])) || null : null,
    text: collapse(decodeEntities(body)),
  };
}

// ------------------------------------------------------------------ fetch
async function readCapped(body, maxBytes) {
  const reader = body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await new Response(body).arrayBuffer());
    if (buf.length > maxBytes) throw new FetchError("FETCH_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new FetchError("FETCH_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch ONE document under all bounds. Redirects are followed manually so every
 * hop is SSRF-checked. HTML is reduced to text; other text types are passed
 * through. Non-text and oversize bodies are rejected.
 *
 * @returns {Promise<{url,status,contentType,bytes,title,text,contentHash,redirects,fetchedAt}>}
 */
export async function fetchDocument(url, {
  timeoutMs = 15000,
  maxBytes = 2_000_000,
  maxRedirects = 5,
  allowPrivate = false,
  userAgent = "SimpleMindsAI/0.2",
  accept = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new FetchError("FETCH_UNAVAILABLE", "global fetch is unavailable");
  let current = url;
  let redirects = 0;
  for (;;) {
    await assertUrlAllowed(current, { allowPrivate });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": userAgent, accept },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") throw new FetchError("FETCH_TIMEOUT", `timed out after ${timeoutMs}ms`, { url: current });
      throw new FetchError("FETCH_NETWORK", err?.message ?? "network error", { url: current });
    }
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (redirects >= maxRedirects) throw new FetchError("FETCH_TOO_MANY_REDIRECTS", `more than ${maxRedirects} redirects`, { url: current });
        current = new URL(res.headers.get("location"), current).href;
        redirects += 1;
        continue;
      }
      if (!res.ok) throw new FetchError("FETCH_STATUS", `HTTP ${res.status}`, { url: current, status: res.status });
      const contentType = res.headers.get("content-type") ?? "";
      if (!HTML_TYPE.test(contentType) && !TEXT_TYPE.test(contentType) && !XML_TYPE.test(contentType)) {
        throw new FetchError("FETCH_BAD_CONTENT_TYPE", `unsupported content-type "${contentType}"`, { url: current });
      }
      const buf = await readCapped(res.body, maxBytes);
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const isHtml = HTML_TYPE.test(contentType);
      const { title, text } = isHtml ? htmlToText(raw) : { title: null, text: collapse(raw) };
      return {
        url: current,
        status: res.status,
        contentType,
        bytes: buf.length,
        title,
        text,
        // Raw HTML is retained ONLY so link discovery can extract anchors; callers
        // that just need text ignore it. It is null for non-HTML responses.
        html: isHtml ? raw : null,
        contentHash: contentHashFor(text),
        redirects,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
