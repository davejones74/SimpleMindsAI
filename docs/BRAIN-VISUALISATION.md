# Brain visualisation (Phase 1.5)

A read-only, explicitly invoked exporter turns the **active** SimpleMindsAI
checkpoint into a versioned structural blueprint. A standalone Three.js page at
`/admin/brain` renders that blueprint as an interactive, cinematic neural
universe.

The synaptic web is the primary visual language. The real transformer
architecture remains embedded in it: structural nodes, tensor metadata and
actual computational connections stay inspectable in **Architecture** mode.

Phase 1.4 refined the art direction without changing the blueprint or the
two-mode design: the layout is a coherent ellipsoidal volume, structural nodes
use a glass/metal/matte material hierarchy, lighting has cool key and
violet/cyan accents, and the illustrative filaments are finer, tapered and
depth-faded.

Phase 1.5 adds bounded, observational live training telemetry. Python emits
step-level aggregates over its existing stderr pipe; the server keeps a small
in-process snapshot and publishes it on the existing SSE feed; the brain page
shows a live dashboard and a rolling loss chart. No weights, activations or
per-parameter events are collected.

The visualiser is optional. It is not part of the perpetual-learning service,
does not run in the background, and never loads model weights.

## Invariants

- **The active pointer is authoritative.** The exporter reads
  `$SMA_STORE/active.json` and refuses a version without a `COMMITTED` marker.
  It never picks the newest directory, version number, or manifest.
- **The model store is read-only.** The exporter reads JSON metadata and
  safetensors *headers*. It writes exactly one output file, outside the store,
  using a temporary file plus atomic `os.replace`.
- **No model is constructed and no tensor data is read.** No torch model, no
  GPU allocation, no hooks, no training loop, no new Python dependency.
- **Telemetry is observational and bounded.** The training loop publishes a
  configured-interval snapshot of metrics it already computes (loss, learning
  rate, tokens, step timing). It never reads activations, gradients, weights or
  individual parameters, and no per-parameter browser objects exist.
- **Training is unaffected by the observer.** Publication uses the existing
  child-process stderr pipe; telemetry failures are swallowed, history is
  capped, and a disconnected browser cannot pause or alter training.

## Two modes, two visual categories

The page has two explicit modes:

| Mode | Contents |
|---|---|
| **Brain** (default) | Structural nodes and genuine connections, plus a deterministic, seeded illustrative web of synaptic nodes and branched filaments. The illustrative layer supplies density and depth. |
| **Architecture** | Only nodes and connections derived from the exported blueprint. Region rings and labels identify the transformer sequence. Illustrative filaments, field synapses and ambient dust are hidden. |

The categories never mix in the authoritative data:

- **Structural** entries come from `components` and `connections`. Their ids,
  dimensions, parameter metadata and inspection behaviour are unchanged.
- **Illustrative** entries live only in the render plan's `synaptic` collection.
  Their ids start with `synapse.` or `filament.`; they have
  `kind: "illustrative"` and are never inserted into `components`,
  `connections`, parameter accounting or the inspector.
- Decorative filaments are drawn as broken/dashed fine lines. Structural
  connections are solid, brighter and use the connection-type palette.
- The on-screen legend states this distinction, and Brain mode explicitly says
  that filaments and ambient particles are artistic atmosphere, not weights,
  activations, learned signals or information flow.

## Live training telemetry (Phase 1.5)

The live panel has a separate, versioned contract: `sma/training-telemetry@1`.
It is observational, not a training input.

| Aspect | Implementation |
|---|---|
| Source | `python/sma/train.py` at natural step/evaluation boundaries. Values are already computed for the durable training history. |
| Transport | One structured JSON line per interval on the existing child-process **stderr** pipe. stdout remains the single final JSON object. |
| Events | `started`, `snapshot`, `evaluation`, `checkpoint`, `completed`, `failed`, plus job lifecycle status. |
| Sampling | Default one snapshot per second (`TRAIN_TELEMETRY_INTERVAL_MS`), clamped to 250 ms minimum. Evaluation events occur only when evaluation actually runs. |
| Server state | A bounded in-process snapshot and history (`TRAIN_TELEMETRY_HISTORY_POINTS`, default 600). Publication to SSE is coalesced (`TRAIN_TELEMETRY_PUBLISH_MS`, default 1000). |
| Reconnect | `GET /api/admin/training/telemetry` returns the authoritative snapshot plus the SSE resume sequence. The browser re-reads it on `hello`/`resync`. |
| Auth | The endpoint and SSE feed sit behind the existing admin auth gate. No token is placed in a URL or telemetry payload. |
| Staleness | The snapshot carries `receivedAt`, `staleAfterMs` and `ageMs`; the UI distinguishes live, stale, disconnected, completed and unavailable states. |
| Stale sessions | Out-of-order sequences and events from an old session are ignored. Only an explicit `started` begins a new session and resets history. |

