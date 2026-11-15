/**
 * Reversible content-quality assessment for training eligibility.
 *
 * This is deliberately SEPARATE from the review verdict, consumption history and
 * mission relevance. A page can be an honest review pass but still be unsuitable
 * training material (a product landing page, a pricing comparison, an SEO list
 * article). The assessment returns explainable signals so the decision can be
 * audited, shadowed and reversed without deleting the article or rewriting its
 * historical review/consumption records.
 */
export const CONTENT_QUALITY_POLICY_VERSION = "content-quality-v1";

const COMMERCIAL_PATH = /(?:^|[\/_-])(pricing|plans?|products?|catalog(?:ue)?|categories|category|compare|comparison|reviews?|buy|cart|checkout|trial|demo|solutions?|services?|jobs?|careers?|salary|salaries|affiliate|coupons?|deals?|best|top|crm|gadget|headset|stylus)(?=[\/_-]|$)/i;
const STRONG_COMMERCIAL_PATH = /(?:^|[\/_-])(pricing|plans?|products?|catalog(?:ue)?|compare|comparison|buy|cart|checkout|trial|demo|jobs?|careers?|salary|salaries|affiliate|coupons?|deals?|crm|gadget|headset|stylus)(?=[\/_-]|$)/i;
const TTS_PATH = /(?:^|[\/_-])(text[-_]to[-_]speech|speech[-_]to[-_]text|text[-_]to[-_]audio|speech[-_]synthesis)(?=[\/_-]|$)/i;
const COMMERCIAL_TITLE = /\b(best|top\s+\d+|review|reviews|pricing|price|plans?|buy|purchase|subscribe|subscription|free trial|book a demo|contact sales|coupon|discount|affiliate|vs\.?|comparison|salary|jobs?|careers?|hiring)\b/i;
const COMMERCIAL_PHRASES = [
  "add to cart", "buy now", "free trial", "book a demo", "contact sales",
  "pricing plans", "subscription plans", "affiliate program", "customer relationship management",
  "text to speech", "text-to-speech", "speech synthesis", "speech to text",
  "best crm", "top crm", "software comparison", "product comparison",
  "sign up today", "start your free trial", "request a demo", "get started free",
];
const CTA_LINE = /^(buy|try|start|book|request|subscribe|sign up|get started|contact sales|add to cart|learn more|shop now)\b/i;
const RETAIL_HOST_PATH = /(?:^|\/)(?:guides|style|shopping|fashion|beauty|reviews|deals)(?:\/|$|-)/i;
const MARKETING_PATH = /(?:^|\/)(?:use-cases?|resources?|solutions?|platforms?|products?)(?:\/|$|-)/i;
const TECHNICAL_HOSTS = new Set(["geeksforgeeks.org", "www.geeksforgeeks.org", "atscale.com", "www.atscale.com"]);
const PRICE = /(?:[$£€]\s?\d|\b\d+\s?(?:usd|gbp|eur)\b|\/\s?(?:mo|month|year|yr)\b)/i;

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function countPhrases(text, phrases) {
  const s = normalize(text);
  const hits = [];
  for (const phrase of phrases) if (s.includes(phrase)) hits.push(phrase);
  return hits;
}

function hasLoneSurrogate(text) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { i += 1; continue; }
      return true;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true;
  }
  return false;
}

