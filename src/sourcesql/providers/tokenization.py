"""Exact embedding tokenization using reviewed, bundled OpenAI tokenizer data.

Constructing the encoding directly avoids tiktoken's lazy network/cache lookup.
Public packages and Docker images bundle the data; the size-bounded Flight runner
explicitly restores verified public ranks before scoring. This helper never
downloads missing data. Untrusted source text must be encoded
with ``encode_ordinary`` so special-token-looking strings remain ordinary text.
The preset and merge ranks are adapted from tiktoken 0.14.0 (MIT); see NOTICE.
"""

from __future__ import annotations

import base64
from functools import lru_cache
import gzip
import hashlib
from importlib.resources import files

import tiktoken
from tiktoken.model import encoding_name_for_model

from ..contracts import SourcesQLError


_CL100K_SHA256 = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"
_CL100K_PATTERN = (
    r"'(?i:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?+\p{L}++|\p{N}{1,3}+"
    r"| ?[^\s\p{L}\p{N}]++[\r\n]*+|\s++$|\s*[\r\n]|\s+(?!\S)|\s"
)


@lru_cache(maxsize=1)
def _bundled_encoding(encoding_name: str) -> tiktoken.Encoding:
    if encoding_name != "cl100k_base":
        raise SourcesQLError(
            "unsupported_capability",
            "Embedding tokenizer is not bundled: " + encoding_name,
            "semantic",
        )
    try:
        compressed = (
            files("sourcesql")
            .joinpath("_resources/tokenizers/cl100k_base.tiktoken.gz")
            .read_bytes()
        )
        data = gzip.decompress(compressed)
        if hashlib.sha256(data).hexdigest() != _CL100K_SHA256:
            raise ValueError("Tokenizer checksum mismatch")
        mergeable_ranks = {
            base64.b64decode(token, validate=True): int(rank)
            for token, rank in (line.split() for line in data.splitlines() if line)
        }
        return tiktoken.Encoding(
            name="cl100k_base",
            pat_str=_CL100K_PATTERN,
            mergeable_ranks=mergeable_ranks,
            special_tokens={
                "<|endoftext|>": 100257,
                "<|fim_prefix|>": 100258,
                "<|fim_middle|>": 100259,
                "<|fim_suffix|>": 100260,
                "<|endofprompt|>": 100276,
            },
        )
    except (OSError, EOFError, ValueError) as exc:
        raise SourcesQLError(
            "unsupported_capability",
            "Bundled embedding tokenizer data is unavailable or invalid",
            "semantic",
        ) from exc


def get_embedding_tokenizer(model: str, encoding_name: str | None = None) -> tiktoken.Encoding:
    """Resolve exact tokenization without network or process-wide configuration.

    Known models must retain their documented encoding. A compatible custom
    model needs an explicit reviewed encoding; guessing a tokenizer is refused.
    Only cl100k_base is bundled for the currently supported embedding models.
    """
    try:
        model_encoding = encoding_name_for_model(model)
    except KeyError:
        model_encoding = None
    if model_encoding is None and encoding_name is None:
        raise SourcesQLError(
            "unsupported_capability",
            "Unknown embedding model needs an explicit encoding_name",
            "semantic",
        )
    if model_encoding is not None and encoding_name not in (None, model_encoding):
        raise SourcesQLError(
            "unsupported_capability",
            "Embedding encoding_name conflicts with the model tokenizer",
            "semantic",
        )
    selected = encoding_name or model_encoding
    assert selected is not None
    return _bundled_encoding(selected)
