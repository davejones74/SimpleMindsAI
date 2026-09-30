"""
Hardware/backend portability for the compute plane.

Two accelerator vendors are in scope: NVIDIA CUDA (the RTX 4090 development
machine) and AMD ROCm (the Ryzen AI HX 370 / 890M deployment host). ROCm
deliberately keeps the `torch.cuda` namespace, so every device call in this
codebase already works on both. What does *not* travel is the provenance: a
manifest that says "cudaAvailable: true" was produced on a machine where that
statement is meaningless, because under ROCm `torch.cuda.is_available()` is true
by design and it is `torch.version.hip` that actually identifies the backend.
Recording one and not the other is how a deployment ends up claiming to be a
CUDA run when it was an AMD one.

So this module answers two questions, once, in one place:

  1. Which backend am I running on, and what does that device actually look
     like?  -> `runtime_environment()`, `platform_report()`
  2. Can a checkpoint trained on one backend be resumed on the other?
     -> `backend_of_resume()` (Phase B adds the full nine-check preflight)

Backend values are lowercase ("cuda" / "rocm" / "cpu") to match torch's own
naming. Note that "rocm" is a *vendor* label while the torch device type is
still "cuda"; recording both is the point, because only the first is true.
"""

from __future__ import annotations

import os
import platform as _platform
import time
from typing import Any, Dict, Optional

import torch

BACKEND_CUDA = "cuda"
BACKEND_ROCM = "rocm"
BACKEND_CPU = "cpu"

BACKENDS = (BACKEND_CUDA, BACKEND_ROCM, BACKEND_CPU)

# What a freshly built bf16 matmul and an fp32 matmul of the same size are
# timed against each other, so a reader can judge "native bf16" from evidence
# instead of a flag. The *verdict* (native vs emulated) is deliberately NOT
# made here: it needs a threshold calibrated on the real device, which is the
# preflight's job in Phase C. These numbers are the raw evidence it consumes.
_BF16_PROBE_SIZE = 256
_BF16_PROBE_ITERS = 3


def build_backend() -> str:
    """The accelerator vendor this torch *build* targets, device or not.

    This is a property of the wheel, not of the machine: a ROCm build reports
    "rocm" even if no device is currently visible. Use `backend_of_runtime()`
    to ask what a run will actually use.
    """
    if getattr(torch.version, "hip", None):
        return BACKEND_ROCM
    if getattr(torch.version, "cuda", None):
        return BACKEND_CUDA
    return BACKEND_CPU


def backend_of_runtime() -> str:
    """The backend a run would actually compute on right now.

    "cpu" whenever no accelerator is visible, even if the build is a CUDA or
    ROCm one — CI installs a CUDA wheel and runs on CPU, and a provenance
    record claiming a GPU run there would be false.
    """
    if not torch.cuda.is_available():
        return BACKEND_CPU
    return BACKEND_ROCM if build_backend() == BACKEND_ROCM else BACKEND_CUDA


def backend_version() -> Optional[str]:
    """CUDA toolkit or HIP version this torch was built against, if any."""
    if build_backend() == BACKEND_ROCM:
        return getattr(torch.version, "hip", None)
    if build_backend() == BACKEND_CUDA:
        return getattr(torch.version, "cuda", None)
    return None


def runtime_environment() -> Dict[str, Any]:
    """The vendor-neutral provenance block recorded with every train state.

    Replaces the CUDA-only `cudaAvailable` field. `backend` names the vendor
    ("cuda" / "rocm" / "cpu") and `device` keeps the torch device type it runs
    on, which under ROCm is still literally "cuda" — that asymmetry is the
    reason both are recorded rather than one.
    """
    import transformers

    backend = backend_of_runtime()
    return {
        "python": _platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "backend": backend,
        "backendVersion": backend_version(),
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }


def backend_of_resume(recorded_environment: Optional[Dict[str, Any]]) -> Optional[str]:
    """The backend a previous run recorded, or None if it predates the field.

    None is treated as cross-vendor (i.e. override-required) by the resume
    guard: an old record that never named its backend cannot be *shown* to
    match, and the conservative reading is the safe one.
    """
    if not recorded_environment:
        return None
    backend = recorded_environment.get("backend")
    return backend if backend in BACKENDS else None


