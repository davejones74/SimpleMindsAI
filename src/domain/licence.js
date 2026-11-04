import { createHash } from "node:crypto";

/**
 * Durable source licensing and attribution.
 *
 * The article ledger historically recorded source identity but not the reuse
 * terms of the source. That makes "licence-compliant knowledge" impossible to
 * distinguish from merely "downloaded knowledge". This module resolves a
 * conservative licence decision from (a) an explicitly declared licence and
 * (b) the source host, and records the decision on the article.
 *
 * It is deliberately NOT a legal opinion. `safe` means the source family has a
 * documented permissive/public-domain reuse basis suitable for this research
 * pipeline; `uncertain` requires item-level review; `restricted` must not be
 * trained; `unknown` is not assumed safe. Unknown/uncertain material is still
 * retained and reviewable — enforcement is a separate policy switch.
 *
 * The host lists are the same conservative pilot policy used by the historical
 * replay migration. `test/licence.test.js` pins them to the JSON policy so the
 * runtime and the audit tool cannot silently drift.
 */

export const LICENCE_STATUS = Object.freeze({
  SAFE: "safe",
  UNCERTAIN: "uncertain",
  RESTRICTED: "restricted",
  UNKNOWN: "unknown",
});

export const LICENCE_DECISION = Object.freeze({
  ALLOW: "allow",
  REVIEW: "review",
  DENY: "deny",
});

export const LICENCE_POLICY_VERSION = "source-licence-policy-v1";

export const LICENCE_REGISTRY = Object.freeze({
  "CC0-1.0": {
    name: "Creative Commons CC0 1.0 Universal",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: false,
    shareAlike: false,
    commercialUse: true,
  },
  "PD-US": {
    name: "U.S. public domain",
    url: "https://www.copyright.gov/title17/",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: false,
    shareAlike: false,
    commercialUse: true,
  },
  "US-Gov-Work": {
    name: "U.S. Government work",
    url: "https://www.usa.gov/government-works",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: false,
    shareAlike: false,
    commercialUse: true,
  },
  "CC-BY-4.0": {
    name: "Creative Commons Attribution 4.0 International",
    url: "https://creativecommons.org/licenses/by/4.0/",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: true,
    shareAlike: false,
    commercialUse: true,
  },
  "CC-BY-3.0": {
    name: "Creative Commons Attribution 3.0 Unported",
    url: "https://creativecommons.org/licenses/by/3.0/",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: true,
    shareAlike: false,
    commercialUse: true,
  },
  "CC-BY-SA-4.0": {
    name: "Creative Commons Attribution-ShareAlike 4.0 International",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    status: LICENCE_STATUS.UNCERTAIN,
    attributionRequired: true,
    shareAlike: true,
    commercialUse: true,
  },
  "CC-BY-SA-3.0": {
    name: "Creative Commons Attribution-ShareAlike 3.0 Unported",
    url: "https://creativecommons.org/licenses/by-sa/3.0/",
    status: LICENCE_STATUS.UNCERTAIN,
    attributionRequired: true,
    shareAlike: true,
    commercialUse: true,
  },
  "CC-BY-NC-4.0": {
    name: "Creative Commons Attribution-NonCommercial 4.0 International",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
    status: LICENCE_STATUS.RESTRICTED,
    attributionRequired: true,
    shareAlike: false,
    commercialUse: false,
  },
  "CC-BY-NC-SA-4.0": {
    name: "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International",
    url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    status: LICENCE_STATUS.RESTRICTED,
    attributionRequired: true,
    shareAlike: true,
    commercialUse: false,
  },
  "MIT": {
    name: "MIT License",
    url: "https://opensource.org/license/mit",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: true,
    shareAlike: false,
    commercialUse: true,
  },
  "Apache-2.0": {
    name: "Apache License 2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: true,
    shareAlike: false,
    commercialUse: true,
  },
  "BSD-3-Clause": {
    name: "BSD 3-Clause License",
    url: "https://opensource.org/license/bsd-3-clause",
    status: LICENCE_STATUS.SAFE,
    attributionRequired: true,
    shareAlike: false,
    commercialUse: true,
  },
});

export const DEFAULT_LICENCE_POLICY = Object.freeze({
  version: LICENCE_POLICY_VERSION,
  safeDomains: Object.freeze([
    "gutenberg.org", "standardebooks.org", "docs.python.org", "python.org",
    "nasa.gov", "science.nasa.gov", "ntrs.nasa.gov", "nist.gov", "nvlpubs.nist.gov",
    "dlmf.nist.gov", "usgs.gov", "pubs.usgs.gov", "noaa.gov", "repository.library.noaa.gov",
    "cdc.gov", "nih.gov", "nlm.nih.gov", "medlineplus.gov", "usda.gov", "nal.usda.gov",
    "census.gov", "bls.gov", "epa.gov", "nps.gov", "energy.gov", "osti.gov", "gov.uk",
    "europa.eu", "worldbank.org", "openknowledge.worldbank.org", "oecd.org",
    "ourworldindata.org", "openlogicproject.org", "forallx.openlogicproject.org",
    "doc.rust-lang.org", "go.dev", "postgresql.org", "kubernetes.io", "tensorflow.org",
    "plos.org", "journals.plos.org", "elifesciences.org", "ncbi.nlm.nih.gov",
    "pmc.ncbi.nlm.nih.gov", "frontiersin.org", "biomedcentral.com", "mdpi.com",
    "copernicus.org", "oapen.org",
  ]),
  uncertainDomains: Object.freeze([
    "arxiv.org", "wikipedia.org", "wikibooks.org", "wikisource.org", "openstax.org",
    "ocw.mit.edu", "libretexts.org", "khanacademy.org", "who.int", "fao.org",
    "imf.org", "unesco.org",
  ]),
  restrictedDomains: Object.freeze([]),
});

