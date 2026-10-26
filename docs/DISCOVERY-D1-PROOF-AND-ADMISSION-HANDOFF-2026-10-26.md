# D1 Post-Deploy Proof and Admission Handoff

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Production: `/opt/simpleminds`
- Authoritative checkout: `/home/dave/Repositories/SimpleMindsAI`
- Status: **D1 deployed and proven; article admission remains blocked; rolling-window work not started**

## 1. Deployed D1 verification

The production service is healthy after the dependency repair:

```text
simpleminds.service: active (running)
http://127.0.0.1:4000/health
{"ok":true,"uptime":...,"articles":11788,
 "admission":{"epoch":"gateway-20261026-01","capLimit":500,"capUsed":500,"source":"pointer"}}
```

D1 source hashes match the authoritative checkout:

| File | Installed = Repository SHA-256 |
|---|---|
| `src/discovery/discovery-service.js` | `dfffd0b31ac4052a1867cb03afb4205b22a7906e3cbee0a49c207d0213254178` |
| `src/discovery/discovery-operations.js` | `eda68be677aaaa146b123ae3e810543e0557e4c936d485bbcd5e486aa3acff02` |
| `src/discovery/adapters/index.js` | `8a347167582b012d11fe4b8686546fc6fa1f97598b04fe052747a906796a9742` |
| `src/discovery/adapters/sitemap-adapter.js` | `030fe0a611613d510cbbcb3af53afea1b4adc8ed28dabaa8e4990932972e76ed` |
| `src/discovery/adapters/feed-adapter.js` | `6b301dca831d8b97420bac4f6aa93da900cbaa5d74d901a372d04a1c3b3fbec1` |
| `src/config.js` | `777c49face022a342e69952a3beaf43c17fe8e842cd51bed4245387ae58ea733` |

The production service created the durable discovery ledger directory:

```text
/var/lib/simpleminds/data/frontier/discovery
```

`job-32` and `job-33` remain stopped. No production learning job was started.

## 2. Bounded live discovery proof

The proof used the **deployed `/opt/simpleminds` code** with isolated temporary
frontier/registry/ledger state, a stub article-admission gateway, and real
network requests. It did not touch production article/admission/frontier data
and did not consume an article admission unit.

Proof directory:

```text
/home/dave/simpleminds-d1-discovery-proof-2026-10-26T20-25-30-463Z/
  proof.json
  discovery/operations-1793044800000.ndjson
  frontier/
  registry/
```

### Successful sitemap proof (science.nasa.gov)

- Adapters built: `sitemap`, `feed`.
- Sitemap report: `status=ok`, `found=5`, `enqueued=5`, `sitemapsFetched=2`,
  `errors=0`.
- Feed report: `status=idle`, `reason=no-feed-candidates` (feed was attempted,
  no feed advertised).
- Discovery operations: **4 grants, 4 completions, 0 errors**.
- Ledger grants include real requests for:
  - `https://science.nasa.gov/robots.txt`
  - `https://science.nasa.gov/wp-sitemap.xml`
  - a sitemap child
  - `https://science.nasa.gov/` (feed/root probe)
- Candidate sample:
  - `https://science.nasa.gov/missions/hubble/hubble-image-of-our-celebrity-neighbors/`
  - `https://science.nasa.gov/missions/hubble/hubble-peers-into-the-center-of-a-spiral/`
  - `https://science.nasa.gov/missions/hubble/hubble-peers-into-the-storm/`
  - `https://science.nasa.gov/missions/hubble/hubble-revisits-a-globular-clusters-age/`
  - `https://science.nasa.gov/missions/hubble/hubble-sees-a-galaxy-with-a-glowing-heart/`
- The candidate URLs were enqueued; they were not fetched by discovery.
- The stub article gateway was called once for the seed/queued work and returned
  a cap rejection; no article page was fetched. This confirms article
  acquisition still requires the gateway.

### Error-path proof (Wikipedia)

A second bounded proof against `https://en.wikipedia.org/wiki/Steam_engine`
recorded the real requests and the failure honestly:

```text
3 grants, 2 completions, 1 error
sitemap: HTTP 403 for the Wikipedia REST sitemap endpoint
feed:  completed; no feed candidates
ledger error: FETCH_STATUS / HTTP 403
```

No candidate was fabricated, no budget was exceeded, and no article was fetched.
Proof directory:
`/home/dave/simpleminds-d1-discovery-proof-2026-10-26T20-25-13-193Z/`.

## 3. Article admission bottleneck

D1 did not change article admission:

```text
epoch: gateway-20261026-01
capLimit: 500
capUsed: 500
source: pointer
job-32: stopped
job-33: stopped
frontier: 181,369 total; 167,201 queued, 12,628 visited, 1,540 deferred
```

No new epoch was created, no quota was changed, and no admission unit was
consumed by the discovery proof.

## 4. Step 4 not started: rolling-window admission needs a decision

The code is ready for a separate rolling-window admission slice, but it has not
been implemented or activated. The remaining choices are policy/migration
decisions, not implementation details:

1. **Window and quota**
   - e.g. 24h/50,000, 1h/2,000, or another operator-selected pair.
   - The quota must be high enough for the perpetual process but still a bounded
     rate; it must not be “millions per epoch.”
2. **Migration/activation**
   - The active epoch `gateway-20261026-01` is a sealed lifetime-cap store at
     500/500. Its sealed config cannot be edited in place.
   - Options are a new explicitly created **rolling-policy store/epoch** (not
     another 500 cap) or a designed migration of the active store. The latter
     changes sealed facts and needs an explicit migration/rollback record.
3. **Startup accounting**
   - Whether old admissions inside the chosen window count against the new
     quota (a 24h window would still see some of the current 500; a 1h window
     would not).
4. **Deployment**
   - The service is healthy now, but `sudo -n` is still unavailable to this
     session; a deployment/restart of the rolling slice will need the operator's
     privileged session.

No new epoch or rolling-window code was created in this step. The perpetual
timer remains inactive.

## 5. Verified vs not yet verified

**Verified:**

- D1 hashes deployed and service healthy.
- Durable discovery ledger directory exists.
- Governed sitemap discovery produces real candidates and records grants,
  completions and errors.
- Budget/per-domain accounting is separate from article admission.
- Article candidates remain gateway-gated; no bypass was observed.
- Article admission is still 500/500.

**Not verified / not started:**

- Production learning-job discovery (no job started).
- Rolling-window admission implementation, migration, activation or deployment.
- Any change to the 500/500 epoch.

No training, evaluation, promotion, data deletion, commit or push was performed.
