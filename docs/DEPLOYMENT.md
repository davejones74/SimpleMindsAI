# Deployment and artifacts

This article covers how SimpleMindsAI stores, names, publishes, deploys and
serves brain versions: what goes in git and what does not, where the weights live,
how artifact names are built, and how a server serves an immutable version
through the single mutable `active.json` pointer.

It is aimed at operators and release engineers. For the system model, see
[ARCHITECTURE.md](ARCHITECTURE.md); for local setup, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Contents

- [The store root](#the-store-root)
- [Store layout](#store-layout)
- [Checkpoints: what goes in git, and what does not](#checkpoints-what-goes-in-git-and-what-does-not)
- [Optimizer moments](#optimizer-moments)
- [Naming](#naming)
- [Export: distribution, never serving](#export-distribution-never-serving)
- [Deploying](#deploying)
- [Environment configuration](#environment-configuration)
- [Operational requirements](#operational-requirements)
- [Troubleshooting](#troubleshooting)

---

## The store root

`$SMA_STORE` is the single knob, resolved in this order:

1. an explicit `--out`
2. the `SMA_STORE` environment variable
3. `~/.sma/store`

Defaulting **outside the working tree** is deliberate, for two reasons that cost
real time to learn. A directory named `scratch` is a promise that someone will
delete it, and the append-only model lineage is the one thing that must not be
disposable — a re-clone or a re-provisioned deploy wipes it without erroring. And
on a server the checkout is often read-only, ephemeral, or on a different host
than the weights; coupling them makes the weights a deployment artifact rather
than a fact.

---

## Store layout

```
$SMA_STORE/                    the store — one root, resolved from SMA_STORE
  v001/  v002/                 complete version directories, bytes and record together
  _runs/                       optimizer state, outside the version dirs
  active.json                  the one mutable name: what a server serves now
  exports/                     content-addressed copies, for distribution

models/                        in git: the record, ~175 KB for the whole lineage
  v001/  v002/                 manifests, provenance, train state, diffs, COMMITTED
```

A version directory is never split. Both halves must arrive together for
`from_pretrained` to work at all, and keeping them whole is what lets
`staging_dir` + `COMMITTED` mean *all or nothing*; a manifest in one place and
weights in another reintroduces exactly the torn state that design exists to
prevent. The `models/` mirror is a **verified copy** for review, never a second
source of truth: `mirror_record` hashes on the way across and re-checks after the
write, and `verify_mirror` compares **symmetrically**, so a file invented in the
mirror or a weight file strayed into it is reported as drift rather than believed.

```bash
python -m sma.brain active --sync --set v002   # mirror records, pin the server pointer
python -m sma.brain active                      # what is serving, and is the mirror honest
```

---

## Checkpoints: what goes in git, and what does not

A brain version is large, and gets larger every version. Measured on this machine:

| Artifact | Size |
|---|---|
| `v001` total (bf16 weights) | 134.4 MiB |
| `v002` total (fp32 weights) | 252.5 MiB |
| optimizer moments for `v002`, AdamW fp32 | 471.9 MiB |
| 3B weights, bf16 | **5.73 GB** |
| 3B weights, fp32 | **11.46 GB** |

`model.safetensors` for the 62M model is already **118 MiB**, past GitHub's hard
100 MiB single-file push limit. Weights in git history are worse than merely
large: git stores every version of a binary blob permanently, compresses none of
it, and cannot merge it. Training to `v010` adds 1.2 GB of unreclaimable history;
`v500` puts 59 GB in the repository and makes it unusable for the code work it is
supposed to contain. Binary merge conflicts are unresolvable.

So the repository splits into two tiers, and the split is not a compromise — the
manifest makes it a stronger guarantee than a blob in history would:

**Tier 1 — in git, as text.** `config.json`, `provenance.json`,
`init-manifest.json`, `train-state.json`, `parameter-diff.json`, `COMMITTED`, and
the tokenizer (16.4 MiB, well under GitHub's per-file limit). Measured for
`v002`: **150,909 bytes** of provenance and config, plus the 17.2 MB tokenizer.
Every claim about how a brain was made and trained is reviewable in a diff. This
includes the SHA-256 of all 76 tensors, so a reviewer can check the manifest
against a downloaded artifact without trusting the uploader.

**Tier 2 — out of git history.** The weight file itself, on a durable volume
outside the working tree, and published as a **GitHub Release asset** (still
GitHub, still versioned, still fetchable through the API) or via Git LFS. The
committed hashes verify it bit-for-bit, which is a stronger statement than "trust
the blob that happens to be in the tree."

---

## Optimizer moments

Optimizer moments are a third thing and deliberately in neither tier: they are
~2× the fp32 weights, they are a torch pickle rather than a reviewable record,
and they describe a *run that may continue* rather than a version that is
immutable once committed. They live in
`$SMA_STORE/_runs/<version>.train-state.pt`, outside the version directory.
Keeping them inside would have made every 62M checkpoint 724 MiB instead of
252 MiB.

---

## Naming

Not `simpleminds_r1:latest`. Docker-style tags are a mutable pointer, and this
project's load-bearing property is that `vNNN` is append-only and immutable — you
must always be able to answer *which exact weights produced this loss number*, and
a name that moves under you cannot answer that. `latest` also invites
pull-and-assume-reproducible, which this project cannot offer.

```
internal identity    vNNN                                   append-only, immutable
artifact name        simpleminds-<size>-<YYYYMMDD>-<hash12>  immutable, content-addressed
release pointer      latest                                 only ever advances, never in a manifest
```

Computed by `store.artifact_name()`, not by hand, and reported by `status`:

```
v001  ->  simpleminds-62m-20260925-875995abf068
v002  ->  simpleminds-62m-20260925-51240e176ed9
```

The 12-hex suffix is the point: the name *proves* which weights it is. A
downloader recomputes it from the weight file, and a mismatch fails loudly. It is
hashed over the `name -> digest` **pairs** rather than the bare digests, because
this model records 76 tensors but only **59 distinct digests** — the 17 RMSNorm
weights all hold `1.0`. Where digests repeat, a digest-only hash cannot
distinguish a correct manifest from one that assigned every value to the wrong
tensor. The date is the version's own `createdAt`, never today's, so the name is
reproducible from committed metadata alone.

### The name does not credit SmolLM3, deliberately

An earlier draft called these `smai-smollm3-...`. That was wrong for a reason
that is not cosmetic: this project's entire claim is that **no pretrained weights
were used**, so putting another model's name in the headline of the artifact
invites precisely the misreading the [proof obligations](PROOF.md#proof-obligations)
exist to prevent. A reader who sees `smollm3` in a filename has been told a
fine-tune happened, whatever the manifest says afterwards.

The architecture genuinely *is* SmolLM3, and that is not being hidden — it is
recorded in `config.json`, `provenance.json` and `architectureReferenceRepo`,
which is where lineage belongs and where it is verifiable. The rule this
repository follows elsewhere applies here too: **the artifact's identity is this
project's work; the borrowed architecture is metadata.** Pretending the
architecture is something else would be the actual dishonesty.

`tests/test_publication.py::test_artifact_name_does_not_credit_a_third_party_model`
enforces this, so a future rename that reintroduces it fails rather than shipping.

The canonical `vNNN` remains the internal identity so `store.py`'s immutability
rules and the manifest chain stay authoritative; the artifact name is a
publication concern layered on top, not a replacement.

For 3B this also forces sharding, because a GitHub Release asset caps at 2 GB —
5.73 GB does not fit in one. `safetensors` shards natively, and shards follow the
same naming scheme.

---

## Export: distribution, never serving

```bash
python -m sma.brain export --version v002 --dest $SMA_STORE/exports
python -m sma.brain verify-export --path $SMA_STORE/exports/simpleminds-62m-20260925-51240e176ed9
```

`export` copies a committed version into a directory named for its content
address. The name goes on the **directory**, not on the weight file, so the
export is still an ordinary transformers checkpoint that `from_pretrained`
accepts unchanged — renaming `model.safetensors` to
`simpleminds-...safetensors` would have made the content address and the standard
loader mutually exclusive. Verified on the real `v002`: loads to 61,839,744
parameters, fp32, tokenizer intact.

It writes `SHA256SUMS` over every copied file, and refuses to overwrite an
existing export — a content address that is already present *should* be
byte-identical, so clobbering it would mean something upstream is already wrong.
It re-derives the artifact name from the copied manifest and aborts if the copy
does not hash to the name it is filed under, so a truncated copy fails at export
rather than at whoever's downloading it. `EXPORT.json` is written *after* the
sums and is therefore absent from them, because it carries a timestamp and
including it would make two exports of identical bytes produce different sums
files.

**Chat, eval and generate do not read exports.** Every consumer goes through
`store.resolve_version_dir(root, version)` and loads the immutable `vNNN`
directory:

```
$SMA_STORE/v002/                                    canonical, hash-verified, what serving loads
$SMA_STORE/exports/simpleminds-.../                a copy, for machines without the store
```

This is structural, not stylistic. Serving from the export would mean two 247 MB
copies of the same weights and a permanent obligation to prove they agree — a
second thing that can be wrong, in exchange for nothing. The export exists to get
bytes across a network boundary, and that is the only job it has.

---

## Deploying

`active` is the only deliberately mutable name in the system, and it exists
purely for deployment: *which brain is this server serving right now*. It is kept
strictly separate from identity — `vNNN` and the content address never move — and
it must never appear in a manifest, because a manifest that claims to be active
is a manifest that can lie. Activity is a property of a deployment, not of a
weight file.

```bash
export SMA_STORE=/var/lib/sma          # durable volume, not the checkout
python -m sma.brain status             # serve from here
python -m sma.brain active             # confirm which version this host will serve
```

For an off-host server, `export` writes a content-addressed copy with
`SHA256SUMS`; ship that instead of the repository, let the server `verify-export`
it, and then point `SMA_STORE` at the result. The server then serves that
immutable directory — export is a transport step, never a per-request one.

Promotion (`src/training/python-promotion.js`) evaluates, decides, moves the
active pointer, and only then reloads the resident worker. A crash between the
pointer write and the reload leaves a committed, valid version active, and the
worker keeps serving the old one until its next reload — the safe direction to
fail in.

### Deploying this checkout (X1 Pro)

A partial sync of only `src/` is not enough for the brain visualiser: the
`blueprint` npm script is in `package.json`, and the exporter is
`python/sma/blueprint.py`. Deploy all three areas plus the lockfile:

```bash
cd ~/Repositories/SimpleMindsAI && git pull

sudo rsync -a --delete src/ /opt/simpleminds/src/
sudo rsync -a package.json package-lock.json /opt/simpleminds/
sudo rsync -a --delete python/sma/ /opt/simpleminds/python/sma/

sudo cp deploy/etc/x1pro.simpleminds.env /etc/simpleminds/simpleminds.env
cd /opt/simpleminds && sudo -u simpleminds npm install
sudo systemctl restart simpleminds.service
```

`npm install` is required because the visualiser adds `three`. The deployment
environment file sets:

```dotenv
SMA_BLUEPRINT=/var/lib/simpleminds/data/visualisation/brain-blueprint.json
```

It also pins the data-derived training policy explicitly:
`TRAIN_TARGET_EPOCHS=2`, `TRAIN_MAX_STEPS=400`, `TRAIN_MIN_UNIQUE_TOKENS=1700`,
`TRAIN_REPLAY_PERCENT=20`, and `TRAIN_VAL_BLOCKS=32`. Verify the effective
config after restart using the command in
[PRODUCTION.md](PRODUCTION.md#71-training-policy-knobs-verify-after-deploy).

The checked-in env carries `SIMPLEMINDS_AUTH_TOKEN=<TOKEN>` as a placeholder.
Before installing it, replace that line with the production token **outside the
repository**; never commit a real token. Verify `/health` stays open and a
GraphQL request without the bearer token returns `401`.

Generate the runtime blueprint **on the target host**, as the service user:

```bash
sudo -u simpleminds env \
  HOME=/var/lib/simpleminds \
  SMA_STORE=/var/lib/simpleminds/store \
  SMA_PYTHON=/opt/simpleminds/python/.venv/bin/python \
  SMA_BLUEPRINT=/var/lib/simpleminds/data/visualisation/brain-blueprint.json \
  bash -c 'cd /opt/simpleminds && npm run blueprint'
```

The exporter writes only that JSON file and never loads model weights. It must
be re-run manually after a promotion if the visualiser should follow the new
active version. A fresh deployment intentionally shows “No blueprint exported
yet” until this command has run.

---

## Environment configuration

Configuration is environment-driven; `.env.example` is the reference. The values
most relevant to deployment:

| Variable | Default | Purpose |
|---|---|---|
| `SMA_STORE` | `~/.sma/store` | The compute-plane store root (versions, `_runs`, `active.json`, `exports`). |
| `SMA_PYTHON` | checkout venv / PATH | Python interpreter Node uses to spawn the compute plane. |
| `SMA_DEVICE` | `auto` | `auto` \| `cpu` \| `cuda` for the student worker. |
| `API_HOST` | `127.0.0.1` | Server bind. Set `0.0.0.0` to expose the admin portal deliberately. |
| `API_PORT` | `4000` | GraphQL + admin portal port. |
| `CHAT_PORT` | `8787` | Standalone chat server port (`npm run chat`). |
| `OLLAMA_ENDPOINT` | `http://localhost:11434` | Teacher/critic endpoint. |
| `OLLAMA_MODEL` | `llama3.2:latest` | Teacher/critic model. |
| `OLLAMA_FIXTURE` | `false` | `true` makes every Ollama call a deterministic stub (no GPU needed for smoke/tests). |
| `SNAPSHOT_DIR` / `EVALUATION_DIR` / `REGISTRY_DIR` / `BUFFER_DIR` / `PLAN_DIR` | `./data/...` | Node data-plane paths. |
| `PROMOTE_EVAL_SET` | (unset) | Frozen `.jsonl` evaluation set; required to compare parent and candidate. |
| `PROMOTE_MIN_LOSS_DELTA` | `0` | Minimum `parentLoss − candidateLoss` for promotion. |
| `PROMOTE_MAX_LOSS` | `Infinity` | Ceiling on candidate loss. |
| `PROMOTE_REQUIRE_FINITE` | `true` | Reject non-finite losses. |
| `TRAIN_LR` / `TRAIN_SEQ_LEN` / `TRAIN_MICRO_BATCH` / `TRAIN_GRAD_ACCUM` | `1e-4`, `128`, `2`, `2` | Python trainer hyperparameters passed by the Node orchestrator. |
| `TRAIN_TARGET_EPOCHS` / `TRAIN_MAX_STEPS` | `2`, `400` | Data-derived budget: steps are rounded up from `targetEpochs × training blocks ÷ effective batch`, then hard-capped. `TRAIN_STEPS` (`60`) is the legacy fallback for trainers without corpus preflight. |
| `TRAIN_MIN_UNIQUE_TOKENS` | `1700` | Minimum unique tokens in the training stream (validation excluded). Below this the run is refused/deferred with `INSUFFICIENT_TRAINING_DATA`. `0` disables. |
| `TRAIN_REPLAY_PERCENT` | `20` | Maximum estimated token share drawn from consumed reviewed articles for replay. `0` disables replay. |
| `TRAIN_WARMUP` / `TRAIN_VAL_BLOCKS` / `TRAIN_EVAL_EVERY` / `TRAIN_TIMEOUT_MS` | `10`, `32`, `10`, `3600000` | LR warmup steps, held-out validation blocks, validation-record interval (0 keeps the legacy two endpoints), and trainer subprocess timeout. Validation rows are appended from consumed material when available, so they do not consume training blocks. |
| `TRAIN_COMPUTE_DTYPE` | `bfloat16` | Compute dtype. Use `float32` on CPU (see below). |
| `INIT_CONFIG` | `small` | `sma.brain init --config` architecture (random init). |
| `CRAWL_MODE` | `fixture` | `fixture` \| `real`. `real` uses the persisted, robots-aware frontier; `CRAWL_URLS` seeds it, but an empty `CRAWL_URLS` never clears persisted work and never disables discovery. |
| `CRAWL_URLS` | (empty) | Optional bootstrap seeds. Leaving it empty is valid; discovery continues from the domain registry and the adapters below. |
| `CRAWL_DISCOVERY_ADAPTERS` | `sitemap,feed` | Enabled discovery adapters: `sitemap` (robots `Sitemap:` + `/sitemap.xml`, bounded index traversal), `feed` (RSS/Atom), `search` (only with a configured provider). |
| `CRAWL_DISCOVERY_SEEDS` / `CRAWL_DISCOVERY_FEEDS` | (empty) | Optional extra discovery roots / explicit feed URLs. |
| `CRAWL_DISCOVERY_MAX_ROOTS` / `CRAWL_DISCOVERY_MAX_CANDIDATES` | `25`, `500` | Per-cycle caps on bootstrap roots and adapter-proposed candidates. |
| `CRAWL_DISCOVERY_MAX_SITEMAPS` / `CRAWL_DISCOVERY_SITEMAP_MAX_DEPTH` | `50`, `3` | Sitemap traversal bounds. |
| `CRAWL_SEARCH_ENDPOINT` / `CRAWL_SEARCH_PROVIDER` / `CRAWL_SEARCH_QUERY_PARAM` / `CRAWL_SEARCH_QUERIES` | (empty) | Optional search-provider adapter; active only when an endpoint is set. No credentialed provider is required. |
| `CRITIC_TEMPERATURE` | `0.1` | Critic sampling temperature; recorded with every review. The Phase 7 experiment retained `0.5` in `.env` (verdicts stable; see [PHASE7_REPORT.md](PHASE7_REPORT.md#critic-temperature-experiment)). |
| `CRITIC_PROMPT_VERSION` | `critic-prompt-v1` | Operator-managed label for the critic prompt wording; recorded with every review. Bump it when the prompt changes. |
| `EVAL_DATASET_ID` | `eval-002` | Frozen evaluation set id. `eval-002` is the bundled, domain-stratified Wikipedia baseline; `eval-001` is the legacy 5-row seed. |
| `EVAL_MIN_DOCUMENTS` | `0` | Advisory floor on frozen-eval-set size (documents). Non-enforcing by default. |
| `EVAL_MIN_TOKENS` | `0` | Advisory floor on frozen-eval-set size, by a ~4-chars/token estimate. Non-enforcing; recommended `20000` so a return to a tiny set warns loudly. |
| `PROMOTE_EVAL_SEQ_LEN` | `128` | Eval block length, pinned to `TRAIN_SEQ_LEN`. Changing it changes the metric signature and starts a new, incomparable promotion ladder. |
| `JOBS_MAX_RUNTIME_MS` | `0` | Wall-clock bound for a job; `0` is unbounded. A job past it ends `max-runtime`. |
| `LEARNING_NO_PROGRESS_CYCLES` | `5` | Consecutive no-progress learning cycles before the job ends `no-progress`. |
| `TRAIN_MAX_CONSECUTIVE_REJECTIONS` | `5` | Consecutive rejected training candidates before the supervisor logs the `repeated-rejection` phase and keeps waiting for new material (continuous training never stops on rejections). `0` disables the guard. |

The full, authoritative list lives in `.env.example` and `src/config.js`. The
Python backend is pinned separately in `python/requirements-cuda.txt` or
`python/requirements-rocm.txt` (see [DEVELOPMENT.md](DEVELOPMENT.md#python-compute-plane)).

### Backend recording

The backend in use is recorded with every train state as
`environment.backend` (`cuda` / `rocm` / `cpu`). Under ROCm the torch device
type is still `cuda`, so `environment.device` and `environment.backend` differ on
purpose — that pair is what makes a run's provenance unambiguous.

---

## Operational requirements

- **One backend profile, chosen explicitly.** CPU-only `requirements.txt` does not
  install torch; install exactly one of `requirements-cuda.txt` or
  `requirements-rocm.txt`. "Which GPU am I running on" must never be an accident
  of a default install.
- **A durable `SMA_STORE` outside the checkout.** The model lineage is
  append-only and must survive a re-clone or re-provision.
- **Disk space for checkpoints.** A 62M fp32 version plus its optimizer pickle is
  ~252 MiB + ~472 MiB; a 3B run is far larger. The `preflight` command estimates
  checkpoint write space and refuses a run the store cannot hold.
- **Resume-state growth, and how to reclaim it.** `_runs/*.train-state.pt`
  optimizer-moment blobs accumulate at ~472 MB per version and are the only part
  of the store that grows without bound. `prune-runs` deletes stale blobs (never a
  published version, weight, or record) and is a **dry run by default**:

  ```bash
  python -m sma.brain prune-runs                      # dry run: report only
  python -m sma.brain prune-runs --keep 5 --confirm   # actually delete
  python -m sma.brain prune-status                    # read-only disk/retention report
  ```

  The active version and the `--keep` most recent published versions are always
  retained (`--keep` defaults to `5`, matching the whole-version retention floor,
  and is overridable with `$SMA_PRUNE_KEEP`). Destructive pruning fails closed
  unless `active.json` is valid, the audit log is writable, no candidate run lock
  is live and the external trainer lock (`SMA_RUN_LOCK`, the Node registry
  `RUN.lock`) is not held; it also refuses symlinked or out-of-store candidates.
  `prune` applies the same dry-run-by-default policy to whole published version
  directories. Both append a durable record to the store's prune log; nothing is
  deleted without `--confirm`. See [PRUNING.md](PRUNING.md).
- **Master weights are fp32.** This is an invariant, not a tuning choice: bf16
  masters silently freeze the 17 RMSNorm parameters. See
  [FINDINGS.md](FINDINGS.md#bf16-master-weights-silently-freeze-17-parameters).
- **ROCm host notes.** The ROCm torch pin is tied to the host's ROCm
  release/kernel and must be verified before it is trusted. 8-bit Adam
  (`bitsandbytes`) is CUDA-only, so the ROCm 3B preflight must fall back to
  Adafactor. The Ryzen AI HX 370 / 890M is an APU: its reported
  `total_memory` is a shared carve-out, not dedicated VRAM, so do not size a 3B
  run as if it were a discrete card.

---

## Troubleshooting

- **`os.fsync()` fails on a directory.** Windows has no POSIX-style directory
  fsync: `os.fsync()` on a read-only handle returns `EBADF` and `os.open()` on a
  directory raises `PermissionError`. `store.py` opens `r+b`, treats directory
  fsync as unsupported there, and reports what actually synced. NTFS still orders
  metadata through `os.replace`. See [FINDINGS.md](FINDINGS.md).
- **CPU training appears to hang.** `bfloat16` is emulated on CPU and measured at
  **220×** slower. Use `--compute-dtype float32` on CPU. See
  [FINDINGS.md](FINDINGS.md#bf16-on-cpu-is-emulated-and-220x-slower).
- **A resume refuses.** Resume verifies the corpus `datasetHash` and every config
  field except `steps`, and refuses if the target does not advance. Continue
  against identical data or start a new version.
- **Chat returns `503`.** The student worker is not running or no version is
  active. There is no teacher fallback by design; check `active.json` and the
  worker.
- **Training History shows unavailable metrics.** Unavailable metrics are
  reported as unavailable, never as zero. An empty `data/` tree and a missing
  `SMA_STORE` are normal first-run conditions.
