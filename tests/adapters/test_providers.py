from __future__ import annotations

import json
import socket

import httpx
import pytest
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

from open_webql.contracts import Budget, WebQLError
from open_webql.providers import (
    BraveProvider,
    ExaProvider,
    FixtureProvider,
    OpenAIEmbeddingProvider,
    ProviderRegistry,
    PydanticSemanticProvider,
    SafeFetcher,
    SerperProvider,
)
from open_webql.providers.common import json_object, text_hash


def public_dns(host, port, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def mock_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)


def model_output(output, *, callback=None):
    def run(messages, info):
        assert not info.function_tools  # Leaf model cannot research or execute source commands.
        if callback:
            callback(messages, info)
        return ModelResponse(
            [ToolCallPart(info.output_tools[0].name, output)],
            usage=RequestUsage(input_tokens=12, output_tokens=8),
        )

    return FunctionModel(run)


def test_fixture_default_is_source_specific_and_preserves_unknowns():
    provider = ProviderRegistry()
    budget = Budget()
    rows = provider.search(["Aurora Birch", "Aurora"], {}, budget)
    assert len(rows) == 4
    aurora, birch, cloud, injection = rows
    assert len(aurora["hits"]) == 2
    assert (
        provider.semantic(
            "SEM_EXTRACT", aurora["content"], "planned capacity", {}, {}, budget
        ).value
        == "500"
    )
    absent = provider.semantic(
        "SEM_EXTRACT", birch["content"], "operating capacity", {}, {}, budget
    )
    assert (absent.value, absent.status) == (None, "not_stated")
    false = provider.semantic(
        "SEM_MATCH", cloud["content"], "specific data center campus", {}, {}, budget
    )
    assert false.value is False and false.status == "processed"
    unknown = provider.semantic(
        "SEM_MATCH", "unseen text", "specific data center campus", {}, {}, budget
    )
    assert unknown.value is None and unknown.status == "unknown"
    missing = provider.semantic("SEM_MATCH", None, "specific data center campus", {}, {}, budget)
    assert missing.value is None and missing.status == "unprocessed"
    assert (
        provider.semantic(
            "SEM_EXTRACT_ALL",
            injection["content"],
            "campuses",
            {"name": "project name"},
            {},
            budget,
        ).value
        == []
    )
    assert budget.counts["search_queries"] == 2 and budget.counts["search_requests"] == 2
    assert all(e.get("fixture_only") for e in provider.events)


def test_fixture_versions_conflict_hashes_and_publication_dates():
    old = FixtureProvider("t1").search(["Aurora"], {}, Budget())[0]
    new = FixtureProvider("t2").search(["Aurora"], {}, Budget())
    assert old["published_at"] == new[0]["published_at"]
    assert old["source_version_id"] != new[0]["source_version_id"]
    assert old["content_sha256"] == text_hash(old["content"])
    provider = FixtureProvider("t2")
    values = [
        provider.semantic("SEM_EXTRACT", r["content"], "planned capacity", {}, {}, Budget()).value
        for r in new
    ]
    assert values == ["500", "600"]


def test_fixture_norm_and_score_are_labeled_fixture_only():
    provider = ProviderRegistry()
    norm = provider.semantic(
        "SEM_NORM", ["Aurora", "Aurora Campus", "Birch"], "same campus", {}, {}, Budget()
    )
    assert norm.value == ["Aurora Campus", "Aurora Campus", "Birch Campus"]
    assert norm.usage["stable_global_ids"] is False and norm.usage["fixture_only"] is True
    row = provider.search(["Aurora"], {}, Budget())[0]
    score = provider.semantic("SEM_SCORE", row["content"], "relevance", {}, {}, Budget())
    assert score.usage["score_basis"] == "fixture_lookup_only"


def test_fixture_dates_require_explicit_undated_policy():
    provider = FixtureProvider()
    budget = Budget()
    with pytest.raises(WebQLError):
        provider.search(["campuses"], {"published_after": "2026-01-01"}, budget)
    assert budget.counts == {}
    rows = provider.search(
        ["campuses"], {"published_after": "2026-01-01", "undated_policy": "exclude"}, budget
    )
    assert [r["title"] for r in rows] == ["Aurora Campus planning"]


