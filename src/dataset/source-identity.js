/**
 * Canonical source identity.
 *
 * A fetched URL is not a source identity: archive captures, query-string
 * variants and redirect targets can all represent the same underlying page.
 * This module keeps the fetched URL for provenance while deriving a stable
 * original/canonical URL and publisher for selection and diversity.
 */
import { normalizeSourceUrl, publisherFromUrl } from "./partition.js";

const ARCHIVE_WEB_PATH = /^\/(?:web|wayback)\/(?:\d{8,14}(?:id_)?\/)?(.+)$/i;

// Common multi-label public suffixes. This is deliberately a conservative
// registrable-domain heuristic: unknown suffixes fall back to the last two
// labels rather than merging unrelated hosts. It is used for publisher
// diversity/fairness, never for fetch identity or robots checks.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.in", "net.in", "org.in", "ac.in", "gov.in",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "com.tr", "com.sg", "com.hk", "com.my",
  "com.tw", "com.pk", "com.ua", "com.ar", "com.co",
  "com.pe", "com.ve", "co.za", "co.kr", "or.kr", "go.kr", "ac.kr",
  "co.il", "org.il", "ac.il", "gov.il",
  "co.id", "or.id", "ac.id", "go.id",
  "com.ph", "com.vn", "com.eg", "com.sa", "com.ng", "com.gh",
]);

/** Extract the original URL from a web.archive.org capture, if present. */
export function unwrapArchiveUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!/^(?:web\.)?archive\.org$/.test(host)) return null;
  const match = url.pathname.match(ARCHIVE_WEB_PATH);
  if (!match) return null;
  let original = match[1];
  if (!/^https?:\/\//i.test(original)) original = `http://${original}`;
  try {
    const parsed = new URL(original);
    return parsed.toString();
  } catch {
    return null;
  }
}

/** The original URL when known, otherwise the fetched/source URL. */
export function originalSourceUrl(articleOrUrl) {
  const value = typeof articleOrUrl === "string" ? articleOrUrl : articleOrUrl?.sourceUrl;
  return unwrapArchiveUrl(value) ?? (value ? String(value) : null);
}

/** Stable canonical identity, stripping archive wrapper and URL noise. */
export function canonicalSourceUrl(articleOrUrl) {
  const value = typeof articleOrUrl === "string"
    ? articleOrUrl
    : articleOrUrl?.sourceUrl ?? articleOrUrl?.fetchedUrl;
  const original = unwrapArchiveUrl(value) ?? value;
  return normalizeSourceUrl(original);
}

/** Publisher of the underlying source, never the archive host. */
/** Conservative registrable-domain identity used for publisher diversity. */
export function registrableDomain(value) {
  const host = String(value ?? "").toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** Canonical publisher identity for an article/URL, with host preserved separately. */
export function publisherIdentity(articleOrUrl) {
  const value = typeof articleOrUrl === "string" ? articleOrUrl : articleOrUrl?.sourceUrl;
  const host = sourcePublisher(articleOrUrl) ?? null;
  return {
    host,
    publisherDomain: host ? registrableDomain(host) : null,
  };
}

export function sourcePublisher(articleOrUrl) {
  const value = typeof articleOrUrl === "string" ? articleOrUrl : articleOrUrl?.sourceUrl;
  return publisherFromUrl(unwrapArchiveUrl(value) ?? value);
}

/**
 * Capture identity: the exact fetched representation, used to choose one
 * capture when multiple snapshots of the same canonical source are present.
 */
export function captureIdentity(article) {
  return article?.fetchedContentHash
    ?? normalizeSourceUrl(article?.fetchedUrl ?? article?.sourceUrl)
    ?? article?.articleId
    ?? "unknown";
}

export function isArchiveCapture(articleOrUrl) {
  const value = typeof articleOrUrl === "string" ? articleOrUrl : articleOrUrl?.sourceUrl;
  return Boolean(unwrapArchiveUrl(value));
}
