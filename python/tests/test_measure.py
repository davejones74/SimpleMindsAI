from __future__ import annotations

from sma.measure import measure_documents


def test_measure_documents_uses_real_tokenizer(tokenizer, tmp_path):
    # The fixture tokenizer is a real tokenizers.Tokenizer. Save it so the
    # measurement path exercises the same from_file route as production.
    tokenizer.save_pretrained(str(tmp_path))
    path = tmp_path / "tokenizer.json"
    docs = [
        {"itemId": "a", "text": "The steam engine converted heat into motion."},
        {"itemId": "b", "text": "Photosynthesis converts light into chemical energy in plants."},
    ]
    result = measure_documents(docs, path, sequence_length=4)
    assert result["schema"] == "sma/token-measurement@1"
    assert result["documentCount"] == 2
    assert result["totalTokens"] == sum(row["tokens"] for row in result["documents"])
    assert result["blocksIfConcatenated"] == result["totalTokens"] // 4
    assert all(row["tokens"] > 0 for row in result["documents"])


def test_measure_documents_skips_empty_rows(tokenizer, tmp_path):
    tokenizer.save_pretrained(str(tmp_path))
    path = tmp_path / "tokenizer.json"
    result = measure_documents([{"text": ""}, {"text": "A real sentence."}], path)
    assert result["documentCount"] == 1
