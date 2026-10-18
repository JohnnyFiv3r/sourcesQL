"""Mock-only DeepSeek acquisition, accounting and failure-certainty contracts."""

import json
import socket

import httpx
import pytest

from sourcesql.contracts import Budget as EngineBudget, SourcesQLError
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.deepseek import DeepSeekProvider


def funded(limits=None):
    return EngineBudget({"max_cost_microusd": 100_000, **(limits or {})})


def hit(**changes):
    return {
        "url": "https://official.example/article",
        "title": "Article",
        "snippet": "Discovery snippet.",
        "summary": "Discovery summary.",
        "content": "Original page content.",
        "date": "2026-10-01T00:00:00Z",
        "rerank_score": 0.01,
        "authority": -1,
        **changes,
    }


def provider(handler, key="synthetic", resolver=None):
    return DeepSeekProvider(
        key,
        httpx.Client(transport=httpx.MockTransport(handler), trust_env=False),
        resolver,
    )


def public_dns(host, port, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))]


def test_fixed_post_contract_retains_content_and_unthresholded_discovery_metadata():
    calls, budget = [], funded()

    def respond(request):
        assert budget.counts == {
            "search_queries": 1,
            "search_requests": 1,
            "estimated_provider_cost_microusd": 750,
        }
        calls.append(request)
        return httpx.Response(200, json={"results": [hit()]})

    adapter = provider(respond)
    query = 'site:official.example "quoted words" -site:other.example'
    row = adapter.search([query], {}, budget)[0]
    assert len(calls) == 1
    assert calls[0].url == "https://api.deepseek.com/v1/tools/search"
    assert calls[0].method == "POST"
    assert calls[0].headers["Authorization"] == "Bearer synthetic"
    assert json.loads(calls[0].content) == {"query": query, "count": 10, "need_content": True}
    assert row["content"] == "Original page content."
    assert row["content_basis"] == "provider_text"
    assert row["coverage"]["complete"] is False
    assert row["provider_metadata"] == {
        "summary": "Discovery summary.",
        "rerank_score": 0.01,
        "authority": -1,
    }
    assert row["published_at"] == "2026-10-01T00:00:00Z"
    assert row["search_hits"][0]["query"] == query
    assert row["search_hits"][0]["rank"] == 1
    assert row["search_hit_count"] == 1
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 750
    assert "synthetic" not in json.dumps(adapter.events)


@pytest.mark.parametrize("content", ["", " \n ", None])
def test_summaries_are_never_quoted_when_page_content_is_absent(content):
    adapter = provider(lambda _: httpx.Response(200, json={"results": [hit(content=content)]}))
    row = adapter.search(["question"], {}, funded())[0]
    assert row["content"] is None and row["windows"] == []
    assert row["content_sha256"] is None
    assert row["snippet"] == "Discovery snippet."
    assert row["provider_metadata"]["summary"] == "Discovery summary."


@pytest.mark.parametrize(
    "queries", [["ok", "x" * 129], ["ok", " "], ["ok", 12], ["ok", "\udfff"], []]
)
def test_whole_query_batch_is_validated_before_any_reservation_or_http(queries):
    calls, budget = [], funded()
    adapter = provider(lambda request: calls.append(request))
    with pytest.raises(SourcesQLError) as caught:
        adapter.search(queries, {}, budget)
    assert caught.value.code == "invalid_request"
    assert calls == [] and budget.counts == {} and adapter.events == []


def test_128_unicode_codepoints_and_fifty_results_are_admitted_without_truncation():
    calls = []

    def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"results": []})

    adapter = provider(respond)
    adapter.search(["🐇" * 128], {"per_query_limit": 50}, funded())
    assert calls == [{"query": "🐇" * 128, "count": 50, "need_content": True}]
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 0


