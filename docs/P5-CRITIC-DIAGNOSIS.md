# P5 Addendum — Critic Failure Diagnosis

Date: 2026-10-18 · Scope: analysis of `reviews.ndjson` / `articles.ndjson` from the
x1pro export (read-only).

> **Status:** the two latent defects identified here are now fixed and tested
> (commit pending): `scoreToVerdict` gained a terminal `reject` branch
> (`REVIEW_REJECT_SCORE`, default 0) and `repetitionPenalty` returns neutral 1.0
> for non-Latin text. Full suite: 451/451. Deploy unchanged.

## Verdict up front

The 98.2% `uncertain` rate is **application logic, not critic quality**. The
critic (`llama3.2:latest`) returned parseable JSON with coherent rationales in
99.7% of cases (158/51,445 technical failures). The pipeline then converted a
huge fraction of its outputs into a non-terminal `uncertain` verdict and
re-reviewed them ~23 times each.

## Evidence

### 1. Verdict mix has no reject branch
- 51,445 reviews → **936 `approve`**, **50,509 `uncertain`**, **0 `reject`**.
- `scoreToVerdict` (`src/reward/reward-scorer.js:53-59`) maps **every** score
  ≤ 5 to `UNCERTAIN` (thresholds `uncertainScore=3`, `minScore=6`). There is no
  `reject` branch at all, so a clearly-bad article (score 0) is treated as
  "inconclusive" and re-reviewed forever instead of reaching a terminal state.

### 2. The repetition penalty zeroes non-Latin text
- `repetitionPenalty` / `heuristicPenalty` (`src/domain/review-gates.js:52-58`)
  tokenises with `/[a-z0-9']+/g` and returns `0` when there are `< 3` ASCII word
  characters. Any non-Latin-script article therefore gets a penalty of **0**.
- `scoreOffline` computes `final = raw × penalty`, so `final = 0` for those
  articles **no matter what the critic scored**.
- Measured: **654** articles have `repetitionPenalty == 0`.

### 3. Score-0 breakdown of the 50,509 `uncertain` reviews
| Mechanism | Reviews | Cause |
|---|---|---|
| `penalty == 0` (non-Latin text zeroed) | **20,105** | §2 — critic score wiped by the penalty |
| `penalty > 0`, critic returned `raw = 0` | **21,576** | language-blind critic scored foreign prose 0 (or genuinely bad text) |
| score in `(0, 6)` (low / middling) | **8,828** | genuinely in the "uncertain" band (6,478 ≤3; 2,350 in 3–6) |

Only 158 reviews are missing/technical: 88 timeout, 26 fetch-failed, 5
"token repeat limit reached", 39 "no JSON object".

### 4. The x1pro build predates the language guardrails
- 2,015/2,214 articles are non-English, yet the ingest language filter was
  **unset** and 0 `reject` verdicts exist — consistent with a build without the
  ingest filter and without the review-time gates (`preScreen`).
- The critic *praised* non-Latin text as "excellent training material" (e.g. the
  Arabic `دورة رانكين` steam-engine articles), i.e. the **language-blind** prompt
  was in effect, not the D6 language-aware prompt. The score became 0 only because
  §2's penalty wiped it — a coincidental, unreliable "filter".
- Up to **267** consecutive `uncertain` reviews on a single article implies the
  x1pro build also lacked the bounded retire/cooldown (`maxAttempts=3`,
  `cooldownMs=6h`) that the current code enforces.

## Conclusion

| Hypothesis | Supported? |
|---|---|
| Model quality is the cause | **No** — 99.7% parseable, coherent rationale |
| Response-format incompatibility | **No** — only 39 no-JSON / 158 total failures |
| Application logic | **Yes** — no-reject verdict mapping + non-Latin penalty zeroing + undeployed language guardrails |

**Recommended order (matches your assessment):**
1. Do **not** repin the critic yet — it would not fix the no-reject path or the
   penalty bug, and the 51-article gemma4 batch is insufficient evidence.
2. Deploy the **current** build first (it contains the ingest language filter,
   the D6 language-aware prompt, and the review gates), then observe a fixed
   representative test set.
3. Two latent defects exist in the **current** code and should be fixed before
   that deployment (or in the same change):
   - `scoreToVerdict`: add a terminal `reject` branch for a critic score of 0
     (or rely strictly on the gates and document that choice).
   - `repetitionPenalty`: return a **neutral 1.0** (not 0) when the text has no
     ASCII words, so non-Latin text is never spuriously zeroed — it should be
     the language gate's job to reject it, not the repetition metric's.
4. Quarantine and critic-fix are separate tracks: fixing the critic will not
   make the 1,792 non-English articles suitable; they still need the quarantine
   (or language-gate rejection on a re-ingest).
