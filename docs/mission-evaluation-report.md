# Mission Evaluation Completion and Production Observation

Date: 2026-11-13
Status: Implemented, tested, shadow-evaluated and deployed. Mission promotion gate remains disabled.

## 1. Verified production baseline

- Active stable: v749, fingerprint `7f51e62902c6`.
- Working: v787, fingerprint `365cfaa83f72`, parent v749.
- Working last-good: v749.
- Optimizer: carried from v749; 233 steps; 119,296 tokens; state present.
- Validation bank: `vb-20261113T185950-1722b98b`, 50 blocks, 32 required.
- Training job: waiting for a clean 16k-token fresh delta; harvesting/review continue.
- Mission evaluation: `MISSION_EVAL_ENABLED=false`.

## 2. Task evaluator

- New `src/training/student-completion.js` adapter uses the **student worker**, never Ollama/DeepSeek.
- Generation is pinned to a committed version with `verify: true`.
- Deterministic settings: `temperature=0`, `topP=1`, `seed=0`, no repeat penalty, configurable max new tokens.
- `src/dataset/mission-eval.js` records task ID, prompt, prompt hash, expected answer, actual answer, scoring mode, score, provenance and error.
- Aggregate accuracy and Wilson 95% interval are reported; paired comparisons report wins/losses/ties.
- CLI: `node src/cli/mission-eval.js --versions v749,v787 --suite tasks`.
- The task set remains sealed and source-versioned.

### Task result

- v749: 0/30 correct.
- v787: 0/30 correct.
- No wins or losses.
- This is a real capability limitation of the current 62M model on open-ended prompt generation, not evidence of improvement. The evaluator itself was verified with deterministic unit tests and a controlled perfect-answer fixture.
- The current task set is valid as a baseline but not yet a discriminating capability measure.

## 2b. Task evaluator v2

- Added `eval-language-tasks-002`: 32 multiple-choice tasks, 1da0c4eec70a.
- Coverage: 6 syntax, 5 morphology, 4 semantics, 5 grammar/agreement, 4 punctuation, 3 phonology, 3 pragmatics, 2 lexicography.
- Each row has a manually authored answer key, rationale, provenance and deterministic `choice` scoring.
- Added a Python `score` operation and Node `StudentWorker.score` exposing conditional continuation loss.
- The evaluator scores each choice by prompt-conditioned mean loss and selects the lowest-loss answer; per-choice losses are recorded. Mean loss is used to avoid comparing raw sums across different lengths.
- The prompt/continuation boundary was corrected (an explicit space is inserted) and the evaluation was rerun; the earlier no-boundary run was not retained as final.
- Actual result on `eval-language-tasks-002` with the boundary-corrected scorer:
  - v749: **13/32** (40.6%, 95% CI 25.5–57.7%)
  - v787: **14/32** (43.8%, 95% CI 28.2–60.7%)
  - paired difference: **+3.1 points** (1 win, 0 losses, 31 ties)
  - The difference is small and not statistically decisive. Both models remain weak on grammar/agreement and phonology.
- This is the first discriminating task result. It shows that mission text-loss improvement is not automatically task capability improvement and must be interpreted independently.

## 3. Dataset validation

| Dataset | Docs | Sources | Tokens (est.) | Version | Notes |
|---|---:|---:|---:|---|---|
| eval-language-001 | 60 | 3 | 9,010 | `908ea826ac94` | original language set; source groups too few for CI |
| eval-language-002 | 24 | 24 | 5,673 | `2b582fdd2dfa` | multi-source replacement for paired language CI |
| eval-language-tasks-001 | 30 | 1 authored | 525 | `fd48f47f4c97` | deterministic tasks; 10 syntax, 6 morphology, 4 semantics, 3 phonology, 2 punctuation, 2 pragmatics, 2 agreement, 1 lexicography |
| eval-fresh-001 | 30 | 1 | 7,416 | `bac538b5cc90` | single-source holdout; no CI |
| eval-fresh-002 | 22 | 22 | 5,573 | `579fa5a4ca4b` | multi-source science/history holdout |
| eval-language-tasks-002 | 32 | 1 authored | 956 | `1da0c4eec70a` | constrained multiple-choice task set |
| eval-002 | 60 | 60 | 58,776 | `69e276fcfb84` | preserved general benchmark |
| eval-broad-002 | 107 | 107 | 104,811 | `1adb03ebe783` | preserved broad benchmark |

