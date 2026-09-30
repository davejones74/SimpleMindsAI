"""Vendor-neutral backend identity, platform reporting, and run-lock tests.

These lock in the behaviour that makes a run's provenance trustworthy across the
two vendors in scope (CUDA on the RTX 4090 dev box, ROCm on the AMD deploy
host), plus the exclusive run lock that the cross-vendor resume preflight
consults.
"""

from __future__ import annotations

import time

import pytest
import torch

from sma import portability, store, train as train_mod


# --------------------------------------------------------------- backend ID


def test_backend_values_are_lowercase():
    assert set(portability.BACKENDS) == {"cuda", "rocm", "cpu"}


def test_build_backend_matches_installed_torch():
    # Whatever the host is, build_backend must describe the *wheel*, and must
    # agree with torch.version (not with attribute presence on device props).
    build = portability.build_backend()
    if getattr(torch.version, "hip", None):
        assert build == "rocm"
    elif getattr(torch.version, "cuda", None):
        assert build == "cuda"
    else:
        assert build == "cpu"


def test_backend_of_runtime_is_never_accelerated_when_no_device(monkeypatch):
    # The critical correctness property: a CUDA/ROCm build with no visible GPU
    # (e.g. CI) must report "cpu", not a fake accelerator. Provenance that
    # claims a GPU run that did not happen is worse than no provenance.
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(portability, "build_backend", lambda: "rocm")
    assert portability.backend_of_runtime() == "cpu"
    monkeypatch.setattr(portability, "build_backend", lambda: "cuda")
    assert portability.backend_of_runtime() == "cpu"


def test_backend_of_runtime_uses_hip_for_rocm(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(portability, "build_backend", lambda: "rocm")
    assert portability.backend_of_runtime() == "rocm"


def test_backend_version_reports_hip_for_rocm(monkeypatch):
    monkeypatch.setattr(portability, "build_backend", lambda: "rocm")
    monkeypatch.setattr(torch.version, "hip", "7.14.0", raising=False)
    assert portability.backend_version() == "7.14.0"


# ------------------------------------------------------------- environment


def test_runtime_environment_is_vendor_neutral():
    env = portability.runtime_environment()
    # Must not carry the old CUDA-only field.
    assert "cudaAvailable" not in env
    for key in ("backend", "backendVersion", "torch", "transformers", "python", "device"):
        assert key in env
    assert env["backend"] in portability.BACKENDS


def test_train_environment_records_backend():
    env = train_mod.environment()
    assert env["backend"] in portability.BACKENDS
    assert "cudaAvailable" not in env
    # environment() is a thin wrapper over the portable provenance.
    assert env["backend"] == portability.runtime_environment()["backend"]


def test_rocm_environment_device_is_cuda_but_backend_is_rocm(monkeypatch):
    # The asymmetry that motivates recording both fields: under ROCm the torch
    # device type is literally "cuda" while the vendor is "rocm".
    monkeypatch.setattr(portability, "backend_of_runtime", lambda: "rocm")
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    env = portability.runtime_environment()
    assert env["backend"] == "rocm"
    assert env["device"] == "cuda"


# ------------------------------------------------------------ backend_resume


def test_backend_of_resume_reads_recorded_backend():
    assert portability.backend_of_resume({"backend": "cuda"}) == "cuda"
    assert portability.backend_of_resume({"backend": "rocm"}) == "rocm"


def test_backend_of_resume_returns_none_for_legacy_records():
    # The v002 train-state predates the backend field. None => cross-vendor =>
    # override-required (fail closed), never silently "same vendor".
    assert portability.backend_of_resume({}) is None
    assert portability.backend_of_resume({"cudaAvailable": True, "device": "cuda"}) is None
    assert portability.backend_of_resume({"backend": "mystery-gpu"}) is None
    assert portability.backend_of_resume(None) is None


# ------------------------------------------------------------------ report


def test_platform_report_shape():
    report = portability.platform_report()
    for key in (
        "backend",
        "buildBackend",
        "backendVersion",
        "deviceName",
        "archString",
        "totalMemoryBytes",
        "memorySharedWithHost",
        "bf16",
    ):
        assert key in report
    assert report["backend"] in portability.BACKENDS


def test_platform_report_arch_is_not_device_name_on_cuda():
    # Regression guard for a real trap: on a *CUDA* build, device props expose
    # `gcnArchName`, but it returns the device NAME ("NVIDIA GeForce RTX 4090"),
    # not an arch. So the arch string must not be derived from gcnArchName on
    # CUDA, or provenance would claim a bogus arch. On CUDA it must be the
    # compute capability "major.minor".
    if not torch.cuda.is_available() or portability.build_backend() != "cuda":
        pytest.skip("CUDA runtime required")
    report = portability.platform_report()
    assert report["archString"] != report["deviceName"]
    assert report["archString"].count(".") == 1  # e.g. "8.9"


def test_rocm_reports_shared_memory_and_gfx_arch(monkeypatch):
    # Simulate a ROCm APU by faking is_available + props, to prove the report
    # labels shared memory and reads gfx from gcnArchName on ROCm only.
    class _Props:
        name = "AMD Ryzen AI Max+ 395 Radeon 8060S"
        major = 0
        minor = 0
        total_memory = 3221225472
        gcnArchName = "gfx1151"

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(portability, "build_backend", lambda: "rocm")
    monkeypatch.setattr(torch.version, "hip", "7.14.0", raising=False)
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda idx: _Props())
    report = portability.platform_report()
    assert report["backend"] == "rocm"
    assert report["archString"] == "gfx1151"
    assert report["memorySharedWithHost"] is True
    assert report["totalMemoryBytes"] == 3221225472


