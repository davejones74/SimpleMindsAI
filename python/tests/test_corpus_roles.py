"""Role-aware packing: replay and appended validation accounting.

These tests use a deterministic fake tokenizer so they exercise the packing and
accounting rules without downloading the reference tokenizer or building a model.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch

from conftest import FIXTURE_CORPUS
from sma import data as data_mod


class FakeTokenizer:
    """One token per whitespace-separated integer; separators tokenize to zero."""

    def __call__(self, text, add_special_tokens=False):
        return SimpleNamespace(input_ids=[int(part) for part in text.split()])


def doc(article_id: str, token: int, count: int, role: str = "train"):
    text = " ".join([str(token)] * count)
    return {
        "articleId": article_id,
        "text": text,
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
        "corpusRole": role,
    }


def test_pack_records_tokens_and_documents_by_corpus_role():
    tokenizer = FakeTokenizer()
    docs = [
        doc("fresh-a", 1, 10),
        doc("fresh-b", 1, 5),
        doc("replay-a", 2, 7, "replay"),
        doc("val-a", 3, 20, "validation"),
    ]
    _blocks, record = data_mod.pack(tokenizer, docs, 16, FIXTURE_CORPUS)
    assert record.roleTokenCounts == {"train": 15, "replay": 7, "validation": 20}
    assert record.roleDocumentCounts == {"train": 2, "replay": 1, "validation": 1}
    assert record.trainBlockCount == record.blockCount
    assert record.validationBlockCount == 0


def test_appended_validation_is_packed_separately_and_does_not_reduce_training_blocks():
    tokenizer = FakeTokenizer()
    docs = [
        doc("fresh-a", 1, 10),
        doc("fresh-b", 1, 10),
        doc("replay-a", 2, 12, "replay"),
        doc("val-a", 3, 40, "validation"),
        doc("val-b", 3, 40, "validation"),
    ]
    train_blocks, val_blocks, record, split = data_mod.pack_for_training(
        tokenizer, docs, 16, FIXTURE_CORPUS, validation_blocks=3
    )

    # 32 training tokens => two whole 16-token blocks; validation is three of
    # its five blocks. Training size is independent of the validation request.
    assert train_blocks.shape[0] == 2
    assert val_blocks.shape[0] == 3
    assert torch.equal(torch.unique(train_blocks), torch.tensor([1, 2]))
    assert torch.equal(torch.unique(val_blocks), torch.tensor([3]))
    assert record.trainBlockCount == 2
    assert record.validationBlockCount == 3
    assert record.blockCount == 5
    assert record.roleTokenCounts == {"train": 20, "replay": 12, "validation": 80}
    assert split["mode"] == "role-appended"
    assert split["trainTokensSeen"] == 32
    assert split["shortfall"] == 0
    assert len(record.datasetHash) == 64


def test_without_validation_roles_the_historical_tail_split_is_preserved():
    tokenizer = FakeTokenizer()
    docs = [doc("fresh", 1, 80)]
    train_blocks, val_blocks, record, split = data_mod.pack_for_training(
        tokenizer, docs, 16, FIXTURE_CORPUS, validation_blocks=2
    )
    assert split["mode"] == "tail-split"
    assert train_blocks.shape[0] == 3
    assert val_blocks.shape[0] == 2
    assert record.trainBlockCount == 3
    assert record.validationBlockCount == 2
    assert record.blockCount == 5


def test_validation_shortfall_is_reported_not_hidden():
    tokenizer = FakeTokenizer()
    docs = [
        doc("fresh", 1, 20),
        doc("val-tiny", 3, 4, "validation"),
    ]
    train_blocks, val_blocks, _record, split = data_mod.pack_for_training(
        tokenizer, docs, 16, FIXTURE_CORPUS, validation_blocks=32
    )
    assert split["mode"] == "role-appended-empty"
    assert split["actualValidationBlocks"] == 0
    assert split["shortfall"] == 32
    assert train_blocks.shape[0] == 1
    # A validation role must never fall back into the training stream.
    assert torch.equal(torch.unique(train_blocks), torch.tensor([1]))


def test_partial_validation_shortfall_uses_available_blocks():
    tokenizer = FakeTokenizer()
    docs = [
        doc("fresh", 1, 20),
        doc("val-a", 3, 40, "validation"),
    ]
    train_blocks, val_blocks, _record, split = data_mod.pack_for_training(
        tokenizer, docs, 16, FIXTURE_CORPUS, validation_blocks=3
    )
    assert split["mode"] == "role-appended"
    assert split["actualValidationBlocks"] == 2
    assert split["shortfall"] == 1
    assert val_blocks.shape[0] == 2
    # The available validation blocks are still used, not repurposed as training.
    assert torch.equal(torch.unique(val_blocks), torch.tensor([3]))
    assert torch.equal(torch.unique(train_blocks), torch.tensor([1]))


class EosFakeTokenizer(FakeTokenizer):
    eos_token_id = 99
    eos_token = "<eos>"


def test_eos_document_boundary_inserts_eos_after_every_document():
    tokenizer = EosFakeTokenizer()
    docs = [doc("a", 1, 7), doc("b", 2, 7)]
    blocks, record = data_mod.pack(
        tokenizer, docs, 16, FIXTURE_CORPUS, document_boundary="eos"
    )
    assert blocks.tolist() == [[1] * 7 + [99] + [2] * 7 + [99]]
    assert record.strategy == data_mod.PACKING_STRATEGY_EOS
    assert record.documentBoundary == "eos"
    assert record.eosTokenId == 99
    assert record.roleTokenCounts == {"train": 14}
    assert record.droppedTokens == 0


def test_eos_document_boundary_applies_to_the_final_document():
    tokenizer = EosFakeTokenizer()
    docs = [doc("only", 4, 15)]
    blocks, record = data_mod.pack(
        tokenizer, docs, 16, FIXTURE_CORPUS, document_boundary="eos"
    )
    assert blocks.tolist() == [[4] * 15 + [99]]
    assert record.eosTokenId == 99


def test_eos_document_boundary_requires_a_valid_eos_token():
    tokenizer = FakeTokenizer()
    with pytest.raises(ValueError, match="no valid eos_token_id"):
        data_mod.pack(
            tokenizer, [doc("a", 1, 5)], 8, FIXTURE_CORPUS, document_boundary="eos"
        )


def test_document_policy_fails_closed_without_validation_documents():
    tokenizer = FakeTokenizer()
    docs = [doc("fresh", 1, 80)]
    with pytest.raises(data_mod.InsufficientValidationError) as exc:
        data_mod.pack_for_training(
            tokenizer,
            docs,
            16,
            FIXTURE_CORPUS,
            validation_blocks=2,
            validation_policy="document-source-disjoint",
        )
    assert "no validation documents" in str(exc.value)


def test_document_policy_fails_closed_when_validation_is_too_small():
    tokenizer = FakeTokenizer()
    docs = [doc("fresh", 1, 80), doc("val-tiny", 3, 4, "validation")]
    with pytest.raises(data_mod.InsufficientValidationError) as exc:
        data_mod.pack_for_training(
            tokenizer,
            docs,
            16,
            FIXTURE_CORPUS,
            validation_blocks=2,
            validation_policy="document-source-disjoint",
        )
    assert "refusing to fall back" in str(exc.value)


def test_document_policy_packs_train_and_validation_separately_and_records_split_hash():
    tokenizer = FakeTokenizer()
    docs = [doc("fresh-a", 1, 40), doc("fresh-b", 2, 40), doc("val-a", 3, 80, "validation")]
    train_blocks, val_blocks, record, split = data_mod.pack_for_training(
        tokenizer,
        docs,
        16,
        FIXTURE_CORPUS,
        validation_blocks=5,
        validation_policy="document-source-disjoint",
    )
    assert split["mode"] == "role-appended"
    assert split["validationPolicy"] == "document-source-disjoint"
    assert split["splitHash"] and len(split["splitHash"]) == 64
    assert train_blocks.shape[0] == 5
    assert val_blocks.shape[0] == 5
    assert torch.equal(torch.unique(train_blocks), torch.tensor([1, 2]))
    assert torch.equal(torch.unique(val_blocks), torch.tensor([3]))
    # Deterministic from the same corpus and policy.
    _tb, _vb, _rec, again = data_mod.pack_for_training(
        tokenizer,
        docs,
        16,
        FIXTURE_CORPUS,
        validation_blocks=5,
        validation_policy="document-source-disjoint",
    )
    assert again["splitHash"] == split["splitHash"]
