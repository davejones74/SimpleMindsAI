# SimpleMindsAI Mission Data Quality Programme — Implementation Report

Date: 2026-11-13
Status: Implemented, tested, deployed, production trial started. Stable model unchanged.

## 1. Baseline

- Active: v749, fingerprint `7f51e62902c6`, weights SHA-256 `7b603bd4...`.
- Working before programme: v749; last-good: v748.
- Optimizer: carried from v748; 122 steps; 62,464 tokens; state hash `a237ae3b...`.
- Training job `job-101` was paused at a safe boundary before changes.
- Production backup: `/var/lib/simpleminds/backups/programme-20261113T183143Z` (4.2G, SHA256SUMS).
- Corpus: 42,181 articles; 20,245 reviewed; 122 trainable at baseline; 240 deferred fresh; 9,447 replay-retained.
- 20 recent runs rejected; best near-miss run-651/v756 at +0.0233 nats; latest run-674/v786 at +0.0820.
- Root causes confirmed: overly broad focus terms, commercial/SEO drift, loose source concentration, batch-coupled validation, evaluation mismatch.

## 2. Implemented

### Focus profile v2
- `src/discovery/mission-profile.js`
- Generic terms are weak signals; strong subject phrases/terms required.
- Commercial negative terms/phrases suppress TTS/CRM/product/salary matches.
- Decisions carry score, signals, negative signals, policy version and legacy comparison for shadow mode.
- Frontier records persist focus audit metadata.

### Content quality and reversible quarantine
- `src/domain/content-quality.js`
- Commercial/product/SEO path, title, phrase, CTA, price, thin-content and link-density signals.
- Applied to fresh, replay and validation-bank candidate selection.
- New reversible quarantine reasons: `commercial-seo`, `mission-irrelevant`.
- `npm run quality:audit -- --limit 300 --order desc --quarantine` quarantined 64/300 recent reviewed items without deleting them.
- Quarantine is reversible through existing release events.

### Tokenizer-authoritative concentration caps
- `src/dataset/diversity.js`, `src/training/lifecycle.js`
- Caps use measured token counts when available; lifecycle re-measures training rows before run creation.
- Applied settings: max 2 units/source, 10% source token share, 25% publisher token share.
- Run-675: 55 rows removed by caps; fresh top-source share 8.16%.

### Persistent validation bank
- `src/dataset/validation-bank.js`
- Immutable bank manifests and NDJSON copies, active pointer, content/manifest hashes.
- Reviewed, unconsumed, source-clustered articles reserved via durable `validation-reserve` events.
- Source/content disjointness checked against training rows.
- 32-block minimum retained; actual bank has 50 blocks / 6,457 tokens.
- Active bank: `vb-20261113T185950-1722b98b`
  - manifest hash `64a400c3...`
  - content hash `1722b98b...`
  - 12 articles, 12 source IDs, 5 publishers.
- Training now waits only when the bank itself is insufficient.
- `validationAvailability` reports bank status.

### Mission evaluation suite
- `eval-language-001`: 60 public-domain grammar/usage passages, 9,010 estimated tokens, 3 Gutenberg sources.
- `eval-language-tasks-001`: 30 deterministic language tasks (syntax, morphology, semantics, punctuation, phonology, pragmatics).
- `eval-fresh-001`: 30 public-domain science holdout passages.
- Manifests and provenance sidecars include source IDs, URLs, licences, provenance hash.
- No content overlap with each other or recent training snapshots.
- `src/dataset/mission-eval.js` provides task scoring, Wilson intervals and paired comparison.
- Lifecycle can record mission loss/fresh-holdout shadow results; gate activation remains disabled.

## 3. Production trial

- Run-675 (`v787`) used the new bank and clean-data policy.
- Corpus: 124 fresh / 73 replay / 12 validation rows; bank provided 32 of 50 available validation blocks.
- Content quality excluded 150 candidate rows; source caps removed 55.
- Candidate loss: 6.66979 vs stable 6.65735; paired improvement −0.0119 (95% CI −0.0275..0.0048), stable inconclusive.
- Working guard accepted: regression 0.0124 nats (limit 0.02), no catastrophic group regression (worst group −0.1403, limit 0.15).
- Working advanced v749 → v787; last-good reset to v749; active remains v749.
- Optimizer continuity: carried from v749; 233 steps; 119,296 tokens.
- After the run, training waits for a 16k-token clean fresh delta; acquisition/review continue.

### Working-guard shadow comparison
- `scripts/guard-shadow.mjs` compared 251 historical manifests.
- Current thresholds (0.02/0.02/0.15): 60 would have been accepted; 191 rejected.
- Proposed experimental thresholds (0.05/0.05/0.20): 118 would have been accepted; 133 rejected.
- The comparison is policy evidence only; discarded candidate weights are not recoverable. The run-675 candidate independently passed the current guard after data cleanup.

## 4. Checkpoints

- Active: v749, SHA-256 `7b603bd4...` (unchanged).
- Working: v787, fingerprint `365cfaa83f72`, SHA-256 `37ae28ff...`.
- Working optimizer: `_runs/v787.train-state.pt`, SHA-256 `b8e5e852...`.
- Last-good: v749, fingerprint `7f51e62902c6`.

## 5. Tests

- Node: `npm test` — 943 tests, 936 pass, 7 skipped, 0 fail.
- Python: `.venv_test/bin/pytest -q` — one environmental failure:
  `tests/test_portability.py::test_rocm_environment_device_is_cuda_but_backend_is_rocm`
  because the test environment's torch build has no CUDA. No Python code was changed.

## 6. Remaining work

- Mission loss/task evaluation is built and shadow-wired but disabled (`MISSION_EVAL_ENABLED=false`).
- Task evaluation needs a student completion adapter and answer-key validation before use.
- Validation bank contains some broad tech articles in addition to grammar seed corpus; future rotation should tighten representativeness.
- Shadow hyperparameter experiments (LR/epochs/replay/min-fresh) are not yet run.
- No new stable promotion yet; v749 remains active until an authorised promotion.
- Git changes are not committed.
