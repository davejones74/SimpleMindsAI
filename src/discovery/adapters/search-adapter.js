import { resolveHttpUrl } from "./parse.js";

/** Pull a candidate list out of the common shapes a search JSON API returns. */
function extractResults(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  for (const key of ["results", "items", "organic_results", "documents", "data"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

/**
 * Independent search-provider adapter.
 *
 * This is a genuine provider interface, not a placeholder: it is only active
 * when at least one endpoint is configured (`CRAWL_SEARCH_ENDPOINT`, optionally
 * plus `CRAWL_SEARCH_FALLBACK_ENDPOINTS`), and it works against any provider that
 * answers a GET query with a JSON list of results carrying a `url`/`link`/`href`
 * field. With no provider configured it returns `unavailable` — the system never
 * pretends search is operational and never silently requires paid credentials or
 * a mandatory API.
 *
 * Resilience (Slice 5):
 *   - each request is retried a bounded number of times (`maxRetries`);
 *   - a failed endpoint transparently fails over to the next configured endpoint
 *     for the same query (multi-provider resilience);
 *   - the result reports a per-endpoint health summary so a partially degraded
 *     pool is visible and distinguishable from a total failure (`error`).
 */
export function createSearchAdapter({
  provider = null,
  endpoint = null,
  fallbackEndpoints = [],
  queryParam = "q",
  queries = [],
  extraParams = null,
  fetchJson,
  maxCandidates = 200,
  maxRetries = 1,
  retryDelayMs = 500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const endpoints = [...new Set([endpoint, ...(fallbackEndpoints ?? [])].filter(Boolean))];
  const configured = endpoints.length > 0 && typeof fetchJson === "function";
  // SearXNG's JSON API needs `format=json`; default it so a bare SearXNG endpoint
  // "just works", while remaining overridable via explicit `extraParams`.
  const isSearxng =
    /searxng/i.test(String(provider ?? "")) || endpoints.some((e) => /searxng/i.test(String(e)));
  const params = extraParams ?? (isSearxng ? { format: "json" } : {});

  function buildUrl(base, q) {
    const url = new URL(base);
    url.searchParams.set(queryParam, String(q));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url.href;
  }

  async function fetchOne(base, q) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return { ok: true, data: await fetchJson(buildUrl(base, q)) };
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) await sleep(retryDelayMs);
      }
    }
    return { ok: false, error: lastError };
  }

  return {
    name: "search",
    kind: "independent",
    async discover() {
      const diagnostics = {
        provider,
        endpoints: endpoints.length,
        queries: 0,
        ok: 0,
        errors: 0,
        health: { ok: 0, failed: 0, endpoints: [] },
      };
      const candidates = [];
      if (!configured) {
        return { status: "unavailable", reason: "no-search-provider", candidates, diagnostics };
      }
      if (!queries.length) {
        return { status: "unavailable", reason: "no-queries-configured", candidates, diagnostics };
      }

      const seen = new Set();
      const epHealth = new Map(
        endpoints.map((e) => [e, { url: e, ok: 0, failed: 0, lastError: null }]),
      );

      for (const q of queries) {
        if (candidates.length >= maxCandidates) break;
        diagnostics.queries++;

        // Try the primary endpoint, then the fallbacks, until one answers.
        let data = null;
        let usedEndpoint = null;
        for (const base of endpoints) {
          const res = await fetchOne(base, q);
          const h = epHealth.get(base);
          if (res.ok) {
            h.ok++;
            data = res.data;
            usedEndpoint = base;
            break;
          }
          h.failed++;
          h.lastError = res.error?.message ?? String(res.error);
          diagnostics.errors++;
        }
        if (!data) continue;
        diagnostics.ok++;

        for (const item of extractResults(data)) {
          if (candidates.length >= maxCandidates) break;
          const resolved = resolveHttpUrl(item?.url ?? item?.link ?? item?.href ?? null);
          if (!resolved || seen.has(resolved)) continue;
          seen.add(resolved);
          candidates.push({ url: resolved, provenance: { type: "search", query: q, provider, endpoint: usedEndpoint } });
        }
      }

      const healthList = [...epHealth.values()];
      diagnostics.health = {
        ok: healthList.reduce((n, h) => n + h.ok, 0),
        failed: healthList.reduce((n, h) => n + h.failed, 0),
        endpoints: healthList,
      };

      // Distinguish a healthy provider from a partially/totally failing pool.
      let status;
      let reason;
      if (candidates.length) {
        status = "ok";
        reason = null;
      } else if (diagnostics.queries > 0 && diagnostics.ok === 0) {
        status = "error";
        reason = "all-search-providers-failed";
      } else if (diagnostics.errors > 0) {
        status = "degraded";
        reason = "some-search-requests-failed";
      } else {
        status = "idle";
        reason = "no-search-results";
      }
      return { status, reason, candidates, diagnostics };
    },
  };
}
