#!/usr/bin/env python3
"""Convert a WikiText-103 parquet split into a trainer-compatible JSONL corpus.

Experiment utility only. It takes a bounded number of clean English sections,
filters evaluation overlap, and writes train/validation rows with the same
content-hash and corpusRole fields the Python trainer already understands.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq

ENGLISH_STOPWORDS = set(
    "the a an and or but if while of to in on at by for from with without into "
    "is are was were be been being it its this that these those as not no "
    "he she they we you i his her their our your them him us do does did done "
    "have has had can could may might will would should about after before "
    "over under between through during more most other some such only also than "
    "then there where which who whom whose what when why how all any both each "
    "few many much neither nor own same so too very just".split()
)


def normalize(text: str) -> str:
    text = text.replace("<unk>", " ")
    text = re.sub(r"^[ \t]*=+[ \t]*(.*?)[ \t]*=+[ \t]*$", r"\1", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def english_score(text: str) -> tuple[float, float]:
    words = re.findall(r"[A-Za-z']+", text.lower())
    if not words:
        return 0.0, 0.0
    stopword_ratio = sum(1 for word in words if word in ENGLISH_STOPWORDS) / len(words)
    ascii_ratio = sum(1 for ch in text if ch.isascii()) / max(1, len(text))
    return stopword_ratio, ascii_ratio


def word_ngrams(text: str, size: int = 8) -> set[tuple[str, ...]]:
    words = re.findall(r"[a-z0-9']+", text.lower())
    if len(words) < size:
        return set()
    return {tuple(words[i : i + size]) for i in range(len(words) - size + 1)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--eval-set", required=True)
    parser.add_argument("--target-chars", type=int, default=40_000_000)
    parser.add_argument("--min-chars", type=int, default=1000)
    parser.add_argument("--validation-percent", type=int, default=5)
    args = parser.parse_args()

    eval_ngrams: set[tuple[str, ...]] = set()
    for line in Path(args.eval_set).read_text(encoding="utf-8").split("\n"):
        if line.strip():
            row = json.loads(line)
            eval_ngrams |= word_ngrams(str(row.get("text") or row.get("completion") or ""))

    kept: list[dict] = []
    skipped = Counter()
    seen_text: set[str] = set()
    chars = 0
    for parquet in args.parquet:
        table = pq.read_table(parquet, columns=["text"])
        for index, raw in enumerate(table.column("text").to_pylist()):
            if chars >= args.target_chars:
                break
            text = normalize(str(raw or ""))
            if len(text) < args.min_chars:
                skipped["short"] += 1
                continue
            stopword_ratio, ascii_ratio = english_score(text)
            if stopword_ratio < 0.08 or ascii_ratio < 0.85:
                skipped["not-english"] += 1
                continue
            if eval_ngrams and word_ngrams(text) & eval_ngrams:
                skipped["eval-overlap"] += 1
                continue
            content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if content_hash in seen_text:
                skipped["duplicate"] += 1
                continue
            seen_text.add(content_hash)
            bucket = int(hashlib.sha256(f"{parquet}:{index}".encode("utf-8")).hexdigest(), 16) % 100
            role = "validation" if bucket < args.validation_percent else "train"
            kept.append(
                {
                    "articleId": f"wt_{hashlib.sha256(f'{parquet}:{index}'.encode('utf-8')).hexdigest()[:16]}",
                    "contentHash": content_hash,
                    "text": text,
                    "corpusRole": role,
                    "sourceUrl": None,
                    "group": "wikitext-103",
                }
            )
            chars += len(text)
        if chars >= args.target_chars:
            break

    kept.sort(key=lambda row: row["articleId"])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        for row in kept:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    total_chars = sum(len(row["text"]) for row in kept)
    train_chars = sum(len(row["text"]) for row in kept if row["corpusRole"] == "train")
    summary = {
        "kept": len(kept),
        "skipped": dict(skipped),
        "chars": total_chars,
        "approxTokens": total_chars // 4,
        "trainApproxTokens": train_chars // 4,
        "validationApproxTokens": (total_chars - train_chars) // 4,
        "output": str(out),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
