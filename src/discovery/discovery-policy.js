/**
 * Discovery policy — the explicit, configurable rule set that decides which
 * hosts the frontier may fetch, and how far it may expand beyond the bootstrap
 * seeds. CRAWL_URLS are seeds, not a permanent boundary; expansion is allowed
 * only through this policy and NEVER bypasses the fetch-time safety checks
 * (scheme, private-address SSRF guard, robots, byte/redirect caps, budgets).
 *
 * Modes:
 *   seeds-only : only the hosts of the bootstrap sources may be fetched
 *   allowlist  : bootstrap hosts + CRAWL_ALLOWED_DOMAINS may be fetched
 *   open       : any host except CRAWL_DENIED_DOMAINS may be fetched
 *
 * "Bootstrap sources" are CRAWL_URLS, CRAWL_DISCOVERY_SEEDS and the eligible
 * REGISTERED domains discovery bootstraps from. The DiscoveryService calls
 * `addSeedHosts` with the roots it actually used this cycle, so a registered
 * domain (or a discovery seed) is fetchable even when CRAWL_URLS is empty —
 * which is what makes the default `seeds-only` policy compatible with
 * registry-first discovery.
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

  const policy = {
    mode: m,
    seedHosts: [...seedHosts],
    allowedDomains: [...allowed],
    deniedDomains: [...denied],

    /**
     * Trust extra bootstrap hosts.
     *
     * CRAWL_URLS are NOT the only bootstrap source: discovery may also start from
     * eligible REGISTERED domains and from CRAWL_DISCOVERY_SEEDS. Those roots must
     * be fetchable too — otherwise the documented "registry-first bootstrap lets
     * discovery run with an empty CRAWL_URLS" would be false under the default
     * `seeds-only` policy, which rejects every host that is not a CRAWL_URL host.
     * DENIED domains still win (they are checked first in `decide`), so this can
     * never re-enable a domain the operator blocked.
     */
    addSeedHosts(hosts = []) {
      for (const h of hosts) {
        if (!h) continue;
        const norm = String(h).toLowerCase();
        if (seedHosts.has(norm)) continue;
        seedHosts.add(norm);
        policy.seedHosts.push(norm);
      }
    },

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

  return policy;
}
