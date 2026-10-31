# Phase 2 — Controlled Prospective Corpus Acquisition Pilot Report

**Final accepted pilot root:** `/home/dave/sma-experiments/prospective-pilot-20261030T215138Z`

This pilot is isolated. It did not write to the production ArticleStore, consume production articles, create a training snapshot, train/evaluate a model, promote anything, start the perpetual timer, or touch the independent final-test corpus.

Two earlier bounded pilot passes were run into separate isolated staging directories and superseded:
- `/home/dave/sma-experiments/prospective-pilot-20261030T212748Z`
- `/home/dave/sma-experiments/prospective-pilot-20261030T213820Z`

The final cohort is the `T215138Z` directory only.

## 1. Sources selected and rationale

| Family | Publisher(s) | Role | Accepted docs | Actual tokens |
|---|---|---|---:|---:|
| Wikipedia English | en.wikipedia.org | Encyclopaedic/reference, broad general knowledge | 30 | 568,609 |
| Project Gutenberg | gutenberg.org | Public-domain long-form books/literature | 4 | 697,682 |
| NASA | nasa.gov / science.nasa.gov | Scientific/educational prose | 7 | 4,982 |
| GOV.UK | gov.uk | Government/general knowledge under OGL | 5 | 2,443 |
| Python documentation | docs.python.org | Technical documentation | 29 | 216,058 |

Five source families and six publishers were accepted.

Licence/terms evidence:

- **Wikipedia:** CC BY-SA 4.0 (`https://creativecommons.org/licenses/by-sa/4.0/`) and Wikimedia Terms of Use (`https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use`). Both fetched HTTP 200. Attribution and share-alike obligations apply to reuse.
- **Project Gutenberg:** Project Gutenberg Terms of Use (`https://www.gutenberg.org/policy/terms_of_use.html`). Fetched HTTP 200. The site explicitly warns non-US persons to check local copyright; this pilot relies on the US public-domain posture and is not a legal opinion.
- **NASA:** NASA media usage guidelines (`https://www.nasa.gov/nasa-brand-center/images-and-media/`). Fetched HTTP 200. The page notes NASA insignia/logotype/imagery are not public domain; text use still requires care. This is recorded as evidence, not a legal clearance.
- **GOV.UK:** Open Government Licence v3.0 (`https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/`). Fetched HTTP 200. OGL attribution requirements apply.
- **Python documentation:** Python documentation licence (`https://docs.python.org/3/license.html`). Fetched HTTP 200. PSF licence terms apply.

Full licence pages, hashes and extracted snippets are in `licence-evidence.json` and `licences/`.

## 2. Acquisition results

| Metric | Count |
|---|---:|
| Requested URLs | 106 |
| Fetched successfully | 84 |
| Failed | 8 |
| Deferred | 14 |
| Accepted documents | 75 |
| Rejected documents | 9 |
| Duplicate-cluster rows rejected | 0 |

Failures/deferrals:

- 14 **deferred** because the canonical URL already exists in the production ArticleStore (`historical-url-in-production-store`): 1 Wikipedia article and 13 NASA pages. No historical content was copied.
- 7 **failed** with HTTP 404: six GOV.UK URLs and one NASA URL.
- 1 **failed** because the response exceeded the 2,000,000-byte cap: Wikipedia `Climate_change`.

No robots-disallowed fetch occurred. Robots files were fetched for every host and all required paths were allowed under the pilot user agent. Robots evidence is in `robots-evidence.json` and `robots/`.

Acquisition used bounded timeouts, a 2 MB body cap, at most 5 redirects, one retry for network/timeout errors only, and a 500 ms inter-request delay. No authentication or access-control bypass was used.

## 3. Quality and deduplication

- Accepted documents: **75**.
- Rejected documents: **9**, all `short` (<1,500 cleaned chars).
- Quality tiers: **100% full-text**; no fallback or curated rows.
- Tiny-fragment contribution: **0 rows / 0 tokens**.
- Language: **100% English** (detector confidence ≥0.8, unknown rejected).
- Deduplication: 75 unique content clusters for 75 accepted documents; **0 duplicate-cluster rows**. Exact/normalised and lexical near-duplicate clustering was applied. Translation and aggressive paraphrase duplicates are not reliably detected by the lexical method.
- Actual token count: **1,489,774** using the SmolLM3 tokenizer (`add_special_tokens=false`).
- Tokenizer SHA-256: `ab4da6b2aa68247e9c0fa9b97fc7fcc796505038d01f7e144522a65ce0dbd2e5`.

The line-based sentence-ratio filter in the Phase 1 cleaner was not appropriate for wrapped Gutenberg prose and code-heavy Python documentation. The pilot used a pilot-specific rule: 1,500-character minimum, common-line removal, and no line-sentence-ratio floor. This is documented as a deviation and should be re-evaluated before production corpus use.

## 4. Source concentration

| Metric | Value |
|---|---:|
| Distinct sources | 75 |
| Distinct publishers | 6 |
| Top-1 source share | 20.17% |
| Top-10 source share | 59.80% |
| Top-1 publisher share | 46.83% |
| Top-10 publisher share | 100% |
| Source Herfindahl | 0.0726 |
| Publisher Herfindahl | 0.3860 |

Publisher shares:

- Project Gutenberg: 46.83%
- English Wikipedia: 38.17%
- Python documentation: 14.50%
- NASA (two hosts): 0.33%
- GOV.UK: 0.16%

**Risk:** the pilot remains concentrated in Project Gutenberg and Wikipedia. NASA and GOV.UK yielded very little usable material because many URLs were historical, 404, or short. This meets the token target but not a balanced publisher target. The next acquisition should explicitly rebalance toward underrepresented publishers before this material supports broad-corpus claims.