@pytest.mark.parametrize(
    "options",
    [
        {"per_query_limit": 51},
        {"per_query_limit": 0},
        {"per_query_limit": True},
        {"query_time": "2026-01-01"},
        {"published_after": "2026-01-01", "undated_policy": "exclude"},
        {"published_after": "2026-01-01", "allow_post_filter": True},
        {"published_after": "nonsense", "allow_post_filter": True, "undated_policy": "include"},
        {"include_domains": "official.example"},
        {"exclude_domains": ["https://official.example"]},
    ],
)
def test_invalid_options_fail_before_http_or_reservations(options):
    calls, budget = [], funded()
    adapter = provider(lambda request: calls.append(request))
    with pytest.raises(SourcesQLError):
        adapter.search(["question"], options, budget)
    assert calls == [] and budget.counts == {} and adapter.events == []


def test_post_filters_keep_original_rank_and_report_returned_vs_retained_counts():
    calls = []

    def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "results": [
                    hit(url="https://other.example/a"),
                    hit(url="https://news.official.example/b", date="2025-01-01T00:00:00Z"),
                    hit(url="https://official.example/c", date=None),
                    hit(url="https://sub.official.example/d"),
                    hit(url="https://spam.official.example/e"),
                ]
            },
        )

    adapter = provider(respond)
    rows = adapter.search(
        ["query"],
        {
            "include_domains": ["OFFICIAL.example"],
            "exclude_domains": ["spam.official.example"],
            "published_after": "2026-01-01",
            "undated_policy": "exclude",
            "allow_post_filter": True,
        },
        funded(),
    )
    assert [row["url"] for row in rows] == ["https://sub.official.example/d"]
    assert rows[0]["best_search_rank"] == 4
    assert calls == [{"query": "query", "count": 10, "need_content": True}]
    coverage = adapter.search_coverage[0]["queries"][0]
    assert (coverage["returned_hits"], coverage["retained_hits"]) == (5, 1)
    assert adapter.capabilities()["publication_filters"] == "post_filter"


@pytest.mark.parametrize(
    "mutation,field",
    [
        ({"content": 4}, "content"),
        ({"summary": ["invalid"]}, "summary"),
        ({"rerank_score": 7}, "rerank_score"),
        ({"rerank_score": True}, "rerank_score"),
        ({"authority": "4"}, "authority"),
    ],
)
def test_bad_optional_search_fields_retain_hit_and_neighbors_with_completed_paid_usage(
    mutation, field
):
    adapter = provider(
        lambda _: httpx.Response(
            200,
            json={
                "results": [
                    hit(url="https://official.example/first"),
                    hit(url="https://official.example/partial", **mutation),
                    hit(url="https://official.example/last"),
                ]
            },
        )
    )
    rows = adapter.search(["query"], {}, funded())
    assert len(rows) == 3
    assert rows[1]["provider_metadata"]["unavailable_fields"] == [field]
    if field == "content":
        assert rows[1]["content"] is None and rows[1]["windows"] == []
        assert rows[1]["content_basis"] is None
    assert adapter.events[0]["status"] == "completed"
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 750
    assert adapter.search_coverage[0]["queries"][0]["status"] == "completed"


@pytest.mark.parametrize("incomplete", [{"title": None, "content": None}, {"title": None}, {}])
def test_missing_page_text_and_nullable_title_remain_metadata_only(incomplete):
    metadata = {key: value for key, value in hit().items() if key not in {"title", "content"}}
    metadata.update(incomplete)
    adapter = provider(
        lambda _: httpx.Response(
            200, json={"results": [metadata, hit(url="https://official.example/valid")]}
        )
    )
    rows = adapter.search(["query"], {}, funded())
    assert len(rows) == 2 and rows[1]["content"] == "Original page content."
    assert rows[0]["title"] is None and rows[0]["content"] is None
    assert rows[0]["windows"] == [] and rows[0]["content_sha256"] is None
    assert (
        rows[0]["provider_metadata"]["content_unavailable_reason"]
        == "provider_page_text_unavailable"
    )


@pytest.mark.parametrize(
    "bad_hit", [None, False, {}, {"url": False}, {"url": "file:///etc/passwd"}]
)
def test_unidentifiable_search_hits_are_omitted_without_renumbering_valid_neighbors(bad_hit):
    adapter = provider(
        lambda _: httpx.Response(
            200,
            json={
                "results": [
                    hit(url="https://official.example/first"),
                    bad_hit,
                    hit(url="https://official.example/last"),
                ]
            },
        )
    )
    rows = adapter.search(["query"], {}, funded())
    assert [row["best_search_rank"] for row in rows] == [1, 3]
    coverage = adapter.search_coverage[0]["queries"][0]
    assert (coverage["returned_hits"], coverage["retained_hits"], coverage["omitted_hits"]) == (
        3,
        2,
        1,
    )
    assert adapter.events[0]["status"] == "completed"
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 750


