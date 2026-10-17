"""A cold package can count embedding tokens with all network paths unavailable."""

import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

from sourcesql.resources import build_personal_cloud_archive, materialize_personal_cloud


TOKENIZER_PATHS = (
    "src/sourcesql/_resources/tokenizers/cl100k_base.tiktoken.gz",
    "src/sourcesql/_resources/tokenizers/TIKTOKEN_LICENSE.txt",
)


def test_personal_cloud_templates_include_verified_runtime_tokenizer_resources(
    tmp_path, monkeypatch
):
    root = Path(__file__).resolve().parents[2]
    package = tmp_path / "installed"
    path = package / "_resources/personal-cloud.zip"
    path.parent.mkdir(parents=True)
    path.write_bytes(build_personal_cloud_archive(root))
    monkeypatch.setattr("sourcesql.resources.files", lambda _: package)
    destination = materialize_personal_cloud(tmp_path / "adopter")
    for relative in TOKENIZER_PATHS:
        assert (destination / relative).read_bytes() == (root / relative).read_bytes()


def test_cold_zip_package_counts_tokens_without_network_or_tokenizer_cache(tmp_path):
    root = Path(__file__).resolve().parents[2]
    archive_path = tmp_path / "cold-runtime.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for path in (root / "src/sourcesql").rglob("*"):
            if path.is_file() and (
                path.suffix == ".py"
                or path.name in {"cl100k_base.tiktoken.gz", "TIKTOKEN_LICENSE.txt"}
            ):
                archive.write(path, path.relative_to(root / "src").as_posix())
    script = """
import json, os, socket, sys, tempfile
from pathlib import Path
import requests
import tiktoken.load
import urllib.request
sys.path.insert(0, sys.argv[1])
def forbidden(*args, **kwargs):
    raise AssertionError('tokenizer attempted network or external cache access')
socket.create_connection = forbidden
requests.get = forbidden
urllib.request.urlopen = forbidden
tiktoken.load.read_file = forbidden
tiktoken.load.read_file_cached = forbidden
before = dict(os.environ)
from sourcesql.providers.tokenization import get_embedding_tokenizer
encoding = get_embedding_tokenizer('text-embedding-3-small')
assert 'cold-runtime.zip' in sys.modules['sourcesql'].__file__
tokens = encoding.encode_ordinary('hello world <|endoftext|> こんにちは')
assert dict(os.environ) == before
assert not (Path(tempfile.gettempdir()) / 'data-gym-cache').exists()
print(json.dumps({'tokens': tokens, 'encoding': encoding.name}))
"""
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in {"PYTHONPATH", "TIKTOKEN_CACHE_DIR", "DATA_GYM_CACHE_DIR"}
    }
    environment["TMPDIR"] = str(tmp_path)
    completed = subprocess.run(
        [sys.executable, "-I", "-c", script, str(archive_path)],
        cwd=tmp_path,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    result = json.loads(completed.stdout)
    assert result["encoding"] == "cl100k_base"
    assert result["tokens"][:2] == [15339, 1917]
