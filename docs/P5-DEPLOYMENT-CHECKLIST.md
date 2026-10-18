# P5 — Deployment-Readiness Validation (config + eval)

Date: 2026-10-18 · Read-only verification against the committed code. No
production changes, no restart, no quarantine.

## 4. Evaluation correction — VALIDATED

`data/evaluation/eval-002.jsonl` (249,785 bytes) is the correct, deployable
baseline and supersedes the noise-dominated `eval-001.jsonl` (5-row seed):

| Field | Value |
|---|---|
| Documents | **60** (all carry a `text` field) |
| Domains | **8** (history 8, science 7, astronomy 8, technology 7, geography 8, arts 7, life 7, society 8) |
| Characters | 235,105 |
| Est. tokens (~4 ch/tok) | 58,776 |
| Blocks @ seq-len 128 | **~460** (≫ `PROMOTE_EVAL_MIN_BLOCKS=8`) |

- The Python eval reads `text` (or `completion` as a fallback) — confirmed in
  `python/sma/data.py:91` — so the article-unit schema of eval-002 is read
  correctly.
- `PROMOTE_EVAL_SEQ_LEN=128` matches `TRAIN_SEQ_LEN=128`, so promotion compares
  the same per-token objective the trainer optimises.
- **Deployment prerequisite:** copy `data/evaluation/eval-002.jsonl` to
  `/var/lib/simpleminds/data/evaluation/eval-002.jsonl` on x1pro before enabling
  promotion on eval-002.

## 3. Config precedence — VERIFIED (one dead var removed)

- Precedence model: process env > `.env` (via `loadDotEnv`, real env wins) >
  code default. `config.js` is the single source of truth.
- Every corrected/new variable is read by the code: `LANGUAGE_FILTER_*`,
  `CRITIC_TEMPERATURE`, `EVAL_DATASET_ID`, `PROMOTE_EVAL_SET/SEQ_LEN/MICRO_BATCH/MIN_BLOCKS/MIN_TOKENS`,
  `REVIEW_GATES_*`, `REVIEW_REJECT_SCORE`, `REVIEW_MIN_SCORE`, `REVIEW_COOLDOWN_MS`,
  `REVIEW_MAX_ATTEMPTS`, `REVIEW_MAX_TECHNICAL_ATTEMPTS`, `DISCOVERY_LANGUAGE_PRIOR`,
  `EXTRACTION_MODE`, `MISSION_*`, `CRAWL_SEARCH_*`, `OLLAMA_MODEL_DIGEST`.
- **`BASE_MODEL` is dead** — `config.baseModel` was removed from the code (there
  is a test asserting its absence). Removed from the deploy env; the effective
  teacher/curator model is `OLLAMA_MODEL`, the critic is `CRITIC_MODEL` (falling
  back to `OLLAMA_MODEL`), and the student's base lineage is registry-tracked.
- **The ingest language filter is ON by default in the current code**
  (`config.languageFilter.enabled` defaults true). The x1pro influx happened
  because the deployed build predates the filter — so the real fix is *deploy the
  current build*, not merely set `LANGUAGE_FILTER_ENABLED` (which is explicit
  belt-and-suspenders).

## 5. Staged rollout (for your review — nothing executed)

1. **Copy** `data/evaluation/eval-002.jsonl` → `/var/lib/simpleminds/data/evaluation/`.
2. **Deploy** the current build (contains: ingest language filter, D6 critic
   prompt, review gates, `REVIEW_REJECT_SCORE` + `repetitionPenalty` fixes) and
   the corrected `deploy/etc/x1pro.simpleminds.env`.
3. **Verify runtime** on the host (this is what the ledger cannot prove):
   - `systemctl cat simpleminds` and/or `systemctl show -p Environment simpleminds`
     to confirm the running environment matches the deployed env file.
   - Confirm `ollama list` shows `llama3.2:latest` (and decide whether to also
     pull a stronger critic for the `uncertain` backlog — a separate decision).
4. **Rehearse quarantine+rollback** on a disposable copy of the three NDJSON
   files (see P5-QUARANTINE-REPORT.md §2).
5. **Apply quarantine** to the 1,792 proposed IDs (operator-approved), one batch
   at a time, verifying the audit trail.
6. **Validate review resolution** on a small representative batch: confirm
   articles reach terminal `REVIEWED`/`REJECTED`/`RETIRED` (no more `uncertain`
   hot loop) before resuming broader processing.

## Not yet done (awaiting your decision)
- Deploying the corrected env + build to x1pro.
- Executing the quarantine of the 1,792 proposed IDs.
- Deciding the critic model/temperature for the `uncertain` backlog.
