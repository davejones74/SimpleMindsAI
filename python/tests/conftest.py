"""Shared fixtures. Tests build real models — there are no mocks in this suite,
because the thing under test is precisely whether real initialisation behaves
as claimed."""

from __future__ import annotations

import socket
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sma import configs  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_CORPUS = Path(__file__).resolve().parents[1] / "sma" / "fixtures" / "tiny_en.txt"


@contextmanager
def no_network():
    """Make any outbound socket connection raise.

    This is how `test_init_needs_no_network` proves that building a model from
    a config performs no download. If construction secretly fetched weights,
    this would raise rather than quietly succeed on a machine that happens to
    be online — which is the failure mode an offline-mode env var alone would
    not catch.
    """
    real_socket = socket.socket
    real_create = socket.create_connection

    def blocked(*args, **kwargs):
        raise AssertionError("network access attempted during a proof test")

    socket.socket = blocked
    socket.create_connection = blocked
    try:
        yield
    finally:
        socket.socket = real_socket
        socket.create_connection = real_create


@pytest.fixture(scope="session")
def small_model():
    from sma import arch

    model, config, sizes = arch.build_model("small", seed=0)
    return model, config, sizes


@pytest.fixture
def tmp_root(tmp_path):
    return tmp_path / "models"


@pytest.fixture(scope="session")
def official_config():
    return dict(configs.SMOLLM3_3B_OFFICIAL)


@pytest.fixture(scope="session")
def tiny_corpus():
    return FIXTURE_CORPUS.read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def tokenizer(tmp_path_factory):
    """The SmolLM3 tokenizer — the one accepted pretrained artifact.

    Reuses an existing v001 checkpoint if one is present, otherwise fetches
    config+tokenizer only. Never fetches weights, so this fixture is itself
    consistent with the no-pretrained-weights rule.
    """
    from sma import proof
    from transformers import AutoTokenizer

    existing = REPO_ROOT / "python" / "scratch" / "models" / "v001"
    if (existing / "tokenizer.json").exists():
        return AutoTokenizer.from_pretrained(str(existing))
    cache = tmp_path_factory.mktemp("reference")
    info = proof.fetch_config_and_tokenizer(configs.ARCH_REFERENCE_REPO, cache)
    return AutoTokenizer.from_pretrained(info["localDir"])
