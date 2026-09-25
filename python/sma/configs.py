"""
Architecture source of truth.

`SMOLLM3_3B_OFFICIAL` is a verbatim transcription of the published
SmolLM3-3B-Base `config.json`. It is the architecture of record. Every field
in it is deliberate, and several differ from the `SmolLM3Config` class
defaults — which is precisely why we load the file instead of calling the
class:

    field                       class default    published
    --------------------------  ---------------  -----------
    max_position_embeddings     32768            65536
    rope_theta                  2000000.0        5000000.0
    bos_token_id                128000           null

Constructing via `SmolLM3Config()` would silently train a model with the wrong
RoPE base and a spurious BOS token, and nothing would fail. `load_official_config`
exists to make that mistake impossible.

`SMALL` is derived from the official dict by overriding ONLY the five scale
fields. Every architecture-identity field — RMSNorm epsilon, attention bias,
RoPE theta, the NoPE interval, KV-head count, embedding tying, activation —
is inherited by construction, not by my having remembered to copy it. The
small config therefore *cannot* drift into being a different architecture; it
is the same family at a different scale.
"""

from __future__ import annotations

import copy
from typing import Any, Dict

# Reference repo. Used for config.json + tokenizer ONLY. Weight files are
# never fetched from it — see proof.CONFIG_ONLY_PATTERNS.
ARCH_REFERENCE_REPO = "HuggingFaceTB/SmolLM3-3B-Base"

# The only fields `small` is allowed to change relative to the official 3B.
# Everything else is architecture identity and is inherited.
SCALE_FIELDS = (
    "hidden_size",
    "intermediate_size",
    "num_hidden_layers",
    "num_attention_heads",
    "num_key_value_heads",
    "max_position_embeddings",
)

SMOLLM3_3B_OFFICIAL: Dict[str, Any] = {
    "architectures": ["SmolLM3ForCausalLM"],
    "attention_bias": False,
    "attention_dropout": 0.0,
    "bos_token_id": None,
    "eos_token_id": 128001,
    "hidden_act": "silu",
    "hidden_size": 2048,
    "initializer_range": 0.02,
    "intermediate_size": 11008,
    "max_position_embeddings": 65536,
    "model_type": "smollm3",
    "no_rope_layer_interval": 4,
    "num_attention_heads": 16,
    "num_hidden_layers": 36,
    "num_key_value_heads": 4,
    "pad_token_id": 128004,
    "pretraining_tp": 2,  # legacy; ignored by transformers 5.x
    "rms_norm_eps": 1e-06,
    "rope_scaling": None,
    "rope_theta": 5000000.0,
    "sliding_window": None,
    "tie_word_embeddings": True,
    "torch_dtype": "bfloat16",
    "use_cache": True,
    "use_sliding_window": False,
    "vocab_size": 128256,
}

# 62M development/CI brain. Same class, same code path, same tokenizer.
# 8 layers x 384 hidden, GQA 3:1, head_dim 64.
SMALL_OVERRIDES: Dict[str, Any] = {
    "hidden_size": 384,
    "intermediate_size": 1024,
    "num_hidden_layers": 8,
    "num_attention_heads": 6,
    "num_key_value_heads": 2,
    # Not used by the forward pass for standard RoPE (no learned position
    # embeddings); it bounds the cache. Overridable so CI need not reserve
    # 65 536 positions of address space for a model that trains at 512.
    "max_position_embeddings": 2048,
}

# Parameter counts verified by construction (see arch.assert_expected_size).
# The 3B figure is computed, not quoted: 262,668,288 tied embedding +
# 36 x 78,123,008 layers + 2,048 final norm.
EXPECTED_PARAMS: Dict[str, int] = {
    "small": 61_839_744,
    "3b": 3_075_098_624,
}

CONFIG_NAMES = tuple(EXPECTED_PARAMS)


def small_config_dict() -> Dict[str, Any]:
    """The 62M config, derived from the official one."""
    cfg = copy.deepcopy(SMOLLM3_3B_OFFICIAL)
    for key, value in SMALL_OVERRIDES.items():
        assert key in SCALE_FIELDS, f"{key} is not a scale field; refusing to override"
        cfg[key] = value
    return cfg


def config_dict(name: str) -> Dict[str, Any]:
    """Resolve a config name to a plain dict ready for SmolLM3Config(**cfg)."""
    if name == "3b":
        return copy.deepcopy(SMOLLM3_3B_OFFICIAL)
    if name == "small":
        return small_config_dict()
    raise KeyError(f"unknown config {name!r}; expected one of {CONFIG_NAMES}")


def scale_delta(name: str) -> Dict[str, tuple]:
    """What this config changes relative to the official 3B. Used by the
    architecture-parity test to assert nothing outside SCALE_FIELDS moved."""
    official = SMOLLM3_3B_OFFICIAL
    current = config_dict(name)
    return {
        k: (official.get(k), current.get(k))
        for k in sorted(set(official) | set(current))
        if official.get(k) != current.get(k)
    }
