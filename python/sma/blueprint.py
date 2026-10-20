"""Structural blueprint exporter for the active SimpleMindsAI brain.

The exporter is deliberately read-only. It resolves the active version through
the same ``active.json`` pointer the serving path uses, refuses anything without
a ``COMMITTED`` marker, and reads only JSON metadata plus safetensors *headers*.
No torch model is constructed, no tensor data is read, and no GPU is touched.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import store

SCHEMA = "sma/brain-blueprint@1"
VERSION_RE = re.compile(r"^v\d+$")
DEFAULT_OUTPUT = Path(
    os.environ.get("SMA_BLUEPRINT")
    or (Path(__file__).resolve().parents[2] / "data" / "visualisation" / "brain-blueprint.json")
)
MAX_HEADER_BYTES = 128 * 1024 * 1024
BUFFER_MARKERS = ("rotary_emb", "inv_freq")


class BlueprintError(RuntimeError):
    """A blueprint cannot be established from authoritative evidence."""


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = json.load(fh)
    except FileNotFoundError as exc:
        raise BlueprintError(f"required file is missing: {path.name}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise BlueprintError(f"required file is unreadable: {path.name}: {exc}") from exc
    if not isinstance(value, dict):
        raise BlueprintError(f"required file is not a JSON object: {path.name}")
    return value


def _numel(shape: Sequence[Any]) -> int:
    total = 1
    for dim in shape:
        total *= int(dim)
    return total


def _is_buffer(name: str) -> bool:
    return any(marker in name for marker in BUFFER_MARKERS)


def _tensor_entries(manifest: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    after = manifest.get("tensorHashesAfterTraining")
    block = after.get("tensors") if isinstance(after, dict) else None
    aliases = after.get("aliasedTensors") if isinstance(after, dict) else None
    if not isinstance(block, dict) or not block:
        block = manifest.get("tensors")
        aliases = manifest.get("aliasedTensors")
    if not isinstance(block, dict) or not block:
        raise BlueprintError("init-manifest.json records no tensor metadata")
    tensors: Dict[str, Dict[str, Any]] = {}
    for name, entry in block.items():
        if not isinstance(entry, dict):
            continue
        shape = entry.get("shape")
        if not isinstance(shape, list) or not shape:
            continue
        numel = entry.get("numel")
        if not isinstance(numel, int):
            numel = _numel(shape)
        tensors[name] = {
            "name": name,
            "shape": [int(dim) for dim in shape],
            "dtype": entry.get("dtype"),
            "numel": numel,
        }
    if not tensors:
        raise BlueprintError("init-manifest.json records no usable tensor shapes")
    return tensors, [a for a in (aliases or []) if isinstance(a, dict)]


def _read_safetensors_header(path: Path) -> Dict[str, Dict[str, Any]]:
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            raw = fh.read(8)
            if len(raw) != 8:
                raise BlueprintError(f"invalid safetensors header: {path.name}")
            header_len = struct.unpack("<Q", raw)[0]
            if header_len <= 0 or header_len > MAX_HEADER_BYTES or header_len > max(size - 8, 0):
                raise BlueprintError(f"refusing unreasonable safetensors header in {path.name}")
            header = json.loads(fh.read(header_len).decode("utf-8"))
    except BlueprintError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, struct.error) as exc:
        raise BlueprintError(f"cannot read safetensors header {path.name}: {exc}") from exc
    if not isinstance(header, dict):
        raise BlueprintError(f"invalid safetensors header object: {path.name}")
    entries: Dict[str, Dict[str, Any]] = {}
    for name, meta in header.items():
        if name == "__metadata__" or not isinstance(meta, dict):
            continue
        shape = meta.get("shape")
        if not isinstance(shape, list):
            continue
        entries[name] = {
            "name": name,
            "shape": [int(dim) for dim in shape],
            "dtype": meta.get("dtype"),
            "numel": _numel(shape),
        }
    return entries


def _weight_files(version_dir: Path) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Dict[str, Any]]]]:
    index_path = version_dir / "model.safetensors.index.json"
    shard_names: List[str] = []
    sharded = False
    if index_path.is_file():
        index = _read_json(index_path)
        weight_map = index.get("weight_map")
        if not isinstance(weight_map, dict) or not weight_map:
            raise BlueprintError("model.safetensors.index.json has no weight_map")
        shard_names = sorted({str(name) for name in weight_map.values()})
        sharded = True
    else:
        single = version_dir / "model.safetensors"
        if single.is_file():
            shard_names = [single.name]
        else:
            shard_names = sorted(p.name for p in version_dir.glob("*.safetensors"))

    if not shard_names:
        return [], None

    files: List[Dict[str, Any]] = []
    merged: Dict[str, Dict[str, Any]] = {}
    for name in shard_names:
        path = version_dir / name
        if not path.is_file():
            raise BlueprintError(f"weight shard named by metadata is missing: {name}")
        entries = _read_safetensors_header(path)
        overlap = set(merged) & set(entries)
        if overlap:
            raise BlueprintError(
                "duplicate tensor entries across weight shards: " + ", ".join(sorted(overlap)[:5])
            )
        merged.update(entries)
        files.append({
            "name": name,
            "bytes": path.stat().st_size,
            "tensorCount": len(entries),
            "shard": sharded,
        })
    return files, merged


def _lineage(root: Path, version: str) -> Tuple[List[Dict[str, Any]], Optional[str], List[str]]:
    lineage: List[Dict[str, Any]] = []
    warnings: List[str] = []
    seen: set[str] = set()
    current: Optional[str] = version
    random_ancestor: Optional[str] = None
    while current and current not in seen and len(lineage) < 256:
        seen.add(current)
        if not VERSION_RE.match(current):
            warnings.append(f"lineage stops at {current!r}: not a version name")
            break
        version_dir = root / current
        if not store.is_committed(version_dir):
            warnings.append(f"lineage stops at {current}: COMMITTED marker is missing")
            break
        manifest = _read_json(version_dir / "init-manifest.json")
        provenance_path = version_dir / "provenance.json"
        provenance = _read_json(provenance_path) if provenance_path.is_file() else {}
        init_type = provenance.get("initialisationType") or manifest.get("initialisationType")
        parent = provenance.get("parentVersion") or manifest.get("parentVersion")
        lineage.append({
            "version": current,
            "parentVersion": parent,
            "initialisationType": init_type,
            "pretrainedWeightsUsed": provenance.get("pretrainedWeightsUsed", manifest.get("pretrainedWeightsUsed")),
            "createdAt": provenance.get("createdAt") or manifest.get("createdAt"),
        })
        if init_type == "RANDOM":
            random_ancestor = current
            break
        current = parent
    return lineage, random_ancestor, warnings


def _cfg(config: Dict[str, Any], arch: Dict[str, Any], key: str, manifest_key: Optional[str] = None) -> Any:
    if key in config:
        return config[key]
    if manifest_key and manifest_key in arch:
        return arch[manifest_key]
    return None


def _rope_theta(config: Dict[str, Any], arch: Dict[str, Any]) -> Any:
    packed = config.get("rope_parameters")
    if isinstance(packed, dict) and packed.get("rope_theta") is not None:
        return packed.get("rope_theta")
    return _cfg(config, arch, "rope_theta", "ropeTheta")


def _component(
    component_id: str,
    name: str,
    component_type: str,
    *,
    parent: Optional[str],
    block_index: Optional[int],
    dimensions: Optional[Dict[str, Any]] = None,
    tensors: Optional[List[Dict[str, Any]]] = None,
    parameters: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    derived: bool = False,
) -> Dict[str, Any]:
    return {
        "id": component_id,
        "name": name,
        "type": component_type,
        "parentId": parent,
        "blockIndex": block_index,
        "derived": derived,
        "dimensions": dimensions or {},
        "tensors": tensors or [],
        "parameters": parameters or {"unique": 0, "elements": 0, "exact": True, "counted": False},
        "metadata": metadata or {},
    }


def _param_meta(entry: Optional[Dict[str, Any]], *, counted: bool = True) -> Dict[str, Any]:
    if not entry:
        return {"unique": 0, "elements": 0, "exact": True, "counted": False}
    return {
        "unique": entry["numel"] if counted else 0,
        "elements": entry["numel"],
        "exact": True,
        "counted": counted,
    }


class _Connections:
    def __init__(self) -> None:
        self.items: List[Dict[str, Any]] = []
        self._used: Dict[str, int] = {}

    def add(
        self,
        source: str,
        target: str,
        connection_type: str,
        *,
        width: Optional[int] = None,
        explicit: bool = True,
        inferred: bool = False,
        note: Optional[str] = None,
    ) -> None:
        base = f"conn.{source}->{target}.{connection_type}"
        count = self._used.get(base, 0) + 1
        self._used[base] = count
        connection_id = base if count == 1 else f"{base}#{count}"
        self.items.append({
            "id": connection_id,
            "from": source,
            "to": target,
            "type": connection_type,
            "explicit": explicit,
            "inferred": inferred,
            "dimensions": {"width": width} if width is not None else {},
            "note": note,
        })


def _smollm3_structure(
    config: Dict[str, Any],
    arch: Dict[str, Any],
    tensors: Dict[str, Dict[str, Any]],
    *,
    tie_word_embeddings: bool,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    components: List[Dict[str, Any]] = []
    connections = _Connections()
    used_tensors: set[str] = set()

    def tensor(name: str) -> Optional[Dict[str, Any]]:
        entry = tensors.get(name)
        if entry:
            used_tensors.add(name)
        return entry

    layers = int(_cfg(config, arch, "num_hidden_layers", "numHiddenLayers") or 0)
    hidden = int(_cfg(config, arch, "hidden_size", "hiddenSize") or 0)
    intermediate = int(_cfg(config, arch, "intermediate_size", "intermediateSize") or 0)
    vocab = int(_cfg(config, arch, "vocab_size", "vocabSize") or 0)
    heads = int(_cfg(config, arch, "num_attention_heads", "numAttentionHeads") or 0)
    kv_heads = int(_cfg(config, arch, "num_key_value_heads", "numKeyValueHeads") or 0)
    if not all((layers, hidden, intermediate, vocab, heads, kv_heads)):
        raise BlueprintError("config/manifest do not establish the required architecture dimensions")
    if hidden % heads:
        raise BlueprintError("hidden_size is not divisible by num_attention_heads")
    if heads % kv_heads:
        raise BlueprintError("num_attention_heads is not divisible by num_key_value_heads")
    head_dim = hidden // heads
    no_rope = config.get("no_rope_layers")
    if not isinstance(no_rope, list) or len(no_rope) != layers:
        no_rope = arch.get("noRopeLayers")
    if not isinstance(no_rope, list) or len(no_rope) != layers:
        no_rope = [1] * layers
        warnings.append("no_rope_layers is absent; all layers are represented as using RoPE")
    layer_types = config.get("layer_types")
    if not isinstance(layer_types, list) or len(layer_types) != layers:
        layer_types = arch.get("layerTypes")
    if not isinstance(layer_types, list) or len(layer_types) != layers:
        layer_types = ["full_attention"] * layers

    rms_eps = _cfg(config, arch, "rms_norm_eps", "rmsNormEps")
    hidden_act = _cfg(config, arch, "hidden_act", "hiddenAct")

    components.append(_component(
        "model", "SimpleMindsAI brain", "model", parent=None, block_index=None,
        dimensions={"hidden": hidden, "layers": layers, "vocab": vocab},
        metadata={"architecture": "SmolLM3ForCausalLM", "modelType": config.get("model_type", "smollm3")},
    ))

    embed = tensor("model.embed_tokens.weight")
    if embed is None:
        raise BlueprintError("token embedding tensor is missing from the manifest")
    components.append(_component(
        "model.embed_tokens", "Token embedding", "embedding", parent="model", block_index=None,
        dimensions={"in": vocab, "out": hidden, "inputKind": "token-id"},
        tensors=[embed], parameters=_param_meta(embed),
        metadata={"tiedOutput": tie_word_embeddings},
    ))

    rope_entry = tensor("model.rotary_emb.inv_freq")
    rope_original = tensor("model.rotary_emb.original_inv_freq")
    rope_tensors = [t for t in (rope_entry, rope_original) if t]
    components.append(_component(
        "model.rotary_emb", "Rotary positional encoding", "positional_encoding",
        parent="model", block_index=None,
        dimensions={"headDim": head_dim},
        tensors=rope_tensors,
        metadata={
            "learned": False,
            "ropeTheta": _rope_theta(config, arch),
            "ropeType": ((config.get("rope_parameters") or {}).get("rope_type")
                         if isinstance(config.get("rope_parameters"), dict) else arch.get("ropeType")),
            "noRopeLayerIndices": [i for i, flag in enumerate(no_rope) if not flag],
            "persistent": False,
        },
    ))

    previous_output = "model.embed_tokens"
    for index in range(layers):
        block_id = f"model.layers.{index}"
        attn_id = f"{block_id}.attn"
        mlp_id = f"{block_id}.mlp"
        input_norm_id = f"{block_id}.input_norm"
        post_norm_id = f"{block_id}.post_norm"
        residual_attn_id = f"{block_id}.residual_attn"
        residual_mlp_id = f"{block_id}.residual_mlp"
        uses_rope = bool(no_rope[index])

        components.append(_component(
            block_id, f"Transformer block {index}", "transformer_block",
            parent="model", block_index=index,
            dimensions={"hidden": hidden, "in": hidden, "out": hidden},
            metadata={"layerType": layer_types[index], "usesRope": uses_rope},
        ))
        norm_entry = tensor(f"model.layers.{index}.input_layernorm.weight")
        components.append(_component(
            input_norm_id, f"Layer {index} input RMSNorm", "normalization",
            parent=block_id, block_index=index,
            dimensions={"in": hidden, "out": hidden},
            tensors=[norm_entry] if norm_entry else [],
            parameters=_param_meta(norm_entry),
            metadata={"kind": "RMSNorm", "eps": rms_eps},
        ))
        components.append(_component(
            attn_id, f"Layer {index} self-attention", "attention",
            parent=block_id, block_index=index,
            dimensions={"in": hidden, "out": hidden},
            metadata={
                "numHeads": heads,
                "numKeyValueHeads": kv_heads,
                "headDim": head_dim,
                "gqaRatio": heads // kv_heads,
                "usesRope": uses_rope,
                "causal": True,
            },
        ))
        q = tensor(f"model.layers.{index}.self_attn.q_proj.weight")
        k = tensor(f"model.layers.{index}.self_attn.k_proj.weight")
        v = tensor(f"model.layers.{index}.self_attn.v_proj.weight")
        o = tensor(f"model.layers.{index}.self_attn.o_proj.weight")
        q_out = heads * head_dim
        kv_out = kv_heads * head_dim
        components.extend([
            _component(
                f"{attn_id}.q_proj", f"Layer {index} query projection", "linear_projection",
                parent=attn_id, block_index=index,
                dimensions={"in": hidden, "out": q_out}, tensors=[q] if q else [],
                parameters=_param_meta(q), metadata={"role": "query", "heads": heads, "headDim": head_dim},
            ),
            _component(
                f"{attn_id}.k_proj", f"Layer {index} key projection", "linear_projection",
                parent=attn_id, block_index=index,
                dimensions={"in": hidden, "out": kv_out}, tensors=[k] if k else [],
                parameters=_param_meta(k), metadata={"role": "key", "kvHeads": kv_heads, "headDim": head_dim},
            ),
            _component(
                f"{attn_id}.v_proj", f"Layer {index} value projection", "linear_projection",
                parent=attn_id, block_index=index,
                dimensions={"in": hidden, "out": kv_out}, tensors=[v] if v else [],
                parameters=_param_meta(v), metadata={"role": "value", "kvHeads": kv_heads, "headDim": head_dim},
            ),
            _component(
                f"{attn_id}.o_proj", f"Layer {index} output projection", "linear_projection",
                parent=attn_id, block_index=index,
                dimensions={"in": q_out, "out": hidden}, tensors=[o] if o else [],
                parameters=_param_meta(o), metadata={"role": "attention-output"},
            ),
        ])
        components.append(_component(
            residual_attn_id, f"Layer {index} attention residual", "residual",
            parent=block_id, block_index=index,
            dimensions={"in": hidden, "out": hidden}, derived=True,
        ))
        post_norm_entry = tensor(f"model.layers.{index}.post_attention_layernorm.weight")
        components.append(_component(
            post_norm_id, f"Layer {index} post-attention RMSNorm", "normalization",
            parent=block_id, block_index=index,
            dimensions={"in": hidden, "out": hidden},
            tensors=[post_norm_entry] if post_norm_entry else [],
            parameters=_param_meta(post_norm_entry),
            metadata={"kind": "RMSNorm", "eps": rms_eps},
        ))
        components.append(_component(
            mlp_id, f"Layer {index} SwiGLU MLP", "mlp",
            parent=block_id, block_index=index,
            dimensions={"in": hidden, "out": hidden},
            metadata={"hiddenAct": hidden_act, "intermediateSize": intermediate},
        ))
        gate = tensor(f"model.layers.{index}.mlp.gate_proj.weight")
        up = tensor(f"model.layers.{index}.mlp.up_proj.weight")
        down = tensor(f"model.layers.{index}.mlp.down_proj.weight")
        components.extend([
            _component(
                f"{mlp_id}.gate_proj", f"Layer {index} MLP gate projection", "linear_projection",
                parent=mlp_id, block_index=index,
                dimensions={"in": hidden, "out": intermediate}, tensors=[gate] if gate else [],
                parameters=_param_meta(gate), metadata={"role": "mlp-gate"},
            ),
            _component(
                f"{mlp_id}.up_proj", f"Layer {index} MLP up projection", "linear_projection",
                parent=mlp_id, block_index=index,
                dimensions={"in": hidden, "out": intermediate}, tensors=[up] if up else [],
                parameters=_param_meta(up), metadata={"role": "mlp-up"},
            ),
            _component(
                f"{mlp_id}.act", f"Layer {index} SiLU activation", "activation",
                parent=mlp_id, block_index=index,
                dimensions={"in": intermediate, "out": intermediate}, derived=True,
                metadata={"activation": hidden_act},
            ),
            _component(
                f"{mlp_id}.mul", f"Layer {index} gated product", "elementwise",
                parent=mlp_id, block_index=index,
                dimensions={"in": intermediate, "out": intermediate}, derived=True,
                metadata={"operation": "elementwise-multiply"},
            ),
            _component(
                f"{mlp_id}.down_proj", f"Layer {index} MLP down projection", "linear_projection",
                parent=mlp_id, block_index=index,
                dimensions={"in": intermediate, "out": hidden}, tensors=[down] if down else [],
                parameters=_param_meta(down), metadata={"role": "mlp-down"},
            ),
        ])
        components.append(_component(
            residual_mlp_id, f"Layer {index} MLP residual", "residual",
            parent=block_id, block_index=index,
            dimensions={"in": hidden, "out": hidden}, derived=True,
        ))

        connections.add(previous_output, input_norm_id, "dataflow", width=hidden)
        connections.add(previous_output, residual_attn_id, "residual", width=hidden)
        for proj in ("q_proj", "k_proj", "v_proj"):
            connections.add(input_norm_id, f"{attn_id}.{proj}", "dataflow", width=hidden)
            connections.add(f"{attn_id}.{proj}", attn_id, "dataflow",
                            width=q_out if proj == "q_proj" else kv_out)
            if uses_rope:
                connections.add("model.rotary_emb", f"{attn_id}.{proj}", "positional_encoding",
                                width=head_dim, note="RoPE is applied inside attention")
        connections.add(attn_id, f"{attn_id}.o_proj", "dataflow", width=q_out)
        connections.add(f"{attn_id}.o_proj", residual_attn_id, "dataflow", width=hidden)
        connections.add(residual_attn_id, post_norm_id, "dataflow", width=hidden)
        connections.add(residual_attn_id, residual_mlp_id, "residual", width=hidden)
        connections.add(post_norm_id, f"{mlp_id}.gate_proj", "dataflow", width=hidden)
        connections.add(post_norm_id, f"{mlp_id}.up_proj", "dataflow", width=hidden)
        connections.add(f"{mlp_id}.gate_proj", f"{mlp_id}.act", "dataflow", width=intermediate)
        connections.add(f"{mlp_id}.act", f"{mlp_id}.mul", "dataflow", width=intermediate)
        connections.add(f"{mlp_id}.up_proj", f"{mlp_id}.mul", "dataflow", width=intermediate)
        connections.add(f"{mlp_id}.mul", f"{mlp_id}.down_proj", "dataflow", width=intermediate)
        connections.add(f"{mlp_id}.down_proj", residual_mlp_id, "dataflow", width=hidden)
        previous_output = residual_mlp_id

    final_norm = tensor("model.norm.weight")
    components.append(_component(
        "model.norm", "Final RMSNorm", "normalization", parent="model", block_index=None,
        dimensions={"in": hidden, "out": hidden},
        tensors=[final_norm] if final_norm else [],
        parameters=_param_meta(final_norm),
        metadata={"kind": "RMSNorm", "eps": rms_eps},
    ))
    connections.add(previous_output, "model.norm", "dataflow", width=hidden)

    lm_head_entry = tensor("model.lm_head.weight")
    lm_head_counted = bool(lm_head_entry) and not tie_word_embeddings
    if tie_word_embeddings and lm_head_entry:
        warnings.append("lm_head.weight is persisted despite tie_word_embeddings=true; it is treated as an alias")
    if not tie_word_embeddings and lm_head_entry is None:
        warnings.append(
            "tie_word_embeddings is false but lm_head.weight is absent from the manifest; "
            "the output head is represented without a verified tensor"
        )
    components.append(_component(
        "model.lm_head", "Language-model head", "output_head", parent="model", block_index=None,
        dimensions={"in": hidden, "out": vocab},
        tensors=[lm_head_entry] if lm_head_entry else [],
        parameters=_param_meta(lm_head_entry, counted=lm_head_counted) if lm_head_entry else {
            "unique": 0, "elements": embed["numel"], "exact": True, "counted": False,
        },
        metadata={
            "tied": tie_word_embeddings,
            "tiedTo": "model.embed_tokens" if tie_word_embeddings else None,
            "sharedElements": embed["numel"] if tie_word_embeddings else 0,
        },
    ))
    connections.add("model.norm", "model.lm_head", "dataflow", width=hidden)
    if tie_word_embeddings:
        connections.add("model.lm_head", "model.embed_tokens", "tied_parameter",
                        width=hidden, explicit=True,
                        note="lm_head.weight aliases model.embed_tokens.weight")

    unexpected = sorted(name for name in tensors if name not in used_tensors)
    if unexpected:
        warnings.append(
            f"{len(unexpected)} tensor(s) were not mapped to a structural component: "
            + ", ".join(unexpected[:8])
        )
    return components, connections.items, warnings


def _parameter_accounting(
    manifest: Dict[str, Any],
    config: Dict[str, Any],
    arch: Dict[str, Any],
    tensors: Dict[str, Dict[str, Any]],
    aliases: List[Dict[str, Any]],
    header: Optional[Dict[str, Dict[str, Any]]],
    tie_word_embeddings: bool,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    warnings: List[str] = []
    alias_by_alias = {
        str(a.get("alias")): str(a.get("canonical"))
        for a in aliases
        if a.get("alias") and a.get("canonical")
    }
    if tie_word_embeddings:
        lm_name = "model.lm_head.weight"
        if lm_name in tensors or lm_name in alias_by_alias:
            alias_by_alias.setdefault(lm_name, "model.embed_tokens.weight")

    parameter_tensors = {
        name: entry for name, entry in tensors.items()
        if not _is_buffer(name) and name not in alias_by_alias
    }
    buffer_tensors = {name: entry for name, entry in tensors.items() if _is_buffer(name)}
    computed_unique = sum(entry["numel"] for entry in parameter_tensors.values())
    computed_trainable = computed_unique
    computed_tensor_elements = sum(entry["numel"] for entry in tensors.values())
    buffer_elements = sum(entry["numel"] for entry in buffer_tensors.values())

    sizes = manifest.get("sizes") if isinstance(manifest.get("sizes"), dict) else {}
    recorded_total = sizes.get("parametersTotal")
    recorded_trainable = sizes.get("parametersTrainable")
    recorded_unique = sizes.get("parametersUniqueByStorage")
    non_trainable = (
        max(0, int(recorded_total) - int(recorded_trainable))
        if isinstance(recorded_total, int) and isinstance(recorded_trainable, int)
        else None
    )

    tied_aliases: List[Dict[str, Any]] = []
    for alias, canonical in sorted(alias_by_alias.items()):
        entry = tensors.get(alias) or tensors.get(canonical)
        tied_aliases.append({
            "alias": alias,
            "canonical": canonical,
            "elements": entry["numel"] if entry else None,
            "counted": False,
        })
    if tie_word_embeddings and not any(t["alias"] == "model.lm_head.weight" for t in tied_aliases):
        embed = tensors.get("model.embed_tokens.weight")
        tied_aliases.append({
            "alias": "model.lm_head.weight",
            "canonical": "model.embed_tokens.weight",
            "elements": embed["numel"] if embed else None,
            "counted": False,
            "reason": "tie_word_embeddings",
        })

    checks: List[Dict[str, Any]] = []

    def check(name: str, ok: Optional[bool], detail: str, basis: str) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "basis": basis})

    check("manifest-sizes-present", bool(sizes), "manifest records parameter sizes" if sizes else "manifest has no sizes block", "manifest")
    check(
        "manifest-unique-count",
        isinstance(recorded_unique, int) and computed_unique == recorded_unique,
        f"computed {computed_unique:,} unique parameter elements; manifest says {recorded_unique!r}",
        "manifest",
    )
    check(
        "manifest-total-count",
        isinstance(recorded_total, int) and computed_unique == recorded_total,
        f"computed {computed_unique:,}; manifest total {recorded_total!r}",
        "manifest",
    )
    check(
        "trainable-accounting",
        isinstance(recorded_trainable, int) and recorded_trainable == recorded_total,
        f"manifest trainable {recorded_trainable!r}; total {recorded_total!r}",
        "manifest",
    )
    expected_layers = _cfg(config, arch, "num_hidden_layers", "numHiddenLayers")
    layer_indices = sorted({
        int(parts[2])
        for name in tensors
        if name.startswith("model.layers.") and len(parts := name.split(".")) > 2 and parts[2].isdigit()
    })
    check(
        "tensor-layer-indices",
        isinstance(expected_layers, int) and layer_indices == list(range(expected_layers)),
        f"tensor metadata carries layers {layer_indices!r}; config declares {expected_layers!r}",
        "manifest+config",
    )
    embed_tensor = tensors.get("model.embed_tokens.weight")
    expected_embed = [
        _cfg(config, arch, "vocab_size", "vocabSize"),
        _cfg(config, arch, "hidden_size", "hiddenSize"),
    ]
    check(
        "embedding-shape",
        bool(embed_tensor) and embed_tensor["shape"] == expected_embed,
        f"embedding shape {embed_tensor['shape'] if embed_tensor else None}; config says {expected_embed}",
        "manifest+config",
    )

    header_persisted = None
    if header is not None:
        expected_persisted = {
            name: entry for name, entry in parameter_tensors.items()
            if not _is_buffer(name)
        }
        header_parameter_names = {name for name in header if not _is_buffer(name)}
        expected_names = set(expected_persisted)
        missing = sorted(expected_names - header_parameter_names)
        unexpected = sorted(header_parameter_names - expected_names)
        shape_mismatches = []
        for name in sorted(expected_names & header_parameter_names):
            if header[name]["shape"] != expected_persisted[name]["shape"]:
                shape_mismatches.append({
                    "name": name,
                    "manifestShape": expected_persisted[name]["shape"],
                    "headerShape": header[name]["shape"],
                })
        header_persisted = sum(header[name]["numel"] for name in header_parameter_names)
        check(
            "safetensors-tensor-set",
            not missing and not unexpected,
            f"{len(missing)} missing, {len(unexpected)} unexpected",
            "safetensors-header",
        )
        check(
            "safetensors-shapes",
            not shape_mismatches,
            f"{len(shape_mismatches)} shape mismatch(es)",
            "safetensors-header",
        )
        check(
            "safetensors-element-count",
            header_persisted == computed_unique,
            f"header {header_persisted:,}; manifest {computed_unique:,}",
            "safetensors-header",
        )
        if tie_word_embeddings:
            check(
                "tied-head-not-persisted",
                "model.lm_head.weight" not in header,
                "tied lm_head is not independently persisted" if "model.lm_head.weight" not in header
                else "lm_head.weight is persisted as well as the embedding",
                "safetensors-header",
            )
        if missing or unexpected or shape_mismatches:
            warnings.append("safetensors header does not fully match the manifest tensor structure")
    else:
        warnings.append(
            "no safetensors header was found; the parameter count is exact as recorded, "
            "but the actual checkpoint structure was not independently verified"
        )

    if isinstance(recorded_unique, int) and computed_unique != recorded_unique:
        warnings.append(
            f"parameter count discrepancy: computed {computed_unique:,}, recorded {recorded_unique:,}"
        )

    header_ok = header is not None and all(c["ok"] is not False for c in checks if c["basis"] == "safetensors-header")
    manifest_ok = all(c["ok"] is not False for c in checks if c["basis"] in ("manifest", "manifest+config"))
    if header is not None and not header_ok:
        status = "mismatch"
    elif header is not None and manifest_ok and header_ok:
        status = "verified"
    elif manifest_ok:
        status = "unverified"
    else:
        status = "mismatch"

    return {
        "totalParameters": computed_unique,
        "uniqueTrainable": computed_trainable,
        "nonTrainable": non_trainable,
        "tensorElements": computed_tensor_elements,
        "persistedTensorElements": header_persisted,
        "nonParameterBufferElements": buffer_elements,
        "tiedAliases": tied_aliases,
        "recorded": {
            "parametersTotal": recorded_total,
            "parametersTrainable": recorded_trainable,
            "parametersUniqueByStorage": recorded_unique,
        },
        "verification": {
            "status": status,
            "exact": manifest_ok and (header is None or header_ok),
            "independentStructuralEvidence": "safetensors-header" if header is not None else None,
            "method": "manifest tensor shapes + config structure + safetensors headers (no tensor data loaded)",
            "checks": checks,
            "discrepancies": [
                c["detail"] for c in checks if c["ok"] is False
            ],
        },
    }, warnings


def _architecture_config(config: Dict[str, Any], arch: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "modelClass": arch.get("modelClass") or "SmolLM3ForCausalLM",
        "modelType": config.get("model_type") or arch.get("modelType"),
        "configName": config.get("_configName") or arch.get("configName"),
        "vocabSize": _cfg(config, arch, "vocab_size", "vocabSize"),
        "hiddenSize": _cfg(config, arch, "hidden_size", "hiddenSize"),
        "intermediateSize": _cfg(config, arch, "intermediate_size", "intermediateSize"),
        "numHiddenLayers": _cfg(config, arch, "num_hidden_layers", "numHiddenLayers"),
        "numAttentionHeads": _cfg(config, arch, "num_attention_heads", "numAttentionHeads"),
        "numKeyValueHeads": _cfg(config, arch, "num_key_value_heads", "numKeyValueHeads"),
        "headDim": (
            int(_cfg(config, arch, "hidden_size", "hiddenSize")) // int(_cfg(config, arch, "num_attention_heads", "numAttentionHeads"))
            if _cfg(config, arch, "hidden_size", "hiddenSize") and _cfg(config, arch, "num_attention_heads", "numAttentionHeads")
            else None
        ),
        "hiddenAct": _cfg(config, arch, "hidden_act", "hiddenAct"),
        "rmsNormEps": _cfg(config, arch, "rms_norm_eps", "rmsNormEps"),
        "tieWordEmbeddings": bool(config.get("tie_word_embeddings", arch.get("tieWordEmbeddings", False))),
        "maxPositionEmbeddings": _cfg(config, arch, "max_position_embeddings", "maxPositionEmbeddings"),
        "ropeTheta": _rope_theta(config, arch),
        "ropeType": ((config.get("rope_parameters") or {}).get("rope_type")
                     if isinstance(config.get("rope_parameters"), dict) else arch.get("ropeType")),
        "noRopeLayers": config.get("no_rope_layers") if isinstance(config.get("no_rope_layers"), list) else arch.get("noRopeLayers"),
        "noRopeLayerIndices": arch.get("noRopeLayerIndices"),
        "layerTypes": config.get("layer_types") if isinstance(config.get("layer_types"), list) else arch.get("layerTypes"),
        "useSlidingWindow": config.get("use_sliding_window", arch.get("useSlidingWindow")),
        "slidingWindow": config.get("sliding_window", arch.get("slidingWindow")),
        "dtype": config.get("dtype") or config.get("torch_dtype") or arch.get("torchDtype"),
    }


def _resolve_active(root: Path) -> Tuple[str, Dict[str, Any]]:
    active_path = store.active_pointer_path(root)
    if not active_path.is_file():
        raise BlueprintError(
            f"no active model: {active_path.name} is missing in {root}; activate a committed version first"
        )
    active = _read_json(active_path)
    version = active.get("version")
    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise BlueprintError("active.json does not name a valid committed version")
    version_dir = root / version
    if not version_dir.is_dir():
        raise BlueprintError(f"active version {version} has no directory in the store")
    if not store.is_committed(version_dir):
        raise BlueprintError(f"active version {version} is not committed (COMMITTED marker is missing)")
    return version, active


def build_blueprint(
    store_root: Path | str,
    *,
    exported_at: Optional[str] = None,
) -> Dict[str, Any]:
    root = Path(store_root)
    if not root.is_dir():
        raise BlueprintError(f"model store does not exist: {root}")
    version, active = _resolve_active(root)
    version_dir = root / version

    config = _read_json(version_dir / "config.json")
    manifest = _read_json(version_dir / "init-manifest.json")
    provenance_path = version_dir / "provenance.json"
    provenance = _read_json(provenance_path) if provenance_path.is_file() else {}
    arch = manifest.get("architecture") if isinstance(manifest.get("architecture"), dict) else {}
    config["_configName"] = provenance.get("configName") or manifest.get("configName") or arch.get("configName")
    config["_layer_names"] = [k for k in (manifest.get("tensors") or {}) if k.startswith("model.layers.")]

    model_type = str(config.get("model_type") or arch.get("modelType") or "")
    model_class = str((config.get("architectures") or arch.get("architectures") or [""])[0])
    if model_type != "smollm3" and model_class != "SmolLM3ForCausalLM":
        raise BlueprintError(
            f"unsupported architecture: model_type={model_type!r}, class={model_class!r}; "
            "the exporter only knows how to represent SmolLM3"
        )

    tensors, aliases = _tensor_entries(manifest)
    weight_files, header = _weight_files(version_dir)
    tie_word_embeddings = bool(config.get("tie_word_embeddings", arch.get("tieWordEmbeddings", False)))

    components, connections, structure_warnings = _smollm3_structure(
        config, arch, tensors, tie_word_embeddings=tie_word_embeddings
    )
    accounting, accounting_warnings = _parameter_accounting(
        manifest, config, arch, tensors, aliases, header, tie_word_embeddings
    )
    lineage, random_ancestor, lineage_warnings = _lineage(root, version)

    warnings = structure_warnings + accounting_warnings + lineage_warnings
    if manifest.get("version") and manifest.get("version") != version:
        warnings.append(
            f"init-manifest.json names version {manifest.get('version')!r}, but active.json names {version!r}"
        )
    if provenance.get("version") and provenance.get("version") != version:
        warnings.append(
            f"provenance.json names version {provenance.get('version')!r}, but active.json names {version!r}"
        )
    if random_ancestor is None:
        warnings.append(
            "no RANDOM initialisation ancestor was found in the recorded lineage; "
            "random-init provenance is not established from the traversed chain"
        )
    if provenance.get("pretrainedWeightsUsed") is not False and manifest.get("pretrainedWeightsUsed") is not False:
        warnings.append(
            "pretrainedWeightsUsed is not explicitly false in provenance/manifest; "
            "the no-pretrained-weights invariant is not established by these records"
        )
    if active.get("artifactName"):
        try:
            derived = store.artifact_name(manifest)
            if derived != active.get("artifactName"):
                warnings.append(
                    "active.json artifactName does not match the artifact name derived from the committed manifest"
                )
        except (ValueError, OSError):
            pass

    architecture_config = _architecture_config(config, arch)
    type_counts: Dict[str, int] = {}
    for component in components:
        type_counts[component["type"]] = type_counts.get(component["type"], 0) + 1
    connection_counts: Dict[str, int] = {}
    for connection in connections:
        connection_counts[connection["type"]] = connection_counts.get(connection["type"], 0) + 1

    created = provenance.get("createdAt") or manifest.get("createdAt")
    stamp = exported_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "schema": SCHEMA,
        "exportedAt": stamp,
        "source": {
            "activePointer": "active.json",
            "activeVersion": version,
            "artifactName": active.get("artifactName") or manifest.get("artifactName"),
            "weightFingerprint": active.get("weightFingerprint"),
            "configSha256": (manifest.get("configSource") or {}).get("configSha256"),
            "manifestSchema": manifest.get("schema"),
            "activeActivatedAt": active.get("activatedAt"),
            "committedAt": _safe_committed_at(version_dir),
            "weightsInspected": "safetensors-header" if header is not None else "manifest-only",
            "weightsLoaded": False,
            "weightFiles": weight_files,
        },
        "model": {
            "id": active.get("artifactName") or manifest.get("artifactName") or f"simpleminds-{version}",
            "version": version,
            "createdAt": created,
            "architecture": architecture_config["modelClass"],
            "configName": architecture_config["configName"],
            "initialisation": {
                "type": provenance.get("initialisationType") or manifest.get("initialisationType"),
                "pretrainedWeightsUsed": provenance.get("pretrainedWeightsUsed", manifest.get("pretrainedWeightsUsed")),
                "parentVersion": provenance.get("parentVersion") or manifest.get("parentVersion"),
                "parentInitialisationType": provenance.get("parentInitialisationType"),
                "randomInitAncestor": random_ancestor,
                "lineage": lineage,
            },
            "architectureConfig": architecture_config,
            "counts": {
                "layers": architecture_config.get("numHiddenLayers"),
                "componentsByType": type_counts,
                "connectionsByType": connection_counts,
            },
        },
        "parameterAccounting": accounting,
        "components": components,
        "connections": connections,
        "warnings": warnings,
        "counts": {
            "components": len(components),
            "connections": len(connections),
            "layers": architecture_config.get("numHiddenLayers"),
        },
    }


def _safe_committed_at(version_dir: Path) -> Optional[str]:
    try:
        return _read_json(version_dir / "COMMITTED").get("committedAt")
    except BlueprintError:
        return None


def write_blueprint(
    path: Path | str,
    blueprint: Dict[str, Any],
    *,
    protected_root: Path | str | None = None,
) -> Path:
    target = Path(path)
    if protected_root is not None and _within(target, Path(protected_root)):
        raise BlueprintError("refusing to write the blueprint inside the model store; choose a path outside it")
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + f".{os.getpid()}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(blueprint, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, target)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise BlueprintError(f"cannot write blueprint output: {exc}") from exc
    return target


def _within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _summary(blueprint: Dict[str, Any], path: Path) -> Dict[str, Any]:
    return {
        "ok": True,
        "verb": "blueprint",
        "version": blueprint["source"]["activeVersion"],
        "artifactName": blueprint["source"]["artifactName"],
        "components": blueprint["counts"]["components"],
        "connections": blueprint["counts"]["connections"],
        "parameters": blueprint["parameterAccounting"]["totalParameters"],
        "verification": blueprint["parameterAccounting"]["verification"]["status"],
        "path": str(path),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m sma.blueprint",
        description="Export a structural blueprint for the active SimpleMindsAI brain (read-only).",
    )
    parser.add_argument("--store", default=str(store.store_root()), help="brain store root")
    parser.add_argument("--out", default=str(DEFAULT_OUTPUT), help="blueprint output path")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        store_root = Path(args.store)
        blueprint = build_blueprint(store_root)
        path = write_blueprint(args.out, blueprint, protected_root=store_root)
        json.dump(_summary(blueprint, path), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    except BlueprintError as exc:
        print(f"[sma] blueprint failed: {exc}", file=sys.stderr)
        json.dump({"ok": False, "verb": "blueprint", "error": str(exc)}, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 1
    except Exception as exc:  # noqa: BLE001 - the CLI always answers with one JSON object
        import traceback

        traceback.print_exc(file=sys.stderr)
        json.dump(
            {"ok": False, "verb": "blueprint", "error": str(exc), "kind": type(exc).__name__},
            sys.stdout,
            sort_keys=True,
        )
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
