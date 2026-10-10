"""The Phase 2 preflight: the budget a long run is gated on.

The preflight's whole job is to be answerable *before* a model is built, so these
tests build nothing: they pin the hardware facts with an injected platform dict
and check the arithmetic, the check semantics, and the CLI contract. The one
thing that must be real is the store, because the run-lock and disk checks read
actual bytes on disk - so those run against a tmp store, never a mock.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT
from sma import configs, preflight, store

NINE_CHECKS = [
    "platform",
    "bf16",
    "resumeParity",
    "runLock",
    "parameters",
    "optimizerAvailability",
    "memoryBudget",
    "checkpointSpace",
    "masterDtype",
]


def _platform(backend: str = "cuda", **over):
    """A plausible platform report, so the checks are hardware-independent."""
    report = {
        "backend": backend,
        "buildBackend": backend,
        "backendVersion": "13.0",
        "torchVersion": "2.14.0",
        "deviceName": "NVIDIA GeForce RTX 4090" if backend == "cuda" else "Test Device",
        "archString": "8.9",
        "totalMemoryBytes": 25_000_000_000,
        "memorySharedWithHost": backend == "rocm",
        "bf16": {
            "device": "cuda",
            "supported": True,
            "fp32Seconds": 1.0,
            "bf16Seconds": 2.0 if backend == "rocm" else 0.66,
            "speedup": 0.4 if backend == "rocm" else 1.5,
        },
        "envOffline": None,
    }
    report.update(over)
    return report


# ----------------------------------------------------------------- parameter math


def test_parameter_count_matches_the_recorded_expectation():
    # The count is derived from the config shapes, so this asserts the derivation
    # agrees with the number the architecture gate already trusts. If the two
    # ever disagree, one of them is lying about the model.
    for name, expected in configs.EXPECTED_PARAMS.items():
        assert preflight.parameter_count(name) == expected


def test_parameter_count_3b_decomposes_as_documented():
    # 262,668,288 tied embedding + 36 x 78,123,008 layers + 2,048 final norm.
    inv = preflight._shape_inventory("3b")
    embedding = inv["matrices"][0][0] * inv["matrices"][0][1]
    per_layer = sum(r * c for r, c in inv["matrices"][1:8])
    norms = inv["vectorCount"] * inv["vectorSize"]
    assert embedding == 262_668_288
    assert per_layer + 2 * inv["hiddenSize"] == 78_123_008
    assert norms == (2 * 36 + 1) * 2048


def test_small_head_dim_divides():
    assert preflight._shape_inventory("small")["headDim"] == 64


# ----------------------------------------------------------------- memory budget


def test_small_adamw_budget_is_exact():
    mem = preflight.estimate_memory("small", optimizer="adamw", seq_len=8192, micro_batch=1)
    params = configs.EXPECTED_PARAMS["small"]
    assert mem["parameters"] == params
    # fp32 masters and fp32 gradients, one of each per parameter.
    assert mem["components"]["masterWeights"]["bytes"] == params * 4
    assert mem["components"]["gradients"]["bytes"] == params * 4
    # AdamW carries two fp32 moments.
    assert mem["components"]["optimizerState"]["bytes"] == params * 8
    # Activation figure is the 34x multiplier over one token per layer.
    expected_act = 1 * 8192 * 384 * 8 * 34 * 2
    assert mem["components"]["activations"]["bytes"] == expected_act
    assert mem["components"]["activations"]["estimated"] is True


def test_grad_checkpointing_collapses_activation_memory():
    full = preflight.estimate_memory("3b", seq_len=8192, grad_checkpointing=False)
    ckpt = preflight.estimate_memory("3b", seq_len=8192, grad_checkpointing=True)
    assert ckpt["components"]["activations"]["bytes"] < full["components"]["activations"]["bytes"]
    # 34x -> 2x, a 17x reduction, and everything else is unchanged.
    assert full["components"]["activations"]["bytes"] == ckpt["components"]["activations"]["bytes"] * 17
    assert ckpt["components"]["masterWeights"] == full["components"]["masterWeights"]


def test_optimizer_ordering_adafactor_lt_8bit_lt_adamw():
    adamw = preflight.estimate_memory("3b", optimizer="adamw")["components"]["optimizerState"]["bytes"]
    eight = preflight.estimate_memory("3b", optimizer="adamw8bit")["components"]["optimizerState"]["bytes"]
    adafactor = preflight.estimate_memory("3b", optimizer="adafactor")["components"]["optimizerState"]["bytes"]
    assert adafactor < eight < adamw


def test_checkpoint_is_weights_plus_optimizer_pickle():
    mem = preflight.estimate_memory("small", optimizer="adamw", storage_dtype="bfloat16")
    params = configs.EXPECTED_PARAMS["small"]
    assert mem["checkpoint"]["weightsBytes"] == params * 2  # bf16 on disk
    assert mem["checkpoint"]["totalBytes"] == params * 2 + params * 8


def test_unknown_optimizer_is_rejected():
    with pytest.raises(ValueError, match="unknown optimizer"):
        preflight.estimate_memory("small", optimizer="sgd")


def test_usable_memory_credits_shared_carve_out_less():
    dedicated = preflight.usable_device_memory(_platform("cuda", totalMemoryBytes=1000))
    shared = preflight.usable_device_memory(_platform("rocm", totalMemoryBytes=1000))
    assert dedicated == 900
    assert shared == 500
    assert preflight.usable_device_memory(_platform("cpu", deviceName=None, totalMemoryBytes=None)) is None


# --------------------------------------------------------------------- checks


def test_run_preflight_reports_exactly_nine_named_checks(tmp_path):
    report = preflight.run_preflight("small", store_root=tmp_path, platform=_platform())
    assert [c["name"] for c in report["checks"]] == NINE_CHECKS
    assert report["ok"] is True
    assert report["failed"] == []
    assert report["warnings"] == []


def test_run_preflight_fails_when_3b_adamw_does_not_fit_a_4090(tmp_path):
    report = preflight.run_preflight(
        "3b", store_root=tmp_path, optimizer="adamw", seq_len=8192, grad_checkpointing=False,
        platform=_platform("cuda"),
    )
    assert report["ok"] is False
    assert "memoryBudget" in report["failed"]
    row = next(c for c in report["checks"] if c["name"] == "memoryBudget")
    assert row["residentBytes"] > row["usableBytes"]


def test_shared_memory_is_not_treated_as_dedicated_vram(tmp_path):
    # The APU mistake the portability module warns about: the same 24 GB that
    # fits on a discrete card must not be credited to a shared carve-out.
    dedicated = preflight.run_preflight(
        "3b", store_root=tmp_path, optimizer="adafactor", seq_len=2048,
        grad_checkpointing=True, platform=_platform("cuda", totalMemoryBytes=25_000_000_000),
    )
    shared = preflight.run_preflight(
        "3b", store_root=tmp_path, optimizer="adafactor", seq_len=2048,
        grad_checkpointing=True,
        platform=_platform("rocm", totalMemoryBytes=25_000_000_000, memorySharedWithHost=True),
    )
    ded = next(c for c in dedicated["checks"] if c["name"] == "memoryBudget")
    shr = next(c for c in shared["checks"] if c["name"] == "memoryBudget")
    assert shr["usableBytes"] < ded["usableBytes"]
    assert shr["usableBytes"] == 12_500_000_000


def test_8bit_optimizer_is_rejected_on_rocm(tmp_path):
    report = preflight.run_preflight(
        "small", store_root=tmp_path, optimizer="adamw8bit", platform=_platform("rocm"),
    )
    assert "optimizerAvailability" in report["failed"]
    row = next(c for c in report["checks"] if c["name"] == "optimizerAvailability")
    assert "CUDA-only" in row["detail"]


def test_cpu_reports_no_memory_verdict_and_accepts_bf16(tmp_path):
    report = preflight.run_preflight(
        "small", store_root=tmp_path,
        platform=_platform("cpu", deviceName=None, totalMemoryBytes=None, memorySharedWithHost=None),
    )
    bf16 = next(c for c in report["checks"] if c["name"] == "bf16")
    mem = next(c for c in report["checks"] if c["name"] == "memoryBudget")
    assert bf16["ok"] is True  # CPU runs in fp32; emulated bf16 is expected
    assert mem["ok"] is None  # no device memory to judge against
    assert "memoryBudget" in report["warnings"]
    assert report["ok"] is True


def test_emulated_bf16_fails_on_an_accelerator(tmp_path):
    # A ROCm device that runs bf16 at 0.4x fp32 is a software fallback; that must
    # fail the check even though the matmul "supported" it.
    report = preflight.run_preflight("small", store_root=tmp_path, platform=_platform("rocm"))
    assert "bf16" in report["failed"]


def test_counts_only_skips_the_bf16_probe_without_failing(tmp_path):
    # On an accelerator the honest answer is "undecided", not a pass or a fail.
    report = preflight.run_preflight(
        "small", store_root=tmp_path, include_bf16_probe=False, platform=_platform("cuda", bf16=None),
    )
    row = next(c for c in report["checks"] if c["name"] == "bf16")
    assert row["ok"] is None
    assert row["speedup"] is None
    assert "bf16" not in report["failed"]


# ------------------------------------------------------------------- resume parity


def _write_resume_state(root: Path, version: str, environment):
    version_dir = store.version_path(root, version)
    version_dir.mkdir(parents=True, exist_ok=True)
    store.write_json(version_dir / "train-state.json", {"stepsCompleted": 1, "environment": environment})


def test_resume_parity_passes_for_same_backend(tmp_path):
    _write_resume_state(tmp_path, "v001", {"backend": "cuda"})
    report = preflight.run_preflight(
        "small", store_root=tmp_path, resume_from="v001", platform=_platform("cuda"),
    )
    row = next(c for c in report["checks"] if c["name"] == "resumeParity")
    assert row["ok"] is True
    assert row["recordedBackend"] == "cuda"


def test_resume_parity_fails_closed_for_cross_vendor(tmp_path):
    _write_resume_state(tmp_path, "v001", {"backend": "cuda"})
    report = preflight.run_preflight(
        "small", store_root=tmp_path, resume_from="v001", platform=_platform("rocm"),
    )
    row = next(c for c in report["checks"] if c["name"] == "resumeParity")
    assert row["ok"] is False
    assert "resumeParity" in report["failed"]


def test_resume_parity_override_allows_cross_vendor(tmp_path):
    _write_resume_state(tmp_path, "v001", {"backend": "cuda"})
    report = preflight.run_preflight(
        "small", store_root=tmp_path, resume_from="v001", platform=_platform("rocm"),
        allow_cross_vendor=True,
    )
    row = next(c for c in report["checks"] if c["name"] == "resumeParity")
    assert row["ok"] is True
    assert row["allowCrossVendor"] is True


def test_resume_parity_fails_closed_for_legacy_record(tmp_path):
    # The v002 record predates the backend field. It cannot be *shown* to match,
    # so the conservative reading is that it does not.
    _write_resume_state(tmp_path, "v001", {"cudaAvailable": True, "device": "cuda"})
    report = preflight.run_preflight(
        "small", store_root=tmp_path, resume_from="v001", platform=_platform("cuda"),
    )
    row = next(c for c in report["checks"] if c["name"] == "resumeParity")
    assert row["ok"] is False
    assert row["recordedBackend"] is None


# ------------------------------------------------------------------- run lock


def test_run_lock_check_fails_when_a_live_run_owns_the_target(tmp_path):
    with store.run_lock(tmp_path, "v001"):
        report = preflight.run_preflight("small", store_root=tmp_path, platform=_platform("cuda"))
    row = next(c for c in report["checks"] if c["name"] == "runLock")
    assert row["ok"] is False
    assert row["version"] == "v001"
    assert "runLock" in report["failed"]


# ------------------------------------------------------------------------- CLI


def _run_cli(*args: str, out: Path):
    proc = subprocess.run(
        [sys.executable, "-m", "sma.brain", *args, "--out", str(out)],
        cwd=REPO_ROOT / "python",
        capture_output=True,
        text=True,
    )
    payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    return proc.returncode, payload


def test_cli_preflight_emits_one_json_object_and_exits_zero(tmp_path):
    code, payload = _run_cli("preflight", "--config", "small", "--counts-only", out=tmp_path)
    assert payload["verb"] == "preflight"
    assert payload["ok"] is True
    assert code == 0
    assert [c["name"] for c in payload["checks"]] == NINE_CHECKS


def test_cli_preflight_exits_nonzero_when_a_check_fails(tmp_path):
    # Force a failure deterministically on any hardware: a resume whose record
    # never named its backend cannot be shown to match, so it fails closed.
    _write_resume_state(tmp_path, "v001", {"device": "cuda"})
    code, payload = _run_cli(
        "preflight", "--config", "small", "--resume-from", "v001", "--counts-only", out=tmp_path,
    )
    assert payload["ok"] is False
    assert "resumeParity" in payload["failed"]
    assert code != 0
