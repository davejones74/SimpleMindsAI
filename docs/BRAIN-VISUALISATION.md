# Brain visualisation (Phase 1)

A read-only, explicitly invoked exporter turns the **active** SimpleMindsAI
checkpoint into a versioned structural blueprint. A standalone Three.js page at
`/admin/brain` renders that blueprint as an interactive 3D model.

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
- **The visualiser has no live telemetry.** There are no activations, gradients,
  weight deltas, or training-progress claims in the scene or inspector.

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
| Output | `data/visualisation/brain-blueprint.json` |
| Server file path | `$SMA_BLUEPRINT` (optional override) |
| API path | `/api/admin/brain/blueprint` |

The exporter rejects an output path inside the model store. The output file is
ignored by git (`data/**`).

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
fabricate a scene. The API returns the blueprint and file metadata only; it does
not expose store paths or weight-file filesystem locations.

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
    "configSha256": "…",
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
  - `verified` — manifest tensor shapes, config structure and safetensors
    headers agree; the header is independent evidence of the persisted tensor
    set.
  - `unverified` — exact as recorded by the manifest, but no safetensors header
    was available to independently confirm the checkpoint structure.
  - `mismatch` — at least one structural check failed; discrepancies are
    reported.
- `verification.checks` lists every comparison and its basis. Agreement between
  config and manifest alone is not reported as independent verification.

The report never claims the count is verified merely because two metadata
sources agree. Only a safetensors header supplies independent structural
evidence, and even then the exporter does not read tensor data.

## Interaction

- Drag to orbit; scroll to zoom; right-drag or shift-drag to pan.
- Click a node or a block ring to select it. Selecting a block shows the
  aggregate parameter/tensor counts of its contained components.
- The inspector lists dimensions, tensor shapes, exact/tied/derived labels,
  incoming and outgoing connections, and the parameter-verification checks.
- Clicking a connected component moves the selection to it.
- **Reset view** (or `R`) restores the camera; **Overview** (or `Esc`) clears the
  selection and returns to the whole-brain view.

## Rendering and scalability

The layout is derived from the blueprint, not from a hard-coded eight-layer
model:

- Transformer blocks are placed along a central Z axis.
- Global embeddings and RoPE sit before the first block; the final norm and
  LM head sit after the last.
- Each block's norms, Q/K/V/O, attention, SwiGLU MLP, activation, product and
  residual joins use a deterministic local arrangement.
- Changing `numHiddenLayers`, widths or head counts changes the scene without
  a renderer redesign.

Performance is independent of parameter count:

- Nodes are one instance per structural component, never one per parameter.
- Node groups use `InstancedMesh`; connections are a single batched
  `LineSegments` buffer.
- Background particles are a fixed budget.
- Render plans cap nodes and edges and report any omitted geometry rather than
  freezing the browser.
- Camera fitting uses the blueprint bounding sphere, so the same code frames
  the 62M prototype and the planned 36-layer, ~3.075B model.

The synthetic 3B test builds a 36-layer blueprint with 581 components and 761
connections and verifies the render plan stays bounded. It does not load the
real 3B model.

## Isolation checklist

| Concern | Status |
|---|---|
| Training algorithms / optimisers / loss | untouched |
| Training loop / hooks | untouched |
| GPU allocation / model loading | none |
| WebSockets / live telemetry | none |
| Background workers / services | none |
| Model selection / promotion | untouched |
| Store artifacts / manifests / registry | read-only |
| Python dependencies | none added |
| Node dependency | `three` only |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no blueprint exported` | Exporter has not run | `npm run blueprint` |
| `no active model` | `active.json` missing | Activate a committed version |
| `active version ... not committed` | Pointer names an incomplete version | Fix the active pointer from the CLI |
| `no safetensors header was found` | Metadata-only store | Export is `unverified` by design |
| `blueprint failed schema validation` | Corrupt/edited export | Re-run the exporter |
| Blank scene / WebGL error | Browser or GPU WebGL unavailable | Use a WebGL-capable browser; the blueprint remains valid |