Metrics collected: training loss, learning rate, step and total steps, tokens
seen, step duration, steps/second, elapsed run time, evaluation loss when
measured, checkpoint creation and final run state. All values that are missing
are reported as unavailable (`null` / "not measured"); no estimate is presented
as a measurement.

A controlled six-step CPU microbenchmark (tiny model, iterations alternated)
measured a 3.259 s median without telemetry and 3.218 s with telemetry enabled.
The difference is smaller than run-to-run noise, so no measurable training
regression was observed; this is not a production GPU benchmark.

The chart keeps only the current live session and distinguishes training loss
from evaluation points. A new session starts a new chart; completed-run history
remains in the Observatory's Trends & Metrics view. Training and evaluation
loss are never joined into a fabricated continuous line.

### Layer activity prototype (Phase 1.6)

The optional layer measurement is **per-transformer-block gradient RMS**:

```
rms_block = sqrt(mean(g^2))
```

over every parameter-gradient element in `model.layers.N`, after `backward()`
and **before gradient clipping**. It is read from gradients the training pass
already produced; no hooks, activations, full tensors or extra model are
created. Per-tensor reductions stay on the device and only one scalar per block
is copied to the host per sample.

Controls:

- `TRAIN_LAYER_ACTIVITY=false` (default) disables measurement entirely.
- `TRAIN_LAYER_ACTIVITY_INTERVAL_MS=2000` sets the sample interval.
- The live panel's **Layer overlay** toggle is independently off by default.
- Missing/non-finite values remain `null`; no layer is marked active by a
  global training-step event.
- Display intensity is normalised only for colour (robust p90 reference); the
  telemetry payload keeps the raw RMS and element count.

The overlay is one batched `Points` object with one point per existing layer
region, not a per-layer sprite/timer. The Phase 1.5 acknowledgement pool remains
four sprites.

A three-condition CPU microbenchmark (tiny model, 10 steps, 3 repetitions,
worst-case 500 ms layer sampling) measured median wall time: baseline 5.044 s,
Phase 1.5 telemetry 5.113 s, layer measurement 5.094 s. The layer condition was
inside run-to-run noise; p95 step time was 0.517 s / 0.528 s / 0.521 s. The
8-layer payload was 897 bytes at its worst sample; a 36-layer payload is about
2.9 KB. This is not a production GPU benchmark. The feature therefore remains
**off by default** until a GPU budget is measured on target hardware.

Live activity effects are a separate renderer layer with a **fixed pool of four**
transient sprites. A genuine new step produces a restrained cyan acknowledgement
at a dedicated status anchor; a genuine checkpoint produces a distinct amber
acknowledgement. Activity can be switched off in the panel without disabling
telemetry or training. It never highlights a layer, because no layer-level
measurement exists. Adding that honestly would require per-layer activation
collection, aggregation and validation within an explicit performance budget;
it is deliberately deferred.

## Export

```bash
npm run blueprint
# or, from python/:
python -m sma.blueprint --store <store> --out <file>
```

Defaults:

| Setting | Default |
|---|---|
| Store | `$SMA_STORE` or `~/.sma/store` |
| Output | `$SMA_BLUEPRINT`, else `data/visualisation/brain-blueprint.json` |
| Server file path | `$SMA_BLUEPRINT` (same default) |
| API path | `/api/admin/brain/blueprint` |

The exporter rejects an output path inside the model store. The output file is
ignored by git (`data/**`), so a fresh checkout or deployment must run the
exporter on the host that serves the page before the visualiser has data. This
is deliberate: the blueprint is an artifact of the active model, not a source
file, and must not be committed or silently replaced with a stale copy.

Typical result for the current 62M prototype:

```json
{
  "ok": true,
  "verb": "blueprint",
  "version": "v061",
  "components": 133,
  "connections": 173,
  "parameters": 61839744,
  "verification": "verified"
}
```

## Open the page

```bash
npm start
```

Open `http://localhost:4000/admin/brain`. The page is linked from the
Observatory header as **Brain visualiser**. It reads only the exported JSON via
the admin REST surface, under the same authentication gate as the rest of
`/api/admin`. The page is not workspace-scoped: it displays the export for the
configured store's active model, which is why the export must be generated
against that same store.

