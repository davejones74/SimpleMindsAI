#!/usr/bin/env python3
"""Build a clean experiment corpus from the existing article raw text.

This is an offline experiment utility. It does not touch the article store,
registry, production models, or training jobs. It reads the article ledger,
removes navigation/boilerplate that repeats across sources, filters non-English
text, removes documents that overlap the frozen evaluation set, and writes a
JSONL corpus the Python trainer can pack directly.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
from collections import Counter
from pathlib import Path

ENGLISH_STOPWORDS = set(
    "the a an and or but if while of to in on at by for from with without into "
    "is are was were be been being it its this that these those as not no "
    "he she they we you i his her their our your them him us do does did done "
    "have has had can could may might will would should about after before "
    "over under between through during more most other some such only also than "
    "then there where which who whom whose what when why how all any both each "
    "few many much neither nor own same so too very just".split()
)

SKIP_LINE = re.compile(
    r"^(toggle\b|jump to content\b|main menu\b|navigation\b|contribute\b|"
    r"tools\b|appearance\b|search\b|donate\b|create account\b|log in\b|"
    r"personal tools\b|contents\b|move to sidebar\b|hide\b|for the .* see\b|"
    r"from wikipedia, the free encyclopedia\b|wikimedia commons has media\b)",
    re.IGNORECASE,
)
REFERENCE_MARK = re.compile(r"\[\s*(?:\d+|edit|citation needed|a|b|c|d)\s*\]", re.IGNORECASE)
SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?])")
MULTISPACE = re.compile(r"\s+")


def normalize(line: str) -> str:
    line = MULTISPACE.sub(" ", line).strip()
    line = REFERENCE_MARK.sub("", line)
    line = SPACE_BEFORE_PUNCT.sub(r"\1", line)
    return MULTISPACE.sub(" ", line).strip()


def prose_ratio(line: str) -> float:
    letters = sum(ch.isalpha() or ch.isspace() for ch in line)
    return letters / max(1, len(line))


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


def clean_source(raw: str, common_lines: set[str]) -> str:
    kept: list[str] = []
    for raw_line in html.unescape(raw).splitlines():
        line = normalize(raw_line)
        if len(line) < 40:
            continue
        if line in common_lines:
            continue
        if SKIP_LINE.match(line):
            continue
        if prose_ratio(line) < 0.65:
            continue
        kept.append(line)
    return "\n".join(kept)


def sentence_ratio(text: str) -> float:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return 0.0
    complete = sum(1 for line in lines if line.rstrip().endswith((".", "!", "?", '"', "'")))
    return complete / len(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--articles", required=True, help="articles.ndjson")
    parser.add_argument("--eval-set", required=True, help="frozen evaluation JSONL")
    parser.add_argument("--out", required=True, help="output corpus JSONL")
    parser.add_argument("--min-chars", type=int, default=1000)
    parser.add_argument("--min-stopword-ratio", type=float, default=0.08)
    parser.add_argument("--min-ascii-ratio", type=float, default=0.85)
    parser.add_argument("--validation-percent", type=int, default=5)
    parser.add_argument("--min-sentence-ratio", type=float, default=0.4)
    parser.add_argument("--common-line-docs", type=int, default=10)
    args = parser.parse_args()

    articles = [json.loads(line) for line in Path(args.articles).read_text(encoding="utf-8").split("\n") if line.strip()]
    sources: dict[str, dict] = {}
    for article in articles:
        digest = article.get("fetchedContentHash")
        raw = article.get("rawText")
        if not digest or not raw or digest in sources:
            continue
        sources[digest] = {
            "raw": raw,
            "sourceUrl": article.get("sourceUrl"),
            "group": article.get("sourceDomain") or article.get("domain") or "unknown",
        }

    line_counts: Counter[str] = Counter()
    for source in sources.values():
        cleaned = {normalize(line) for line in source["raw"].splitlines()}
        line_counts.update(line for line in cleaned if len(line) >= 40)
    common_lines = {line for line, count in line_counts.items() if count >= args.common_line_docs and line}

    eval_ngrams: set[tuple[str, ...]] = set()
    for line in Path(args.eval_set).read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        row = json.loads(line)
        eval_ngrams |= word_ngrams(str(row.get("text") or row.get("completion") or ""))

    seen_text: set[str] = set()
    kept: list[dict] = []
    skipped = Counter()
    for digest, source in sources.items():
        text = clean_source(source["raw"], common_lines)
        if len(text) < args.min_chars:
            skipped["short"] += 1
            continue
        if sentence_ratio(text) < args.min_sentence_ratio:
            skipped["listing"] += 1
            continue
        stopword_ratio, ascii_ratio = english_score(text)
        if stopword_ratio < args.min_stopword_ratio or ascii_ratio < args.min_ascii_ratio:
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
        bucket = int(hashlib.sha256(digest.encode("utf-8")).hexdigest(), 16) % 100
        role = "validation" if bucket < args.validation_percent else "train"
        kept.append(
            {
                "articleId": f"src_{digest[:16]}",
                "contentHash": content_hash,
                "text": text,
                "corpusRole": role,
                "sourceUrl": source["sourceUrl"],
                "group": source["group"],
            }
        )

    kept.sort(key=lambda row: row["articleId"])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        for row in kept:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    chars = sum(len(row["text"]) for row in kept)
    train_chars = sum(len(row["text"]) for row in kept if row["corpusRole"] == "train")
    validation_chars = chars - train_chars
    summary = {
        "sources": len(sources),
        "kept": len(kept),
        "skipped": dict(skipped),
        "chars": chars,
        "approxTokens": chars // 4,
        "trainChars": train_chars,
        "trainApproxTokens": train_chars // 4,
        "validationChars": validation_chars,
        "validationApproxTokens": validation_chars // 4,
        "trainDocuments": sum(1 for row in kept if row["corpusRole"] == "train"),
        "validationDocuments": sum(1 for row in kept if row["corpusRole"] == "validation"),
        "output": str(out),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
