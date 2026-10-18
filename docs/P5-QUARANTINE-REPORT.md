# P5 — x1pro Quarantine & Rollout Report (READ-ONLY)

Date: 2026-10-18 · Scope: analysis of the x1pro production export only. No
quarantine was executed, no production configuration changed, no service touched.
All article IDs are traceable to `E:\Development\X1Pro\{articles,reviews,article-events}.ndjson`.

Companion files (this directory `docs/p5/`, one `articleId<TAB>detail` per line):

| File | Count | Meaning |
|---|---|---|
| `quarantine_non_english.txt` | 1792 | **Proposed auto-quarantine** — confidently non-English text |
| `quarantine_corrupted.txt` | 1 | **Proposed auto-quarantine** — degenerate repetition (no mojibake found) |
| `quarantine_proposed_set.txt` | 1792 | **Exact proposed quarantine set** (deduplicated union) |
| `manual_review_machine_translation.txt` | 260 | Manual review — possible machine translation |
| `manual_review_lean_english_foreign.txt` | 223 | Manual review — lean-English text on a foreign host |
| `manual_review_repeat_failures.txt` | 895 | Manual review — repeated review failures / retired |

---

## 0. Headline findings

- **2,214 unique articles**; **51,445 reviews**; all 2,214 currently `PENDING_REVIEW`.
- **0 articles consumed** (`consumedAt`/`consumedRef` null for every article) and
  **0 trainable**. **No x1pro article has ever entered a training snapshot.** This
  is decisive for the contamination question (§5).
- **91% of the corpus is non-English** (2,015/2,214 assessed `non-english`;
  735 are non-Latin script). Root cause: the ingest language filter was **unset**
  in the deployed environment and discovery ran with `CRAWL_DISCOVERY_POLICY=open`,
  so the crawler expanded across the non-English Wikipedia interlanguage graph
  (top hosts: `ca`, `ckb`, `de`, `el`, `da`, `ar`, `bg`, `ast`, `af`, `arz`, `as`,
  `azb`, `bjn`, `be-tarask`, `bs`, …).
- **The review loop never resolves**: 50,509 of 51,445 verdicts (98.2%) are
  `uncertain` (→ `PENDING_REVIEW`), vs 936 `approve`. Some articles carry up to
  267 consecutive `uncertain` reviews. This is a *critic/model defect*, not an
  article-quality defect, and is the reason every article is still pending.

---

## 1. Exact quarantine candidates

Detection semantics are the P3 review-gate rules (deterministic, reproducible):
`assess(text, {sourceUrl})` + a text-first `leansEnglish` guard, `mojibakeRatio`,
and `repetitionPenalty`. A foreign source/host alone is **not** a rejection reason.

### Category A — non-English text (proposed quarantine) — **1,792**
- `assess().verdict === "non-english"` **and** the text does **not** lean English
  (`englishRatio < 0.5`). Highest-confidence sub-set: 735 non-Latin script.
- Overlap with category B: 1 (the single corrupted article is also non-English).
- Overlap with category C (translation): 165; with category D (repeat failure): 802.
- Status: all `PENDING_REVIEW`. Trainable: **no** (none consumed, none `REVIEWED`).
- These are the articles that would poison an English-only student.

### Category B — corrupted text (proposed quarantine) — **1**
- Degenerate repetition (`bigramRatio < 0.15` on ≥30 words). **0 mojibake** found
  (the cleaning step removed encoding corruption before it reached the ledger).

### Category C — machine translation (MANUAL REVIEW, not auto-quarantine) — **260**
- 84 are English text on a foreign-language host; 178 carry a critic flag
  (`translat…`, `non-english`, `foreign`, `garbled`, `mojibake` in rationale/guardrail).
- Per your instruction, a foreign source alone is insufficient evidence. These
  need a human to read the text. They are **not** in the proposed quarantine set.

### Category D — repeated review failures (MANUAL REVIEW, not auto-quarantine) — **895**
- Articles that reached `RETIRED` (exhausted inconclusive attempts) or accumulated
  many `uncertain` reviews. Root cause is critic indecision (§3), **not** proven
  unsuitability; quarantine is the wrong remedy. Recommend the critic/temperature
  fix below and let the retry policy retire them cleanly.