def test_cuda_reports_dedicated_memory(monkeypatch):
    if not torch.cuda.is_available():
        pytest.skip("GPU required")

    class _Props:
        name = "NVIDIA GeForce RTX 4090"
        major = 8
        minor = 9
        total_memory = 25756696576
        gcnArchName = "NVIDIA GeForce RTX 4090"  # the trap

    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda idx: _Props())
    report = portability.platform_report()
    assert report["memorySharedWithHost"] is False
    assert report["archString"] == "8.9"


# -------------------------------------------------------------------- bf16


def test_bf16_probe_runs_and_reports_evidence():
    probe = portability.bf16_probe()
    assert probe["device"] in ("cuda", "cpu")
    assert "error" not in probe
    if torch.cuda.is_available():
        # A real bf16 matmul must run and produce finite values on any of our
        # supported backends; and it must be timed against fp32 so the
        # preflight can judge native vs emulated.
        assert probe["supported"] is True
        assert probe["speedup"] is not None
        assert probe["speedup"] > 0


# --------------------------------------------------------------- run lock


def test_run_lock_inactive_when_absent(tmp_path):
    assert store.run_lock_active(tmp_path, "v001") is False


def test_run_lock_active_inside_context_and_released_after(tmp_path):
    with store.run_lock(tmp_path, "v001") as path:
        assert path.exists()
        assert store.run_lock_active(tmp_path, "v001") is True
    assert not store.run_lock_path(tmp_path, "v001").exists()
    assert store.run_lock_active(tmp_path, "v001") is False


def test_run_lock_blocks_second_live_holder(tmp_path):
    with store.run_lock(tmp_path, "v001"):
        with pytest.raises(RuntimeError):
            with store.run_lock(tmp_path, "v001"):
                pass


def test_run_lock_released_on_exception(tmp_path):
    with pytest.raises(ValueError):
        with store.run_lock(tmp_path, "v001"):
            raise ValueError("boom")
    # A failed run must not wedge the version.
    assert store.run_lock_active(tmp_path, "v001") is False


def test_run_lock_takes_over_stale_lock(tmp_path):
    # Simulate a killed process: create a lock, then backdate its mtime past the
    # stale window. It must be treated as inactive and retaken, not block forever.
    stale_path = store.run_lock_path(tmp_path, "v001")
    stale_path.parent.mkdir(parents=True, exist_ok=True)
    stale_path.write_text("{}", encoding="utf-8")
    old = time.time() - store.RUN_LOCK_STALE_S - 60
    import os

    os.utime(stale_path, (old, old))
    assert store.run_lock_active(tmp_path, "v001") is False
    with store.run_lock(tmp_path, "v001") as path:
        assert path.exists()
    assert store.run_lock_active(tmp_path, "v001") is False
