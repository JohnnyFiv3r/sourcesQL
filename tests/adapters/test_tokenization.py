"""Exact model token counts without network, cache warming, or source-size heuristics."""

import base64
import gzip
import hashlib
from importlib.resources import files

import pytest
import tiktoken
import tiktoken_ext.openai_public as official

from sourcesql.contracts import SourcesQLError
from sourcesql.providers import tokenization


def test_bundled_encoding_matches_the_official_preset_for_multilingual_and_special_text(
    monkeypatch,
):
    data = gzip.decompress(
        files("sourcesql").joinpath("_resources/tokenizers/cl100k_base.tiktoken.gz").read_bytes()
    )
    assert hashlib.sha256(data).hexdigest() == tokenization._CL100K_SHA256
    ranks = {
        base64.b64decode(token): int(rank)
        for token, rank in (line.split() for line in data.splitlines())
    }

    def local_official_data(url, expected_hash):
        assert url.endswith("/cl100k_base.tiktoken")
        assert expected_hash == tokenization._CL100K_SHA256
        return ranks

    monkeypatch.setattr(official, "load_tiktoken_bpe", local_official_data)
    reference = tiktoken.Encoding(**official.cl100k_base())
    actual = tokenization.get_embedding_tokenizer("text-embedding-3-small")
    assert actual is tokenization.get_embedding_tokenizer("text-embedding-3-large")
    for text in [
        "Campus grid connection and planned capacity: 300 MW.",
        "こんにちは世界。再生可能エネルギー容量を比較します。",
        "الطاقة المتجددة والتوصيل بالشبكة الكهربائية",
        "Emoji 🐇🧠, accents naïve café, tabs\tand newlines\n.",
        "Untrusted source contains <|endoftext|> and <|fim_prefix|> literally.",
        "a " * 20_000,
    ]:
        assert actual.encode_ordinary(text) == reference.encode_ordinary(text)
    assert len(actual.encode_ordinary("a " * 7_000)) < 8_192
    assert len(("a " * 7_000).encode()) > 8_192


def test_model_mapping_requires_an_explicit_reviewed_encoding_for_custom_models():
    with pytest.raises(SourcesQLError, match="explicit encoding_name") as unknown:
        tokenization.get_embedding_tokenizer("custom-embedding")
    assert unknown.value.code == "unsupported_capability"
    assert (
        tokenization.get_embedding_tokenizer("custom-embedding", "cl100k_base").name
        == "cl100k_base"
    )
    with pytest.raises(SourcesQLError, match="conflicts"):
        tokenization.get_embedding_tokenizer("text-embedding-3-small", "o200k_base")
    with pytest.raises(SourcesQLError, match="not bundled"):
        tokenization.get_embedding_tokenizer("custom-embedding", "o200k_base")


def test_corrupt_or_missing_bundled_data_refuses_tokenization_before_provider_dispatch(
    tmp_path, monkeypatch
):
    tokenization._bundled_encoding.cache_clear()
    monkeypatch.setattr(tokenization, "files", lambda _: tmp_path)
    with pytest.raises(SourcesQLError, match="unavailable or invalid"):
        tokenization.get_embedding_tokenizer("text-embedding-3-small")
    path = tmp_path / "_resources/tokenizers/cl100k_base.tiktoken.gz"
    path.parent.mkdir(parents=True)
    path.write_bytes(gzip.compress(b"changed tokenizer ranks"))
    with pytest.raises(SourcesQLError, match="unavailable or invalid"):
        tokenization.get_embedding_tokenizer("text-embedding-3-small")
    tokenization._bundled_encoding.cache_clear()