@pytest.mark.parametrize(
    "response,expected,cost",
    [
        (httpx.Response(402, json={"message": "PRIVATE"}), "failed", 0),
        (httpx.Response(429, json={"message": "PRIVATE"}), "failed", 0),
        (httpx.Response(302, headers={"Location": "https://private.example/"}), "failed", 0),
        (httpx.Response(200, content=b"invalid-json"), "completed_validation_failed", None),
    ],
)
def test_known_refusals_parse_failures_and_redirects_are_distinct_without_retries(
    response, expected, cost
):
    calls = []

    def respond(request):
        calls.append(request)
        return response

    adapter = provider(respond)
    with pytest.raises(SourcesQLError):
        adapter.search(["query", "unstarted"], {}, funded())
    assert len(calls) == 1
    assert adapter.events[0]["status"] == expected
    assert adapter.events[0]["usage"].get("estimated_cost_microusd") == cost
    assert adapter.search_coverage[0]["queries"][1]["status"] == "not_dispatched"
    assert "PRIVATE" not in json.dumps(adapter.events)


def test_timeout_outcome_and_cost_remain_unknown_without_touching_other_events():
    calls = []

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("PRIVATE", request=request)

    adapter = provider(timeout)
    adapter.events.append({"status": "completed", "search_id": "unrelated", "query_index": 0})
    with pytest.raises(SourcesQLError) as caught:
        adapter.search(["query", "unstarted"], {}, funded())
    assert len(calls) == 1 and caught.value.effect_state == "outcome_unknown"
    assert adapter.events[0]["status"] == "completed"
    assert adapter.events[1]["status"] == "remote_outcome_unknown"
    assert adapter.events[1]["usage"].get("estimated_cost_microusd") is None


def test_later_query_failure_preserves_first_query_paid_usage_and_hits():
    calls = []

    def respond(request):
        calls.append(request)
        return (
            httpx.Response(200, json={"results": [hit()]})
            if len(calls) == 1
            else httpx.Response(429)
        )

    adapter = provider(respond)
    with pytest.raises(SourcesQLError):
        adapter.search(["first", "second", "unstarted"], {}, funded())
    assert len(calls) == 2 and len(adapter.hits) == 1
    assert [event["status"] for event in adapter.events] == ["completed", "failed"]
    assert [event["usage"]["estimated_cost_microusd"] for event in adapter.events] == [750, 0]
    assert [query["status"] for query in adapter.search_coverage[0]["queries"]] == [
        "completed",
        "failed",
        "not_dispatched",
    ]


@pytest.mark.parametrize("cause", ["credential", "cancelled", "request_limit", "deadline"])
def test_no_effect_when_dispatch_is_forbidden(cause):
    calls = []
    adapter = provider(
        lambda request: calls.append(request), key="" if cause == "credential" else "synthetic"
    )
    budget = funded(
        {"max_search_requests": 0}
        if cause == "request_limit"
        else {"dispatch_deadline_seconds": 0}
        if cause == "deadline"
        else {}
    )
    budget.cancelled = cause == "cancelled"
    with pytest.raises(SourcesQLError):
        adapter.search(["query"], {}, budget)
    assert calls == []


