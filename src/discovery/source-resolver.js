import { classifyUrlQuality } from "./source-quality.js";

/**
 * Resolve archive.org item pages to their actual OCR/full text.
 *
 * A `/details/` page is a catalogue/navigation shell, never the source. The
 * metadata API is the authoritative machine-readable description of the item:
 * it names the available text files and declares the item language. This
 * resolver deliberately resolves ENGLISH full text only. It never downloads a
 * non-English body just to discover that the language gate will reject it.
 *
 * Network access is injected (`fetchText`) so production can route it through
 * the durable discovery-operation governor. The resolver performs no article
 * admission; the crawler admits the resolved download URL as the acquisition
 * target.
 */

export const RESOLUTION_STATUS = Object.freeze({
  NOT_APPLICABLE: "not-applicable",
  RESOLVED: "resolved",
  NON_ENGLISH: "non-english",
  UNVERIFIED_LANGUAGE: "unverified-language",
  NO_FULLTEXT: "no-fulltext",
  RESTRICTED: "restricted",
  RETRY: "retry",
});

const ARCHIVE_HOSTS = new Set(["archive.org", "www.archive.org"]);
const TEXT_FILE_FORMATS = new Set(["djvutxt", "text", "ocr", "additional text"]);
const NON_TEXT_FILE = /\.(?:pdf|epub|djvu|xml|json|gz|zip|tar|7z|rar|jpe?g|png|gif|svg|webp|mp3|mp4|ogg|wav|woff2?|ttf|eot)$/i;
const ENGLISH_LANGUAGES = new Set(["en", "eng", "english", "en-us", "en-gb", "en-au", "en-ca", "en-nz", "en-ie", "en-za"]);

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Return the archive.org item identifier for a `/details/` URL, or null. */
export function archiveOrgItemId(urlString) {
  let url;
  try {
    url = new URL(String(urlString ?? ""));
  } catch {
    return null;
  }
  if (!ARCHIVE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/details\/([^/]+)(?:\/|$)/i);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]).trim();
    return id || null;
  } catch {
    return null;
  }
}

/** True when this is an archive.org item/details page (not a direct download). */
export function isArchiveOrgItemUrl(urlString) {
  return Boolean(archiveOrgItemId(urlString));
}