### Category E — lean-English on a foreign host (MANUAL REVIEW) — **223**
- Assessed `non-english` only because of a declared foreign language, but the text
  actually leans English (`englishRatio ≥ 0.5`). These are the valid-English-
  translation cases that must **not** be auto-quarantined.

**Proposed quarantine set (deduplicated) = 1,792** (`quarantine_proposed_set.txt`).
All are `PENDING_REVIEW` and none have contributed to training.

---

## 2. Rollback verification

- Quarantine in the current code (`src/storage/article-store.js`:
  `quarantineArticle` / `releaseQuarantine`) only appends a status transition
  (`QUARANTINED`) plus an audit event. It **never deletes** the article record,
  its reviews, or its provenance — those are append-only NDJSON collections.
- Restore path: `releaseQuarantine(articleId)` returns the article to its previous
  non-quarantined status, or `setStatus(articleId, previousStatus)` with a reason.
  The pre-quarantine status is recoverable from `article-events.ndjson`
  (`type:"status"`, ordered by `at`).
- Because **0 articles are consumed**, article-level restoration is complete for
  the current store: there are no derived snapshots, datasets, or model artefacts
  that reference these articles yet (§5).
- Demonstration of reversibility against a disposable copy is recommended before
  the live run: copy `articles.ndjson`/`reviews.ndjson`/`article-events.ndjson` to
  a temp `ARTICLE_DIR`, open a throwaway store, quarantine + release a sample ID,
  and diff the store. No production paths are touched by this rehearsal.

---

## 3. Effective x1pro runtime configuration

"Verified" = corroborated by the live ledger; "configured" = from the env file only.

| Setting | Env (before) | Ledger / evidence | Resolution |
|---|---|---|---|
| Teacher model | `llama3.2:latest` (gemma4 commented) | `llama3.2:latest` = 2151/2214 articles, 50685/51445 reviews; `gemma4-turbo:e4b` = 51 early; `llama3.2` (no tag) = 12 | **Verified.** Env already matches the majority; stray tags are historical drift. Cleaned the commented pin. |
| Critic model | `llama3.2:latest` | `reviewerModel` mirrors the teacher (same model). | **Verified.** No separate critic was ever in effect. |
| Critic temperature | `0.5` | `criticTemperature=0.7` on all 51,445 reviews | **Resolved → 0.7.** `0.5` was never in effect. |
| Evaluation dataset | `eval-001`, seq `32` | — (configured only) | **Corrected → eval-002, seq 128.** eval-001 is the noise-dominated 5-row seed; seq must equal `TRAIN_SEQ_LEN=128`. |
| Ingest language filter | **unset** | 2,015/2,214 non-English ingested ⇒ filter was off | **Corrected → enabled.** This is the defect that admitted the corpus. |
| Discovery policy | `open` | — (configured only) | **Left `open`; added `DISCOVERY_LANGUAGE_PRIOR=warn`.** See §6 for the `reject`/`allowlist` decision. |
| Review retry limits / gates | unset (code defaults) | 51,445 reviews, 98% `uncertain` | **Made explicit** (`REVIEW_*`, `REVIEW_GATE_*`). |

Verified runtime values (from the ledger): model `llama3.2:latest`, critic
temperature `0.7`, verdict mix, `origin=curated`, zero consumption, and the
absence of language filtering. Everything else in the env is **configured only**
and must be confirmed on the host (e.g. `systemctl cat simpleminds` +
`systemctl show -p Environment` or the running process environment) before rollout.

---

## 4. Impact and rollout plan

**Counts by reason (proposed auto-quarantine):** non-English 1,792 · corrupted 1 ·
total (dedup) **1,792**.

**Overlaps:** non-English ∩ translation = 165 · non-English ∩ repeat-failure = 802
· translation ∩ repeat-failure = 141 · corrupted ∩ non-English = 1.

**Effect on trainable material:** none today (0 trainable). After quarantine, the
1,792 would be excluded from any future snapshot; the remaining 422 articles
(2,214 − 1,792) remain eligible for review.

**Effect on next training/eval cycle:** none in the immediate term — the pipeline
is blocked on the review loop (§0), not on the quarantine set. The quarantine
prevents *future* contamination once reviews start resolving.

