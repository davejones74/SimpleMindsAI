/**
 * Deterministic discovery-time URL quality filter.
 *
 * Frontier volume is not a virtue. A large share of queued URLs are Wikimedia
 * file/category/special/template pages, images, login/search endpoints and
 * other non-article resources that can never become useful training prose.
 * Fetching and curating them wastes admission budget, teacher time and disk.
 *
 * This is a URL-shape filter, not a domain allow/deny list and not a language
 * prior: an English article on any host still passes unless its URL is a known
 * non-content resource. The ingest/review gates remain authoritative for the
 * actual text.
 */

export const URL_QUALITY_MODES = Object.freeze(["off", "shadow", "enforce"]);

const WIKI_NAMESPACE = /\/wiki\/(File|Image|Category|Special|Template|Talk|User|User_talk|Help|Portal|Wikipedia|Draft|Module|MediaWiki|TimedText|Book|Education_Program)(?::|%3A)/i;
const NON_ARTICLE_PATH = /\/(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|checkout|search|searchresults|w\/index\.php|wp-json|feed|rss|api\/)(?:\/|$|\?)/i;
const NON_CONTENT_EXT = /\.(?:jpe?g|png|gif|svg|webp|ico|bmp|tiff?|mp3|mp4|m4a|avi|mov|webm|ogg|wav|zip|gz|tar|7z|rar|css|js|json|xml|woff2?|ttf|eot)(?:\?|$)/i;
const NON_HTTP_SCHEME = /^(?:mailto|tel|javascript|data|file):/i;
const KNOWN_NON_CONTENT_HOSTS = [
  "donate.wikimedia.org",
  "foundation.wikimedia.org",
  "wikimediafoundation.org",
  "stats.wikimedia.org",
  "phabricator.wikimedia.org",
  "wikitech.wikimedia.org",
  "incubator.wikimedia.org",
  "test.wikipedia.org",
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * @returns {{action:"allow"|"reject", kind:string|null, reason:string|null, host:string|null}}
 */
export function classifyUrlQuality(urlString) {
  const raw = String(urlString ?? "").trim();
  if (!raw) return { action: "reject", kind: "empty", reason: "empty-url", host: null };
  if (NON_HTTP_SCHEME.test(raw)) return { action: "reject", kind: "scheme", reason: "non-http-scheme", host: null };
  const host = hostOf(raw);
  if (!host) return { action: "reject", kind: "bad-url", reason: "bad-url", host: null };
  if (KNOWN_NON_CONTENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { action: "reject", kind: "host", reason: "non-content-host", host };
  }
  const pathAndQuery = (() => {
    try {
      const u = new URL(raw);
      return `${u.pathname}${u.search}`;
    } catch {
      return raw;
    }
  })();
  if (WIKI_NAMESPACE.test(pathAndQuery)) {
    const match = pathAndQuery.match(WIKI_NAMESPACE);
    return { action: "reject", kind: "wiki-namespace", reason: `wiki-namespace:${(match?.[1] ?? "special").toLowerCase()}`, host };
  }
  if (NON_ARTICLE_PATH.test(pathAndQuery)) {
    return { action: "reject", kind: "non-article-path", reason: "non-article-path", host };
  }
  if (NON_CONTENT_EXT.test(pathAndQuery)) {
    return { action: "reject", kind: "non-content-extension", reason: "non-content-extension", host };
  }
  return { action: "allow", kind: null, reason: null, host };
}

export function classifyUrlQualityWithMode(urlString, mode = "enforce") {
  const result = classifyUrlQuality(urlString);
  if (mode === "off") return { ...result, action: "allow", shadowRejected: false };
  if (mode === "shadow") return { ...result, action: "allow", shadowRejected: result.action === "reject" };
  return result;
}