function hostOf({ sourceUrl = null, sourceDomain = null } = {}) {
  if (sourceDomain) return String(sourceDomain).toLowerCase().replace(/^www\./, "");
  try {
    return new URL(String(sourceUrl)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function matchesDomain(host, domains = []) {
  const normalised = String(host ?? "").toLowerCase().replace(/^www\./, "");
  return domains.some((domain) => normalised === domain || normalised.endsWith(`.${domain}`));
}

function normaliseLicenceId(value) {
  return String(value ?? "").trim();
}

function hostFallbackLicenceId(host) {
  if (!host) return null;
  if (matchesDomain(host, DEFAULT_LICENCE_POLICY.safeDomains)) return "US-Gov-Work";
  if (host.endsWith("wikipedia.org")) return "CC-BY-SA-4.0";
  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) return "CC-BY-4.0";
  return null;
}

/**
 * Resolve a durable licence record. This function never throws on missing
 * metadata: an absent licence is `unknown`, not `safe`.
 */
export function resolveLicence({
  sourceUrl = null,
  sourceDomain = null,
  licenceId = null,
  licenceUrl = null,
  attribution = null,
  declaredStatus = null,
  policy = DEFAULT_LICENCE_POLICY,
} = {}) {
  const host = hostOf({ sourceUrl, sourceDomain });
  const declared = normaliseLicenceId(licenceId);
  const registry = declared ? LICENCE_REGISTRY[declared] ?? null : null;
  let status = LICENCE_STATUS.UNKNOWN;
  let reason = "source family is not in the licence policy";
  let id = declared || null;
  let name = registry?.name ?? null;
  let url = licenceUrl || registry?.url || null;
  let attributionRequired = registry?.attributionRequired ?? false;
  let shareAlike = registry?.shareAlike ?? false;
  let commercialUse = registry?.commercialUse ?? null;

  if (declaredStatus && Object.values(LICENCE_STATUS).includes(declaredStatus)) {
    status = declaredStatus;
    reason = "status explicitly declared by caller";
  } else if (registry) {
    status = registry.status;
    reason = `declared licence ${declared}`;
  } else if (matchesDomain(host, policy.restrictedDomains)) {
    status = LICENCE_STATUS.RESTRICTED;
    reason = "source family is explicitly restricted";
  } else if (matchesDomain(host, policy.safeDomains)) {
    status = LICENCE_STATUS.SAFE;
    reason = "source family is on the conservative safe list";
    id = id || hostFallbackLicenceId(host);
    const fallback = id ? LICENCE_REGISTRY[id] : null;
    name = name || fallback?.name || "Source-specific permissive licence";
    url = url || fallback?.url || null;
    attributionRequired = attributionRequired || Boolean(fallback?.attributionRequired);
    shareAlike = shareAlike || Boolean(fallback?.shareAlike);
    commercialUse = commercialUse ?? fallback?.commercialUse ?? true;
  } else if (matchesDomain(host, policy.uncertainDomains)) {
    status = LICENCE_STATUS.UNCERTAIN;
    reason = "source family requires item-level licence review";
    id = id || hostFallbackLicenceId(host);
    const fallback = id ? LICENCE_REGISTRY[id] : null;
    name = name || fallback?.name || "Licence requires review";
    url = url || fallback?.url || null;
    attributionRequired = attributionRequired || Boolean(fallback?.attributionRequired);
    shareAlike = shareAlike || Boolean(fallback?.shareAlike);
    commercialUse = commercialUse ?? fallback?.commercialUse ?? null;
  } else if (!host && !id) {
    reason = "missing source host and licence id";
  }

  const decision = status === LICENCE_STATUS.SAFE
    ? LICENCE_DECISION.ALLOW
    : status === LICENCE_STATUS.RESTRICTED
      ? LICENCE_DECISION.DENY
      : LICENCE_DECISION.REVIEW;

  return {
    schema: "sma/licence@1",
    policyVersion: policy.version ?? LICENCE_POLICY_VERSION,
    status,
    decision,
    id,
    name,
    url,
    sourceHost: host || null,
    attribution: attribution ?? null,
    attributionRequired,
    shareAlike,
    commercialUse,
    reason,
    resolvedAt: new Date().toISOString(),
  };
}

/** True when this record may be used for training under the given policy. */
export function licenceAllowsTraining(licence, { enforcement = "shadow" } = {}) {
  if (enforcement === "off") return true;
  if (!licence) return enforcement !== "enforce";
  if (licence.status === LICENCE_STATUS.RESTRICTED) return false;
  if (enforcement === "enforce") return licence.status === LICENCE_STATUS.SAFE && licence.decision === LICENCE_DECISION.ALLOW;
  return true;
}

/** True when this record may enter the replay reservoir. */
export function licenceAllowsReplay(licence, { enforcement = "shadow" } = {}) {
  return licenceAllowsTraining(licence, { enforcement });
}

export function licenceFingerprint(licence) {
  if (!licence) return null;
  const stable = JSON.stringify({
    id: licence.id ?? null,
    status: licence.status ?? null,
    decision: licence.decision ?? null,
    policyVersion: licence.policyVersion ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/** Compact fields copied into immutable snapshot rows for provenance. */
export function licenceSnapshotFields(licence) {
  if (!licence) return {};
  return {
    licenceId: licence.id ?? null,
    licenceStatus: licence.status ?? null,
    licenceDecision: licence.decision ?? null,
    licencePolicyVersion: licence.policyVersion ?? null,
    licenceAttribution: licence.attribution ?? null,
  };
}
