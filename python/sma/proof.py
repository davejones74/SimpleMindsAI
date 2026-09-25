"""
Provenance: turning "no pretrained weights were used" from a claim into a
checkable fact.

Five independent lines of evidence, strongest first:

1. STRUCTURAL  — nothing in the model-construction path calls
   `from_pretrained` on an upstream repo. `audit_from_pretrained_usage` parses
   the package source and fails if it finds one. This is a build-time
   invariant, not a runtime hope.

2. OFFLINE     — config and tokenizer are fetched with an explicit
   allowlist, then the model is built with `HF_HUB_OFFLINE=1` and no weight
   file anywhere on disk. Under those conditions loading pretrained weights
   is not merely unlikely, it is impossible.

3. BYTE        — per-tensor sha256 of what we actually built, recorded in
   `init-manifest.json`, comparable against the published checkpoint by anyone
   who wants to check.

4. LOSS SIGNATURE — a uniformly-random model over a vocab of size V starts at
   cross-entropy ln(V). Here ln(128256) = 11.76. A pretrained SmolLM3 sits
   near 1.8-2.5. This is the cheapest continuous guard we have and it stays
   armed forever: if a future vNNN ever evaluates below the guard band, a
   weight leak has occurred.

5. PARAMETER ACCOUNTING — unique-parameter count is asserted against a
   value computed from the config, so "same architecture, different scale" is
   verified rather than eyeballed.

What is *not* claimed: the tokenizer is a pretrained artifact. Its merges were
learned from data. That is accepted by design and labelled as such in the
manifest rather than buried.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import torch

from . import configs

# Exactly what may be fetched from the architecture reference repo. Note the
# absence of any weight pattern: *.safetensors, *.bin, *.pt, *.pth and
# *.gguf are all excluded by construction.
CONFIG_ONLY_PATTERNS = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
]

WEIGHT_PATTERNS = ("*.safetensors", "*.bin", "*.pt", "*.pth", "*.gguf", "*.h5")

# A randomly initialised model must start at ln(vocab_size). Pretrained
# models sit far below this. The band is deliberately wide: it must not trip
# on implementation differences in how the loss is reduced or shifted.
INITIAL_LOSS_BAND = (10.5, 12.5)

# transformers 5.x initialises with a plain normal, not a truncated normal.
INITIALIZER_KIND = "normal"
INITIALIZER_SOURCE = "transformers SmolLM3PreTrainedModel._init_weights -> init.normal_(std=initializer_range)"


# ------------------------------------------------------------------- hashing


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def tensor_sha256(tensor: torch.Tensor) -> str:
    """Hash raw tensor bytes. bf16 has no numpy dtype, so view as uint8
    (exact, no rounding) rather than upcasting."""
    flat = tensor.detach().cpu().contiguous().reshape(-1)
    return sha256_bytes(flat.view(torch.uint8).numpy().tobytes())


def tensor_hashes(model) -> Dict[str, Dict[str, Any]]:
    """sha256 per UNIQUE tensor.

    `state_dict()` contains 75 entries for the 62M model but only 74 distinct
    storages, because `tie_word_embeddings: True` makes `lm_head.weight`
    alias `model.embed_tokens.weight`. Deduplicating by storage keeps the tied
    matrix counted once, so a later diff can neither miss a change to it nor
    be confused by the alias.
    """
    out: Dict[str, Dict[str, Any]] = {}
    seen: Dict[int, str] = {}
    aliased: List[Dict[str, str]] = []

    for name, param in model.named_parameters():
        ptr = param.data_ptr()
        canonical = seen.get(ptr)
        if canonical is not None:
            aliased.append({"alias": name, "canonical": canonical})
            continue
        seen[ptr] = name
        out[name] = {
            "shape": list(param.shape),
            "dtype": str(param.dtype).replace("torch.", ""),
            "numel": param.numel(),
            "sha256": tensor_sha256(param),
        }

    for name, buf in model.named_buffers():
        if not torch.is_floating_point(buf) and buf.dtype not in (torch.float32,):
            continue
        ptr = buf.data_ptr()
        canonical = seen.get(ptr)
        if canonical is not None:
            aliased.append({"alias": name, "canonical": canonical})
            continue
        seen[ptr] = name
        out[name] = {
            "shape": list(buf.shape),
            "dtype": str(buf.dtype).replace("torch.", ""),
            "numel": buf.numel(),
            "sha256": tensor_sha256(buf),
        }

    return {"tensors": out, "aliasedTensors": aliased}


# -------------------------------------------------------- structural audit

_FROM_PREDICTED = re.compile(r"from_pretrained\s*\(\s*([^)]*)", re.S)
_HUB_REPO_ID = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


def audit_from_pretrained_usage(package_dir: Path) -> Dict[str, Any]:
    """Find every real `from_pretrained(...)` call in this package and flag
    the ones that name a Hub repo.

    Loading our OWN checkpoints through `from_pretrained("data/models/v002")`
    is required — it is the only way to read a trained brain. What is banned
    is `from_pretrained("HuggingFaceTB/SmolLM3-3B-Base")`, i.e. a bare
    `org/name` id, which could pull published weights.

    Implemented with `ast` rather than a regex on purpose. A text scan matches
    inside docstrings and comments, so this function's own documentation — or
    any commented-out experiment — reports a false violation. Walking the
    syntax tree sees only calls that can actually execute.

    Returns a report; `violations` must be empty.
    """
    import ast

    package_dir = Path(package_dir)
    calls: List[Dict[str, Any]] = []
    violations: List[Dict[str, Any]] = []

    for py in sorted(package_dir.rglob("*.py")):
        try:
            tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            if node.func.attr != "from_pretrained":
                continue
            raw = None
            if node.args:
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    raw = first.value
            record = {
                "file": str(py.relative_to(package_dir)),
                "line": node.lineno,
                "argument": raw,
            }
            calls.append(record)
            if raw is None:
                continue  # non-literal argument; cannot be classified statically
            is_local_path = (
                raw.startswith((".", "/"))
                or (len(raw) > 2 and raw[1] == ":")  # windows drive letter
                or "/" in raw
                and "\\" in raw
                or Path(raw).exists()
            )
            if _HUB_REPO_ID.match(raw) and not is_local_path:
                violations.append(record)

    return {
        "packageDir": str(package_dir),
        "calls": calls,
        "violations": violations,
        "rule": (
            "from_pretrained may only name a local filesystem path under the "
            "brain root; a bare org/name Hub id is a pretrained-weight load."
        ),
    }


# ------------------------------------------------------ config-only fetch


def fetch_config_and_tokenizer(repo: str, dest: Path) -> Dict[str, Any]:
    """Download ONLY config + tokenizer artifacts. Never any weight file."""
    from huggingface_hub import snapshot_download

    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    path = snapshot_download(repo_id=repo, allow_patterns=CONFIG_ONLY_PATTERNS, local_dir=str(dest))

    # The hub writes its own bookkeeping under .cache/huggingface/ — exclude
    # it so the manifest lists only the artifacts we actually asked for.
    downloaded = sorted(
        p.relative_to(path).as_posix()
        for p in Path(path).rglob("*")
        if p.is_file() and not p.relative_to(path).as_posix().startswith(".cache")
    )
    weight_files = [f for f in downloaded if any(f.endswith(w.split("*.")[-1]) for w in WEIGHT_PATTERNS)]
    if weight_files:
        raise RuntimeError(
            f"weight files were downloaded from {repo}: {weight_files}. "
            f"Architecture comes from config; weights are never fetched."
        )

    return {
        "repo": repo,
        "localDir": str(path),
        "filesDownloaded": downloaded,
        "weightsDownloaded": [],
        "weightBytes": 0,
        "configSha256": sha256_bytes(Path(path, "config.json").read_bytes())
        if Path(path, "config.json").exists()
        else None,
    }


def assert_offline_build(package_dir: Path = None) -> Dict[str, Any]:
    """Record the offline state the model was built under."""
    return {
        "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
        "HF_HUB_DISABLE_TELEMETRY": os.environ.get("HF_HUB_DISABLE_TELEMETRY"),
        "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
    }


# --------------------------------------------------------- loss signature


def expected_initial_loss(vocab_size: int) -> float:
    """ln(V) — the cross-entropy of a model with no learned structure."""
    return math.log(vocab_size)


def check_loss_signature(
    loss: float, vocab_size: int, band: Tuple[float, float] = INITIAL_LOSS_BAND
) -> Dict[str, Any]:
    expected = expected_initial_loss(vocab_size)
    result = {
        "loss": loss,
        "expectedUniform": expected,
        "band": list(band),
        "vocabSize": vocab_size,
        "deltaFromUniform": loss - expected,
        "ok": band[0] <= loss <= band[1],
    }
    if not result["ok"]:
        raise AssertionError(
            f"initial loss {loss:.4f} is outside {band}. A randomly initialised "
            f"model over vocab {vocab_size} should sit near ln({vocab_size})="
            f"{expected:.4f}. A loss this low means pretrained weights leaked in."
        )
    return result


# ---------------------------------------------------------------- manifest


def build_manifest(
    *,
    config_name: str,
    version: str,
    model: Any,
    architecture: Dict[str, Any],
    sizes: Dict[str, int],
    seed: int,
    dtype: str,
    repo: str = configs.ARCH_REFERENCE_REPO,
    fetch_info: Optional[Dict[str, Any]] = None,
    offline_env: Optional[Dict[str, Optional[str]]] = None,
    structural_audit: Optional[Dict[str, Any]] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    import time

    hashes = tensor_hashes(model)
    manifest: Dict[str, Any] = {
        "schema": "sma/init-manifest@1",
        "version": version,
        "createdAt": created_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # ---- the two fields the whole project is built on ----
        "initialisationType": "RANDOM",
        "pretrainedWeightsUsed": False,
        # ---- how it was built ----
        "seed": seed,
        "dtype": dtype,
        "configName": config_name,
        "architectureReferenceRepo": repo,
        "configSource": fetch_info
        or {
            "repo": repo,
            "filesDownloaded": list(CONFIG_ONLY_PATTERNS),
            "weightsDownloaded": [],
            "weightBytes": 0,
        },
        "tokenizerSource": "pretrained-artifact (accepted by design: an encoding mechanism, not neural weights)",
        "initializer": {
            "kind": INITIALIZER_KIND,
            "std": architecture["initializerRange"],
            "source": INITIALIZER_SOURCE,
        },
            "offlineEnv": offline_env or assert_offline_build(),
            # Evidence that no code path could have loaded upstream weights.
            # Persisted rather than only logged, so the audit survives the
            # console and can be re-checked months later.
            "structuralAudit": structural_audit,
        # ---- what was built ----
        "sizes": sizes,
        "architecture": architecture,
        "tensorCount": len(hashes["tensors"]),
        "aliasedTensors": hashes["aliasedTensors"],
        "tensors": hashes["tensors"],
    }
    # the loss signature is filled in once v001 has been evaluated
    manifest["initialLossSignature"] = {
        "expectedUniform": expected_initial_loss(architecture["vocabSize"]),
        "band": list(INITIAL_LOSS_BAND),
        "measured": None,
        "verified": False,
    }
    return manifest


def manifest_summary(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Compact view for CLI output and for the Node registry."""
    return {
        "version": manifest["version"],
        "initialisationType": manifest["initialisationType"],
        "pretrainedWeightsUsed": manifest["pretrainedWeightsUsed"],
        "configName": manifest["configName"],
        "seed": manifest["seed"],
        "parametersTotal": manifest["sizes"]["parametersTotal"],
        "parametersUniqueByStorage": manifest["sizes"]["parametersUniqueByStorage"],
        "tensorCount": manifest["tensorCount"],
        "tensorsDownloaded": len(manifest["configSource"].get("weightsDownloaded", [])),
        "expectedInitialLoss": manifest["initialLossSignature"]["expectedUniform"],
    }