If no export exists, the page says so and gives the command; it does not
fabricate a scene. The request has a 15-second timeout so the loading state can
never remain indefinitely. Invalid JSON/schema, a failed module import, or a
WebGL initialisation failure each produce a clear overlay with a retry action.
The API returns the blueprint and file metadata only; it does not expose store
paths or weight-file filesystem locations.

## Blueprint schema: `sma/brain-blueprint@1`

The complete export has this shape. Array contents are abbreviated here.

```json
{
  "schema": "sma/brain-blueprint@1",
  "exportedAt": "2026-10-20T00:00:00Z",
  "source": {
    "activePointer": "active.json",
    "activeVersion": "v061",
    "artifactName": "simpleminds-62m-20260925-2664db44513d",
    "weightFingerprint": "2664db44513d",
    "configSha256": "â€¦",
    "manifestSchema": "sma/init-manifest@1",
    "committedAt": "2026-10-14T18:40:54Z",
    "weightsInspected": "safetensors-header",
    "weightsLoaded": false,
    "weightFiles": [
      { "name": "model.safetensors", "bytes": 247367192, "tensorCount": 74, "shard": false }
    ]
  },
  "model": {
    "id": "simpleminds-62m-20260925-2664db44513d",
    "version": "v061",
    "architecture": "SmolLM3ForCausalLM",
    "configName": "small",
    "initialisation": {
      "type": "TRAINED",
      "pretrainedWeightsUsed": false,
      "parentVersion": "v040",
      "randomInitAncestor": "v001",
      "lineage": []
    },
    "architectureConfig": {
      "numHiddenLayers": 8,
      "hiddenSize": 384,
      "intermediateSize": 1024,
      "numAttentionHeads": 6,
      "numKeyValueHeads": 2,
      "headDim": 64,
      "vocabSize": 128256,
      "ropeTheta": 5000000.0,
      "tieWordEmbeddings": true
    },
    "counts": {
      "layers": 8,
      "componentsByType": {
        "linear_projection": 56,
        "normalization": 17,
        "transformer_block": 8,
        "attention": 8,
        "mlp": 8,
        "residual": 16,
        "activation": 8,
        "elementwise": 8,
        "embedding": 1,
        "positional_encoding": 1,
        "output_head": 1,
        "model": 1
      },
      "connectionsByType": {
        "dataflow": 138,
        "positional_encoding": 18,
        "residual": 16,
        "tied_parameter": 1
      }
    }
  },
  "parameterAccounting": {
    "totalParameters": 61839744,
    "uniqueTrainable": 61839744,
    "nonTrainable": 0,
    "tensorElements": 61839808,
    "persistedTensorElements": 61839744,
    "nonParameterBufferElements": 64,
    "tiedAliases": [
      {
        "alias": "model.lm_head.weight",
        "canonical": "model.embed_tokens.weight",
        "elements": 49250304,
        "counted": false
      }
    ],
    "recorded": {
      "parametersTotal": 61839744,
      "parametersTrainable": 61839744,
      "parametersUniqueByStorage": 61839744
    },
    "verification": {
      "status": "verified",
      "exact": true,
      "independentStructuralEvidence": "safetensors-header",
      "method": "manifest tensor shapes + config structure + safetensors headers (no tensor data loaded)",
      "checks": [],
      "discrepancies": []
    }
  },
  "components": [
    {
      "id": "model.layers.3.attn.q_proj",
      "name": "Layer 3 query projection",
      "type": "linear_projection",
      "parentId": "model.layers.3.attn",
      "blockIndex": 3,
      "derived": false,
      "dimensions": { "in": 384, "out": 384 },
      "tensors": [
        {
          "name": "model.layers.3.self_attn.q_proj.weight",
          "shape": [384, 384],
          "dtype": "float32",
          "numel": 147456
        }
      ],
      "parameters": { "unique": 147456, "elements": 147456, "exact": true, "counted": true },
      "metadata": { "role": "query", "heads": 6, "headDim": 64 }
    }
  ],
  "connections": [
    {
      "id": "conn.model.layers.3.input_norm->model.layers.3.attn.q_proj.dataflow",
      "from": "model.layers.3.input_norm",
      "to": "model.layers.3.attn.q_proj",
      "type": "dataflow",
      "explicit": true,
      "inferred": false,
      "dimensions": { "width": 384 },
      "note": null
    }
  ],
  "warnings": [],
  "counts": { "components": 133, "connections": 173, "layers": 8 }
}
```

