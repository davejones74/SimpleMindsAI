from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest

from sma import configs
from sma.blueprint import BlueprintError, build_blueprint, main, write_blueprint


def _architecture(config: dict) -> dict:
    hidden = config["hidden_size"]
    heads = config["num_attention_heads"]
    kv_heads = config["num_key_value_heads"]
    return {
        "architectures": config["architectures"],
        "modelClass": "SmolLM3ForCausalLM",
        "modelType": config["model_type"],
        "configName": config.get("configName"),
        "vocabSize": config["vocab_size"],
        "hiddenSize": hidden,
        "intermediateSize": config["intermediate_size"],
        "numHiddenLayers": config["num_hidden_layers"],
        "numAttentionHeads": heads,
        "numKeyValueHeads": kv_heads,
        "headDim": hidden // heads,
        "gqaRatio": heads // kv_heads,
        "hiddenAct": config["hidden_act"],
        "rmsNormEps": config["rms_norm_eps"],
        "attentionBias": config["attention_bias"],
        "attentionDropout": config["attention_dropout"],
        "mlpBias": config.get("mlp_bias", False),
        "ropeTheta": config["rope_theta"],
        "ropeType": "default",
        "ropeScaling": None,
        "noRopeLayerInterval": config["no_rope_layer_interval"],
        "noRopeLayers": list(config["no_rope_layers"]),
        "noRopeLayerIndices": [i for i, flag in enumerate(config["no_rope_layers"]) if not flag],
        "layerTypes": sorted(set(config["layer_types"])),
        "useSlidingWindow": config["use_sliding_window"],
        "slidingWindow": config["sliding_window"],
        "tieWordEmbeddings": config["tie_word_embeddings"],
        "initializerRange": config["initializer_range"],
        "maxPositionEmbeddings": config["max_position_embeddings"],
        "padTokenId": config["pad_token_id"],
        "bosTokenId": config["bos_token_id"],
        "eosTokenId": config["eos_token_id"],
        "torchDtype": "float32",
    }


def _tensor(name: str, shape: list) -> dict:
    numel = 1
    for dim in shape:
        numel *= dim
    return {"name": name, "shape": shape, "dtype": "float32", "numel": numel}


