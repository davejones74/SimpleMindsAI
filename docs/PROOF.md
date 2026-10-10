# Proof obligations and the Phase 1 gate

SimpleMindsAI's central claim is unusual: the student model is **trained from
random initialisation** and never receives pretrained neural weights. This
document explains the invariant, the six independent checks that make it
falsifiable, and the twelve checks that define the Phase 1 gate.

It is aimed at reviewers who need to verify the claim, and at contributors who
must not break it. For the system context, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [The one invariant that cannot bend](#the-one-invariant-that-cannot-bend)
- [Proof obligations](#proof-obligations)
- [The 12 checks (Phase 1 gate)](#the-12-checks-phase-1-gate)
- [Check 7 is a statement about parameters, not about state_dict()](#check-7-is-a-statement-about-parameters-not-about-state_dict)

---

## The one invariant that cannot bend

**The student is randomly initialized and never receives pretrained neural
weights.**

Everything else in this repository is negotiable. This is not. It is the
difference between a system that learns and a system that launders someone
else's training run. Three things are permitted because they are encodings, not
learned knowledge:

1. `config.json` — architecture hyperparameters. Shapes, not values.
2. The tokenizer (vocabulary, merges, special-token IDs) — an encoding mechanism.
3. A teacher LLM's *text output*, which becomes corpus data and is never merged
   into weights outside of ordinary training.

The proof is deliberately over-determined, because "we didn't load pretrained
weights" is easy to claim and easy to get wrong.

---

## Proof obligations

`python/sma/proof.py` exists to make the invariant above falsifiable. Six
independent checks:

1. **Manifest fields.** Every checkpoint records `initialisationType: "RANDOM"`,
   `pretrainedWeightsUsed: false`, the seed, the initializer kind and std, and
   the full architecture. A checkpoint without these is invalid.
2. **Structural audit.** An AST walk over the whole `sma` package finds every
   `.from_pretrained` call. A bare `org/name` Hub id is a violation; a filesystem
   path is allowed, because reloading our own trained checkpoint is required. An
   AST walk rather than a text scan, so docstrings and comments cannot trigger a
   false positive. Result is **persisted into the manifest**, not merely logged —
   an init that prints "0 violations" while writing no evidence has proved
   nothing.
3. **Zero weight bytes.** The fetch uses an allowlist of config/tokenizer
   patterns and asserts on *bytes*, not filenames. A single shard under any name
   shows up as `weightBytes > 0`.
4. **Offline construction.** `init` sets `HF_HUB_OFFLINE=1` and
   `TRANSFORMERS_OFFLINE=1` after fetching, then builds the model. The recorded
   env is written to the manifest.
5. **Parameter accounting.** Unique-parameter count is computed from the config
   (deduplicated by `data_ptr()`, because tied embeddings alias) and asserted
   against a stored expectation. All parameters must be trainable — a frozen
   tensor is a bug.
6. **Loss signature.** A randomly initialized model over vocabulary *V* must have
   cross-entropy near `ln(V)`. For `V = 128256` that is **11.7618**. The accepted
   band is `[10.5, 12.5]`, wide enough not to trip on loss-reduction differences.
   A pretrained SmolLM3 scores ~1.8–2.5, so the guard is armed permanently: **if
   a fresh checkpoint ever evaluates below the band, weights leaked.** This is the
   check that catches a silent leak, because nothing else inspects numbers.

   **The band applies only to freshly initialized, untrained checkpoints.** A
   successfully trained `v002` legitimately scores far below 11.76 — that is the
   whole point. Applying the band to a trained checkpoint would report a leak
   that did not happen, so the guard must be conditional on
   `initialisationType == "RANDOM"` with no training steps recorded. This is a
   correctness requirement for check 8, not an extension of it.

---

## The 12 checks (Phase 1 gate)

Phase 1 exists to prove the full lifecycle end-to-end at 62M before spending
years on 3B. A phase is not done until all twelve pass.

**The Phase 1 scope boundary, stated explicitly:**

```
Phase 1:   prove the machinery can train and recover safely
Later:      prove the machinery can learn continuously without degrading
```

Experience replay and sophisticated continual-learning algorithms are **out of
scope**. The architecture must merely stay *open* to them. See
[Known future problems](ROADMAP.md#known-future-problems) — both of the big risks
are recorded there deliberately unimplemented.

| # | Check | Status |
|---|---|---|
| 1 | A config exists and produces a randomly initialized model | done |
| 2 | Parameter count matches the config exactly (`61,839,744`) | done |
| 3 | `v001` is saved and published atomically with a `COMMITTED` marker | done |
| 4 | No pretrained neural weights were loaded (all six obligations above) | done |
| 5 | `train` runs real optimization on the fixture corpus and produces `v002` | done |
| 6 | `v002` reloads from disk into a fresh process | done — 74 persisted tensors re-hash byte-identical; 2 non-persistent RoPE buffers recomputed by the loader and reconciled to their recorded digest at the recorded dtype |
| 7 | Every trainable parameter changes materially; buffers stay put | done |
| 8 | Evaluation produces a loss number | done — `v001` scores 11.9452, inside the `[10.5, 12.5]` init band |
| 9 | Loss decreases in the expected direction | done — `v002` 11.5915 < `v001` 11.9452 on the identical frozen set, improvement 0.3537 |
| 10 | Versions are comparable and the diff is explainable | done — same architecture; 74/74 params named and changed; 0 buffers drifted |
| 11 | Generation runs from a checkpoint (nonsense output is fine) | done |
| 12 | Provenance and init manifest are persisted | done |

Nonsense generations at step 11 are **expected and acceptable**. A model that has
seen a few thousand tokens of English should not produce English. The point is
that the plumbing works.

### How checks 8 and 9 are measured

Checks 8 and 9 are the **frozen cross-checkpoint comparison**, not the training
curve. Both versions are scored by the same code path
(`python -m sma.brain eval`) on the same immutable file:

```
python -m sma.brain eval --version v001 --eval-set data/evaluation/eval-001.jsonl `
    --seq-len 32 --micro-batch 2 --device cpu --verify-weights --out $SMA_STORE
```

`v001` → 11.9452 (trained steps 0; the ln(V) init band applies), `v002` →
11.5915 (60 steps; the band no longer applies), improvement 0.3537. Both report
the same `datasetHash`
(`d4677e09878a155c0bd4cab61baf807ba6413a7f2172fa91e9f1463979344374`), which is
what makes the pair comparable, and both pass `--verify-weights` (`verifiedAll:
true`) — the evaluation loads the committed tensors, hashes them and runs under
`torch.no_grad()`, so it cannot move a weight. The device is pinned to CPU here
for reproducibility; the promotion gate instead uses `SMA_DEVICE` (default
`auto`).

This is deliberately a **different** measurement from the fixture training run
below, which reports the loss on the tiny `tiny_en.txt` fixture corpus the run
was trained on. The two must not be conflated: the fixture numbers describe the
optimizer moving five memorised blocks, while the frozen numbers above describe
both checkpoints on held-out science Q/A they were not trained on.

### What `v002` does and does not prove

`v002` was trained for 60 steps on the 4 KB fixture corpus — 7 blocks, 5 of them
train. On that *fixture* corpus, train loss fell 11.83 → 7.72 and validation loss
moved 11.82 → 11.54. **That gap is memorization of five blocks, not learning**,
and the honest reading is that the model still knows almost nothing. It is
supposed to. The fixture exists to prove the machinery moves real gradients into
real weights and can be resumed, not to produce a language model.

So check 5 passing means *"the optimizer, the precision model, the guards, the
provenance and the resume path work"* — nothing more. Any claim that the model has
learned English at this point would be reading a training curve as a capability,
which is the mistake the loss-signature guard exists to prevent in the opposite
direction.

---

## Check 7 is a statement about parameters, not about `state_dict()`

The change test is deliberately narrow, because the obvious version of it is
wrong:

```
Every trainable parameter tensor changes materially after training.
Expected non-trainable buffers remain unchanged unless explicitly designed otherwise.
```

The diff therefore runs over **`named_parameters()`**, not `state_dict()`. Two
measured facts make the narrow form the correct one:

- The RoPE `inv_freq` buffers are **non-persistent**. They are absent from
  `state_dict()` entirely and never change value, because they are a closed-form
  function of `head_dim` and `rope_theta`. A `state_dict()`-wide "everything must
  differ" test would be asserting that a constant changed. They *are* enumerated
  by `named_buffers()`, which is why the init manifest hashes 76 entries
  (74 parameters + 2 buffers) while `state_dict()` has only 74.
- Asserting that buffers are unchanged is worth doing explicitly, because it
  catches a desynchronised RoPE table — a real failure mode that would otherwise
  be invisible.

"Changes materially" is not the same as "changes at all", and the threshold is
not arbitrary — see
[bf16 master weights silently freeze 17 parameters](FINDINGS.md#bf16-master-weights-silently-freeze-17-parameters).

### Verifying a trained checkpoint's weights

The init manifest hashes **76** entries (74 parameters + 2 non-persistent RoPE
buffers). Only the **74** *persisted* tensors can be verified byte-for-byte on
reload; the loader omits the **2** `persistent=False` buffers from every
safetensors file and recomputes them in fp32 (the init-time model held them in
the build dtype, bf16). Those 2 are therefore reported separately as derived
tensors — never counted as a false mismatch — and are independently verified:
casting each reloaded buffer back to its **recorded dtype** must reproduce the
manifest digest byte-for-byte, which proves the buffer was reconstructed
faithfully while explicitly handling the dtype difference. The report exposes
`recordedCount: 76`, `persistedCount: 74`, `derivedTensors: 2`,
`derivedReconstructed`, and `verifiedAll`.

For the commands that exercise these checks, see
[DEVELOPMENT.md](DEVELOPMENT.md#testing-and-validation).
