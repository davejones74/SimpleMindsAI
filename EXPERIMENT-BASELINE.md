# EXPERIMENT-BASELINE — Unchanged Parent v389

Parent baseline is read-only and isolated. No weights, corpus files or production state were modified.

## Identity

| Item | Value |
|---|---|
| Parent version | `v389` |
| Isolated model | `/home/dave/sma-experiments/controlled-experiment-20261030T230000Z/parent-store/v389` |
| Model SHA-256 | `4ca50873039fa3d0f5af92fc004c368e6a5c40c33a5122b05b337e98627627ff` |
| Weight fingerprint | `a2aa77c0c3efb6b59fea452e206d7e3cc02a5f22a60d4db4527869f338db92a9` |
| Architecture | SmolLM3ForCausalLM, 8 layers, hidden 384, GQA 3:1 |
| Parameters | 61,839,744 |
| Weights verified against manifest | Yes |
| Initialisation lineage | `parentInitialisationType: RANDOM`, `pretrainedWeightsUsed: false` |
| Parent training history | 8 steps, 4,096 tokens, final train loss 7.4628 |
| Tokenizer SHA-256 | `ab4da6b2aa68247e9c0fa9b97fc7fcc796505038d01f7e144522a65ce0dbd2e5` |

The parent is a barely-trained checkpoint, not a mature baseline. It is the production lineage root for this experiment.

## Loss evidence

Commands used the isolated parent copy, frozen corpus files, sequence length 128, micro-batch 2, CPU float32, and `--verify-weights --per-document`. Baseline/validation evaluation used the recorded CPU evaluation runtime (Torch 2.14.1+cpu, Transformers 5.20.0, Tokenizers 0.23.3), not the ROCm training runtime. The manifest records both runtime fingerprints separately.

| Corpus | Documents | Blocks | Actual tokens | Parent loss |
|---|---:|---:|---:|---:|
| Frozen validation | 20 | 1,082 | 138,571 | **8.316381543489129** |
| Frozen training | 87 | 6,058 | 775,434 | **8.256554264328038** |

Baseline validation is higher than training loss, consistent with the parent being weakly trained.

### Validation distribution

| Statistic | Value |
|---|---:|
| Token-weighted mean | 8.317612293724556 |
| Group SD | 0.34140248434880577 |
| Group naive standard error | 0.07633991626912377 |
| Group 95% half-width | **0.14962623588748258** |
| Per-document min | 7.5287637535585175 |
| Per-document median | 8.34149962550353 |
| Per-document max | 9.096203892514977 |

The 0.15-nat material threshold in `EXPERIMENT-DESIGN.md` was motivated by the measured validation group-level 95% half-width (0.1496), rounded to two decimals. It is a practical material threshold, not the candidate-versus-parent paired confidence interval, and it was chosen before candidate training.

Best validation sources (lower loss): OpenStax physics sections, ~7.53–7.67. Worst validation sources: Python `stdlib` tutorial ~9.10, Python `modules` ~8.79, Python `functools` ~8.75, NIST standards ~8.55.

## Generation baseline

Five fixed prompts, greedy, 32 new tokens.

| Metric | Value |
|---|---:|
| meanLength | 29.2 |
| meanRep1 | 0.30057471264367813 |
| meanRep2 | 0.47384601350118594 |
| maxRun | 4 |
| totalTokens | 146 |

Example retained outputs:

- “The capital of France is” → ` a the of the, and the. ... The 6 is a 6 ...`
- “A steam engine converts heat into” → ` the the the the of the . ...`

The parent is degenerate by any useful generation standard. This is the expected baseline for a barely-trained random-rooted 62M student. Generation is a regression diagnostic, not proof of learning.

## Baseline artifact hashes

| Artifact | SHA-256 |
|---|---|
| `baseline/parent-validation-eval.json` | `1f7c64785a07786e4838a64c136e0963e129ebda753c9f802f096b30c70b237e` |
| `baseline/parent-train-eval.json` | `709176a54d6fc038edddb24a4052ceecec57f9a016e5928b7afb8b14e26ea8a1` |
| `baseline/parent-generation-quality.json` | `ed85515ab060c7ac2ceeda3ebe712fb050b23cdc3ab1be3aa21693669d7be66a` |
| `baseline/parent-baseline-summary.json` | `d5ec4db089d518db052954124deb8112aafa6675585d16ff11d67b47c3723081` |

All four are bound in `EXPERIMENT-MANIFEST.json`.

## Interpretation

The parent cannot serve as evidence of useful generation. The experiment’s meaningful signal must be a **paired improvement on frozen prospective validation**, with seed replication, and no generation/retention regression relative to this weak baseline. Reduced training loss alone is not sufficient.