## 5. Prospective training/validation split

- Policy: `document-source-disjoint-v1`
- Cluster policy: `lexical-minhash-lsh-v1`
- Split seed: `20261030`
- Split hash: `10193d4c518cb1201ace627f262ced693983c9c36959e606dc41e43645796ae4`
- Exposure: `prospective-only`
- Historical validation articles: **0**
- Validation clusters: **12**
- Validation minimum: **50,000 tokens / 10 clusters** — **satisfied**
- Train: **63 documents / 1,035,912 tokens**
- Validation: **12 documents / 453,862 tokens**
- Source crossings: **0**
- Content-hash overlap between train and validation: **0**

The validation cohort is **30.5%** of tokens rather than the 15% target because assignment is whole-cluster and one large Gutenberg source was selected. The policy was not relaxed; the oversized cohort is reported as a concentration/balance issue, not hidden.

Validation was reserved before any training exposure. The pilot made no training corpus and did not merge anything into production.

## 6. Historical exposure handling

The pilot read the production article store and registry **read-only** to exclude known historical material by canonical URL and content hash. It did not copy historical content or relabel historical data as prospective.

Limitation: the historical check is URL/hash-based; it does not perform near-duplicate comparison against all historical production text. Transliterations, translations and paraphrases of historical material could evade that check. This is a residual contamination risk requiring future near-duplicate review.

## 7. Exact files and hashes

Manifest: `/home/dave/sma-experiments/prospective-pilot-20261030T215138Z/manifest.json`

| Artifact | Path | SHA-256 |
|---|---|---|
| Source manifest | `source-manifest.json` | `3306e2ab21ff47549d3f0571a316ea27e809702aff64a9503cadf5ef3a1833e1` |
| Acquisitions | `acquisitions.ndjson` | `9a3592be724700d66fde23040bb03c0ad87460624e76a46c78091c731516113d` |
| Robots evidence | `robots-evidence.json` | `c03df776037e7518d397d7f902dbb356cd90cc1c2b779d451fb8134561c11b78` |
| Licence evidence | `licence-evidence.json` | `2544d3ff171ce58da14ce4c0b5a74fe99bcac3c45e62e86a1843e9f509d5976c` |
| Accepted/tokenized | `corpus/accepted-tokenized.jsonl` | `defd1eb1a78c4db66394925a5cc85d81520ff74c9269379af679cba0725416dd` |
| Train cohort | `corpus/train.jsonl` | `00de49bb12d35481574284678637ffdac4ff8ab46c0808b39cc86bb767c94e6d` |
| Validation cohort | `corpus/validation.jsonl` | `81271871dc7843fcfddadc0a63df092c74184af7aab806aabef0b3f4a4d9933a` |
| Split assignment | `corpus/split-assignment.json` | `3eff8648cd4f6e21691d4d0b4afdd9b9d0a6025fbedaf7787643f816461e9f5c` |
| Quality report | `quality-report.json` | `fe6c6ef629e37ad7cd9f12e21946732c31322eff5220067d85b75a533b033195` |

Staging size: ~26 MB.

## 8. Remaining gaps and risks

1. Publisher concentration remains high: Gutenberg 46.8%, Wikipedia 38.2%.
2. NASA and GOV.UK yielded very little material; the pilot did not meet a balanced-source goal.
3. Licence evidence is recorded but not a legal clearance. Gutenberg non-US copyright, NASA media restrictions, CC BY-SA attribution/share-alike, OGL attribution and PSF terms all require review before any redistribution or production use.
4. Validation is 30.5% of tokens because whole large clusters were selected; a more balanced validation target needs cluster-size-aware selection or more small sources.
5. Historical exclusion is URL/hash-based, not exhaustive near-duplicate comparison against all historical production text.
6. Near-duplicate detection is lexical; translations and paraphrases remain a limitation.
7. The pilot cleaner uses a relaxed sentence-ratio rule for wrapped books/docs. This needs re-evaluation before the material becomes a permanent training corpus.
8. No independent final test was created or accessed.
9. No training was run; no learning-quality claim is made.

## 9. Test results

- Full Node suite: **722 tests, 715 passed, 0 failed, 7 skipped**.
- Focused Python tests (`test_corpus_roles`, `test_validation_policy`, `test_training`, `test_eval_record`, `test_preflight`): passed.
- Gated real provenance smoke test: passed with `SMA_RUN_SMOKE=1`.
- `git diff --check`: clean.
- `node --check scripts/phase2-acquisition-pilot.mjs`: clean.
- Python venv emitted an existing `sys.prefix`/`sys.exec_prefix` warning; results unaffected.
- Test temp dirs were redirected to the root filesystem because `/tmp` hit its tmpfs quota.

## 10. Git and commit status — important

- During this task, HEAD changed from `9324fbf` to **`42d3b8c` (`Reworking training process.`)**.
- That commit was **not made by this assistant**. It appears to have been created and also reflected in `origin/master` by another process/user at 2026-10-30 01:21:23 +0000.
- The only working-tree change now is the untracked pilot script:
  `scripts/phase2-acquisition-pilot.mjs`.
- No commit or push was executed by this assistant.
- This unexpected repository state should be reviewed before accepting the implementation.

## 11. Stop state

The pilot is complete. The prospective training/validation cohorts and all acquisition evidence are isolated under the staging root above. No training, deployment, production merge, promotion, final-test creation, or timer start occurred.

Separate authorisation is required before any controlled candidate experiment or any production integration of the pilot material.