def test_brave_request_and_excerpt_semantics():
    def response(request):
        assert request.url.path == "/res/v1/web/search"
        assert request.headers["X-Subscription-Token"] == "mock-key"
        assert request.url.params["count"] == "3"
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {
                            "url": "https://public.example/a#x",
                            "title": "Campus",
                            "description": "<b>Planned</b> capacity",
                            "extra_snippets": ["500 MW"],
                            "page_age": "2 days ago",
                        }
                    ]
                },
                "query": {"more_results_available": True},
            },
        )

    provider = BraveProvider("mock-key", mock_client(response))
    rows = provider.search(["campus"], {"per_query_limit": 3}, Budget())
    assert rows[0]["content"] == "Planned capacity\n500 MW"
    assert rows[0]["content_basis"] == "excerpt" and not rows[0]["coverage"]["complete"]
    assert rows[0]["published_at"] is None
    assert provider.events[0]["usage"]["cost_microusd"] is None
    assert provider.events[0]["more_results_available"] is True


def test_exa_current_nested_contents_and_dates():
    def response(request):
        body = json.loads(request.content)
        assert body["contents"] == {"text": {"maxCharacters": 16000}}
        assert body["startPublishedDate"] == "2026-01-01T00:00:00Z"
        assert "outputSchema" not in body and "livecrawl" not in body
        return httpx.Response(
            200,
            json={
                "requestId": "r1",
                "results": [
                    {
                        "url": "https://public.example/a",
                        "title": "Campus",
                        "text": "Retained page text",
                        "publishedDate": "2026-05-01T00:00:00Z",
                    }
                ],
                "costDollars": {"total": 0.007},
            },
        )

    provider = ExaProvider("mock-key", mock_client(response))
    row = provider.search(["campus"], {"published_after": "2026-01-01"}, Budget())[0]
    assert row["content_basis"] == "provider_text" and row["coverage"]["complete"] is False
    usage = provider.events[0]["usage"]
    assert usage["cost_microusd"] is None and usage["estimated_cost_microusd"] == 7000


def test_exa_fetch_freshness_contract_and_failed_url():
    def response(request):
        body = json.loads(request.content)
        assert body["maxAgeHours"] == 0 and "livecrawl" not in body
        assert body["urls"] == ["https://public.example/a"]
        return httpx.Response(200, json={"results": [], "statuses": [{"status": "error"}]})

    provider = ExaProvider("mock-key", mock_client(response), resolver=public_dns)
    rows = provider.fetch(["https://public.example/a"], {"mode": "live"}, Budget())
    assert rows[0]["status"] == "fetch_failed"


def test_serper_organic_only_and_relative_date_unknown():
    def response(request):
        assert request.url == "https://google.serper.dev/search"
        assert request.headers["X-API-KEY"] == "mock-key"
        assert json.loads(request.content) == {"q": "campus", "num": 20}
        return httpx.Response(
            200,
            json={
                "organic": [
                    {"link": "https://public.example/a", "snippet": "Campus", "date": "yesterday"}
                ],
                "answerBox": {"answer": "ignored synthesized answer"},
            },
        )

    row = SerperProvider("mock-key", mock_client(response)).search(["campus"], {}, Budget())[0]
    assert row["content"] == "Campus" and row["published_at"] is None


@pytest.mark.parametrize("provider_class", [BraveProvider, SerperProvider])
def test_unsupported_dates_refused_before_dispatch(provider_class):
    provider = provider_class("mock-key", mock_client(lambda _: pytest.fail("unexpected dispatch")))
    budget = Budget()
    with pytest.raises(WebQLError, match="post-filter"):
        provider.search(["campus"], {"published_after": "2026-01-01"}, budget)
    assert budget.counts == {}


def test_failed_search_is_not_successful_empty_and_cannot_retry_beyond_budget():
    calls = []
    provider = BraveProvider(
        "mock-key", mock_client(lambda r: calls.append(r) or httpx.Response(503))
    )
    budget = Budget({"max_search_requests": 1})
    with pytest.raises(WebQLError) as first:
        provider.search(["campus"], {}, budget)
    assert first.value.code == "provider_unavailable"
    with pytest.raises(WebQLError) as second:
        provider.search(["campus"], {}, budget)
    assert second.value.code == "budget_exhausted" and len(calls) == 1


