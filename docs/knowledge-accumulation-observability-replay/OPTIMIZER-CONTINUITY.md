# AdamW Continuity Verification

Evidence file: [`evidence/optimizer-continuity.json`](./evidence/optimizer-continuity.json).

## Direct tensor evidence, `v493 → v495`

Both files are real PyTorch train-state checkpoints under `/var/lib/simpleminds/store/_runs/`. They were loaded on CPU with `torch.load(..., weights_only=False)` and compared parameter-by-parameter.

| Evidence | `v493` | `v495` |
|---|---:|---:|
| Optimizer parameter groups | 2 | 2 |
| Parameters per group | `57 + 17` | `57 + 17` |
| Optimizer state entries | 74 | 74 |
| Per-parameter AdamW step | **7** for all 74 | **15** for all 74 |
| Step delta | — | **+8 for all 74** |
| `exp_avg` / `exp_avg_sq` tensors compared | — | 148 |
| Moment tensors changed | — | **148 / 148** |
| Moment tensors unchanged | — | **0** |
| `train-state.stepsCompleted` | 7 | 8 |
| Training order length | 14 | 16 |
| Optimizer mode metadata | — | `carried` |
| `carryOptimizerFrom` | — | `v493` |

The step arithmetic is the decisive test:

```text
v493 optimizer step 7
+ 8 new optimizer steps
= v495 optimizer step 15
```

A freshly initialized optimizer would have step `8` after the same eight training steps. The observed `15` is only possible if the `v493` moments and counters were restored and advanced.

Sample tensor hashes (full set in the evidence file):

| Parameter | Tensor | `v493` SHA-256 | `v495` SHA-256 |
|---|---|---|---|
| 0 | `exp_avg` | `5071a83b…11e0d30` | `e918b4a7…82d83b` |
| 1 | `exp_avg` | `180edaff…9ea8dd0f` | `df6da835…849146e` |
| 2 | `exp_avg` | `b6f3ffd3…329841e9a` | `7c5b3bca…0f926cbe` |
| 3 | `exp_avg` | `6b49e19f…eff97fd` | `150ed972…6b3d2a0` |
| 4 | `exp_avg` | `1b404981…3148d6` | `fc7190cb…de93099` |
| 5 | `exp_avg` | `2e7357d6…e30da` | `6c03c401…37bc5` |

The `v495` state file is committed at:

```text
/var/lib/simpleminds/store/_runs/v495.train-state.pt
494,800,711 bytes
```

`v495` also has a committed checkpoint directory and `COMMITTED` record with `parentVersion=v493` and `stepsCompleted=8`.

## Future parent selection

`run-421` (the next training run) recorded:

- `parentSelection=working`
- working parent `v495`
- optimizer mode `carried`
- `carryOptimizerFrom=v495`

The chain then continued through `v496`, `v497`, `v498`, `v499`, and `v500`. The current production working pointer is `v500`; the current optimizer state is `carried` from `v499`, with 12 steps and a 494,800,711-byte state file. The historical `v495 → v496` transition proves the “future training selects the working optimizer parent” requirement without relying only on metadata.

## Caveat found during audit

The second (no-decay) parameter group changed `weight_decay` from `0.0` in `v493` to `0.01` in `v495`. The first group was already `0.01`. Moments and step counters are continuous, and the change is not evidence of a reset. It is a separate optimizer-hyperparameter continuity question and should be reviewed before treating the parameter-group split as fully preserved.