def test_fetch_uses_native_fixed_endpoint_normalized_url_and_incomplete_markdown():
    calls, budget = [], funded()

    def respond(request):
        assert budget.counts == {"fetches": 1, "estimated_provider_cost_microusd": 750}
        calls.append(request)
        return httpx.Response(200, json={"title": "Fetched", "content": "# Heading\n\nPage body."})

    adapter = provider(respond, resolver=public_dns)
    row = adapter.fetch(["https://OFFICIAL.example:443/article#section"], {}, budget)[0]
    assert calls[0].url == "https://api.deepseek.com/v1/tools/fetch"
    assert json.loads(calls[0].content) == {"url": "https://official.example/article"}
    assert row["url"] == "https://official.example/article"
    assert row["content"] == "# Heading\nPage body."
    assert row["content_basis"] == "provider_text" and not row["coverage"]["complete"]
    assert row["acquisition_mode"] == "cache_preferred"
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 750


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://user:secret@public.example/",
        "https://public.example:8443/",
        "https://localhost/",
        "https://public.example/" + "x" * 8192,
    ],
)
def test_fetch_rejects_unsafe_or_oversized_url_before_disclosure(url):
    calls, budget = [], funded()
    adapter = provider(lambda request: calls.append(request), resolver=public_dns)
    with pytest.raises(SourcesQLError):
        adapter.fetch(["https://official.example/", url], {}, budget)
    assert calls == [] and budget.counts == {}


def test_fetch_rejects_mixed_private_dns_answers_before_disclosure():
    calls = []

    def mixed_dns(host, port, **kwargs):
        return public_dns(host, port) + [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))
        ]

    adapter = provider(lambda request: calls.append(request), resolver=mixed_dns)
    with pytest.raises(SourcesQLError) as caught:
        adapter.fetch(["https://official.example/"], {}, funded())
    assert caught.value.code == "unauthorized" and calls == []


def test_live_fetch_refuses_unsupported_freshness_without_silently_using_cache():
    calls, budget = [], funded()
    adapter = provider(lambda request: calls.append(request), resolver=public_dns)
    with pytest.raises(SourcesQLError) as caught:
        adapter.fetch(["https://official.example/"], {"mode": "live"}, budget)
    assert caught.value.code == "unsupported_capability" and calls == [] and budget.counts == {}


def test_empty_fetch_is_unavailable_and_has_zero_estimated_charge():
    adapter = provider(
        lambda _: httpx.Response(200, json={"title": "", "content": ""}), resolver=public_dns
    )
    row = adapter.fetch(["https://official.example/"], {}, funded())[0]
    assert row["status"] == "fetch_failed" and row["content"] is None
    assert adapter.events[0]["status"] == "completed"
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 0


@pytest.mark.parametrize(
    "body,estimate,acquired",
    [
        ({"title": "Bad", "content": 1}, None, False),
        ({"title": None, "content": None}, None, False),
        ({"title": "Bad"}, None, False),
        ({"title": False, "content": "Source text."}, 750, True),
        ({"title": None, "content": "Source text."}, 750, True),
        ({"content": "Source text."}, 750, True),
        ({"title": "Bad", "content": "\udfff"}, 750, False),
    ],
)
def test_malformed_fetch_content_is_a_failed_row_and_valid_neighbors_are_retained(
    body, estimate, acquired
):
    calls = []

    def respond(request):
        calls.append(request)
        response = body if len(calls) == 2 else {"title": "Valid", "content": "Neighbor text."}
        return httpx.Response(200, content=json.dumps(response).encode())

    adapter = provider(respond, resolver=public_dns)
    urls = [
        "https://official.example/first",
        "https://official.example/partial",
        "https://official.example/last",
    ]
    rows = adapter.fetch(urls, {}, funded())
    assert len(calls) == 3 and len(rows) == 3
    assert [row["url"] for row in rows] == urls
    assert [rows[0]["content"], rows[2]["content"]] == ["Neighbor text."] * 2
    assert rows[1]["status"] == ("acquired" if acquired else "fetch_failed")
    if acquired:
        assert rows[1]["title"] is None and rows[1]["content"] == "Source text."
    else:
        assert rows[1]["content"] is None and rows[1]["error_code"] == "invalid_output"
    assert all(event["status"] == "completed" for event in adapter.events)
    assert adapter.events[1]["usage"].get("estimated_cost_microusd") == estimate


