"""
Phase 2 preflight: measure the machine before committing to a long 3B run.

The README is explicit that a 3B run must be budgeted before it is started, not
discovered to be impossible an hour in: parameters, gradients, optimizer state,
fp32 master weights, activations, CUDA overhead and checkpoint write space. This
module produces that budget as one JSON object and, alongside it, the four facts
that decide whether the run is allowed to start at all (bf16 is native, the
resume boundary is not a different vendor, no live run already owns the version,
and the store has room for the checkpoint).

It is deliberately read-only. It does not touch the store, does not load the
model, and does not reserve anything; it measures and reports. The one place it
can fail closed is the resume parity check, where a record that cannot be
*shown* to match the current backend is treated as a mismatch (see
`portability.backend_of_resume`). Everything else is a budget the caller reads
and decides on.

Why a separate module and not a branch in `brain.cmd_train`: the budget is a
statement about this machine and this config, and it has to be answerable before
a model is built or a checkpoint is loaded. Folding it into `train` would mean
paying for a 3B load just to be told there is not enough memory.

Estimates vs measurements: parameter counts are exact (derived from the config
and reconciled against `configs.EXPECTED_PARAMS`); device/bf16 facts are
measured through `portability`; activation memory is the standard transformer
multiplier and is labelled as an estimate. The output says which is which so a
reader never mistakes the activation figure for a measurement.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import configs

# Version of this report's shape. Bumped when a field changes meaning, so a
# downstream parser can tell an old budget from a new one.
PREFLIGHT_VERSION = "sma/preflight@1"

STORAGE_BYTES_PER_ELEMENT = {"float32": 4, "bfloat16": 2, "float16": 2}

# Framework context, cuBLAS/HIPBLAS workspaces, allocator fragmentation and the
# allocations nobody accounts for until an OOM. A floor, not a measurement.
ACCELERATOR_OVERHEAD_BYTES = 1 << 30

# The classic transformer activation multiplier (elements per token per layer)
# for the no-recomputation case. Training with gradient checkpointing stores
# only the layer inputs and recomputes the rest, so the multiplier collapses to
# a small constant. Both are ESTIMATES, not measurements.
ACTIVATION_MULTIPLIER = 34.0
ACTIVATION_MULTIPLIER_CHECKPOINTED = 2.0

# A bf16 matmul is called native when it runs at least this fraction of fp32.
# A native unit runs bf16 at or above fp32; the measured software fallback on
# CPU is ~220x slower, so the gap either side of this line is enormous.
BF16_NATIVE_MIN_SPEEDUP = 0.5

OPTIMIZERS = ("adamw", "adamw8bit", "adafactor")

# bitsandbytes' 8-bit optimizers are compiled against CUDA; they do not exist
# for ROCm. Choosing one on a non-CUDA backend is a configuration error, not a
# runtime surprise to discover after the weights are loaded.
_CUDA_ONLY_OPTIMIZERS = ("adamw8bit",)

_UNIT = ("B", "KiB", "MiB", "GiB", "TiB")


def human_bytes(n: Optional[int]) -> Optional[str]:
    """A readable companion to the exact byte count. Never used for decisions."""
    if n is None:
        return None
    value = float(n)
    for unit in _UNIT:
        if abs(value) < 1024 or unit == _UNIT[-1]:
            return f"{value:.2f} {unit}"
        value /= 1024
    return None


def _shape_inventory(name: str) -> Dict[str, Any]:
    """Every parameter as a shape, derived from the config alone.

    The model is tied (``tie_word_embeddings``), so the embedding matrix is
    counted once and there is no separate lm_head. Each layer contributes seven
    linear maps plus two RMSNorm vectors, and there is one final norm vector.
    Getting this in one place is what lets `parameter_count` be an exact
    statement rather than a number remembered from a README.
    """
    cfg = configs.config_dict(name)
    hidden = int(cfg["hidden_size"])
    intermediate = int(cfg["intermediate_size"])
    layers = int(cfg["num_hidden_layers"])
    heads = int(cfg["num_attention_heads"])
    kv_heads = int(cfg["num_key_value_heads"])
    vocab = int(cfg["vocab_size"])
    if hidden % heads:
        raise ValueError(f"hidden_size {hidden} is not divisible by heads {heads}")
    head_dim = hidden // heads

    matrices: List[Tuple[int, int]] = [(vocab, hidden)]
    for _ in range(layers):
        matrices.extend(
            [
                (hidden, hidden),              # q_proj
                (kv_heads * head_dim, hidden),  # k_proj
                (kv_heads * head_dim, hidden),  # v_proj
                (hidden, hidden),              # o_proj
                (intermediate, hidden),        # gate_proj
                (intermediate, hidden),        # up_proj
                (hidden, intermediate),        # down_proj
            ]
        )
    vector_count = 2 * layers + 1
    return {
        "hiddenSize": hidden,
        "intermediateSize": intermediate,
        "layers": layers,
        "heads": heads,
        "kvHeads": kv_heads,
        "headDim": head_dim,
        "vocabSize": vocab,
        "matrices": matrices,
        "vectorCount": vector_count,
        "vectorSize": hidden,
    }


def parameter_count(name: str) -> int:
    """Exact unique-parameter count for a config name, from its shapes."""
    inv = _shape_inventory(name)
    matrix_params = sum(rows * cols for rows, cols in inv["matrices"])
    vector_params = inv["vectorCount"] * inv["vectorSize"]
    return matrix_params + vector_params


def _optimizer_bytes(inv: Dict[str, Any], optimizer: str) -> Tuple[int, str]:
    """Optimizer-state memory for one strategy, in bytes.

    - ``adamw``: two fp32 moments per parameter (m and v).
    - ``adamw8bit``: the bitsandbytes block-quantized state, ~2 bits-... bytes
      per parameter; 2.5 bytes is the documented steady-state rule of thumb.
    - ``adafactor``: factored — two vectors per matrix (row+column means) and
      two full moments only for the 1-D parameters (the norms), which is why it
      fits on a machine where AdamW does not.
    """
    matrix_params = sum(rows * cols for rows, cols in inv["matrices"])
    vector_params = inv["vectorCount"] * inv["vectorSize"]
    total = matrix_params + vector_params
    if optimizer == "adamw":
        return total * 8, "two fp32 moments per parameter"
    if optimizer == "adamw8bit":
        return int(total * 2.5), "bitsandbytes 8-bit block-quantized state"
    if optimizer == "adafactor":
        factored = sum((rows + cols) * 4 for rows, cols in inv["matrices"])
        return factored + vector_params * 8, "factored (row/column) state for matrices"
    raise ValueError(f"unknown optimizer {optimizer!r}; expected one of {OPTIMIZERS}")


def estimate_memory(
    name: str,
    *,
    optimizer: str = "adamw",
    storage_dtype: str = "bfloat16",
    compute_dtype: str = "bfloat16",
    micro_batch: int = 1,
    seq_len: int = 8192,
    grad_checkpointing: bool = False,
    overhead_bytes: int = 0,
) -> Dict[str, Any]:
    """The full memory and disk budget for a run, in bytes.

    Resident training memory (what an OOM is about) is masters + gradients +
    optimizer + activations + ``overhead_bytes`` (the caller supplies the
    device-appropriate framework overhead). Checkpoint write space (what fills
    the disk) is the stored weights plus the optimizer pickle that lives beside
    the run, because both are written to the store.
    """
    if optimizer not in OPTIMIZERS:
        raise ValueError(f"unknown optimizer {optimizer!r}; expected one of {OPTIMIZERS}")
    if storage_dtype not in {"float32", "bfloat16", "float16"}:
        raise ValueError(f"unknown storage dtype {storage_dtype!r}")
    if compute_dtype not in {"float32", "bfloat16", "float16"}:
        raise ValueError(f"unknown compute dtype {compute_dtype!r}")

    inv = _shape_inventory(name)
    params = parameter_count(name)
    master_bytes = params * 4  # fp32 masters are an invariant, not a choice
    gradient_bytes = params * 4
    optimizer_bytes, optimizer_note = _optimizer_bytes(inv, optimizer)

    multiplier = 2.0 if grad_checkpointing else 34.0
    activation_elements = (
        micro_batch * seq_len * inv["hiddenSize"] * inv["layers"]
    )
    activation_bytes = int(
        activation_elements * multiplier * {"float32": 4, "bfloat16": 2, "float16": 2}[compute_dtype]
    )

    overhead_bytes = int(overhead_bytes)
    resident_bytes = (
        master_bytes + gradient_bytes + optimizer_bytes + activation_bytes + overhead_bytes
    )
    weights_bytes = params * {"float32": 4, "bfloat16": 2, "float16": 2}[storage_dtype]
    checkpoint_bytes = weights_bytes + optimizer_bytes

    components = {
        "masterWeights": {"bytes": master_bytes, "human": human_bytes(master_bytes)},
        "gradients": {"bytes": gradient_bytes, "human": human_bytes(gradient_bytes)},
        "optimizerState": {
            "bytes": optimizer_bytes,
            "human": human_bytes(optimizer_bytes),
            "strategy": optimizer,
            "note": optimizer_note,
        },
        "activations": {
            "bytes": activation_bytes,
            "human": human_bytes(activation_bytes),
            "estimated": True,
            "gradCheckpointing": grad_checkpointing,
            "multiplier": multiplier,
            "microBatch": micro_batch,
            "sequenceLength": seq_len,
        },
        "overhead": {"bytes": overhead_bytes, "human": human_bytes(overhead_bytes)},
    }
    return {
        "config": name,
        "parameters": params,
        "shape": {
            "hiddenSize": inv["hiddenSize"],
            "layers": inv["layers"],
            "vocabSize": inv["vocabSize"],
            "headDim": inv["headDim"],
        },
        "optimizer": optimizer,
        "storageDtype": storage_dtype,
        "computeDtype": compute_dtype,
        "resident": {"bytes": resident_bytes, "human": human_bytes(resident_bytes)},
        "checkpoint": {
            "weightsBytes": weights_bytes,
            "weightsHuman": human_bytes(weights_bytes),
            "optimizerPickleBytes": optimizer_bytes,
            "totalBytes": checkpoint_bytes,
            "totalHuman": human_bytes(checkpoint_bytes),
        },
        "components": components,
    }


def usable_device_memory(platform: Dict[str, Any], *, shared_factor: float = 0.5, dedicated_factor: float = 0.9) -> Optional[int]:
    """How much of the reported device memory a training step may actually use.

    An APU reports the whole shared carve-out as ``totalMemoryBytes``; treating
    that like a discrete card's VRAM is the documented mistake, so a shared
    device is credited a smaller fraction. ``None`` means "no device memory
    measured" (CPU), and the memory check declines to make a claim.
    """
    total = platform.get("totalMemoryBytes")
    if not total:
        return None
    factor = shared_factor if platform.get("memorySharedWithHost") else dedicated_factor
    return int(total * factor)


def _check(name: str, ok: Optional[bool], detail: str, **extra: Any) -> Dict[str, Any]:
    """One row of the preflight.

    ``ok`` is None when the check cannot be decided on this machine (there is no
    measurement to judge). None is reported as a warning, never silently as a
    pass, so an unknown is visible in the output.
    """
    status = "pass" if ok is True else "fail" if ok is False else "warn"
    row = {"name": name, "ok": ok, "status": status, "detail": detail}
    row.update(extra)
    return row


def _disk_free(path: Path) -> Optional[int]:
    probe = Path(path)
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return int(shutil.disk_usage(probe).free)
    except OSError:
        return None


def _resume_environment(root: Path, version: str) -> Optional[Dict[str, Any]]:
    from . import store

    state_path = store.version_path(root, version) / "train-state.json"
    if not state_path.is_file():
        return None
    return store.read_json(state_path).get("environment")


def run_preflight(
    name: str = "3b",
    *,
    store_root: Optional[Path] = None,
    optimizer: str = "adamw",
    storage_dtype: str = "bfloat16",
    compute_dtype: str = "bfloat16",
    micro_batch: int = 1,
    seq_len: int = 8192,
    grad_checkpointing: bool = False,
    resume_from: Optional[str] = None,
    allow_cross_vendor: bool = False,
    include_bf16_probe: bool = True,
    platform: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run the nine checks and return one JSON-serialisable report.

    ``platform`` and ``include_bf16_probe`` exist so a test can pin the hardware
    facts instead of depending on the machine running the suite; the CLI always
    measures.
    """
    from . import portability, store

    root = Path(store_root) if store_root is not None else store.store_root()
    if platform is None:
        platform = portability.platform_report(with_bf16=include_bf16_probe)
    backend = platform.get("backend") or portability.backend_of_runtime()

    memory = estimate_memory(
        name,
        optimizer=optimizer,
        storage_dtype=storage_dtype,
        compute_dtype=compute_dtype,
        micro_batch=micro_batch,
        seq_len=seq_len,
        grad_checkpointing=grad_checkpointing,
        overhead_bytes=0 if backend == portability.BACKEND_CPU else ACCELERATOR_OVERHEAD_BYTES,
    )

    expected = configs.EXPECTED_PARAMS.get(name)
    computed = memory["parameters"]

    checks: List[Dict[str, Any]] = []

    # 1. platform ---------------------------------------------------------
    device = platform.get("deviceName")
    known_backend = backend in portability.BACKENDS
    checks.append(
        _check(
            "platform",
            known_backend,
            f"backend={backend} device={device or 'n/a'} arch={platform.get('archString') or 'n/a'} "
            f"totalMemory={human_bytes(platform.get('totalMemoryBytes')) or 'unreported'}"
            + (" (shared with host)" if platform.get("memorySharedWithHost") else ""),
            backend=backend,
            deviceName=device,
            archString=platform.get("archString"),
            totalMemoryBytes=platform.get("totalMemoryBytes"),
            memorySharedWithHost=platform.get("memorySharedWithHost"),
        )
    )

    # 2. bf16 -------------------------------------------------------------
    bf16 = platform.get("bf16")
    speedup = bf16.get("speedup") if bf16 else None
    if bf16 is None:
        native: Optional[bool] = None
        if backend == portability.BACKEND_CPU:
            bf16_ok: Optional[bool] = True
            bf16_detail = f"CPU run uses {memory['computeDtype']}; bf16 probe skipped"
        else:
            bf16_ok = None
            bf16_detail = "bf16 probe skipped; native vs emulated undecided"
    else:
        native = bool(speedup is not None and speedup >= BF16_NATIVE_MIN_SPEEDUP)
        if backend == portability.BACKEND_CPU:
            bf16_ok = True
            bf16_detail = f"CPU run uses {memory['computeDtype']}; bf16 speedup {speedup if speedup is not None else 'n/a'}"
        else:
            bf16_ok = native
            bf16_detail = f"bf16 speedup {speedup:.3f}x vs fp32 (native threshold {BF16_NATIVE_MIN_SPEEDUP}x)" if speedup is not None else "bf16 timing unavailable"
    checks.append(
        _check(
            "bf16",
            bf16_ok,
            bf16_detail,
            supported=bf16.get("supported") if bf16 else None,
            speedup=speedup,
            native=native,
            minSpeedup=BF16_NATIVE_MIN_SPEEDUP,
        )
    )

    # 3. resume parity ----------------------------------------------------
    if resume_from is None:
        checks.append(
            _check("resumeParity", True, "no resume requested; nothing to reconcile", resumeFrom=None)
        )
    else:
        recorded_env = _resume_environment(root, resume_from)
        recorded = portability.backend_of_resume(recorded_env)
        if recorded is None:
            parity_ok = bool(allow_cross_vendor)
            detail = (
                f"{resume_from} has no recorded backend; treated as cross-vendor "
                f"(override-required). Current backend is {backend}."
            )
        else:
            parity_ok = (recorded == backend) or bool(allow_cross_vendor)
            detail = (
                f"{resume_from} recorded backend={recorded}; current backend={backend}"
                + ("" if recorded == backend else " (cross-vendor)")
            )
        checks.append(
            _check(
                "resumeParity",
                parity_ok,
                detail,
                resumeFrom=resume_from,
                recordedBackend=recorded,
                currentBackend=backend,
                allowCrossVendor=bool(allow_cross_vendor),
            )
        )

    # 4. run lock ---------------------------------------------------------
    target = resume_from or store.next_version(root)
    lock_active = store.run_lock_active(root, target)
    checks.append(
        _check(
            "runLock",
            not lock_active,
            f"version {target} " + ("is owned by a live run" if lock_active else "is free"),
            version=target,
            lockActive=lock_active,
            staleAfterSeconds=store.RUN_LOCK_STALE_S,
        )
    )

    # 5. parameters -------------------------------------------------------
    params_ok = expected is not None and computed == expected
    checks.append(
        _check(
            "parameters",
            params_ok,
            f"computed {computed:,} unique parameters"
            + (f" (matches expected {expected:,})" if expected is not None and params_ok else f" (expected {expected:,})" if expected is not None else " (no recorded expectation for this config)"),
            computed=computed,
            expected=expected,
        )
    )

    # 6. optimizer availability ------------------------------------------
    if optimizer in _CUDA_ONLY_OPTIMIZERS and backend != portability.BACKEND_CUDA:
        opt_ok: Optional[bool] = False
        opt_detail = f"{optimizer} is CUDA-only; use adafactor on {backend}"
    else:
        opt_ok = True
        opt_detail = f"{optimizer} is available on {backend}"
    checks.append(
        _check(
            "optimizerAvailability",
            opt_ok,
            opt_detail,
            optimizer=optimizer,
            backend=backend,
        )
    )

    # 7. memory budget ----------------------------------------------------
    budget = usable_device_memory(platform)
    resident = memory["resident"]["bytes"]
    if budget is None:
        mem_ok: Optional[bool] = None
        mem_detail = f"no device memory reported; resident need {memory['resident']['human']} not evaluated"
    else:
        mem_ok = resident <= budget
        mem_detail = (
            f"resident {memory['resident']['human']} vs usable {human_bytes(budget)} "
            f"({'fits' if mem_ok else 'exceeds'})"
        )
    checks.append(
        _check(
            "memoryBudget",
            mem_ok,
            mem_detail,
            residentBytes=resident,
            usableBytes=budget,
        )
    )

    # 8. checkpoint write space ------------------------------------------
    free = _disk_free(root)
    checkpoint_bytes = memory["checkpoint"]["totalBytes"]
    if free is None:
        disk_ok: Optional[bool] = None
        disk_detail = f"could not stat {root}; checkpoint need {human_bytes(checkpoint_bytes)} not evaluated"
    else:
        disk_ok = checkpoint_bytes <= free
        disk_detail = (
            f"checkpoint {memory['checkpoint']['totalHuman']} vs {human_bytes(free)} free "
            f"({'fits' if disk_ok else 'exceeds'})"
        )
    checks.append(
        _check(
            "checkpointSpace",
            disk_ok,
            disk_detail,
            requiredBytes=checkpoint_bytes,
            freeBytes=free,
            storeRoot=str(root),
        )
    )

    # 9. master dtype (invariant 11) -------------------------------------
    checks.append(
        _check(
            "masterDtype",
            True,
            "fp32 master weights (bf16 masters silently freeze the RMSNorm parameters)",
            computeDtype=compute_dtype,
            storageDtype=storage_dtype,
        )
    )

    failed = [c["name"] for c in checks if c["ok"] is False]
    warnings = [c["name"] for c in checks if c["ok"] is None]
    return {
        "ok": not failed,
        "verb": "preflight",
        "config": name,
        "backend": backend,
        "device": device,
        "storeRoot": str(root),
        "platform": platform,
        "memory": memory,
        "checks": checks,
        "failed": failed,
        "warnings": warnings,
    }