def test_transport_timeout_retains_unknown_remote_outcome_without_retry():
    calls = []

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("mock timeout")

    provider = BraveProvider("mock-key", mock_client(timeout))
    budget = Budget()
    with pytest.raises(WebQLError) as error:
        provider.search(["campus"], {}, budget)
    assert getattr(error.value, "remote_outcome_unknown") is True
    assert provider.events[0]["status"] == "remote_outcome_unknown"
    assert provider.events[0]["usage"]["cost_microusd"] is None
    assert len(calls) == 1 and budget.counts["search_requests"] == 1


@pytest.mark.parametrize("raw", [b'{"x":1,"x":2}', b'{"x":NaN}', b"[]", b"\xff"])
def test_invalid_provider_json_is_rejected(raw):
    with pytest.raises(WebQLError):
        json_object(raw)


def test_safe_fetch_pins_public_dns_and_retains_normalized_html():
    def response(request):
        assert request.url.host == "93.184.216.34"
        assert request.headers["host"] == "public.example"
        assert request.extensions["sni_hostname"] == "public.example"
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text="<p>α &amp; β</p><script>hostile()</script><p>500 MW</p>",
        )

    row = SafeFetcher(mock_client(response), public_dns).fetch(
        ["https://public.example/a"], {}, Budget()
    )[0]
    assert row["content"] == "α & β\n500 MW"
    assert row["content_sha256"] == text_hash(row["content"])
    assert row["coverage"]["complete"] is True