@pytest.mark.parametrize("response", [httpx.Response(402), httpx.Response(429)])
def test_fetch_provider_refusal_stops_without_retrying_or_dispatching_later_url(response):
    calls = []

    def respond(request):
        calls.append(request)
        return (
            httpx.Response(200, json={"content": "First source text."})
            if len(calls) == 1
            else response
        )

    adapter = provider(respond, resolver=public_dns)
    with pytest.raises(SourcesQLError) as caught:
        adapter.fetch(
            [
                "https://official.example/first",
                "https://official.example/refused",
                "https://official.example/unstarted",
            ],
            {},
            funded(),
        )
    assert len(calls) == 2
    assert caught.value.effect_state == "rejected" and not caught.value.remote_outcome_unknown
    assert [event["status"] for event in adapter.events] == ["completed", "failed"]


def test_search_and_fetch_share_the_same_attempt_reservation_without_refunding_empty_calls():
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"results": []})

    adapter, budget = provider(respond, resolver=public_dns), funded({"max_cost_microusd": 750})
    assert adapter.search(["empty"], {}, budget) == []
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 0
    assert budget.counts["estimated_provider_cost_microusd"] == 750
    with pytest.raises(SourcesQLError) as caught:
        adapter.fetch(["https://official.example/"], {}, budget)
    assert len(calls) == 1
    assert caught.value.code == "budget_exhausted"
    assert caught.value.effect_state == "not_dispatched"
    assert adapter.events[-1]["status"] == "not_dispatched"
    assert adapter.events[-1]["usage"].get("estimated_cost_microusd") is None


def test_custom_request_reservation_uses_reviewed_estimate_not_provider_claims():
    calls, budget = [], funded({"max_cost_microusd": 2_000})
    adapter = DeepSeekProvider(
        "synthetic",
        httpx.Client(
            transport=httpx.MockTransport(
                lambda request: calls.append(request) or httpx.Response(200, json={"results": []})
            )
        ),
        request_cost_microusd=1_000,
    )
    adapter.search(["first", "second"], {}, budget)
    assert len(calls) == 2 and budget.counts["estimated_provider_cost_microusd"] == 2_000
    assert all(event["usage"]["estimated_cost_microusd"] == 0 for event in adapter.events)
    assert all(event["reservation_microusd"] == 1_000 for event in adapter.events)


@pytest.mark.parametrize("estimate", [0, -1, 749, 1.5, True, "750"])
def test_invalid_request_estimate_refuses_before_transport(estimate):
    with pytest.raises(SourcesQLError) as caught:
        DeepSeekProvider("synthetic", request_cost_microusd=estimate)
    assert caught.value.code == "invalid_request"


@pytest.mark.parametrize(
    "invalid_url",
    [
        "https://official.example/" + "x" * 8192,
        "https://official.example/path\udfff",
        "https://official.example/?q=\udfff",
    ],
)
def test_registry_validates_complete_native_fetch_batch_before_checkpoint_splitting(invalid_url):
    calls, stages, budget = [], [], funded()
    registry = ProviderRegistry(
        {
            "mode": "live",
            "provider": "deepseek",
            "api_key": "synthetic",
            "fetch_adapter": "deepseek",
            "resolver": public_dns,
            "allow_public_source_hosts": True,
            "allow_live": True,
            "approved_cost_microusd": 100_000,
            "metering_policy": "estimated",
            "http_client": httpx.Client(
                transport=httpx.MockTransport(
                    lambda request: (
                        calls.append(request)
                        or httpx.Response(
                            200,
                            json={
                                "title": "Would spend",
                                "content": "Source text.",
                            },
                        )
                    )
                )
            ),
        }
    )

    def stage_call(operator, arguments, options, dispatch):
        stages.append(arguments)
        return dispatch(), False

    registry.stage_call = stage_call
    with pytest.raises(SourcesQLError) as caught:
        registry.fetch(
            [
                "https://official.example/first",
                invalid_url,
            ],
            {},
            budget,
        )
    assert caught.value.code == "invalid_request"
    assert calls == [] and stages == [] and budget.counts == {}