function countWords(text) {
  return (String(text ?? "").match(/[A-Za-z0-9']+/g) ?? []).length;
}

/**
 * @returns {{policyVersion:string, decision:"allow"|"exclude", score:number,
 *   reasons:string[], signals:object, metrics:object}}
 */
export function assessContentQuality({ url = "", title = "", text = "" } = {}) {
  const rawUrl = String(url ?? "");
  let path = rawUrl;
  let host = "";
  try {
    const parsed = new URL(rawUrl);
    path = `${parsed.pathname}${parsed.search}`;
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch { /* URL may be absent in tests/fixtures */ }
  const lowerTitle = normalize(title);
  const body = String(text ?? "");
  const normalizedBody = normalize(body);
  const words = countWords(body);
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ctaLines = lines.filter((line) => CTA_LINE.test(line)).length;
  const linkCount = (body.match(/\bhttps?:\/\//gi) ?? []).length;
  const phraseHits = countPhrases(body, COMMERCIAL_PHRASES);
  const titleHits = COMMERCIAL_TITLE.test(lowerTitle) ? [lowerTitle] : [];
  const retailHostPath = /(?:^|\.)businessinsider\.com$/.test(host) && RETAIL_HOST_PATH.test(path);
  const marketingPath = MARKETING_PATH.test(path);
  const technicalHost = TECHNICAL_HOSTS.has(host);
  const pathHit = COMMERCIAL_PATH.test(path) || TTS_PATH.test(path) || retailHostPath || marketingPath || technicalHost;
  const strongPathHit = STRONG_COMMERCIAL_PATH.test(path) || TTS_PATH.test(path) || retailHostPath || marketingPath || technicalHost;
  const ttsPath = TTS_PATH.test(path);
  const priceHit = PRICE.test(body);
  const ctaDensity = lines.length ? ctaLines / lines.length : 0;
  const linkDensity = words ? linkCount / words : 0;
  const commercialDensity = words ? phraseHits.length / Math.max(1, words / 500) : 0;

  let score = 0;
  const reasons = [];
  if (hasLoneSurrogate(body)) {
    return {
      policyVersion: CONTENT_QUALITY_POLICY_VERSION,
      decision: "exclude",
      score: 1,
      reasons: ["invalid-unicode"],
      signals: { invalidUnicode: true },
      metrics: { words: countWords(body), lines: 0, linkCount: 0, ctaLines: 0 },
    };
  }
  if (strongPathHit) {
    score += ttsPath ? 0.55 : 0.6;
    reasons.push(ttsPath ? "commercial-tts-path" : retailHostPath ? "retail-host-path" : marketingPath ? "marketing-path" : technicalHost ? "technical-host" : "commercial-url-path");
  } else if (pathHit) {
    score += 0.35;
    reasons.push("commercial-url-path");
  }
  if (titleHits.length) {
    score += 0.25;
    reasons.push("commercial-title");
  }
  if (phraseHits.length) {
    score += Math.min(0.3, 0.12 + commercialDensity * 0.08);
    reasons.push("commercial-phrases");
  }
  if (priceHit) {
    score += 0.15;
    reasons.push("price-pattern");
  }
  if (ctaDensity >= 0.15 || ctaLines >= 3) {
    score += 0.2;
    reasons.push("call-to-action-density");
  }
  if (words > 0 && words < 80) {
    score += 0.1;
    reasons.push("thin-content");
  }
  if (linkDensity >= 0.04) {
    score += 0.15;
    reasons.push("link-heavy");
  }
  if (/^elevenlabs\.io$/.test(host) && ttsPath) {
    score += 0.1;
    reasons.push("known-tts-product");
  }

  score = Math.max(0, Math.min(1, score));
  const hardCommercial = strongPathHit || (pathHit && titleHits.length > 0) || (ttsPath && (phraseHits.length > 0 || words < 250));
  const decision = score >= 0.55 || hardCommercial ? "exclude" : "allow";
  return {
    policyVersion: CONTENT_QUALITY_POLICY_VERSION,
    decision,
    score,
    reasons: [...new Set(reasons)],
    signals: {
      pathHit,
      ttsPath,
      titleHit: titleHits.length > 0,
      phraseHits,
      priceHit,
      ctaLines,
      ctaDensity: +ctaDensity.toFixed(4),
      linkDensity: +linkDensity.toFixed(4),
      words,
    },
    metrics: { words, lines: lines.length, linkCount, ctaLines },
  };
}

export function isContentEligible(input) {
  return assessContentQuality(input).decision === "allow";
}
