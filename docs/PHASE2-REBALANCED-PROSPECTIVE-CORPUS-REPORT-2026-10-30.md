# Phase 2 — Rebalanced Prospective Corpus Report

**Frozen staging path:** `/home/dave/sma-experiments/prospective-rebalanced-20261030T224516Z`

**Top-level manifest SHA-256:** `44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35`

**Verification:** all 13 manifest-bound artifacts independently re-hashed after manifest write; `verification.json` reports `ok: true`. The staging directory is read-only (`dr-xr-xr-x`, files `r--r--r--`).

No training, evaluation, promotion, production ArticleStore write, article consumption, deployment, timer change, job-40 modification, or job-41 retry occurred. The independent final-test corpus was not accessed.

## 1. Baseline comparison

| Metric | Previous pilot `T215138Z` | Rebalanced corpus `T224516Z` |
|---|---:|---:|
| Actual English tokens | 1,489,774 | **914,005** |
| Publishers | 6 | **14** |
| Source families | 5 | **12** |
| Top-one publisher share | 46.83% | **32.61%** |
| Top-two publisher share | ~85.0% | **65.17%** |
| Validation share | 30.5% | **15.16%** |
| Historical screening | URL + exact hash only | **actual-text exact/normalised + MinHash/LSH + Jaccard** |
| Frozen / verified | partial | **full manifest + independent verification** |

The rebalanced corpus is smaller than the previous pilot because dominant publishers were capped and several government/education sources yielded short or unavailable pages. It was not padded with more Gutenberg or Wikipedia material. Diversity and historical screening improved; raw token count did not.

## 2. Publisher and source-family distribution

14 distinct publishers, 12 source families.

| Family | Publisher(s) | Docs | Tokens |
|---|---|---:|---:|
| project-gutenberg | gutenberg.org | 2 | 298,098 |
| wikipedia-en | en.wikipedia.org | 16 | 297,572 |
| openstax | openstax.org | 41 | 154,892 |
| python-docs | docs.python.org | 24 | 148,970 |
| nasa | science.nasa.gov, nasa.gov | 7 | 4,982 |
| gov-uk | gov.uk | 5 | 2,443 |
| nist | nist.gov | 3 | 1,749 |
| census | census.gov | 3 | 1,398 |
| libretexts | math.libretexts.org, bio.libretexts.org | 2 | 1,821 |
| doe | energy.gov | 2 | 1,026 |
| mit-ocw | ocw.mit.edu | 1 | 777 |
| epa | epa.gov | 1 | 277 |

Publisher shares:

- Project Gutenberg: **32.61%**
- English Wikipedia: **32.56%**
- OpenStax: **16.95%**
- Python documentation: **16.30%**
- All others combined: ~1.6%

Top-two publisher share: **65.17%** (below the 70% target).

## 3. Acquisition counts

| State | Count |
|---|---:|
| Requested URLs | 210 |
| Fetched | 171 |
| Failed | 25 |
| Deferred | 14 |
| Accepted documents | 107 |
| Rejected documents | 43 |
| Quarantined documents | 0 |
| Publisher-budget excluded | 21 |

Failures/deferrals:

- 14 deferred as `historical-url-in-production-store` (1 Wikipedia, 13 NASA).
- 20 HTTP failures (mostly 404 on GOV.UK, DOE, NPS, Census, NASA).
- 4 MIT OCW redirect-limit failures.
- 1 Wikipedia body over the 2,000,000-byte cap.
- 43 cleaned documents rejected as `short` (<1,500 chars). No fallback/curated text was admitted.
- 21 documents were excluded by deterministic per-publisher token budgets (14 Wikipedia, 5 Python docs, 2 Gutenberg).

All robots checks were performed; no robots-disallowed fetch occurred. No authentication or access-control bypass was used.

## 4. Publisher/source concentration

| Metric | Value |
|---|---:|
| Distinct publishers | 14 |
| Distinct sources | 107 |
| Top-one source share | 18.16% |
| Top-ten source share | 56.10% |
| Top-one publisher share | 32.61% |
| Top-two publisher share | **65.17%** |
| Source Herfindahl | 0.0652 |
| Publisher Herfindahl | 0.2677 |

The publisher target is met, but concentration is still meaningful: Gutenberg + Wikipedia are 65.17%, and OpenStax + Python docs add another 33.25%. Government/education pages had low usable yield, so broad publisher diversity is represented mostly by small contributions.

## 5. Historical near-duplicate screening

Historical comparison used the **actual available production text**, read-only:

- 19,719 historical production articles indexed.
- 22,838 exact/fetched hashes.
- 3,091 canonical historical URLs.
- 11,152 historical snapshot article IDs.
- 32-hash MinHash signatures over 5-word shingles, 8 LSH bands × 4 rows.
- Exact Jaccard verification for every candidate match.
- Exact and normalised text hashes.
- Canonical URL/source identity.

Historical index fingerprint:

`3ab7fcae5de2bc350bb519303e086a16d794710693c90107955eab927d0ec0e1`

Screening outcomes for 128 cleaned documents:

| Outcome | Count |
|---|---:|
| `NO_HISTORICAL_MATCH` | 128 |
| `EXACT_HISTORICAL_MATCH` | 0 |
| `NORMALISED_HISTORICAL_MATCH` | 0 |
| `PROBABLE_NEAR_DUPLICATE` | 0 |
| `AMBIGUOUS_REQUIRES_REVIEW` | 0 |

Maximum observed best-similarity score was 0.0; no LSH candidates were returned for the accepted new documents. All 43 short documents were rejected before screening; 14 known historical URLs were deferred before fetch. No historical text was copied into the prospective corpus.

**Index self-check:** an independent check modified five historical documents and re-ran the same 32-hash/8-band LSH index. All five were retrieved as candidates, with exact Jaccard `0.736`–`0.806`. The index is not inert.

**Job-40 separation:** the historical index was built from the complete production ArticleStore, so job-40 material is treated conservatively as historical unless independently shown otherwise. No job-40 article was merged or consumed.

Limitations: lexical comparison cannot reliably identify translations, substantial paraphrases, or rewrites that break 5-word shingle overlap. The historical index uses hashes/signatures only, not semantic embeddings.

## 6. Quality and cleaning controls

- Language: English only; confidence threshold 0.8; unknown rejected.
- Quality: 100% full-text; 0 fallback, 0 curated, 0 tiny-fragment tokens.
- Minimum cleaned length: 1,500 chars.
- Common-line boilerplate removal: threshold 10 documents.
- Per-line prose ratio: ≥0.65; lines under 40 chars skipped.
- Sentence-ratio floor: **disabled (0)** for this pilot because it rejected wrapped Gutenberg prose and code-heavy documentation. This is a documented pilot-specific deviation; it was not promoted into the permanent production cleaner.
- Cleaning implementation: `cleanRawText` in `src/dataset/corpus-text.js`; pilot policy version `phase2-pilot-quality-v1`.
- Dedup policy: `lexical-minhash-lsh-v1`; 5-word shingles; Jaccard threshold 0.6; short documents excluded from near-duplicate clustering.
- Tokenizer: `/home/dave/sma-experiments/corpus-only-candidate-20261029T071409Z/store/v389/tokenizer.json`; SHA-256 `ab4da6b2aa68247e9c0fa9b97fc7fcc796505038d01f7e144522a65ce0dbd2e5`.
- Actual tokens: measured with SmolLM3 tokenizer, `add_special_tokens=false`.
- Dedup result: 128 cleaned documents formed 128 clusters; 0 duplicate-cluster rows. Near-duplicate pairs: 0.

## 7. Prospective partition

| Metric | Value |
|---|---:|
| Policy | `document-source-disjoint-v1` |
| Cluster policy | `lexical-minhash-lsh-v1` |
| Split seed | 20261030 |
| Split hash | `603e0260d481a4b0ab21b7b29a975cfcb97fe5262f58d2a5a795b2250dd7ab5a` |
| Training documents | 87 |
| Training tokens | 775,434 |
| Validation documents | 20 |
| Validation tokens | 138,571 |
| Validation percentage | **15.16%** |
| Validation clusters | 20 |
| Validation minimum | 50,000 tokens / 10 clusters — **satisfied** |
| Exposure | `prospective-only` |
| Historical validation articles | 0 |
| Source crossings | 0 |
| Cluster crossings | 0 |
| Exact content-hash overlap | 0 |
| Normalised hash overlap | 0 |

Training covers 13 publishers / 11 source families. Validation covers 5 publishers / 5 source families (OpenStax, Python docs, Wikipedia, MIT OCW, NIST). Whole-cluster assignment produced a 15.16% validation share, within the 15–20% aim.

## 8. Licence and terms status

All licence/terms evidence URLs were fetched (HTTP 200) and hashed. Principal obligations:

- **Wikipedia:** CC BY-SA 4.0 + Wikimedia Terms; attribution and share-alike.
- **Project Gutenberg:** US public-domain posture; site warns non-US users to check local copyright.
- **NASA:** NASA media usage page notes insignia/logotype/imagery restrictions; text requires review.
- **GOV.UK:** Open Government Licence v3.0; attribution.
- **NIST/EPA/DOE/NPS/Census:** US federal-government public-domain posture with agency disclaimers; third-party material may remain copyrighted.
- **OpenStax:** CC BY 4.0; attribution.
- **MIT OCW:** CC BY-NC-SA; non-commercial/share-alike obligations.
- **LibreTexts:** content-level Creative Commons licences vary by page; legal review unresolved.
- **Python docs:** PSF licence.

This is evidence collection, not legal clearance. Redistribution, attribution, share-alike, non-commercial and third-party-content questions require review before production use.

## 9. Frozen artifacts and hashes

All paths under `/home/dave/sma-experiments/prospective-rebalanced-20261030T224516Z`.

| Artifact | SHA-256 |
|---|---|
| `manifest.json` | `44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35` |
| `source-manifest.json` | `5371830ef904945e0b569217fca27a769d39980955aa228a76b11898d48992f7` |
| `acquisitions.ndjson` | `692df29b698006676a1a332f94d24756b3d71847e8cc3226121fe3ad7df7ce9f` |
| `robots-evidence.json` | `817967d1e765c80f9389494f16b75d9329a768dfd21d181ee5a1ddadc13aba86` |
| `licence-evidence.json` | `74ff5fddbbf04bd508a9f5b25e2bb1c75693ccc954383bf1687322945ce00afe` |
| `historical-index.json` | `f77ea7a2b026df1a122c97cdb90edc3b0b43c2e45959970c4e4f77542a447f42` |
| `historical-screening.ndjson` | `fbf42af6fd90c10638af6ebd0154d4eeb9439157d027e3263dd09c6d6c06ed47` |
| `dedup-clusters.json` | `c4a7fa01cd8988d8507835379e0fb2475c5910d17a38d670adaf654ba2c2894a` |
| `publisher-manifest.json` | `95ffbfebaf419a2aa2c9e4cb50e5319bd485d587d7c65b5470f36dbaab6b6c1b` |
| `corpus/accepted-tokenized.jsonl` | `2cb6ed08a692d63b8d40cc15ffd91cee22983aaab7b643587891edd29a664d60` |
| `corpus/train.jsonl` | `552ffad836b9b95f6609c4062531bd2883a5f1f7a7e9833366bdd54d7a68b446` |
| `corpus/validation.jsonl` | `95aa6f130a73b0516253f52fd3572da853598ea8285e259a79a5d84418f176ae` |
| `corpus/split-assignment.json` | `7e29a66f445d1b4bbf3a206ef5b0f5c3f9cc5fe4d0cd4bef5cc8910407ff2c6a` |
| `quality-report.json` | `0f2a0d0d0df6c1b4158ceb05c5bd6e0e0d7db0ce932052c95d99d404342e1a8b` |

`verification.json` independently re-hashed all 13 manifest-bound artifacts after manifest write: all **ok**. The directory was then made read-only.

## 10. Test results

- Full Node suite: **724 tests, 717 passed, 0 failed, 7 skipped**.
- Focused dedup/partition and Node/Python CLI contract tests: passed.
- Focused Python validation/split/training tests: passed.
- Historical LSH self-check: **5/5** modified historical documents retrieved, Jaccard 0.736–0.806.
- `git diff --check`: clean.
- Script syntax check: clean.
- Python venv emitted an existing `sys.prefix` warning; results unaffected.

## 11. Known limitations

- Total tokens are **914,005**, lower than the previous pilot's 1,489,774. This is the deliberate result of per-publisher caps and weak yield from government/education sources; it was not padded with more Gutenberg/Wikipedia.
- Publisher diversity is real but uneven: 14 publishers, yet Gutenberg + Wikipedia remain 65.17%.
- Government/education sources were mostly short, 404, or unavailable; the corpus does not equally represent all 14 publishers in training or validation.
- Historical screening is lexical; translations, paraphrases and substantial rewrites may evade detection.
- Historical index uses 32 hashes / 8 bands; lower recall than the full 64-hash production dedup signature.
- Historical index covers production ArticleStore text but cannot cover experiments or corpora never recorded there.
- The pilot-specific cleaning rule disables the sentence-ratio floor; it is not the permanent production cleaner.
- Licence evidence is not legal clearance; several obligations remain unresolved.
- Validation includes only 5 publishers / 5 source families; validation is source-disjoint but not publisher-balanced.
- No training, evaluation or generation-quality evidence was produced.

## 12. Stop state

The corpus is frozen and independently verified. No controlled candidate experiment has begun. Training requires separate authorisation.