def test_registry_rejects_later_surrogate_query_before_checkpoint_splitting():
    calls, stages, budget = [], [], funded()
    registry = ProviderRegistry(
        {
            "mode": "live",
            "provider": "deepseek",
            "api_key": "synthetic",
            "allow_live": True,
            "approved_cost_microusd": 100_000,
            "metering_policy": "estimated",
            "http_client": httpx.Client(
                transport=httpx.MockTransport(
                    lambda request: (
                        calls.append(request) or httpx.Response(200, json={"results": []})
                    ),
                )
            ),
        }
    )

    def stage_call(operator, arguments, options, dispatch):
        stages.append(arguments)
        return dispatch(), False

    registry.stage_call = stage_call
    with pytest.raises(SourcesQLError) as caught:
        registry.search(["first valid query", "invalid \udfff"], {}, budget)
    assert caught.value.code == "invalid_request"
    assert calls == [] and stages == [] and budget.counts == {}


@pytest.mark.parametrize("body", [{}, {"results": None}, {"results": "invalid"}])
def test_successful_search_with_invalid_shape_has_unknown_cost_but_known_completed_effect(body):
    adapter = provider(lambda _: httpx.Response(200, json=body))
    with pytest.raises(SourcesQLError) as caught:
        adapter.search(["query"], {}, funded())
    assert caught.value.effect_state == "completed_unretained"
    assert caught.value.remote_outcome_unknown is False
    assert adapter.events[0]["status"] == "completed"
    assert adapter.events[0]["usage"].get("estimated_cost_microusd") is None


def test_invalid_date_is_unavailable_without_replacing_it_with_retrieval_time():
    adapter = provider(lambda _: httpx.Response(200, json={"results": [hit(date="unknown")]}))
    row = adapter.search(["query"], {}, funded())[0]
    assert row["published_at"] is None and row["provider_acquired_at"] is None
    assert isinstance(row["retrieved_at"], str)


@pytest.mark.parametrize("field", ["title", "summary", "content", "url"])
def test_malformed_unicode_remains_unavailable_or_omitted_after_completed_search(field):
    adapter = provider(
        lambda _: httpx.Response(
            200,
            content=json.dumps(
                {"results": [hit(**{field: "\udfff"}), hit(url="https://official.example/valid")]}
            ).encode(),
        )
    )
    rows = adapter.search(["query"], {}, funded())
    assert len(rows) == (1 if field == "url" else 2)
    if field != "url":
        assert rows[0]["provider_metadata"]["unavailable_fields"] == [field]
    assert rows[-1]["content"] == "Original page content."
    assert adapter.events[0]["status"] == "completed"
    assert adapter.events[0]["usage"]["estimated_cost_microusd"] == 750


@pytest.mark.parametrize("operation", ["search", "fetch"])
def test_complete_document_requirement_refuses_before_paid_work_even_if_content_available(
    operation,
):
    calls, budget = [], funded()

    def respond(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "results": [hit()],
                "title": "Source",
                "content": "Page content is available.",
            },
        )

    adapter = provider(respond, resolver=public_dns)
    method = adapter.search if operation == "search" else adapter.fetch
    arguments = ["query"] if operation == "search" else ["https://official.example/"]
    with pytest.raises(SourcesQLError) as caught:
        method(arguments, {"source_mode": "require_document"}, budget)
    assert caught.value.code == "unsupported_capability"
    assert calls == [] and adapter.events == [] and budget.counts == {}
    assert adapter.capabilities()["source_modes"] == ["allow_excerpt"]


def test_prepared_fetch_checks_each_unique_normalized_url_once_before_dispatch():
    lookups, calls = [], []

    def resolve(host, port, **kwargs):
        lookups.append(host)
        return public_dns(host, port, **kwargs)

    adapter = provider(
        lambda request: (
            calls.append(request) or httpx.Response(200, json={"content": "Source text."})
        ),
        resolver=resolve,
    )
    prepared = adapter.prepare_fetch(
        [
            "https://official.example/a",
            "https://official.example/b",
            "https://OFFICIAL.example:443/a#fragment",
        ],
        {},
    )
    assert len(lookups) == 2 and calls == []
    for index in range(3):
        assert adapter.fetch_prepared(prepared, funded(), index=index)[0]["status"] == "acquired"
    assert len(lookups) == 2 and len(calls) == 3


