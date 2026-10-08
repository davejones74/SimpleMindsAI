"""The long-lived student worker's framed stdio protocol.

These are the guarantees the chat path depends on: one JSON response per request,
in order, with `id` echoed; a bad request is an error response rather than a
crash; and generation only happens after a committed version is loaded. The
worker runs as a real subprocess over pipes, exactly as Node drives it, against
the real read-only store — no mock stands in for the thing under test.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from conftest import REPO_ROOT
from sma import store

STORE = store.store_root()
V001 = STORE / "v001"

needs_store = pytest.mark.skipif(
    not (V001.is_dir() and (V001 / "init-manifest.json").is_file()),
    reason=f"committed v001 store required at {STORE}",
)


class Worker:
    """Minimal framed client: write one JSON line, read one JSON line."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "sma.student", "--out", str(STORE), "--device", "cpu"],
            cwd=REPO_ROOT / "python",
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self._id = 0

    def request(self, op: str, **payload):
        self._id += 1
        self.proc.stdin.write(json.dumps({"id": self._id, "op": op, **payload}) + "\n")
        self.proc.stdin.flush()
        return self._read_until(self._id)

    def raw(self, line: str):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()
        return self._read_json()

    def _read_json(self):
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError("worker closed stdout")
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue  # progress-bar / loader noise, never a response

    def _read_until(self, request_id):
        while True:
            message = self._read_json()
            if message.get("id") == request_id:
                return message

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@pytest.fixture
def worker():
    w = Worker()
    try:
        yield w
    finally:
        w.close()


@needs_store
def test_ping_reports_protocol(worker):
    reply = worker.request("ping")
    assert reply["ok"] is True
    assert reply["pong"] is True
    assert reply["protocol"] == 1


@needs_store
def test_load_then_generate_returns_text(worker):
    loaded = worker.request("load", version="v001")
    assert loaded["ok"] is True, loaded
    assert loaded["version"] == "v001"
    assert loaded["parameters"] == 61_839_744

    gen = worker.request("generate", prompt="Hello", maxNewTokens=4)
    assert gen["ok"] is True, gen
    assert gen["version"] == "v001"
    assert isinstance(gen["text"], str)
    assert gen["generatedTokens"] == 4

    current = worker.request("version")
    assert current["loaded"] is True
    assert current["version"] == "v001"


@needs_store
def test_generate_before_load_is_an_error(worker):
    reply = worker.request("generate", prompt="Hello", maxNewTokens=2)
    assert reply["ok"] is False
    assert "no version loaded" in reply["error"]
    # The worker must still be alive and usable.
    assert worker.request("ping")["ok"] is True


@needs_store
def test_unknown_op_is_an_error_and_worker_survives(worker):
    reply = worker.request("nonsense")
    assert reply["ok"] is False
    assert "unknown op" in reply["error"]
    assert worker.request("ping")["ok"] is True


@needs_store
def test_malformed_line_is_an_error_and_worker_survives(worker):
    reply = worker.raw("{not json")
    assert reply["ok"] is False
    assert reply["id"] is None
    assert worker.request("ping")["ok"] is True


@needs_store
def test_shutdown_exits_cleanly(worker):
    reply = worker.request("shutdown")
    assert reply["ok"] is True
    assert reply["shutdown"] is True
    assert worker.proc.wait(timeout=10) == 0
