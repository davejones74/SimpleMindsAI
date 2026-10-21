"""Corpus ingestion: tokenization and packing.

Packing is `concatenate-and-chunk`, chosen so that the recorded state is enough
to rebuild the exact token stream later (a replay prerequisite):

    tokenize every document -> concatenate with a separator -> chunk into
    fixed-length blocks -> each block is one training example, labels shifted
    by the model

No padding, no attention masking, no document boundary bookkeeping inside a
block. That is a deliberate trade: it maximises token efficiency and makes the
stream trivially reconstructible, at the cost of letting a block straddle a
document boundary. The alternative (per-document with EOS separators and
masking) changes what the loss number means, so it is not mixed in silently.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Sequence

import torch

# Recorded in train state. A different value is a different corpus.
PACKING_STRATEGY = "concatenate-chunk-v1"
SEPARATOR_TOKEN = "\n\n"


class InsufficientCorpusError(ValueError):
    """The corpus cannot form even one fixed-length block.

    This is an *operator* condition (too little reviewed material for the chosen
    `--seq-len`), not a training fault. Callers distinguish it from a numerical
    failure so a continuous job can wait for more material instead of crashing.
    """


@dataclass(frozen=True)
class PackRecord:
    """Everything needed to rebuild this exact token stream."""

    strategy: str
    sequenceLength: int
    separator: str
    documentCount: int
    blockCount: int
    tokensSeen: int
    droppedTokens: int
    articles: List[Dict[str, Any]]
    datasetHash: str
    tokenizerHash: str
    # Role accounting, recorded per pack so a run can prove how much of the
    # corpus was fresh, replay or held-out validation. `tokensSeen` is the sum
    # over documents and excludes separators; role counts are the same unit.
    roleTokenCounts: Dict[str, int] = field(default_factory=dict)
    roleDocumentCounts: Dict[str, int] = field(default_factory=dict)
    trainBlockCount: int = 0
    validationBlockCount: int = 0

    def to_json(self) -> Dict[str, Any]:
        return asdict(self)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_documents(paths: Sequence[Path]) -> List[Dict[str, str]]:
    """Read fixture corpora. Plain text, or JSONL with a text field.

    Content hashes are computed here, at ingestion, because a hash computed
    later is a hash of whatever happened to still be on disk.
    """
    docs: List[Dict[str, str]] = []
    for path in paths:
        path = Path(path)
        raw = path.read_text(encoding="utf-8")
        if path.suffix == ".jsonl":
            items = []
            for line in raw.splitlines():
                line = line.strip()
                if line:
                    items.append(json.loads(line))
        else:
            items = [{"text": raw}]
        for index, item in enumerate(items):
            text = item.get("text") or item.get("completion") or ""
            if not text.strip():
                continue
            role = item.get("corpusRole") or "train"
            if role not in ("train", "replay", "validation"):
                raise ValueError(f"unknown corpusRole {role!r} for {path.name}#{index}")
            docs.append(
                {
                    "articleId": item.get("articleId") or f"{path.name}#{index}",
                    "text": text,
                    "contentHash": _sha256_text(text),
                    "corpusRole": role,
                }
            )
    return docs


def pack(
    tokenizer: Any,
    documents: Sequence[Dict[str, str]],
    sequence_length: int,
    tokenizer_path: Path,
) -> tuple[torch.Tensor, PackRecord]:
    """Tokenize, concatenate, chunk. Returns blocks and its reconstruction record.

    Each document's `contentHash` is verified against its own text. The hash is
    what the per-version contribution record is built from, so a stale or
    fabricated hash would make the provenance quietly false — and the failure
    would surface months later, during a replay, when it is expensive to
    diagnose. A missing hash is computed; a *wrong* one is refused.
    """
    if sequence_length <= 0:
        raise ValueError("sequence_length must be positive")

    for doc in documents:
        actual = _sha256_text(doc["text"])
        claimed = doc.get("contentHash")
        if claimed is None:
            doc["contentHash"] = actual
        elif claimed != actual:
            raise ValueError(
                f"contentHash mismatch for article {doc.get('articleId')!r}: "
                f"claimed {claimed[:16]}..., actual {actual[:16]}..."
            )

    pieces: List[List[int]] = []
    seen = 0
    role_tokens: Dict[str, int] = {}
    role_docs: Dict[str, int] = {}
    for doc in documents:
        ids = tokenizer(doc["text"], add_special_tokens=False).input_ids
        if ids:
            role = doc.get("corpusRole") or "train"
            pieces.append(ids)
            seen += len(ids)
            role_tokens[role] = role_tokens.get(role, 0) + len(ids)
            role_docs[role] = role_docs.get(role, 0) + 1
    if not pieces:
        raise ValueError("no tokens produced from the supplied documents")

    sep_ids = tokenizer(SEPARATOR_TOKEN, add_special_tokens=False).input_ids
    stream: List[int] = []
    for index, ids in enumerate(pieces):
        if index:
            stream.extend(sep_ids)
        stream.extend(ids)

    total = len(stream)
    usable = (total // sequence_length) * sequence_length
    blocks = torch.tensor(
        [stream[i : i + sequence_length] for i in range(0, usable, sequence_length)],
        dtype=torch.long,
    )
    if blocks.numel() == 0:
        raise InsufficientCorpusError(
            f"corpus has {total} tokens, fewer than one {sequence_length}-token block; "
            "lower --seq-len or supply more text"
        )

    record = PackRecord(
        strategy=PACKING_STRATEGY,
        sequenceLength=sequence_length,
        separator=SEPARATOR_TOKEN,
        documentCount=len(documents),
        blockCount=int(blocks.shape[0]),
        tokensSeen=seen,
        droppedTokens=total - usable,
        articles=[
            {"articleId": d["articleId"], "contentHash": d["contentHash"]}
            for d in documents
        ],
        datasetHash=hashlib.sha256(
            ",".join(d["contentHash"] for d in documents).encode("utf-8")
        ).hexdigest(),
        tokenizerHash=_sha256_file(Path(tokenizer_path)),
        roleTokenCounts=role_tokens,
        roleDocumentCounts=role_docs,
        trainBlockCount=int(blocks.shape[0]),
        validationBlockCount=0,
    )
    return blocks, record


def split_documents_by_role(
    documents: Sequence[Dict[str, str]]
) -> tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """Partition snapshot rows into training and held-out validation documents.

    The role is carried on the snapshot row, so a held-out block can be appended
    after the training prefix without the packer ever mixing the two streams.
    Rows without a role keep the historical behaviour: training data.
    """
    train: List[Dict[str, str]] = []
    validation: List[Dict[str, str]] = []
    for doc in documents:
        if (doc.get("corpusRole") or "train") == "validation":
            validation.append(doc)
        else:
            train.append(doc)
    return train, validation


def _merge_pack_records(
    train_record: PackRecord,
    validation_record: PackRecord | None,
    validation_blocks: int,
    *,
    documents: Sequence[Dict[str, str]],
) -> tuple[PackRecord, int, int]:
    """Combine train/validation packs into one provenance record.

    Block counts describe *used* blocks: the validation stream is truncated to
    `validation_blocks` whole blocks, while its documents remain in the dataset
    hash because they are part of the immutable snapshot artifact.
    """
    val_used = 0 if validation_record is None else min(
        validation_record.blockCount, max(0, int(validation_blocks))
    )
    role_tokens: Dict[str, int] = dict(train_record.roleTokenCounts)
    role_docs: Dict[str, int] = dict(train_record.roleDocumentCounts)
    if validation_record is not None:
        for role, count in validation_record.roleTokenCounts.items():
            role_tokens[role] = role_tokens.get(role, 0) + count
        for role, count in validation_record.roleDocumentCounts.items():
            role_docs[role] = role_docs.get(role, 0) + count
    articles = list(train_record.articles)
    if validation_record is not None:
        articles.extend(validation_record.articles)
    merged = PackRecord(
        strategy=train_record.strategy,
        sequenceLength=train_record.sequenceLength,
        separator=train_record.separator,
        documentCount=len(documents),
        blockCount=train_record.blockCount + val_used,
        tokensSeen=(
            train_record.tokensSeen
            + (validation_record.tokensSeen if validation_record is not None else 0)
        ),
        droppedTokens=(
            train_record.droppedTokens
            + (validation_record.droppedTokens if validation_record is not None else 0)
        ),
        articles=articles,
        datasetHash=hashlib.sha256(
            ",".join(d["contentHash"] for d in documents).encode("utf-8")
        ).hexdigest(),
        tokenizerHash=train_record.tokenizerHash,
        roleTokenCounts=role_tokens,
        roleDocumentCounts=role_docs,
        trainBlockCount=train_record.blockCount,
        validationBlockCount=val_used,
    )
    return merged, train_record.blockCount, val_used


def pack_for_training(
    tokenizer: Any,
    documents: Sequence[Dict[str, str]],
    sequence_length: int,
    tokenizer_path: Path,
    validation_blocks: int,
    *,
    on_warning=None,
) -> tuple[torch.Tensor, torch.Tensor, PackRecord, Dict[str, Any]]:
    """Pack a snapshot into training and validation streams.

    When rows carry `corpusRole: "validation"`, validation is packed from those
    rows *after* the training prefix, so increasing validation size does not
    remove training blocks. Without validation rows this falls back to the
    historical contiguous tail split of one packed stream.
    """
    train_docs, validation_docs = split_documents_by_role(documents)
    if not train_docs:
        raise InsufficientCorpusError("corpus has no training documents")
    if validation_docs:
        train_blocks, train_record = pack(
            tokenizer, train_docs, sequence_length, tokenizer_path
        )
        if validation_blocks <= 0:
            return train_blocks, train_blocks[:0], train_record, {
                "mode": "role-appended-empty",
                "requestedValidationBlocks": 0,
                "actualValidationBlocks": 0,
                "trainBlockCount": int(train_blocks.shape[0]),
                "trainTokensSeen": train_record.tokensSeen,
                "validationTokensSeen": 0,
                "shortfall": 0,
            }
        try:
            val_all_blocks, val_record = pack(
                tokenizer, validation_docs, sequence_length, tokenizer_path
            )
        except InsufficientCorpusError:
            val_all_blocks, val_record = None, None
        if val_record is not None and val_all_blocks is not None and val_all_blocks.shape[0] > 0:
            val_blocks = val_all_blocks[: min(validation_blocks, val_all_blocks.shape[0])]
            record, train_blocks_used, val_used = _merge_pack_records(
                train_record, val_record, validation_blocks, documents=documents
            )
            return train_blocks, val_blocks, record, {
                "mode": "role-appended",
                "requestedValidationBlocks": int(validation_blocks),
                "actualValidationBlocks": val_used,
                "trainBlockCount": train_blocks_used,
                "trainTokensSeen": train_record.tokensSeen,
                "validationTokensSeen": val_record.tokensSeen,
                "shortfall": max(0, int(validation_blocks) - val_used),
            }
        if on_warning:
            on_warning(
                "validation documents could not form a block; keeping them out of training"
            )
        # A role says "never train on this". If the validation rows are too small
        # to form even one block, drop them from the training stream and report
        # the shortfall instead of silently repurposing them.
        record = PackRecord(
            **{
                **train_record.to_json(),
                "documentCount": len(documents),
                "datasetHash": hashlib.sha256(
                    ",".join(d["contentHash"] for d in documents).encode("utf-8")
                ).hexdigest(),
            }
        )
        return train_blocks, train_blocks[:0], record, {
            "mode": "role-appended-empty",
            "requestedValidationBlocks": int(validation_blocks),
            "actualValidationBlocks": 0,
            "trainBlockCount": int(train_blocks.shape[0]),
            "trainTokensSeen": train_record.tokensSeen,
            "validationTokensSeen": 0,
            "shortfall": int(validation_blocks),
        }
    blocks, record = pack(tokenizer, documents, sequence_length, tokenizer_path)
    train_blocks, val_blocks = train_validation_split(blocks, validation_blocks)
    record = PackRecord(
        **{
            **record.to_json(),
            "trainBlockCount": int(train_blocks.shape[0]),
            "validationBlockCount": int(val_blocks.shape[0]),
        }
    )
    return train_blocks, val_blocks, record, {
        "mode": "tail-split",
        "requestedValidationBlocks": int(validation_blocks),
        "actualValidationBlocks": int(val_blocks.shape[0]),
        "trainBlockCount": int(train_blocks.shape[0]),
        "trainTokensSeen": (
            record.roleTokenCounts.get("train", 0)
            + record.roleTokenCounts.get("replay", 0)
        ),
        "validationTokensSeen": record.roleTokenCounts.get("validation", 0),
        "shortfall": max(0, int(validation_blocks) - int(val_blocks.shape[0])),
    }


def train_validation_split(
    blocks: torch.Tensor, validation_blocks: int
) -> tuple[torch.Tensor, torch.Tensor]:
    """Hold out whole blocks from the end. Never random — a random split over a
    packed stream leaks neighbouring context across the boundary."""
    if validation_blocks <= 0:
        return blocks, blocks[:0]
    if validation_blocks >= blocks.shape[0]:
        # Not enough blocks for a validation split; return all for training
        # with empty validation. This can happen with very small datasets/fixtures.
        return blocks, blocks[:0]
    split = blocks.shape[0] - validation_blocks
    return blocks[:split], blocks[split:]