- All new evaluation sets have zero content-hash overlap with each other, the validation bank, or the most recent 40 training snapshots.
- Public-domain provenance is recorded in sidecar files and manifests.
- New identifiers were used; existing sealed sets were not modified.
- eval-language-002 has 24 independent source groups, enough for the paired bootstrap (20 required).

## 4. Evaluation results for v749 and v787

| Suite | v749 | v787 | Improvement | 95% CI | Interpretation |
|---|---:|---:|---:|---|---|
| Primary eval-002 | 6.657351 | 6.669791 | −0.012439 | −0.027462..0.004798 | inconclusive; no stable promotion |
| Broad eval-broad-002 | 6.760602 | 6.769505 | −0.008903 | −0.020290..0.005408 | within 0.02 non-inferiority margin |
| Mission text-loss eval-language-002 | 7.745014 | 7.582459 | **+0.162555** | **0.116797..0.205541** | significant mission improvement |
| Fresh holdout eval-fresh-002 | 6.875927 | 6.823101 | +0.052827 | −0.006546..0.134438 | positive but not significant |
| Mission tasks v1 (open-ended) | 0/30 | 0/30 | 0 | — | not discriminating |
| Mission tasks v2 (likelihood choice) | 13/32 | 14/32 | +3.1 pts | 25.5–57.7 / 28.2–60.7 | discriminating but small; inconclusive |

The mission text-loss result is the first statistically reliable evidence that the cleaned corpus improved language-mechanics modelling while general capabilities remained non-inferior. It is not, by itself, sufficient for stable promotion under the existing policy.

## 4b. RUN.lock preflight fix

- Added `TRAIN_PREFLIGHT_BEFORE_LOCK=true` and `preflightMaterial` checks for:
  - fresh estimated tokens below `TRAIN_MIN_FRESH_TOKENS`,
  - missing/undersized validation bank.
- These checks run before RUN.lock acquisition. The lifecycle remains authoritative and still performs tokenizer-accurate preflight.
- Production verification: after restart, job-101 reported `fresh training delta has 13440 token(s), below 16000` with no lock for that observation. A residual short-lived lock record was later observed while the lifecycle retried a dry-collection edge case (`corpus has no training documents`); it was automatically reclaimed and did not create a run. The preflight reduces the common churn, but the lifecycle still owns the final authoritative collection check.
- Regression tests cover insufficient fresh material, sufficient material, and missing bank.

## 5. Production observation

- `run-675` advanced the working checkpoint v749 → v787. A later service restart marked the run record failed after its promotion/working-advancement had already committed; the v787 working checkpoint and optimiser state remain intact.
- `run-676` (v788, parent v787) was a clean-data candidate and was rejected:
  - candidate loss 6.688505 vs stable 6.657351
  - paired improvement −0.0336 (95% CI −0.0502..−0.0161)
  - working guard rejected: drift 0.0312 > 0.02 and regression 0.0187; working remained v787
  - corpus: 54 fresh / 49 replay / 12 validation; 121 content-quality exclusions; 68 source-cap removals; bank supplied 32/50 blocks
  - no mission/fresh evaluation was retained because the rejected staged candidate was discarded; primary loss is the available evidence.
- Corpus: 124 fresh, 73 replay, 12 validation rows; bank supplied 32/50 blocks.
- Content-quality exclusions: 150; source-cap removals: 55; fresh top-source share 8.16%.
- Optimizer continuity preserved.
- Stable active pointer unchanged.
- After run-676, training waits for fresh clean material at the existing 16k threshold. The material-supply limitation is documented rather than bypassing the threshold; no lower-quality batch was manufactured.

## 6. Tests

- Node: `npm test` — 943 tests, 936 passed, 7 skipped, 0 failed.
- Python: one pre-existing/environmental failure in `test_rocm_environment_device_is_cuda_but_backend_is_rocm` because the test torch build lacks CUDA.
- Added tests: student completion adapter, mission task scoring, validation bank, content quality, focus v2, guard shadow comparison.