### Component types

| Type | Meaning |
|---|---|
| `model` | Root container |
| `embedding` | Token embedding |
| `positional_encoding` | RoPE mechanism / non-learned positional buffers |
| `transformer_block` | One decoder layer container |
| `attention` | Self-attention container |
| `linear_projection` | Q/K/V/O, MLP gate/up/down |
| `mlp` | SwiGLU MLP container |
| `activation` | SiLU (derived node, no tensor) |
| `elementwise` | Gated product (derived node, no tensor) |
| `normalization` | RMSNorm |
| `residual` | Residual join (derived node, no tensor) |
| `output_head` | Tied language-model head |
| `buffer` | Non-parameter buffer |

### Parameter accounting

The fields deliberately answer different questions:

- `totalParameters` / `uniqueTrainable`: parameter elements counted once by
  storage, excluding aliases.
- `tensorElements`: every tensor element in the manifest, including
  non-parameter buffers.
- `persistedTensorElements`: parameter elements found in the safetensors
  headers, when a header exists.
- `nonParameterBufferElements`: RoPE buffers, which are not parameters.
- `tiedAliases`: entries such as `lm_head.weight` that share storage with the
  embedding and are **not** counted twice.
- `verification.status`:
  - `verified` â€” manifest tensor shapes, config structure and safetensors
    headers agree; the header is independent evidence of the persisted tensor
    set.
  - `unverified` â€” exact as recorded by the manifest, but no safetensors header
    was available to independently confirm the checkpoint structure.
  - `mismatch` â€” at least one structural check failed; discrepancies are
    reported.
- `verification.checks` lists every comparison and its basis. Agreement between
  config and manifest alone is not reported as independent verification.

The report never claims the count is verified merely because two metadata
sources agree. Only a safetensors header supplies independent structural
evidence, and even then the exporter does not read tensor data.

## Interaction

- Drag to orbit; scroll to zoom; right-drag or shift-drag to pan.
- Switch modes with the **Brain / Architecture** control, or press `B` / `A`.
  `?mode=architecture` opens the precise view directly.
- Click a structural node or a layer region to select it. Selecting a region
  shows the aggregate parameter/tensor counts of its contained components.
- Selection illuminates the real component and its genuine blueprint
  connections. The surrounding synaptic web is dimmed, not hidden, in Brain
  mode.
- The inspector lists dimensions, tensor shapes, exact/tied/derived labels,
  incoming and outgoing connections, and the parameter-verification checks.
- Clicking a connected component moves the selection to it.
- **Reset view** (or `R`) restores the camera; **Overview** (or `Esc`) clears the
  selection and returns to the whole-brain view.

## Rendering and scalability

The layout is derived from the blueprint, not from a hard-coded eight-layer
model:

- Transformer regions are distributed along a deterministic spherical spiral
  over an ellipsoidal shell. The sequence still runs from the first region to
  the last, but it winds through a coherent volume instead of forming a flat
  grid, a horseshoe or a set of rectangular compartments.
- Each region is a local cluster in a basis aligned to the spiral. Norms,
  Q/K/V/O, attention, the SwiGLU MLP, activation, product and residual joins use
  semantic slots derived from the blueprint's parent/child relationships and
  `role` metadata.
- Global embedding, RoPE, final norm and LM head sit at the two ends of the
  sequence, with subtle colour and size cues.
- Satellite synaptic clusters orbit the regions they belong to; inner core
  clusters fill the middle-distance volume. Field filaments bridge outward and
  inward without scattering disconnected islands around the model.
- Region tint follows a cyan-to-violet gradient along the sequence. Faint
  circular rings trace the spiral in Brain mode; Architecture mode shows them
  more clearly alongside region labels.
- Positional-encoding and tied-parameter connections are real but low-priority
  in the overview; they are dimmed in Brain mode and remain visible and
  inspectable in Architecture mode.
- There are no rectangular block enclosures or wireframe boxes.

The material and lighting system is deliberately restrained:

- Weight-bearing and container nodes use a glass or brushed-metal physical
  material with clearcoat highlights; derived structural nodes stay matte.
- Selected components gain a translucent glass shell and a soft halo.
- Real blueprint connections remain solid and type-coloured. Illustrative
  filaments are finer, dashed/dotted, tapered toward their tips, and fogged with
  depth so long foreground strands recede.
- A cool hemisphere/key light, cyan fill, violet rim and a low-intensity inner
  point light provide volume without washing out the scene. Large, very faint
  atmosphere sprites add a soft background gradient; no bloom pass is used.

