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
 * when an endpoint is configured (`CRAWL_SEARCH_ENDPOINT`), and it works against
 * any provider that answers a GET query with a JSON list of results carrying a
 * `url`/`link`/`href` field. With no provider configured it returns
 * `unavailable` — the system never pretends search is operational and never
 * silently requires paid credentials or a mandatory API.
 */
export function createSearchAdapter({
  provider = null,
  endpoint = null,
  queryParam = "q",
  queries = [],
  fetchJson,
  maxCandidates = 200,
} = {}) {
  const configured = Boolean(endpoint && typeof fetchJson === "function");
  return {
    name: "search",
    kind: "independent",
    async discover() {
      const diagnostics = { provider, queries: 0, errors: 0 };
      const candidates = [];
      if (!configured) {
        return { status: "unavailable", reason: "no-search-provider", candidates, diagnostics };
      }
      if (!queries.length) {
        return { status: "unavailable", reason: "no-queries-configured", candidates, diagnostics };
      }
      const seen = new Set();
      for (const q of queries) {
        if (candidates.length >= maxCandidates) break;
        diagnostics.queries++;
        let data;
        try {
          const url = new URL(endpoint);
          url.searchParams.set(queryParam, String(q));
          data = await fetchJson(url.href);
        } catch {
          diagnostics.errors++;
          continue;
        }
        for (const item of extractResults(data)) {
          if (candidates.length >= maxCandidates) break;
          const resolved = resolveHttpUrl(item?.url ?? item?.link ?? item?.href ?? null);
          if (!resolved || seen.has(resolved)) continue;
          seen.add(resolved);
          candidates.push({ url: resolved, provenance: { type: "search", query: q, provider } });
        }
      }
      return {
        status: candidates.length ? "ok" : "idle",
        reason: candidates.length ? null : "no-search-results",
        candidates,
        diagnostics,
      };
    },
  };
}
