# Verified empirical findings

Behaviours measured on the development machine, not assumed. Several contradict
the documentation or the intuition, and each cost real debugging time. They are
recorded here as the authoritative reference so they are not relearned.

This is a developer/reference article. For how these findings shape the design,
see [ARCHITECTURE.md](ARCHITECTURE.md); for the proof obligations they support,
see [PROOF.md](PROOF.md).

## Contents

- [Initialisation and the transformers 5.x API](#initialisation-and-the-transformers-5x-api)
- [Tensor hashing and version diffs](#tensor-hashing-and-version-diffs)
- [bf16 master weights silently freeze 17 parameters](#bf16-master-weights-silently-freeze-17-parameters)
- [bf16 on CPU is emulated and 220× slower](#bf16-on-cpu-is-emulated-and-220x-slower)
- [A ragged final batch makes effectiveBatchSize a lie](#a-ragged-final-batch-makes-effectivebatchsize-a-lie)
- [Platform and storage quirks](#platform-and-storage-quirks)
- [Manifest shape changes to flatten before Phase 2](#manifest-shape-changes-to-flatten-before-phase-2)

---

## Initialisation and the transformers 5.x API

**Transformers 5.x uses a plain normal, not a truncated normal.** The docstring
says "truncated normal"; the observed max is ~4.6σ, not 2. `INITIALIZER_KIND =
"normal"` and `std = 0.02`.

**Transformers 5.17 API changes.** RoPE lives under `config.rope_parameters`;
`torch_dtype` is deprecated in favour of `dtype`. Setting `config.torch_dtype`
emits a warning.

---

## Tensor hashing and version diffs

**19 of 76 hashed tensors are seed-invariant.** `proof.tensor_hashes` walks
`named_parameters()` *and* `named_buffers()`, so it records 76 entries: 74
parameters plus the 2 RoPE buffers. Of those 76, 57 depend on the seed. The other
19 do not: the 17 RMSNorm weights initialize to exactly 1.0 regardless of seed,
and the 2 RoPE buffers are a closed-form function of `head_dim` and `rope_theta`.
Consequences:

- "Reseeding produces a different brain" holds for 57/76 hashed entries, not all
  of them.
- 76 entries yield only **59 distinct SHA-256 digests**.
- **Version diffs must be keyed by tensor name.** A digest-set comparison loses
  the name correspondence and cannot report *which* tensor moved.
- `named_parameters()` already deduplicates tied embeddings, so the alias never
  appears there. It does appear in `state_dict()`; count by `data_ptr()`, not by
  entry.
- The 2 RoPE buffers are **non-persistent**: they are not in `state_dict()` at
  all, never serialize, and never change value. `state_dict()` has 74 entries, not
  76.

---

## bf16 master weights silently freeze 17 parameters

The single most consequential measurement in this repository, and the reason
check 7 is phrased as it is.

The 17 RMSNorm weights all initialize to **1.0**. bfloat16 has 8 mantissa bits, so
at magnitude 1.0 its representable resolution is about **7.8e-3**. A default
AdamW update of `lr = 1e-4` is two orders of magnitude *below* that resolution.
Measured, with real non-zero gradients of ~1.3e-2:

| master weight dtype | parameters that moved after 5 steps |
|---|---|
| bf16 | **57 of 74** — 17 frozen |
| fp32 | **74 of 74** — none frozen |

So with bf16 parameters those 17 norms receive gradients, are handed to the
optimizer, and then **do not change at all** — the update rounds away. Nothing
raises. Loss still falls, because the other 57 parameters are learning, so this
failure is completely invisible in the loss curve. It would have shipped as a
passing Phase 1 and quietly frozen every normalization scale in the 3B model.

**Consequence, and it is not optional:** the compute dtype and the master dtype
must be separated, and the master must be fp32, on the 62M development model too
— not only on 3B. bf16 is then a compute/cast detail, never the storage the
optimizer updates. The Phase 2 preflight assumes this; this measurement is why it
is a requirement rather than a preference.

---

## bf16 on CPU is emulated and 220x slower

The precision model above is correct on an accelerator and a serious performance
trap on a CPU. Measured on this machine, 62M model, batch 2 × 64 tokens, forward
+ backward:

| compute path | time per fwd+bwd |
|---|---|
| fp32 | **0.13 s** |
| `torch.autocast("cpu", bfloat16)` | **28.96 s** |

A **220× penalty**, because this CPU has no native bf16 and PyTorch emulates it.
The result is still numerically correct, so nothing raises — the run just appears
to hang, which is how this was found: a test suite written against the 62M model
took **27 minutes** instead of 30 seconds.

Two consequences. `bf16` compute is for the accelerator; CPU runs use `float32`.
And a test suite that exercises a real model must state its compute dtype
deliberately, or it will silently bill 220× for nothing. `train` logs a warning if
you ask for CPU + bf16.

---

## A ragged final batch makes effectiveBatchSize a lie

The sampler originally took whatever remained at the end of a shuffle, so a "batch
of 2" was sometimes a batch of 1. `effectiveBatchSize` was recorded as 4 while
the mean was not, and a 60-step run reported 25,600 tokens where
`60 × 2 × 2 × 128 = 30,720` was expected.

Nothing crashed and the loss still fell. The fix is to drop the ragged tail and
reshuffle, so every micro-batch is exactly `microBatchSize` blocks; token
accounting is then exact by construction and is asserted. The general lesson is
the one this repository keeps hitting: a training number that is *nearly* right is
worse than one that is absent, because it reads as evidence.

---

## Platform and storage quirks

**`os.fsync()` on a read-only handle returns `EBADF` on Windows**, and `os.open()`
on a directory raises `PermissionError` — there is no POSIX-style directory fsync
on Windows at all. `store.py` opens `r+b`, treats directory fsync as unsupported
there, and reports what actually synced rather than pretending. NTFS still orders
metadata through `os.replace`.

**`snapshot_download(local_dir=...)` writes hub bookkeeping** under
`.cache/huggingface/`. It is filtered out of `filesDownloaded` so the manifest
lists only artifacts actually requested.

---

## Manifest shape changes to flatten before Phase 2

**`tensors` and `tensorHashesAfterTraining` have two different shapes.** `tensors`
is a flat `name -> digest` map; `tensorHashesAfterTraining` nests the same map
beside an `aliasedTensors` list. An untrained version has only the first, a
trained version has both, so any consumer of "the tensor hashes" has to know
which. Found while naming artifacts, which needed to hash the weights.
`store._tensor_hash_map()` normalizes it and prefers the trained hashes — those
are the bytes a release asset contains — but **this should be flattened to one
shape before Phase 2.** Two shapes for one field is one more thing every consumer
has to know.