def _tensors(config: dict) -> dict:
    hidden = config["hidden_size"]
    intermediate = config["intermediate_size"]
    vocab = config["vocab_size"]
    heads = config["num_attention_heads"]
    kv_heads = config["num_key_value_heads"]
    head_dim = hidden // heads
    out = {
        "model.embed_tokens.weight": _tensor("model.embed_tokens.weight", [vocab, hidden]),
        "model.norm.weight": _tensor("model.norm.weight", [hidden]),
        "model.rotary_emb.inv_freq": _tensor("model.rotary_emb.inv_freq", [head_dim // 2]),
        "model.rotary_emb.original_inv_freq": _tensor("model.rotary_emb.original_inv_freq", [head_dim // 2]),
    }
    for index in range(config["num_hidden_layers"]):
        prefix = f"model.layers.{index}"
        out[f"{prefix}.input_layernorm.weight"] = _tensor(f"{prefix}.input_layernorm.weight", [hidden])
        out[f"{prefix}.post_attention_layernorm.weight"] = _tensor(f"{prefix}.post_attention_layernorm.weight", [hidden])
        out[f"{prefix}.self_attn.q_proj.weight"] = _tensor(f"{prefix}.self_attn.q_proj.weight", [heads * head_dim, hidden])
        out[f"{prefix}.self_attn.k_proj.weight"] = _tensor(f"{prefix}.self_attn.k_proj.weight", [kv_heads * head_dim, hidden])
        out[f"{prefix}.self_attn.v_proj.weight"] = _tensor(f"{prefix}.self_attn.v_proj.weight", [kv_heads * head_dim, hidden])
        out[f"{prefix}.self_attn.o_proj.weight"] = _tensor(f"{prefix}.self_attn.o_proj.weight", [hidden, heads * head_dim])
        out[f"{prefix}.mlp.gate_proj.weight"] = _tensor(f"{prefix}.mlp.gate_proj.weight", [intermediate, hidden])
        out[f"{prefix}.mlp.up_proj.weight"] = _tensor(f"{prefix}.mlp.up_proj.weight", [intermediate, hidden])
        out[f"{prefix}.mlp.down_proj.weight"] = _tensor(f"{prefix}.mlp.down_proj.weight", [hidden, intermediate])
    return out


def _sizes(tensors: dict) -> dict:
    buffers = {"model.rotary_emb.inv_freq", "model.rotary_emb.original_inv_freq"}
    unique = sum(entry["numel"] for name, entry in tensors.items() if name not in buffers)
    return {
        "parametersTotal": unique,
        "parametersTrainable": unique,
        "parametersUniqueByStorage": unique,
    }


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def _write_safetensors_header(path: Path, tensors: dict, skip: set[str] | None = None) -> None:
    skip = skip or set()
    header = {"__metadata__": {"format": "pt"}}
    offset = 0
    for name, entry in tensors.items():
        if name in skip:
            continue
        size = entry["numel"] * 4
        header[name] = {
            "dtype": "F32",
            "shape": entry["shape"],
            "data_offsets": [offset, offset + size],
        }
        offset += size
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    path.write_bytes(struct.pack("<Q", len(raw)) + raw)


def _make_store(
    root: Path,
    *,
    version: str = "v001",
    config: dict | None = None,
    active: str | None = None,
    committed: bool = True,
    safetensors: bool = True,
    sharded: bool = False,
    write_active: bool = True,
    provenance: dict | None = None,
) -> dict:
    config = dict(config or configs.config_dict("small"))
    config.setdefault("configName", "small")
    layers = config["num_hidden_layers"]
    interval = max(int(config.get("no_rope_layer_interval") or 1), 1)
    config.setdefault("no_rope_layers", [0 if (i + 1) % interval == 0 else 1 for i in range(layers)])
    config.setdefault("layer_types", ["full_attention"] * layers)
    config.setdefault("mlp_bias", False)
    config.setdefault("dtype", "float32")
    tensors = _tensors(config)
    sizes = _sizes(tensors)
    version_dir = root / version
    version_dir.mkdir(parents=True, exist_ok=True)
    if committed:
        _write_json(version_dir / "COMMITTED", {"version": version, "committedAt": "2026-10-20T00:00:00Z"})
    _write_json(version_dir / "config.json", config)
    _write_json(version_dir / "init-manifest.json", {
        "schema": "sma/init-manifest@1",
        "version": version,
        "configName": config.get("configName"),
        "createdAt": "2026-10-20T00:00:00Z",
        "architecture": _architecture(config),
        "initialisationType": "RANDOM",
        "pretrainedWeightsUsed": False,
        "sizes": sizes,
        "tensors": tensors,
        "aliasedTensors": [],
    })
    _write_json(version_dir / "provenance.json", provenance or {
        "schema": "sma/provenance@1",
        "version": version,
        "configName": config.get("configName"),
        "createdAt": "2026-10-20T00:00:00Z",
        "initialisationType": "RANDOM",
        "parentVersion": None,
        "parentInitialisationType": None,
        "pretrainedWeightsUsed": False,
    })
    if safetensors:
        persisted = {k: v for k, v in tensors.items() if "rotary_emb" not in k}
        if sharded:
            names = [f"model-{i:05d}-of-00002.safetensors" for i in (1, 2)]
            halfway = len(persisted) // 2
            shards = [dict(list(persisted.items())[:halfway]), dict(list(persisted.items())[halfway:])]
            weight_map = {}
            for name, shard in zip(names, shards):
                _write_safetensors_header(version_dir / name, shard)
                weight_map.update({key: name for key in shard})
            _write_json(version_dir / "model.safetensors.index.json", {"weight_map": weight_map})
        else:
            _write_safetensors_header(version_dir / "model.safetensors", persisted)
    if write_active:
        _write_json(root / "active.json", {
            "schema": "sma/active@1",
            "version": active or version,
            "artifactName": f"simpleminds-test-{active or version}",
            "weightFingerprint": "deadbeef0000",
            "activatedAt": "2026-10-20T00:00:00Z",
        })
    return {"config": config, "tensors": tensors, "sizes": sizes}


def _snapshot(root: Path) -> dict:
    return {
        str(path.relative_to(root)): (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_active_pointer_wins_over_a_newer_directory(tmp_path):
    root = tmp_path / "store"
    _make_store(root, version="v001", active="v001")
    _make_store(root, version="v003", active="v001", write_active=False)

    blueprint = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")

    assert blueprint["source"]["activeVersion"] == "v001"
    assert blueprint["model"]["version"] == "v001"
    assert blueprint["source"]["artifactName"] == "simpleminds-test-v001"


def test_missing_active_pointer_is_a_clear_failure(tmp_path):
    root = tmp_path / "store"
    _make_store(root, write_active=False)

    with pytest.raises(BlueprintError, match="active.json|no active model"):
        build_blueprint(root)


def test_uncommitted_active_version_is_refused(tmp_path):
    root = tmp_path / "store"
    _make_store(root, committed=False, write_active=False)
    _write_json(root / "active.json", {"version": "v001"})

    with pytest.raises(BlueprintError, match="not committed"):
        build_blueprint(root)


def test_missing_manifest_or_config_is_refused(tmp_path):
    root = tmp_path / "store"
    _make_store(root)
    (root / "v001" / "init-manifest.json").unlink()
    with pytest.raises(BlueprintError, match="init-manifest"):
        build_blueprint(root)

    _make_store(root, version="v002")
    (root / "v002" / "config.json").unlink()
    _write_json(root / "active.json", {"version": "v002"})
    with pytest.raises(BlueprintError, match="config.json"):
        build_blueprint(root)


def test_component_and_connection_ids_are_consistent(tmp_path):
    root = tmp_path / "store"
    _make_store(root)
    blueprint = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")

    component_ids = [component["id"] for component in blueprint["components"]]
    connection_ids = [connection["id"] for connection in blueprint["connections"]]
    assert len(component_ids) == len(set(component_ids))
    assert len(connection_ids) == len(set(connection_ids))
    known = set(component_ids)
    for connection in blueprint["connections"]:
        assert connection["from"] in known
        assert connection["to"] in known
        assert connection["from"] != connection["to"]


def test_parameter_accounting_separates_buffers_and_tied_aliases(tmp_path):
    root = tmp_path / "store"
    fixture = _make_store(root)
    blueprint = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")
    accounting = blueprint["parameterAccounting"]

    assert accounting["totalParameters"] == fixture["sizes"]["parametersUniqueByStorage"]
    assert accounting["nonParameterBufferElements"] == 64
    assert accounting["tensorElements"] == accounting["totalParameters"] + 64
    assert accounting["persistedTensorElements"] == accounting["totalParameters"]
    assert accounting["tiedAliases"][0]["alias"] == "model.lm_head.weight"
    assert accounting["tiedAliases"][0]["counted"] is False
    assert accounting["verification"]["status"] == "verified"
    assert accounting["verification"]["exact"] is True
    assert accounting["verification"]["independentStructuralEvidence"] == "safetensors-header"


def test_manifest_only_is_exact_but_not_independently_verified(tmp_path):
    root = tmp_path / "store"
    _make_store(root, safetensors=False)
    blueprint = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")
    accounting = blueprint["parameterAccounting"]

    assert accounting["verification"]["status"] == "unverified"
    assert accounting["verification"]["exact"] is True
    assert accounting["verification"]["independentStructuralEvidence"] is None
    assert any("not independently verified" in warning for warning in blueprint["warnings"])


def test_sharded_safetensors_headers_are_merged(tmp_path):
    root = tmp_path / "store"
    _make_store(root, sharded=True)
    blueprint = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")

    assert len(blueprint["source"]["weightFiles"]) == 2
    assert all(item["shard"] for item in blueprint["source"]["weightFiles"])
    assert blueprint["parameterAccounting"]["verification"]["status"] == "verified"


def test_export_is_deterministic_for_a_fixed_timestamp(tmp_path):
    root = tmp_path / "store"
    _make_store(root)
    first = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")
    second = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")
    assert first == second


def test_export_does_not_modify_the_store(tmp_path):
    root = tmp_path / "store"
    _make_store(root)
    before = _snapshot(root)
    output = tmp_path / "outside" / "blueprint.json"

    exit_code = main(["--store", str(root), "--out", str(output)])
    assert exit_code == 0
    assert output.is_file()
    assert str(root) not in output.read_text(encoding="utf-8")
    assert _snapshot(root) == before
    assert not any(path.name.endswith(".tmp") for path in output.parent.iterdir())


def test_atomic_write_replaces_an_existing_blueprint(tmp_path):
    target = tmp_path / "blueprint.json"
    target.write_text('{"old":true}', encoding="utf-8")
    path = write_blueprint(target, {"schema": "sma/brain-blueprint@1", "value": 1})
    assert path == target
    assert json.loads(target.read_text(encoding="utf-8"))["value"] == 1
    assert not any(path.name.endswith(".tmp") for path in tmp_path.iterdir())


def test_output_inside_the_model_store_is_refused(tmp_path, capsys):
    root = tmp_path / "store"
    _make_store(root)
    before = _snapshot(root)
    exit_code = main(["--store", str(root), "--out", str(root / "blueprint.json")])
    assert exit_code == 1
    assert "inside the model store" in capsys.readouterr().out
    assert _snapshot(root) == before


def test_large_synthetic_3b_architecture_is_represented_without_loading_weights(tmp_path):
    root = tmp_path / "store-3b"
    config = dict(configs.config_dict("3b"))
    config["configName"] = "3b"
    fixture = _make_store(root, config=config, safetensors=False)
    blueprint = build_blueprint(root, exported_at="2026-10-20T00:00:00Z")

    assert blueprint["counts"]["layers"] == 36
    assert blueprint["counts"]["components"] == 5 + 16 * 36
    assert blueprint["parameterAccounting"]["totalParameters"] == fixture["sizes"]["parametersUniqueByStorage"]
    assert blueprint["parameterAccounting"]["totalParameters"] == configs.EXPECTED_PARAMS["3b"]
    assert blueprint["source"]["weightsLoaded"] is False


def test_malformed_safetensors_header_is_reported(tmp_path):
    root = tmp_path / "store"
    _make_store(root, safetensors=False)
    (root / "v001" / "model.safetensors").write_bytes(b"not-a-header")

    with pytest.raises(BlueprintError, match="safetensors header"):
        build_blueprint(root)


def test_exporter_does_not_import_a_model_framework():
    result = subprocess.run(
        [sys.executable, "-c", "import sma.blueprint, sys; print('torch' in sys.modules, 'transformers' in sys.modules)"],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "False False"
