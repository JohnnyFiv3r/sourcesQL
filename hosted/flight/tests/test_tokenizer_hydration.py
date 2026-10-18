"""Explicit, bounded tokenizer setup occurs only before admitted live scoring."""

import asyncio
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import uuid

import httpx
import pytest

from sourcesql.contracts import SourcesQLError


def load(name):
    spec = importlib.util.spec_from_file_location(
        "sourcesql_tokenizer_" + name, Path(__file__).resolve().parents[1] / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load("runner")
builder = load("build")
ROOT = Path(__file__).resolve().parents[3]
RESOURCE = runner.TOKENIZER_HYDRATION["resource"]
RAW = gzip.decompress((ROOT / "src" / RESOURCE).read_bytes())


class Body(httpx.AsyncByteStream):
    def __init__(self, content):
        self.content = content

    async def __aiter__(self):
        yield self.content


def manifest():
    distribution_hash = hashlib.sha256((ROOT / "src" / RESOURCE).read_bytes()).hexdigest()
    return {
        "engine_source_sha256": {RESOURCE: distribution_hash},
        "tokenizer_hydration": {
            **runner.TOKENIZER_HYDRATION,
            "distribution_resource_sha256": distribution_hash,
        },
    }


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    settings = []

    def client(**kwargs):
        settings.append(kwargs)
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        return original(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return settings


def test_restoration_uses_only_the_official_resource_without_credentials(tmp_path, monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        assert str(request.url) == runner.TOKENIZER_HYDRATION["url"]
        assert not any(name in request.headers for name in ["authorization", "cookie", "x-api-key"])
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, stream=Body(RAW))

    settings = transport(monkeypatch, respond)
    report = runner.hydrate_embedding_tokenizer(tmp_path, manifest())
    assert (
        report["state"] == "restored"
        and report["raw_sha256"] == runner.TOKENIZER_HYDRATION["raw_sha256"]
    )
    assert gzip.decompress((tmp_path / RESOURCE).read_bytes()) == RAW
    assert settings[0]["timeout"] == 10
    assert len(requests) == 1
    assert runner.hydrate_embedding_tokenizer(tmp_path, manifest())["state"] == "present"
    assert len(requests) == 1
    assert runner.TOKENIZER_HYDRATION == builder.TOKENIZER_HYDRATION


def test_stripped_package_needs_explicit_hydration_before_tokenization(tmp_path, monkeypatch):
    from sourcesql.providers import tokenization

    package = tmp_path / "sourcesql"
    monkeypatch.setattr(tokenization, "files", lambda _: package)
    tokenization._bundled_encoding.cache_clear()
    with pytest.raises(SourcesQLError, match="unavailable or invalid"):
        tokenization.get_embedding_tokenizer("text-embedding-3-small")
    transport(monkeypatch, lambda _: httpx.Response(200, stream=Body(RAW)))
    runner.hydrate_embedding_tokenizer(tmp_path, manifest())
    encoding = tokenization.get_embedding_tokenizer("text-embedding-3-small")
    assert len(encoding.encode_ordinary("a " * 7000)) == 7001
    tokenization._bundled_encoding.cache_clear()


@pytest.mark.parametrize(
    "failure", ["redirect", "oversize_header", "oversize_body", "checksum", "encoded"]
)
def test_restoration_refuses_unreviewed_or_invalid_responses_without_retry(
    tmp_path, monkeypatch, failure
):
    calls = []

    def respond(request):
        calls.append(request)
        if failure == "redirect":
            return httpx.Response(302, headers={"location": "https://example.org/tokenizer"})
        if failure == "oversize_header":
            return httpx.Response(200, headers={"content-length": "2000001"}, content=b"")
        if failure == "oversize_body":
            return httpx.Response(200, stream=Body(b"x" * 2_000_001))
        if failure == "encoded":
            return httpx.Response(
                200, headers={"content-encoding": "gzip"}, content=gzip.compress(RAW)
            )
        return httpx.Response(200, stream=Body(b"wrong ranks"))

    transport(monkeypatch, respond)
    with pytest.raises(SourcesQLError) as error:
        runner.hydrate_embedding_tokenizer(tmp_path, manifest())
    assert error.value.code == "provider_unavailable"
    assert len(calls) == 1
    assert not (tmp_path / RESOURCE).exists()


def test_restoration_rejects_mutated_manifest_before_network(tmp_path, monkeypatch):
    transport(monkeypatch, lambda _: pytest.fail("Unreviewed resource must not be downloaded"))
    value = manifest()
    value["tokenizer_hydration"]["url"] = "https://example.org/changed"
    with pytest.raises(SourcesQLError, match="Unreviewed"):
        runner.hydrate_embedding_tokenizer(tmp_path, value)


def test_existing_corrupt_resource_is_refused_without_download_fallback(tmp_path, monkeypatch):
    transport(monkeypatch, lambda _: pytest.fail("Corrupt local data must not trigger fallback"))
    resource = tmp_path / RESOURCE
    resource.parent.mkdir(parents=True)
    resource.write_bytes(gzip.compress(b"changed ranks"))
    with pytest.raises(SourcesQLError, match="unavailable"):
        runner.hydrate_embedding_tokenizer(tmp_path, manifest())
    assert gzip.decompress(resource.read_bytes()) == b"changed ranks"


def test_resource_parent_symlink_is_refused_before_network(tmp_path, monkeypatch):
    transport(monkeypatch, lambda _: pytest.fail("Unsafe path must not trigger a download"))
    outside = tmp_path / "outside"
    outside.mkdir()
    installed = tmp_path / "installed"
    installed.mkdir()
    (installed / "sourcesql").symlink_to(outside, target_is_directory=True)
    with pytest.raises(SourcesQLError, match="resource path"):
        runner.hydrate_embedding_tokenizer(installed, manifest())
    assert list(outside.iterdir()) == []


def test_download_completing_after_total_allowance_does_not_write_resource(tmp_path, monkeypatch):
    transport(monkeypatch, lambda _: httpx.Response(200, stream=Body(RAW)))
    moments = iter([0, 10])
    monkeypatch.setattr(runner, "time", SimpleNamespace(monotonic=lambda: next(moments)))
    with pytest.raises(SourcesQLError) as error:
        runner.hydrate_embedding_tokenizer(tmp_path, manifest())
    assert isinstance(error.value.__cause__, TimeoutError)
    assert not (tmp_path / RESOURCE).exists()


def test_download_deadline_covers_slow_chunks_not_only_individual_reads(tmp_path, monkeypatch):
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(20):
                await asyncio.sleep(0.01)
                yield b"x"

    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, stream=Slow())

    transport(monkeypatch, respond)
    with pytest.raises(SourcesQLError) as error:
        runner.hydrate_embedding_tokenizer(tmp_path, manifest(), timeout_seconds=0.03)
    assert error.value.code == "provider_unavailable" and len(calls) == 1
    assert isinstance(error.value.__cause__, TimeoutError)
    assert not (tmp_path / RESOURCE).exists()


@pytest.mark.parametrize("operator", ["WEB_SEARCH", "SEM_SCORE"])
@pytest.mark.parametrize("hydration_fails", [False, True])
@pytest.mark.parametrize("profile", ["fixture", "exa", "brave", "serper"])
def test_only_validated_scoring_hydrates_before_dispatch_and_preserves_request(
    tmp_path, monkeypatch, operator, hydration_fails, profile
):
    request = {"profile": profile, "sql": "fixture", "budgets": {"dispatch_deadline_seconds": 100}}
    saved = json.dumps(request, sort_keys=True)
    events = []

    class Store:
        def claim_job(self, *args, **kwargs):
            return {"operation": "query", "request": request, "provider_policy_sha256": "reviewed"}

        def bind_job(self, *args):
            pass

        def finish_job(self, *args):
            events.append("finish")

        def fail_job(self, *args):
            events.append("fail")

    class Helper:
        @staticmethod
        def validate_request(*args):
            events.append("validate_request")

        @staticmethod
        def validate_explain(*args):
            events.append("validate_explain")

    class Engine:
        def __init__(self, **kwargs):
            self.before_dispatch = kwargs["before_dispatch"]

        def explain(self, **kwargs):
            raise AssertionError("Query must validate in its own execution session")

        def query(self, **kwargs):
            assert json.dumps(kwargs, sort_keys=True) == saved
            events.append("query")
            events.append("binding_validated")
            self.before_dispatch(
                {"plan": {"stages": [{"stage": "external", "operator": operator}]}}
            )
            events.append("dispatch")
            return {
                "result_id": "r1",
                "receipt": {"status": "completed", "run_id": "run1", "plan_complete": True},
            }

    def hydrate(*args):
        events.append("hydrate")
        if hydration_fails:
            raise SourcesQLError("provider_unavailable", "Synthetic tokenizer failure", "dispatch")
        return {"state": "restored", "elapsed_seconds": 0.01}

    monkeypatch.setattr(runner, "hydrate_embedding_tokenizer", hydrate)
    settings = {
        "allowed_profiles": (profile,),
        "provider_policy_sha256": "reviewed",
        "profiles": {},
    }
    report = {}
    with patch("sourcesql.engine.Engine", Engine):
        runner.execute_job(
            Store(), {"job_id": str(uuid.uuid4())}, report, tmp_path, Helper, settings
        )
    assert json.dumps(request, sort_keys=True) == saved
    if profile == "fixture" or operator == "WEB_SEARCH":
        assert "hydrate" not in events and "query" in events
    elif hydration_fails:
        assert events == [
            "validate_request",
            "query",
            "binding_validated",
            "validate_explain",
            "hydrate",
            "fail",
        ]
        assert report["error_code"] == "provider_unavailable"
    else:
        assert events == [
            "validate_request",
            "query",
            "binding_validated",
            "validate_explain",
            "hydrate",
            "dispatch",
            "finish",
        ]
