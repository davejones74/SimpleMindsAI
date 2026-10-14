/**
 * Discovery policy — the explicit, configurable rule set that decides which
 * hosts the frontier may fetch, and how far it may expand beyond the bootstrap
 * seeds. CRAWL_URLS are seeds, not a permanent boundary; expansion is allowed
 * only through this policy and NEVER bypasses the fetch-time safety checks
 * (scheme, private-address SSRF guard, robots, byte/redirect caps, budgets).
 *
 * Modes:
 *   seeds-only : only the hosts of the seed URLs may be fetched
 *   allowlist  : seed hosts + CRAWL_ALLOWED_DOMAINS may be fetched
 *   open       : any host except CRAWL_DENIED_DOMAINS may be fetched
 *
 * `CRAWL_DENIED_DOMAINS` is always prohibited, in every mode.
 */
export const DISCOVERY_MODES = Object.freeze(["seeds-only", "allowlist", "open"]);

export function hostOf(urlString) {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesDomain(host, domain) {
  const d = domain.toLowerCase().replace(/^\./, "");
  return host === d || host.endsWith("." + d);
}

export function createDiscoveryPolicy({
  seedUrls = [],
  allowedDomains = [],
  deniedDomains = [],
  mode = "seeds-only",
} = {}) {
  const m = DISCOVERY_MODES.includes(mode) ? mode : "seeds-only";
  const seedHosts = new Set(seedUrls.map(hostOf).filter(Boolean));
  const allowed = allowedDomains.map((d) => String(d).trim()).filter(Boolean);
  const denied = deniedDomains.map((d) => String(d).trim()).filter(Boolean);

  function isSeedHost(host) {
    return seedHosts.has(host);
  }

  return {
    mode: m,
    seedHosts: [...seedHosts],
    allowedDomains: [...allowed],
    deniedDomains: [...denied],

    /**
     * Decide whether a URL may be fetched/enqueued.
     * @returns {{allowed:boolean, reason:string, trust:string|null, host:string|null}}
     */
    decide(urlString) {
      const host = hostOf(urlString);
      if (!host) return { allowed: false, reason: "bad-url", trust: null, host: null };
      if (denied.some((d) => matchesDomain(host, d))) {
        return { allowed: false, reason: "denied-domain", trust: null, host };
      }
      if (isSeedHost(host)) return { allowed: true, reason: "seed", trust: "seed", host };
      if (m === "seeds-only") return { allowed: false, reason: "not-seed-host", trust: null, host };
      if (m === "allowlist") {
        if (allowed.some((d) => matchesDomain(host, d))) {
          return { allowed: true, reason: "allowlisted", trust: "allowlist", host };
        }
        return { allowed: false, reason: "not-allowlisted", trust: null, host };
      }
      // open
      return { allowed: true, reason: "discovered", trust: "discovered", host };
    },

    /** True when any host may be fetched beyond the seeds. */
    expands() {
      return m !== "seeds-only";
    },
  };
}