## 7. Risks and limitations

- Mission task evaluation is not yet a useful capability measure; it needs prompt adaptation (e.g. constrained answer format or likelihood-based multiple choice) before activation.
- Task set balance is adequate but thin in punctuation, pragmatics, and lexicography.
- Fresh-domain holdout is still small; the CI includes zero.
- Validation bank includes some broad tech articles in addition to grammar seed material.
- The mission gate is intentionally disabled; no promotion policy was changed.
- Changes are deployed to code and evaluation assets; the stable gate remains unchanged.
- Short-lived RUN.lock ownership churn is visible while the supervisor retries a preflight wait; it clears on the next cycle but should be cleaned up in a later reliability pass.

## 8. Recommendation

1. Keep the mission gate in shadow mode; do not promote v787 or v788.
2. Treat v787 as evidence of mission text-loss improvement, not decisive capability improvement: the boundary-corrected task result is 13/32 → 14/32 (+1 task, not significant).
3. Expand task coverage in grammar/agreement and phonology, where both models currently score poorly; preserve `eval-language-tasks-002` for comparability.
4. Continue collecting clean material and observe multiple candidates from the v787 working parent when supply permits.
5. Only after repeated mission improvements, stable task evidence and non-inferior general results should a mission-aware promotion policy be proposed.

## 9. Recheck after prolonged production run (2026-11-14)

- Stable remains v749; working remains v787; last-good remains v749.
- 44 training runs have been recorded since v787; all were rejected and no working advancement occurred.
- Latest candidate `v833` / run-721: loss 6.816806 vs stable 6.657351 (paired improvement −0.1648, CI −0.1991..−0.1285).
- Recent training snapshots are still dominated by technical/commercial material despite the previous filters:
  - SentenceTransformers documentation (`sbert.net`) — 12 rows in run-721
  - Business Insider retail content — 12 rows
  - InfoWorld programming-language articles — 6 rows
  - Oracle language-service docs, Wired, HuffPost, Educba, etc.
- Focus-v2 treated `sentence`/`semantic` in ML documentation as strong signals. Content-quality did not classify those pages as commercial. The 20% broad quota also admitted retail/news material.
- The working guard is not the primary cause: v787 itself is 0.0124 nats above stable, leaving only 0.0076 nats of headroom under the current 0.02 drift limit; almost all subsequent candidates were 0.02–0.16 nats above stable.
- A lone surrogate (`U+DF16`) in an sbert.net article caused `sma.measure` to fail and job-101 to terminate. Fixed by:
  - excluding invalid Unicode at content-quality time,
  - sanitizing text in `sma.measure`,
  - quarantining the offending article as `corrupted-text`.
- Added technical negative signals to focus-v2 and a training-side mission-focus gate (`TRAIN_REQUIRE_MISSION_FOCUS=true`). This now rejects technical/commercial pages that previously passed.
- Added focused discovery seeds (grammar/syntax/punctuation/linguistics and writing-centre sources), prioritised in the frontier.
- After these changes, only ~6 focused trainable documents remain; training is correctly waiting rather than poisoning itself. This is a material-supply limitation, not a training-strategy failure.
- Current job state: job-103 training is waiting for eligible focused material; job-101 is failed at the earlier tokenizer error; the newly started learning job showed no cycle progress and needs normal supervisor reconciliation.
- Tests: 947 Node tests, 940 passed, 7 skipped, 0 failed (serial run).

Recommendation: do not relax the working guard or stable gate. Complete focused acquisition and review until the 16k-token floor is met, then run clean candidates from v787 and compare mission/task/general metrics. If the focused corpus is still too small, seed additional high-quality grammar/composition sources rather than lowering the threshold.

## 10. Language-focus correction (2026-11-14)

The operator clarified that "language focus" means **well-formed English prose and sentence/paragraph construction**, not articles that talk about language, programming languages, language models, or the "language" of another subject.

Changes:

