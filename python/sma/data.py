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
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Sequence

import torch

# Recorded in train state. A different value is a different corpus.
PACKING_STRATEGY = "concatenate-chunk-v1"
SEPARATOR_TOKEN = "\n\n"


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
            docs.append(
                {
                    "articleId": item.get("articleId") or f"{path.name}#{index}",
                    "text": text,
                    "contentHash": _sha256_text(text),
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
    for doc in documents:
        ids = tokenizer(doc["text"], add_special_tokens=False).input_ids
        if ids:
            pieces.append(ids)
            seen += len(ids)
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
        raise ValueError(
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
    )
    return blocks, record


def train_validation_split(
    blocks: torch.Tensor, validation_blocks: int
) -> tuple[torch.Tensor, torch.Tensor]:
    """Hold out whole blocks from the end. Never random — a random split over a
    packed stream leaks neighbouring context across the boundary."""
    if validation_blocks <= 0:
        return blocks, blocks[:0]
    if validation_blocks >= blocks.shape[0]:
        raise ValueError(
            f"cannot hold out {validation_blocks} of {blocks.shape[0]} blocks"
        )
    split = blocks.shape[0] - validation_blocks
    return blocks[:split], blocks[split:]
