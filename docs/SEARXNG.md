# SearXNG search provider

SimpleMindsAI's discovery uses a **sitemap** adapter, a **feed** adapter, and an
**optional independent search** adapter. Search is off until an endpoint is
configured — with no provider the adapter reports `unavailable` and the system
never pretends search is working or requires paid credentials.

This document covers running a self-hosted SearXNG instance, wiring it into
discovery, and the health/resilience behaviour (Slice 5).

## 1. Run SearXNG

The simplest path is the official container. A minimal `docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8888:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8888/
```

> Bind to `127.0.0.1` unless you put an authenticating reverse proxy in front of
> it. An open SearXNG instance is an open proxy.

Start it once to generate `./searxng/settings.yml`, then **enable the JSON API**.
In `settings.yml`:

```yaml
search:
  formats:
    - html
    - json        # REQUIRED: the adapter fetches JSON
```

Restart the container. Confirm the JSON API works:

```bash
curl -s 'http://127.0.0.1:8888/search?q=neural+network&format=json' \
  | head -c 200
```

You should see a JSON object with a `results` array. If you get HTML, a 403, or
`"json" is not a valid format`, the `formats` change did not take effect.

## 2. Wire it into discovery

Add `search` to the adapter list and point it at the endpoint. In your
`simpleminds.env`:

```dotenv
CRAWL_DISCOVERY_ADAPTERS=sitemap,feed,search
CRAWL_SEARCH_PROVIDER=searxng
CRAWL_SEARCH_ENDPOINT=http://127.0.0.1:8888/search
CRAWL_SEARCH_QUERY_PARAM=q
CRAWL_SEARCH_QUERIES=human language,contextual insights
CRAWL_SEARCH_EXTRA_PARAMS={"format":"json","safesearch":"1","language":"en"}
```

- `format=json` is appended automatically for a `searxng` provider, but setting
  it explicitly documents the requirement (and is harmless).
- `language=en` biases results to English. It is **advisory**: the ingest-time
  language filter is still the authoritative gate on the actual text.
- Search-derived URLs are **candidates**: they pass the discovery policy, the
  domain registry (block list) and the discovery language prior like any other
  candidate. The adapter never enqueues or fetches a document itself.

Mission queries can also feed the search adapter (see `MISSION_QUERIES_ENABLED`),
and reviewed-corpus keyphrases can be appended (`CORPUS_QUERIES_ENABLED`).

## 3. Resilience and health (Slice 5)

- **Retry.** Each request is retried up to `CRAWL_SEARCH_MAX_RETRIES` times
  (default `1`) with `CRAWL_SEARCH_RETRY_DELAY_MS` between attempts (default
  `500`).
- **Failover.** `CRAWL_SEARCH_FALLBACK_ENDPOINTS` (comma-separated) is tried in
  order when the primary fails for a query. This is multi-provider resilience: a
  local instance plus a remote mirror, or two providers exposing the same JSON
  shape.
- **Health.** Every `discover()` result carries `diagnostics.health`:

  ```json
  {
    "ok": 3,
    "failed": 1,
    "endpoints": [
      { "url": "http://127.0.0.1:8888/search", "ok": 2, "failed": 1, "lastError": "HTTP 502" },
      { "url": "https://search.example.org/search", "ok": 1, "failed": 0, "lastError": null }
    ]
  }
  ```

  The adapter's `status` distinguishes the cases the scheduler cares about:

  | status        | meaning                                                        |
  |---------------|----------------------------------------------------------------|
  | `ok`          | at least one candidate URL was proposed                        |
  | `idle`        | the provider answered, but returned no results                 |
  | `degraded`    | some requests failed, but the pool is still answering          |
  | `error`       | every query failed across every endpoint (transient)           |
  | `unavailable` | not configured (or no queries) — never a silent failure        |

  `degraded` counts as an available provider; `error` feeds the acquisition
  classifier's `degraded` state so the job waits and retries instead of treating
  a temporary provider outage as permanent exhaustion.

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `status: "error"`, reason `all-search-providers-failed` | endpoint down / wrong port / JSON disabled | `curl` the endpoint; check `search.formats` |
| Response is HTML or a 403 | `json` not in `search.formats` | add `json`, restart SearXNG |
| `"json" is not a valid format` | same as above | same as above |
| `status: "unavailable"` | `CRAWL_SEARCH_ENDPOINT` empty or `search` not in `CRAWL_DISCOVERY_ADAPTERS` | set both |
| `status: "idle"` | the instance works but the queries return nothing | broaden `CRAWL_SEARCH_QUERIES` / `language=en` |
| `status: "degraded"` | one endpoint is failing, a fallback is carrying | inspect `diagnostics.health.endpoints[].lastError` |

Health is also surfaced in the periodic discovery log line and in the job's
waiting diagnostics (`meta.diagnostics.discovery`), so a degraded provider is
observable without attaching a debugger.