**Staged rollout (all reversible, nothing here is executed by this report):**
1. Rehearse quarantine+rollback on a disposable copy (§2); verify.
2. Deploy the corrected `deploy/etc/x1pro.simpleminds.env` (§6) + the current
   build (which contains `QUARANTINED` status and the language gate).
3. Fix the critic (the `uncertain` hot loop) — see §6 required decisions — and
   confirm reviews resolve to `REVIEWED`/`RETIRED` in bounded attempts.
4. Apply quarantine to the 1,792 proposed IDs (one operator-approved batch),
   verifying the audit trail after each batch.
5. Human-review the manual lists (C, D, E) and apply targeted quarantines where
   warranted.

**Stop criteria:** any status transition not matching `evaluateVerdict` expectations;
any article whose content/review/provenance count changes; any non-`QUARANTINED`
status appearing on a quarantined ID. **Rollback criteria:** `releaseQuarantine`
(or `setStatus` to the recorded prior status) restores each article with its full
history intact.

---

## 5. Contamination limitation (explicit)

Quarantine prevents unsuitable material from entering **future** training
snapshots. It **cannot** undo contamination of an **existing** model: if an
article was already consumed into a snapshot and trained on, restoring or
removing the article record does **not** un-train the weights.

For the x1pro store specifically, **consumed = 0**, so **no model contamination
exists from these 1,792 articles** — they were never included in any snapshot.
This is the one scenario where quarantine is *fully* effective, because there is
nothing already-trained to un-train. Any future training run must therefore have
the language gate enabled **before** consumption begins, or the same non-English
corpus will contaminate the first real checkpoint.

---

## 6. Exact proposed quarantine set + required configuration changes

**Proposed quarantine set (1,792 IDs):** `docs/p5/quarantine_proposed_set.txt`
(each line `articleId<TAB>status<TAB>lang<TAB>script<TAB>conf<TAB>src`).

**Required configuration changes (already applied to
`deploy/etc/x1pro.simpleminds.env` — review before deploying):**
1. `LANGUAGE_FILTER_ENABLED=true` (was unset) — **the critical fix.**
2. `CRITIC_TEMPERATURE=0.7` (was 0.5 — never in effect).
3. `EVAL_DATASET_ID=eval-002`, `PROMOTE_EVAL_SET=…/eval-002.jsonl`,
   `PROMOTE_EVAL_SEQ_LEN=128`, `PROMOTE_EVAL_MICRO_BATCH=2` (+ `PROMOTE_EVAL_MIN_BLOCKS=8`).
   *Deployment prerequisite: copy `data/evaluation/eval-002.jsonl` to the host.*
4. `REVIEW_GATES_ENABLED=true` (+ language/quality sub-gates).
5. `REVIEW_COOLDOWN_MS` / `REVIEW_MAX_ATTEMPTS=3` / `REVIEW_MAX_TECHNICAL_ATTEMPTS=5`
   and critic `CRITIC_MAX_TOKENS/CRITIC_MAX_ATTEMPTS/CRITIC_REPEAT_PENALTY` — made explicit.
6. `DISCOVERY_LANGUAGE_PRIOR=warn`, `EXTRACTION_MODE=legacy`, mission/search knobs
   (all default/off) — documented.

**Required decisions (not taken here — for your approval):**
- **Critic model:** `llama3.2:latest` at temp 0.7 produces 98% `uncertain`.
  Recommend re-pinning the originally configured `ssfdre38/gemma4-turbo:e4b`
  critic (or another stronger model) so reviews resolve; this is the root fix for
  the 51k-review backlog, and it is **orthogonal** to the quarantine set.
- **Discovery scope:** keep `open` + language filter (recommended), or tighten to
  `DISCOVERY_LANGUAGE_PRIOR=reject` and/or `CRAWL_DISCOVERY_POLICY=allowlist`.
- **`LANGUAGE_FILTER_UNKNOWN_POLICY`:** `allow` (conservative, chosen) vs `reject`.

**Approval boundary:** this report is the stopping point. No quarantine IDs are
applied and no production config is changed until you review the exact IDs and the
proposed config above.