- Disabled the training-side topical mission-focus requirement (`TRAIN_REQUIRE_MISSION_FOCUS=false`).
- Added `TRAIN_REQUIRE_PROSE_QUALITY=true` and `src/domain/training-prose.js`.
- The prose gate accepts coherent English prose from any subject and rejects:
  - technical documentation and API/reference pages,
  - code-heavy pages,
  - retail/commercial pages,
  - insufficient prose.
- Added technical negatives to discovery focus so `sentence transformer`, `semantic search`, `language model`, NLP, PyTorch and similar pages are not treated as language-mechanics focus.
- Added `setFocusClass` for operator discovery seeds so grammar/writing seed URLs are not stranded behind the 449k-item broad frontier.
- Batched seed-focus persistence to avoid rewriting the 379 MB frontier once per seed.
- Fixed the lone-surrogate tokenizer crash (`U+DF16`) with content exclusion, measurement sanitisation and quarantine.

Current observation:

- Active v749, working v787, last-good v749.
- The prose gate finds ~55 trainable prose candidates (~66k estimated tokens), but the authoritative snapshot/validation/source-cap path currently reports only 672 fresh tokens, so training is still not eligible for a run.
- The system is therefore still stalled on focused/prose material supply; it is no longer being trained on obvious technical docs, but it is not yet producing a promotable candidate.

## 11. Prose-gate trial and worker result

After the operator approved waiting for organic discovery/review, the prose gate filled the fresh-token gap and produced two clean candidates from the v787 lineage:

- `run-722` / **v834**, parent v787:
  - fresh 41, replay 19, validation 12; 20,446 fresh tokens
  - content-quality exclusions 360; training-prose exclusions 47
  - working guard accepted: regression 0.0008 nats vs v787, drift 0.0132 vs stable
  - working advanced v787 → v834; last-good v787; active remains v749
- `run-723` / **v835**, parent v834:
  - fresh 21, replay 0, validation 12; 20,654 fresh tokens
  - rejected: improvement −0.1101 (95% CI −0.1447..−0.0768)
  - working remained v834

### v834 evaluation

| Suite | v749 | v834 | Change |
|---|---:|---:|---:|
| Primary eval-002 | 6.657351 | 6.670572 | −0.013221 |
| Broad eval-broad-002 | 6.760602 | 6.764184 | −0.003582 |
| Mission eval-language-002 | 7.745014 | 7.472376 | **+0.272638** |
| Fresh eval-fresh-002 | 6.875927 | 6.774541 | **+0.101386** |
| Tasks v2 | 13/32 | 14/32 | +1 task; 1 win, 0 losses, 31 ties |

Broad remains within the 0.02 non-inferiority margin. Primary is still not a confirmed improvement, so v834 is not eligible for stable promotion under the existing gate.

The prose-gate trial therefore worked mechanically: organic review supplied a full 16k+ fresh batch and the working lineage advanced. It did not yet produce a stable promotion; the remaining gap is primary-eval improvement and candidate quality, not material supply.

## 12. Article-quality tightening and latest clean candidate

Additional extraction/selection filters now reject:

- retail host paths such as Business Insider guides/style/reviews;
- marketing use-case/resource/solution pages (for example AtScale);
- technical hosts such as GeeksforGeeks;
- non-prose funding/opportunity pages;
- fragmented prose with too few complete sentence lines.

These are applied before training snapshot construction, in addition to the prose/technical/commercial gate and the existing source/publisher caps.

The organic review pipeline then produced a cleaner candidate:

- `run-725` / **v837**, parent v834:
  - 17 fresh / 0 replay / 12 validation rows
  - 430 content-quality exclusions; 116 training-prose exclusions
  - source-cap/publisher-cap removals applied
  - primary improvement −0.0178 (95% CI −0.0434..0.0076), inconclusive
  - working guard accepted: regression 0.0050 nats vs v834, drift 0.01825 vs stable
  - working advanced v834 → **v837**; last-good v834; active remains v749
- `run-726` / v838 was rejected; working stayed v837.

Current state: active v749, working v837, last-good v834. The training corpus is now mainly grammar/linguistics/prose sources rather than programming-language or retail pages, but the stable primary evaluation still prevents promotion.