def test_prepared_batches_are_adapter_bound_and_copy_original_inputs():
    calls = []
    adapter = provider(
        lambda request: calls.append(request) or httpx.Response(200, json={"results": []}),
        resolver=public_dns,
    )
    queries = ["original"]
    prepared = adapter.prepare_search(queries, {})
    queries[0] = "changed"
    adapter.search_prepared(prepared, funded(), index=0, per_query_limit=2)
    assert json.loads(calls[0].content)["query"] == "original"
    other = provider(
        lambda _: pytest.fail("Foreign prepared batch must not dispatch"), resolver=public_dns
    )
    with pytest.raises(SourcesQLError):
        other.search_prepared(prepared, funded())
    with pytest.raises(SourcesQLError):
        adapter.search_prepared(prepared, funded(), per_query_limit=11)
    with pytest.raises(SourcesQLError):
        adapter.search_prepared(prepared, funded(), index=-1)
    fetch = adapter.prepare_fetch(["https://official.example/"], {})
    with pytest.raises(SourcesQLError):
        other.fetch_prepared(fetch, funded())
    assert len(calls) == 1


def test_nonempty_response_reports_published_estimate_separately_from_larger_reservation():
    adapter = DeepSeekProvider(
        "synthetic",
        httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"results": [hit()]}))
        ),
        request_cost_microusd=1_000,
    )
    budget = funded()
    adapter.search(["query"], {}, budget)
    event = adapter.events[0]
    assert event["reservation_microusd"] == 1_000
    assert event["usage"]["estimated_cost_microusd"] == 750
    assert budget.counts["estimated_provider_cost_microusd"] == 1_000


@pytest.mark.parametrize("status", [403, 404])
def test_known_per_url_fetch_refusal_keeps_failed_event_and_continues_neighbors(status):
    calls = []

    def respond(request):
        calls.append(request)
        return (
            httpx.Response(status)
            if len(calls) == 2
            else httpx.Response(200, json={"content": "Available source text."})
        )

    adapter = provider(respond, resolver=public_dns)
    rows = adapter.fetch(
        [
            "https://official.example/first",
            "https://official.example/unavailable",
            "https://official.example/last",
        ],
        {},
        funded(),
    )
    assert len(calls) == 3
    assert [row["status"] for row in rows] == ["acquired", "fetch_failed", "acquired"]
    assert rows[1]["content"] is None and rows[1]["error_code"] == "provider_unavailable"
    assert [event["status"] for event in adapter.events] == ["completed", "failed", "completed"]
    assert adapter.events[1]["http_status"] == status
    assert adapter.events[1]["usage"]["estimated_cost_microusd"] == 0


def test_fetch_transport_timeout_stops_with_unknown_outcome_and_no_retry():
    calls = []

    def respond(request):
        calls.append(request)
        raise httpx.ReadTimeout("PRIVATE", request=request)

    adapter = provider(respond, resolver=public_dns)
    with pytest.raises(SourcesQLError) as caught:
        adapter.fetch(
            ["https://official.example/unknown", "https://official.example/unstarted"], {}, funded()
        )
    assert len(calls) == 1 and caught.value.effect_state == "outcome_unknown"
    assert caught.value.remote_outcome_unknown is True
    assert adapter.events[0]["status"] == "remote_outcome_unknown"
    assert adapter.events[0]["usage"].get("estimated_cost_microusd") is None
    assert adapter.events[0]["reservation_microusd"] == 750
    assert "PRIVATE" not in json.dumps(adapter.events)


@pytest.mark.parametrize("unapproved", ["https://other.example/", "https://sub.official.example/"])
def test_prepared_fetch_enforces_trusted_exact_host_allowlist_before_any_dns(unapproved):
    lookups, calls = [], []

    def resolve(host, port, **kwargs):
        lookups.append(host)
        return public_dns(host, port, **kwargs)

    adapter = provider(lambda request: calls.append(request), resolver=resolve)
    with pytest.raises(SourcesQLError) as caught:
        adapter.prepare_fetch(
            ["https://official.example/first", unapproved], {}, allowed_hosts=["official.example"]
        )
    assert caught.value.code == "unauthorized"
    assert lookups == [] and calls == []
    prepared = adapter.prepare_fetch(
        ["https://official.example/"], {}, allowed_hosts=["OFFICIAL.example."]
    )
    assert prepared.urls == ("https://official.example/",) and lookups == ["official.example"]
