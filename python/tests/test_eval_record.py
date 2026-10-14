"""The provenance that `sma brain eval` emits for a loss measurement.

The Node promotion gate builds a metric signature from this payload and persists
it as a durable evaluation record; before this work the Python path produced NO
records at all, so a promotion could not be reconstructed from the ledger. These
tests pin the payload the eval verb returns (`_pack_paths` -> `PackRecord` ->
the `evaluationSet` dict in `cmd_eval`): every field a record needs must be
present, stable across runs, and addressable (article ids + content hashes), so a
future replay is reconstructible rather than merely repeatable.
"""

from __future__ import annotations

import json

from conftest import FIXTURE_CORPUS
from sma import brain, data as data_mod

REQUIRED_FIELDS = (
    "strategy",
    "datasetHash",
    "tokenizerHash",
    "sequenceLength",
    "documentCount",
    "blockCount",
    "tokensSeen",
    "articles",
)


def _eval_payload(record):
    """Mirror the `evaluationSet` dict built in `brain.cmd_eval`."""
    return {
        "strategy": record.strategy,
        "datasetHash": record.datasetHash,
        "tokenizerHash": record.tokenizerHash,
        "sequenceLength": record.sequenceLength,
        "documentCount": record.documentCount,
        "blockCount": record.blockCount,
        "tokensSeen": record.tokensSeen,
        "articles": record.articles,
    }


def test_eval_provenance_payload_is_complete_and_hashed(tokenizer):
    _blocks, record = brain._pack_paths(tokenizer, [FIXTURE_CORPUS], 64, FIXTURE_CORPUS)
    payload = _eval_payload(record)

    for field in REQUIRED_FIELDS:
        assert field in payload, f"the eval record must carry {field}"

    assert payload["strategy"] == data_mod.PACKING_STRATEGY
    assert payload["sequenceLength"] == 64
    assert payload["documentCount"] >= 1
    assert payload["blockCount"] >= 1
    assert payload["tokensSeen"] > 0

    # The two hashes a metric signature depends on must be real digests.
    assert len(payload["datasetHash"]) == 64
    assert len(payload["tokenizerHash"]) == 64

    # Every consumed article is addressable by id AND content hash, which is what
    # makes a replay reconstructible from the record alone.
    assert payload["articles"]
    for article in payload["articles"]:
        assert article["articleId"]
        assert len(article["contentHash"]) == 64


def test_eval_provenance_is_deterministic(tokenizer):
    _b1, first = brain._pack_paths(tokenizer, [FIXTURE_CORPUS], 64, FIXTURE_CORPUS)
    _b2, second = brain._pack_paths(tokenizer, [FIXTURE_CORPUS], 64, FIXTURE_CORPUS)

    a, b = _eval_payload(first), _eval_payload(second)
    assert a == b, "scoring the same frozen set twice must yield the same record"


def test_dataset_hash_changes_when_the_frozen_set_changes(tokenizer, tmp_path):
    docs = data_mod.load_documents([FIXTURE_CORPUS])
    _b1, before = brain._pack_paths(tokenizer, [FIXTURE_CORPUS], 64, FIXTURE_CORPUS)

    mutated = tmp_path / "eval-mutated.jsonl"
    mutated.write_text(
        "\n".join(
            json.dumps({"articleId": f"x{i}", "text": d["text"] + " extra"})
            for i, d in enumerate(docs[:3])
        )
        + "\n",
        encoding="utf-8",
    )
    _b2, after = brain._pack_paths(tokenizer, [mutated], 64, FIXTURE_CORPUS)

    # Different corpus => different dataset hash, so a cross-set comparison would
    # be caught rather than silently taken as an improvement.
    assert before.datasetHash != after.datasetHash