@pytest.mark.parametrize(
    "target", ["http://127.0.0.1/", "http://localhost/", "https://public.example:8080/"]
)
def test_ssrf_is_refused_before_fetch_dispatch(target):
    def loopback_dns(host, port, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    budget = Budget()
    fetcher = SafeFetcher(mock_client(lambda _: pytest.fail("unexpected dispatch")), loopback_dns)
    rows = fetcher.fetch([target], {}, budget)
    assert rows[0]["error_code"] == "unauthorized" and not budget.counts


def test_redirect_to_private_address_refused_and_redirect_attempt_counted():
    def dns(host, port, **kwargs):
        addr = "127.0.0.1" if host == "127.0.0.1" else "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addr, port))]

    fetcher = SafeFetcher(
        mock_client(lambda r: httpx.Response(302, headers={"location": "http://127.0.0.1/"})), dns
    )
    budget = Budget()
    assert (
        fetcher.fetch(["https://public.example/a"], {}, budget)[0]["error_code"] == "unauthorized"
    )
    assert budget.counts["fetches"] == 1


def test_fetch_redirects_and_byte_caps_consume_actual_attempts():
    calls = []

    def response(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(302, headers={"location": "/b"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="123456")

    fetcher = SafeFetcher(mock_client(response), public_dns, max_bytes=5)
    budget = Budget()
    row = fetcher.fetch(["https://public.example/a"], {}, budget)[0]
    assert row["error_code"] == "invalid_output" and budget.counts["fetches"] == 2


def test_structured_match_false_unknown_and_unprocessed_are_distinct():
    provider = PydanticSemanticProvider(
        model_output({"value": False, "status": "processed", "support": []})
    )
    budget = Budget()
    result = provider.semantic("SEM_MATCH", "No campus here", "is a campus", {}, {}, budget)
    assert result.value is False and result.status == "processed"
    assert result.usage["input_tokens"] == 12 and budget.counts["model_requests"] == 1
    provider = PydanticSemanticProvider(
        model_output({"value": None, "status": "unknown", "support": []})
    )
    assert (
        provider.semantic("SEM_MATCH", "Unclear", "is a campus", {}, {}, Budget()).status
        == "unknown"
    )
    assert (
        provider.semantic("SEM_MATCH", None, "is a campus", {}, {}, Budget()).status
        == "unprocessed"
    )


def test_quote_coordinates_and_input_windows_are_exact():
    text = "α Campus 500 MW"
    provider = PydanticSemanticProvider(
        model_output(
            {
                "value": "500",
                "status": "supported_text",
                "support": [{"quote": "500 MW", "start": 9, "end": 15, "field": "value"}],
            }
        )
    )
    good = provider.semantic(
        "SEM_EXTRACT", text, "capacity", {}, {"source_version_id": "source-v1"}, Budget()
    )
    assert good.value == "500" and good.support[0]["content_sha256"] == text_hash(text)
    assert good.support[0]["source_version_id"] == "source-v1"
    invalid = provider.semantic("SEM_EXTRACT", text, "capacity", {}, {"window_chars": 10}, Budget())
    assert invalid.value is None and invalid.status == "evidence_invalid"


def test_unsupported_or_invented_support_fails_instead_of_returning_value():
    provider = PydanticSemanticProvider(
        model_output(
            {
                "value": "900",
                "status": "supported_text",
                "support": [{"quote": "900 MW", "start": 0, "end": 6, "field": "value"}],
            }
        )
    )
    result = provider.semantic("SEM_EXTRACT", "500 MW", "capacity", {}, {}, Budget())
    assert result.value is None and result.status == "evidence_invalid"
    budget = Budget()
    with pytest.raises(WebQLError):
        provider.semantic("SEM_EXTRACT", "500 MW", "capacity", {}, {"type": "UUID"}, budget)
    assert budget.counts == {}


def test_all_named_fields_preserve_items_and_field_support():
    output = {
        "value": [{"name": "Aurora", "capacity": "500"}],
        "status": "supported_text",
        "support": [
            {"quote": "Aurora", "start": 0, "end": 6, "field": "name", "item": 0},
            {"quote": "500", "start": 7, "end": 10, "field": "capacity", "item": 0},
        ],
    }
    provider = PydanticSemanticProvider(model_output(output))
    result = provider.semantic(
        "SEM_EXTRACT_ALL", "Aurora 500", "campus", {"name": "name", "capacity": "MW"}, {}, Budget()
    )
    assert result.value == [{"name": "Aurora", "capacity": "500"}]


def test_model_validation_retry_consumes_same_shared_allowance():
    calls = []

    def response(messages, info):
        calls.append(messages)
        value = "wrong type" if len(calls) == 1 else False
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"value": value, "status": "processed", "support": []},
                )
            ]
        )

    provider = PydanticSemanticProvider(FunctionModel(response), retries=1)
    budget = Budget({"max_model_requests": 2})
    result = provider.semantic("SEM_MATCH", "text", "is campus", {}, {}, budget)
    assert result.value is False and budget.counts["model_requests"] == 2
    assert len(calls) == 2
    budget = Budget({"max_model_requests": 0})
    with pytest.raises(WebQLError) as error:
        provider.semantic("SEM_MATCH", "text", "is campus", {}, {}, budget)
    assert error.value.code == "budget_exhausted" and len(calls) == 2


def test_collection_norm_is_complete_and_scope_is_retained():
    provider = PydanticSemanticProvider(
        model_output(
            {
                "entries": [
                    {"original": "Aurora", "normalized": "Aurora Campus"},
                    {"original": "Birch", "normalized": None},
                ]
            }
        )
    )
    result = provider.semantic(
        "SEM_NORM", ["Aurora", "Birch", "Aurora"], "same campus", {}, {}, Budget()
    )
    assert result.value == ["Aurora Campus", None, "Aurora Campus"]
    assert result.usage["interpretation_scope"] == "collection"
    bad = provider.semantic("SEM_NORM", ["Other"], "same campus", {}, {}, Budget())
    assert bad.status == "invalid_output" and bad.value is None


def test_configured_embeddings_are_scored_without_lexical_substitution():
    def response(request):
        assert json.loads(request.content)["input"] == ["campus", "grid agreement"]
        return httpx.Response(
            200,
            json={
                "data": [{"index": 1, "embedding": [0, 1]}, {"index": 0, "embedding": [1, 1]}],
                "usage": {"total_tokens": 4},
            },
        )

    provider = OpenAIEmbeddingProvider("mock-embedding", "mock-key", mock_client(response))
    budget = Budget()
    result = provider.score("campus", "grid agreement", {}, budget)
    assert result.value == pytest.approx(2**-0.5)
    assert result.usage["model"] == "mock-embedding"
    assert budget.counts["model_requests"] == 1 and budget.counts["input_tokens"] == 4


