"""Tokenizer-based measurement for corpus/validation observability.

Character/4 estimates are useful for planning, but decisions that depend on
whether a validation cohort can form a 128-token block must use the real
tokenizer. This module is deliberately small and model-free: it loads only the
tokenizer and reports per-document token counts plus packed block capacity.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List

from tokenizers import Tokenizer


def measure_documents(
    documents: Iterable[Dict[str, Any]],
    tokenizer_path: str | Path,
    sequence_length: int = 128,
) -> Dict[str, Any]:
    if sequence_length <= 0:
        raise ValueError("sequence_length must be positive")
    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    rows: List[Dict[str, Any]] = []
    total = 0
    for index, doc in enumerate(documents):
        text = str(doc.get("text") or doc.get("completion") or "")
        if not text.strip():
            continue
        tokens = len(tokenizer.encode(text, add_special_tokens=False).ids)
        total += tokens
        rows.append(
            {
                "itemId": doc.get("itemId") or doc.get("articleId") or f"row-{index}",
                "tokens": tokens,
                "chars": len(text),
                "meetsOneBlock": tokens >= sequence_length,
            }
        )
    return {
        "schema": "sma/token-measurement@1",
        "sequenceLength": sequence_length,
        "documentCount": len(rows),
        "totalTokens": total,
        "blocksIfConcatenated": total // sequence_length,
        "droppedTokens": total % sequence_length,
        "documentsMeetingOneBlock": sum(1 for row in rows if row["meetsOneBlock"]),
        "documents": rows,
    }


def _read_jsonl(stream: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for line in stream:
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure real tokenizer counts for JSONL documents")
    parser.add_argument("--tokenizer", required=True, help="path to tokenizer.json")
    parser.add_argument("--seq-len", type=int, default=128)
    parser.add_argument("--input", default=None, help="JSONL file (default: stdin)")
    args = parser.parse_args(argv)

    if args.input:
        with open(args.input, "r", encoding="utf-8") as fh:
            documents = _read_jsonl(fh)
    else:
        documents = _read_jsonl(sys.stdin)

    result = measure_documents(documents, args.tokenizer, args.seq_len)
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