function languageValues(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw
    .flatMap((v) => String(v ?? "").split(/[;,]/))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Classify the declared item language. English-only is required because the
 * resolver's purpose is to obtain an English training source; a mixed-language
 * item cannot tell us which language the selected text file contains.
 */
export function classifyArchiveLanguage(value) {
  const values = languageValues(value);
  if (!values.length) return { status: "unknown", reason: "missing-language", languages: values };
  const english = values.filter((v) => ENGLISH_LANGUAGES.has(v));
  if (english.length === values.length) return { status: "english", reason: null, languages: values };
  if (english.length === 0) return { status: "non-english", reason: "non-english-language", languages: values };
  return { status: "mixed", reason: "mixed-language", languages: values };
}

function fileSize(file) {
  const n = Number(file?.size);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function textCandidateScore(file, itemId) {
  const name = String(file?.name ?? "");
  const format = String(file?.format ?? "").trim().toLowerCase();
  if (!name || file.private === true || file.private === "true") return -1;
  if (NON_TEXT_FILE.test(name)) return -1;
  if (/^_?(?:meta|files|reviews|scandata)/i.test(name)) return -1;

  let score = 0;
  if (/_djvu\.txt$/i.test(name)) score = 100;
  else if (format === "djvutxt") score = 90;
  else if (/_hocr_searchtext\.txt$/i.test(name)) score = 80;
  else if (/\.txt$/i.test(name) && TEXT_FILE_FORMATS.has(format)) score = 70;
  else if (/\.txt$/i.test(name)) score = 50;
  else return -1;

  if (itemId && name.toLowerCase().includes(itemId.toLowerCase())) score += 5;
  return score;
}

/** Select the best single OCR/text file from archive.org metadata. */
export function selectArchiveTextFile(files, itemId = null) {
  const candidates = (Array.isArray(files) ? files : [])
    .map((file) => ({ file, score: textCandidateScore(file, itemId) }))
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score || fileSize(b.file) - fileSize(a.file));
  return candidates[0]?.file ?? null;
}

export function archiveDownloadUrl(itemId, fileName) {
  const encodedId = encodeURIComponent(itemId);
  const encodedName = String(fileName ?? "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://archive.org/download/${encodedId}/${encodedName}`;
}

function restrictedItem(metadata) {
  const item = metadata?.metadata ?? {};
  return (
    metadata?.is_dark === true ||
    item?.["access-restricted-item"] === true ||
    item?.["access-restricted-item"] === "true" ||
    item?.collection === "access-restricted"
  );
}

function retryable(error) {
  const code = String(error?.code ?? "");
  const status = Number(error?.status);
  return (
    code === "FETCH_TIMEOUT" ||
    code === "FETCH_NETWORK" ||
    code === "FETCH_DNS" ||
    (Number.isFinite(status) && (status === 429 || status >= 500))
  );
}

/**
 * Remove the archive.org digitisation cover notice. This is downloader chrome,
 * not book content; the book's own title/copyright pages remain untouched.
 */
export function cleanArchiveOrgText(text) {
  let out = String(text ?? "");
  out = out.replace(
    /^\s*Digitized by the Internet Archive[\s\S]{0,600}?https?:\/\/archive\.org\/details\/\S+\s*/i,
    "",
  );
  out = out.replace(
    /\n\s*Digitized by the Internet Archive\s*\n(?:\s*(?:in|with funding from|for)\b[^\n]*\n?){0,8}\s*https?:\/\/archive\.org\/details\/\S+\s*$/i,
    "\n",
  );
  return out.trim();
}

/**
 * @param {object} opts
 * @param {(url: string, opts?: object) => Promise<string>} opts.fetchText
 * @param {number} [opts.maxMetadataBytes]
 * @param {number} [opts.maxRedirects]
 */
export function createArchiveOrgResolver({
  fetchText,
  maxMetadataBytes = 1_000_000,
  maxRedirects = 3,
  adapter = "source-resolver",
} = {}) {
  if (typeof fetchText !== "function") throw new TypeError("fetchText is required");

  return async function resolveArchiveOrg(urlString) {
    const itemId = archiveOrgItemId(urlString);
    if (!itemId) return { status: RESOLUTION_STATUS.NOT_APPLICABLE };

    // Never resolve a URL shape the discovery policy already classifies as
    // non-content (e.g. a file/photo path masquerading as an item page).
    const quality = classifyUrlQuality(urlString);
    if (quality.action === "reject") {
      return {
        status: RESOLUTION_STATUS.NO_FULLTEXT,
        requestedUrl: urlString,
        itemId,
        reason: quality.reason ?? "non-content-url",
      };
    }

    const metadataUrl = `https://archive.org/metadata/${encodeURIComponent(itemId)}`;
    let metadata;
    try {
      const body = await fetchText(metadataUrl, {
        adapter,
        allowJson: true,
        maxBytes: maxMetadataBytes,
        maxRedirects,
      });
      metadata = JSON.parse(body);
    } catch (err) {
      if (retryable(err)) {
        return {
          status: RESOLUTION_STATUS.RETRY,
          requestedUrl: urlString,
          itemId,
          reason: err?.code ?? "metadata-fetch-failed",
          error: String(err?.message ?? err),
        };
      }
      return {
        status: RESOLUTION_STATUS.NO_FULLTEXT,
        requestedUrl: urlString,
        itemId,
        reason: err?.code === "FETCH_STATUS" ? "metadata-not-found" : "metadata-invalid",
      };
    }

    if (restrictedItem(metadata)) {
      return {
        status: RESOLUTION_STATUS.RESTRICTED,
        requestedUrl: urlString,
        itemId,
        reason: "access-restricted-item",
      };
    }

    const language = classifyArchiveLanguage(metadata?.metadata?.language);
    if (language.status === "non-english") {
      return {
        status: RESOLUTION_STATUS.NON_ENGLISH,
        requestedUrl: urlString,
        itemId,
        reason: language.reason,
        languages: language.languages,
      };
    }
    if (language.status !== "english") {
      return {
        status: RESOLUTION_STATUS.UNVERIFIED_LANGUAGE,
        requestedUrl: urlString,
        itemId,
        reason: language.reason ?? "unverified-language",
        languages: language.languages,
      };
    }

    const file = selectArchiveTextFile(metadata?.files, itemId);
    if (!file) {
      return {
        status: RESOLUTION_STATUS.NO_FULLTEXT,
        requestedUrl: urlString,
        itemId,
        reason: "no-ocr-fulltext",
        languages: language.languages,
      };
    }

    return {
      status: RESOLUTION_STATUS.RESOLVED,
      requestedUrl: urlString,
      resolvedUrl: archiveDownloadUrl(itemId, file.name),
      itemId,
      textFile: {
        name: file.name,
        format: file.format ?? null,
        size: fileSize(file) || null,
      },
      languages: language.languages,
      cleanText: true,
    };
  };
}

export default createArchiveOrgResolver;