def test_live_guard_refuses_before_any_dispatch_without_grant():
    provider = ProviderRegistry(
        {
            "mode": "live",
            "provider": "brave",
            "api_key": "mock-key",
            "http_client": mock_client(lambda _: pytest.fail("unexpected dispatch")),
        }
    )
    budget = Budget()
    with pytest.raises(WebQLError) as error:
        provider.search(["campus"], {}, budget)
    assert error.value.code == "unauthorized" and budget.counts == {}


def test_strict_metering_and_unconfigured_scorer_refused_before_dispatch():
    config = {
        "mode": "live",
        "provider": "brave",
        "api_key": "mock-key",
        "allow_live": True,
        "approved_cost_microusd": 1000,
        "http_client": mock_client(lambda _: pytest.fail("unexpected dispatch")),
    }
    provider = ProviderRegistry(config)
    budget = Budget({"max_cost_microusd": 1000})
    with pytest.raises(WebQLError) as error:
        provider.search(["campus"], {}, budget)
    assert error.value.code == "unsupported_capability" and budget.counts == {}
    provider = ProviderRegistry({**config, "metering_policy": "estimated"})
    with pytest.raises(WebQLError):
        provider.semantic("SEM_SCORE", "text", "criterion", {}, {}, budget)
    assert budget.counts == {}


def test_configured_openai_constructor_uses_sdk_transport_and_no_hidden_retries():
    import asyncio

    provider = PydanticSemanticProvider.openai("configured-model", "mock-key")
    assert provider.model.client.max_retries == 0
    assert provider.events == []
    asyncio.run(provider.model.client.close())


def test_duplicate_structured_model_json_and_failed_schema_usage_are_retained():
    def response(messages, info):
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    '{"value":true,"value":false,"status":"processed","support":[]}',
                )
            ],
            usage=RequestUsage(input_tokens=10, output_tokens=4),
        )

    provider = PydanticSemanticProvider(FunctionModel(response))
    budget = Budget()
    result = provider.semantic("SEM_MATCH", "text", "campus", {}, {}, budget)
    assert result.status == "invalid_output" and result.value is None
    assert budget.counts["input_tokens"] == 10 and budget.counts["output_tokens"] == 4
    assert result.usage["input_tokens"] == 10


def test_redirect_cannot_escape_trusted_destination_permissions():
    fetcher = SafeFetcher(
        mock_client(
            lambda r: httpx.Response(302, headers={"location": "https://different.example/a"})
        ),
        public_dns,
        allowed_hosts=["public.example"],
    )
    budget = Budget()
    result = fetcher.fetch(["https://public.example/a"], {}, budget)
    assert result[0]["error_code"] == "unauthorized" and budget.counts["fetches"] == 1


def test_document_assurance_keeps_redirected_source_and_search_membership():
    def search(request):
        return httpx.Response(
            200,
            json={
                "web": {"results": [{"url": "https://public.example/a", "description": "excerpt"}]}
            },
        )

    def fetch(request):
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": "/b"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="retained document")

    provider = ProviderRegistry(
        {
            "mode": "live",
            "provider": "brave",
            "api_key": "mock-key",
            "http_client": mock_client(search),
            "fetch_client": mock_client(fetch),
            "resolver": public_dns,
            "allow_live": True,
            "approved_cost_microusd": 1000,
            "metering_policy": "estimated",
            "allowed_source_hosts": ["public.example"],
        }
    )
    budget = Budget({"max_cost_microusd": 1000})
    row = provider.search(["campus"], {"source_mode": "require_document"}, budget)[0]
    assert row["url"] == "https://public.example/b"
    assert row["content"] == "retained document" and row["coverage"]["complete"]
    assert row["hits"][0]["url"] == "https://public.example/a"
    assert budget.counts["fetches"] == 2