def _arch_string(props) -> str:
    """A stable architecture identifier for the device.

    On ROCm this is the gfx target (e.g. "gfx1151") from `gcnArchName`. On CUDA
    it is the compute capability ("8.9"). Note that on a *CUDA* build
    `gcnArchName` is present and returns the device *name*, not an arch, so the
    vendor must be checked explicitly rather than by attribute presence.
    """
    if build_backend() == BACKEND_ROCM:
        gcn = getattr(props, "gcnArchName", None)
        if gcn:
            return str(gcn)
    return f"{props.major}.{props.minor}"


def _memory_shared_with_host(props, backend: str) -> bool:
    """Whether the device memory is shared with the host rather than dedicated.

    An APU (the ROCm target here, gfx11xx / gfx1151) reports the whole
    carve-out as `total_memory`; it is not a dedicated VRAM budget, and the 3B
    memory preflight must not treat it like a discrete card's 24 GB.
    """
    return backend == BACKEND_ROCM


def bf16_probe(
    device: Optional[str] = None,
    size: int = _BF16_PROBE_SIZE,
    iters: int = _BF16_PROBE_ITERS,
) -> Dict[str, Any]:
    """Measure a real bf16 matmul against an fp32 one of the same size.

    This is a measurement, not a feature query. `torch.cuda.is_bf16_supported()`
    answers the wrong question and is a known trap: under ROCm it returns True
    whenever `torch.version.hip` is set, without checking the architecture at
    all, so it cannot distinguish native bf16 from a software fallback.

    The result reports:
      - `supported`: the bf16 matmul ran and produced finite values.
      - `fp32Seconds` / `bf16Seconds` / `speedup`: the timing evidence. A
        native bf16 accelerator runs bf16 at least as fast as fp32; an emulated
        one is dramatically slower (the measured CPU figure in the README is
        220x). Interpreting that ratio needs a threshold calibrated per device,
        which is why the pass/fail call is left to the preflight.
    """
    dev_type = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dev = torch.device(dev_type)
    out: Dict[str, Any] = {
        "device": dev.type,
        "size": size,
        "iters": iters,
        "supported": False,
        "fp32Seconds": None,
        "bf16Seconds": None,
        "speedup": None,
    }

    generator = torch.Generator(device="cpu").manual_seed(0)
    a32 = torch.randn(size, size, generator=generator)
    b32 = torch.randn(size, size, generator=generator)

    def _sync():
        if dev.type == "cuda" and torch.cuda.is_available():
            torch.cuda.synchronize()

    def _time(fn, iters: int):
        fn()  # warmup
        _sync()
        start = time.perf_counter()
        for _ in range(iters):
            fn()
        _sync()
        return (time.perf_counter() - start) / iters

    try:
        a = a32.to(dev)
        b = b32.to(dev)
        out["fp32Seconds"] = _time(lambda: a @ b, iters)

        ab = a.to(torch.bfloat16)
        bb = b.to(torch.bfloat16)
        out["bf16Seconds"] = _time(lambda: ab @ bb, iters)
        result = ab @ bb
        out["supported"] = bool(torch.isfinite(result.to(torch.float32)).all().item())
        if out["fp32Seconds"] and out["bf16Seconds"]:
            out["speedup"] = out["fp32Seconds"] / out["bf16Seconds"]
    except Exception as exc:  # noqa: BLE001 — a probe must report, not crash
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def platform_report() -> Dict[str, Any]:
    """Everything the memory/portability preflight needs about this machine.

    Vendor-neutral superset of what the old CUDA-only `arch.cuda_report()`
    provided (which was dead code and would have reported a placeholder
    compute-capability and a misleading "totalVramBytes" on ROCm). `archString`
    is the real architecture, `totalMemoryBytes` is what the device reports, and
    `memorySharedWithHost` says whether that number is a dedicated budget or a
    shared carve-out.
    """
    backend = backend_of_runtime()
    report: Dict[str, Any] = {
        "backend": backend,
        "buildBackend": build_backend(),
        "backendVersion": backend_version(),
        "torchVersion": torch.__version__,
        "deviceName": None,
        "archString": None,
        "totalMemoryBytes": None,
        "memorySharedWithHost": None,
        "bf16": None,
    }
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        report["deviceName"] = props.name
        report["archString"] = _arch_string(props)
        report["totalMemoryBytes"] = int(props.total_memory)
        report["memorySharedWithHost"] = _memory_shared_with_host(props, backend)
    report["bf16"] = bf16_probe()
    report["envOffline"] = os.environ.get("HF_HUB_OFFLINE")
    return report
