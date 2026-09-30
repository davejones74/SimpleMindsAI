"""
Architecture construction.

One function builds both the 62M development brain and the 3B target:
`SmolLM3ForCausalLM(config)`. Per the transformers documentation this loads
*configuration only* — no checkpoint, no weights. `__init__` calls
`post_init()` -> `init_weights()`, which for SmolLM3 is:

    nn.Linear / nn.Embedding -> init.normal_(weight, mean=0.0, std=initializer_range)
    biases                    -> init.zeros_
    RMSNorm / LayerNorm       -> init.ones_(weight), init.zeros_(bias)
    RoPE buffers              -> analytic inverse frequencies

Note it is a plain normal, NOT a truncated normal, despite what the
`initializer_range` docstring implies. This matters for provenance: at
std 0.02 the observed max magnitude is ~4.6 sigma, not the 2 sigma a
truncated init would produce. `proof.py` records the real initializer.
"""

from __future__ import annotations

from typing import Any, Dict

import torch

from . import configs


def hf_config(name: str):
    """Build a SmolLM3Config from the recorded architecture dict."""
    from transformers import SmolLM3Config

    d = configs.config_dict(name)
    return SmolLM3Config(**d)


def rope_params(config) -> Dict[str, Any]:
    """Read RoPE settings across transformers layouts.

    4.x exposes `rope_theta` / `rope_scaling` as top-level attributes. 5.x
    folds them into a `rope_parameters` dict and drops the top-level fields,
    so `config.rope_theta` raises AttributeError there. Accept either, and
    fail loudly if neither is present rather than defaulting silently.
    """
    packed = getattr(config, "rope_parameters", None)
    if isinstance(packed, dict):
        theta = packed.get("rope_theta")
        rope_type = packed.get("rope_type", "default")
        scaling = packed.get("factor") or packed.get("short_factor") or None
    else:
        theta = getattr(config, "rope_theta", None)
        rope_type = "default"
        scaling = getattr(config, "rope_scaling", None)
    if theta is None:
        raise AssertionError(
            f"could not read rope_theta from {type(config).__name__}; "
            f"available rope fields: "
            f"{[k for k in vars(config) if 'rope' in k.lower()]}"
        )
    return {"theta": float(theta), "ropeType": rope_type, "scaling": scaling}


def config_dtype(config):
    """5.x renamed `torch_dtype` to `dtype`. Accept either."""
    for attr in ("dtype", "torch_dtype"):
        value = getattr(config, attr, None)
        if value is not None:
            return value
    return torch.float32


def assert_head_dim_divides(config) -> int:
    """SmolLM3Config has no `head_dim` field — the attention layer derives it
    as hidden_size // num_attention_heads and does not validate. A bad small
    config therefore explodes deep inside SDPA instead of at construction.
    Check it here, where the error message can be useful."""
    hidden, heads = config.hidden_size, config.num_attention_heads
    if heads <= 0 or hidden % heads != 0:
        raise ValueError(
            f"hidden_size ({hidden}) must be divisible by num_attention_heads "
            f"({heads}); SmolLM3Config does not validate this"
        )
    kv = config.num_key_value_heads
    if kv <= 0 or heads % kv != 0:
        raise ValueError(
            f"num_attention_heads ({heads}) must be divisible by "
            f"num_key_value_heads ({kv}) for GQA"
        )
    return hidden // heads


def count_parameters(model) -> tuple:
    """(total, trainable, unique_by_storage).

    The third number is the one that matters for provenance. With
    `tie_word_embeddings: True` the state dict contains 75 entries for the
    62M model but only 74 distinct storages — `lm_head.weight` aliases
    `model.embed_tokens.weight`. Hashing or diffing naively over entries would
    count the embedding matrix twice and could mask a real change to it.
    """
    total = sum(p.numel() for p in model.parameters())
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    unique = sum({p.data_ptr(): p.numel() for p in model.parameters()}.values())
    return total, trainable, unique


