"""Registry validates complete DeepSeek batches once before checkpoint splitting."""

import json
import socket

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry


def registry(calls, lookups, **changes):
    def reply(request):
        calls.append(request)
        if request.url.path.endswith("/search"):
            return httpx.Response(200, json={"results": []})
        return httpx.Response(200, json={"title": None, "content": "Acquired page text."})

    def resolve(host, port, **kwargs):
        lookups.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    provider = ProviderRegistry(
        {
            "mode": "live",
            "provider": "deepseek",
            "api_key": "SYNTHETIC-KEY",
            "allow_live": True,
            "approved_cost_microusd": 100_000,
            "metering_policy": "estimated",
            "allow_public_source_hosts": True,
            "fetch_adapter": "deepseek",
            "resolver": resolve,
            "http_client": httpx.Client(transport=httpx.MockTransport(reply), trust_env=False),
            **changes,
        }
    )
    provider.stage_call = lambda operator, args, options, acquire: (acquire(), False)
    return provider


def test_forty_url_checkpoint_batch_resolves_each_source_once():
    calls, lookups = [], []
    provider = registry(calls, lookups)
    urls = [f"https://public{i}.example/article" for i in range(40)]
    budget = Budget({"max_cost_microusd": 100_000, "max_fetches": 40})
    rows = provider.fetch(urls, {}, budget)
    assert len(rows) == len(calls) == len(lookups) == 40
    assert all(row["content"] == "Acquired page text." for row in rows)
    assert [json.loads(call.content)["url"] for call in calls] == urls


def test_query_batch_is_validated_once_despite_separate_checkpoints(monkeypatch):
    calls, lookups, validations = [], [], []
    provider = registry(calls, lookups)
    original = provider.search_provider.validate_queries

    def validate(queries):
        validations.append(list(queries))
        return original(queries)

    monkeypatch.setattr(provider.search_provider, "validate_queries", validate)
    provider.search(["first query", "second query"], {}, Budget({"max_cost_microusd": 100_000}))
    assert validations == [["first query", "second query"]]
    assert len(calls) == 2 and lookups == []


def test_explicit_host_grant_denies_entire_batch_before_dns_or_paid_dispatch():
    calls, lookups = [], []
    provider = registry(
        calls, lookups, allow_public_source_hosts=False, allowed_source_hosts=["allowed.example"]
    )
    budget = Budget({"max_cost_microusd": 100_000})
    with pytest.raises(SourcesQLError) as error:
        provider.fetch(["https://allowed.example/a", "https://other.example/b"], {}, budget)
    assert error.value.code == "unauthorized"
    assert calls == lookups == [] and budget.counts == {}


def test_real_sql_keeps_metadata_only_hits_and_good_fetch_neighbors(tmp_path, monkeypatch):
    from sourcesql.engine import Engine

    calls = []

    def reply(request):
        calls.append(request)
        if request.url.path.endswith("/search"):
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "url": "https://public.example/good",
                            "title": None,
                            "content": "Retained evidence.",
                        },
                        {
                            "url": "https://public.example/pdf",
                            "title": "Discovery only",
                            "content": None,
                        },
                    ]
                },
            )
        url = json.loads(request.content)["url"]
        if url.endswith("/pdf"):
            return httpx.Response(404)
        return httpx.Response(200, json={"title": None, "content": "Retained evidence."})

    client = httpx.Client(transport=httpx.MockTransport(reply), trust_env=False)
    profile = {
        "mode": "live",
        "provider": "deepseek",
        "api_key": "SYNTHETIC-KEY",
        "allow_live": True,
        "approved_cost_microusd": 100_000,
        "metering_policy": "estimated",
        "allow_public_source_hosts": True,
        "fetch_adapter": "deepseek",
    }

    class MockedRegistry(ProviderRegistry):
        def __init__(self, configured):
            super().__init__(
                {
                    **configured,
                    "http_client": client,
                    "resolver": lambda host, port, **kwargs: [
                        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))
                    ],
                }
            )

    monkeypatch.setattr("sourcesql.providers.ProviderRegistry", MockedRegistry)
    engine = Engine(tmp_path / "engine", profiles={"deepseek": profile})
    discovered = engine.query(
        profile="deepseek",
        source_mode="allow_excerpt",
        budgets={"max_cost_microusd": 100_000},
        query="SELECT url,content FROM WEB_SEARCH('public evidence') ORDER BY url",
    )
    assert len(discovered["rows"]) == 2
    assert discovered["rows"][0]["content"] == "Retained evidence."
    assert discovered["rows"][1]["content"] is None
    fetched = engine.query(
        profile="deepseek",
        source_mode="allow_excerpt",
        budgets={"max_cost_microusd": 100_000},
        query="SELECT url,content FROM WEB_FETCH('https://public.example/good','https://public.example/pdf','https://public.example/last') ORDER BY url",
    )
    assert [row["url"] for row in fetched["rows"]] == [
        "https://public.example/good",
        "https://public.example/last",
    ]
    assert fetched["receipt"]["status"] == "partial"
    assert fetched["receipt"]["errors"][0]["stage"] == "fetch"
    before = len(calls)
    assert engine.read_result(fetched["result_id"])["rows"] == fetched["rows"]
    assert len(calls) == before == 4