Performance is independent of parameter count:

- Structural nodes are one instance per component, never one per parameter.
- Structural node groups, synaptic nodes and region auras use `InstancedMesh` or
  batched `Points`.
- Curved structural and illustrative lines are batched into two
  `LineSegments2` buffers. Illustrative lines are intentionally broken into
  dashes, which also keeps their segment count bounded.
- Budgets are fixed: at most 5,000 structural nodes, 20,000 structural
  connections, 2,400 synaptic nodes and 2,200 illustrative filaments.
  Omitted geometry is reported, never silently invented.
- Background dust is a fixed budget. Fog, additive glow and soft halos replace
  expensive post-processing; no bloom pass is required.
- Live telemetry costs one short stderr line per configured interval, one
  bounded server history and at most one coalesced SSE publication per interval.
  It creates no browser object per parameter or tensor.
- Render plans are deterministic for the same blueprint (seeded from stable
  ids, version and counts). Rebuilding the page does not reshuffle the scene.
- Camera fitting projects the actual blueprint bounds, then derives near and
  far planes from that fit. Brain mode uses a closer cinematic composition;
  Architecture mode backs up slightly so the full blueprint remains legible.
  The stage fills the viewport below the header; it does not inherit the
  portal's global `main` max-width/margins.

The synthetic 3B test builds a 36-layer blueprint with 581 components and 795
connections and verifies the render plan stays bounded: 544 structural nodes,
2,400 synaptic nodes and 2,016 filaments in the verification run. It does not
load the real 3B model.

## Isolation checklist

| Concern | Status |
|---|---|
| Training algorithms / optimisers / loss | untouched |
| Training loop / hooks | observational telemetry callback only; no gradient, optimizer, RNG or decision changes |
| GPU allocation / model loading | none |
| WebSockets / new services | none; live telemetry uses the existing HTTP API + SSE change feed |
| Background workers / services | none |
| Model selection / promotion | untouched |
| Store artifacts / manifests / registry | read-only |
| Python dependencies | none added |
| Node dependency | `three` only |

## Verification screenshots

All four screenshots below use the exported eight-layer blueprint (`v001`, 124
rendered structural components, 173 connections) at the default overview
camera.

Phase 1.3 baseline:

- [Brain mode](screenshots/brain-mode.png) â€” earlier horseshoe composition.
- [Architecture mode](screenshots/architecture-mode.png) â€” earlier blueprint view.

Phase 1.4 refinement:

- [Brain mode](screenshots/phase-1.4-brain.png) â€” cohesive ellipsoidal synaptic
  volume with glass/metal/matte nodes and refined lighting.
- [Architecture mode](screenshots/phase-1.4-architecture.png) â€” same precise
  blueprint view with the refined spatial layout.

The synthetic 36-layer, ~3.075B-parameter fixture was also rendered in both
modes. Its render plan contained 544 structural nodes, 795 structural
connections, 2,400 synaptic nodes and 2,016 filaments, with no console or page
errors. The browser verification used software WebGL; frame rate varied under
that renderer, so the meaningful budget numbers are the bounded geometry counts
and draw calls (17 in Brain mode, 30 in Architecture mode for the synthetic
36-layer fixture, the latter including label sprites and region annotation), not
the software-rendered FPS.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no blueprint exported` | Exporter has not run | `npm run blueprint` |
| `no active model` | `active.json` missing | Activate a committed version |
| `active version ... not committed` | Pointer names an incomplete version | Fix the active pointer from the CLI |
| `no safetensors header was found` | Metadata-only store | Export is `unverified` by design |
| `blueprint failed schema validation` | Corrupt/edited export | Re-run the exporter |
| Scene squeezed into a narrow central strip | The portal's global `main` max-width/margins leaked into the standalone page | The visualiser overrides `main.brain-stage` with full width, no max-width, and zero margins |
| Blank scene / WebGL error | Browser or GPU WebGL unavailable | Use a WebGL-capable browser; the blueprint remains valid |
| Live panel says stale | No telemetry snapshot arrived within `TRAIN_TELEMETRY_STALE_MS` | Check that training is still running and its step interval is not longer than the stale window |
| Live panel says reconnecting | SSE is disconnected or auth expired | The page re-reads the snapshot on reconnect; re-authenticate via the admin sign-in if needed |
| Cannot find a component in Brain mode | The decorative web is dense at the overview scale | Select the layer region, use the inspector connection chips, or switch to Architecture mode |