def assert_expected_size(name: str, model) -> Dict[str, int]:
    """Guard the parameter count against an accidental architecture change."""
    total, trainable, unique = count_parameters(model)
    expected = configs.EXPECTED_PARAMS[name]
    if unique != expected:
        raise AssertionError(
            f"config {name!r} produced {unique:,} unique parameters, "
            f"expected {expected:,}. The architecture drifted."
        )
    if trainable != total:
        raise AssertionError(
            f"{total - trainable:,} parameters are frozen. This project trains "
            f"every parameter; a frozen tensor means a bug, not an intent."
        )
    return {
        "parametersTotal": total,
        "parametersTrainable": trainable,
        "parametersUniqueByStorage": unique,
    }


def build_model(
    name: str,
    seed: int = 0,
    dtype: torch.dtype | None = None,
    device: str | torch.device = "cpu",
):
    """Randomly initialise a SmolLM3. No pretrained weights are loaded.

    Deterministic for a given (name, seed): `torch.manual_seed` is set
    immediately before construction, and init draws from the global RNG.
    """
    from transformers import SmolLM3ForCausalLM

    config = hf_config(name)
    assert_head_dim_divides(config)

    if dtype is None:
        declared = config_dtype(config)
        dtype = getattr(torch, declared) if isinstance(declared, str) else declared
    if isinstance(dtype, str):
        dtype = getattr(torch, dtype)
    # `torch_dtype` is deprecated in 5.x in favour of `dtype`
    setattr(config, "dtype", dtype)
    config.torch_dtype = str(dtype).replace("torch.", "")

    torch.manual_seed(seed)
    model = SmolLM3ForCausalLM(config)
    model = model.to(dtype=dtype)
    model.to(device)

    sizes = assert_expected_size(name, model)
    return model, config, sizes


def architecture_report(name: str) -> Dict[str, Any]:
    """Everything needed to prove a config is the intended architecture,
    computed from the config object rather than from our own notes."""
    config = hf_config(name)
    head_dim = assert_head_dim_divides(config)
    rope = rope_params(config)
    return {
        "configName": name,
        "modelClass": "SmolLM3ForCausalLM",
        "modelType": config.model_type,
        "vocabSize": config.vocab_size,
        "hiddenSize": config.hidden_size,
        "intermediateSize": config.intermediate_size,
        "numHiddenLayers": config.num_hidden_layers,
        "numAttentionHeads": config.num_attention_heads,
        "numKeyValueHeads": config.num_key_value_heads,
        "headDim": head_dim,
        "gqaRatio": config.num_attention_heads // config.num_key_value_heads,
        "hiddenAct": config.hidden_act,
        "rmsNormEps": config.rms_norm_eps,
        "attentionBias": config.attention_bias,
        "attentionDropout": config.attention_dropout,
        "mlpBias": getattr(config, "mlp_bias", False),
        "ropeTheta": rope["theta"],
        "ropeType": rope["ropeType"],
        "ropeScaling": rope["scaling"],
        "noRopeLayerInterval": config.no_rope_layer_interval,
        "noRopeLayers": list(config.no_rope_layers),
        "noRopeLayerIndices": [
            i for i, has_rope in enumerate(config.no_rope_layers) if not has_rope
        ],
        "layerTypes": sorted(set(config.layer_types)),
        "useSlidingWindow": config.use_sliding_window,
        "slidingWindow": config.sliding_window,
        "tieWordEmbeddings": config.tie_word_embeddings,
        "initializerRange": config.initializer_range,
        "maxPositionEmbeddings": config.max_position_embeddings,
        "padTokenId": config.pad_token_id,
        "bosTokenId": config.bos_token_id,
        "eosTokenId": config.eos_token_id,
        "torchDtype": str(config_dtype(config)).replace("torch.", ""),
        "architectures": list(config.architectures),
    }
