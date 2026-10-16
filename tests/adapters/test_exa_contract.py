"""Current Exa HTTP contracts; synthetic responses only, no credentials or spending."""

from __future__ import annotations

import json
import socket
import threading
import time

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ExaProvider, ProviderRegistry
from sourcesql.providers.search import BraveProvider, SerperProvider


def public_dns(host, port, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)


def profile(http_client):
    return {
        "mode": "live",
        "provider": "exa",
        "api_key": "synthetic-key",
        "http_client": http_client,
        "resolver": public_dns,
        "allow_live": True,
        "approved_cost_microusd": 10000,
        "metering_policy": "estimated",
        "fetch_adapter": "exa",
        "allowed_source_hosts": ["public.example"],
    }


def test_one_three_hit_search_retains_source_citations_without_fetch_or_model():
    requests = []

    def respond(request):
        requests.append(request)
        assert str(request.url) == "https://api.exa.ai/search"
        assert request.headers["x-api-key"] == "synthetic-key"
        assert json.loads(request.content) == {
            "query": "synthetic campus query",
            "numResults": 3,
            "type": "auto",
            "contents": {"highlights": True},
        }
        return httpx.Response(
            200,
            json={
                "requestId": "synthetic-request",
                "results": [
                    {
                        "id": f"exa-document-{i}",
                        "url": f"https://public.example/{i}#fragment",
                        "title": f"Campus {i}",
                        "highlights": [f"Original source {i}. Planned capacity 500 MW."],
                        "publishedDate": "2026-10-01T12:30:00Z" if i != 1 else "yesterday",
                    }
                    for i in range(4)
                ],
                "costDollars": {"total": 0.007},
                "output": {"content": "Unrequested synthesis is never source evidence."},
            },
        )

    registry = ProviderRegistry(profile(client(respond)))
    budget = Budget(
        {
            "max_search_queries": 1,
            "max_search_requests": 1,
            "max_candidates": 3,
            "max_fetches": 0,
            "max_model_requests": 0,
            "max_cost_microusd": 10000,
        }
    )
    rows = registry.search(
        ["synthetic campus query"], {"per_query_limit": 3, "source_mode": "allow_excerpt"}, budget
    )
    assert len(requests) == len(registry.events) == 1
    assert len(rows) == 3
    assert budget.counts == {"search_queries": 1, "search_requests": 1, "candidates": 3}
    for rank, row in enumerate(rows, 1):
        assert row["url"] == f"https://public.example/{rank - 1}"
        assert row["provider_document_id"] == f"exa-document-{rank - 1}"
        assert row["content"].startswith("Original source")
        assert row["content_basis"] == "excerpt"
        assert row["coverage"]["complete"] is False
        assert row["hits"][0]["rank"] == rank
        assert row["hits"][0]["request_id"] == "synthetic-request"
        assert row["hits"][0]["source_version_id"] == row["source_version_id"]
    assert rows[0]["published_at"] == "2026-10-01T12:30:00Z"
    assert rows[1]["published_at"] is None
    usage = registry.events[0]["usage"]
    assert usage["cost_microusd"] is None
    assert usage["estimated_cost_microusd"] == 7000
    assert usage["cost_basis"] == "provider_estimate"


@pytest.mark.parametrize("through_registry", [False, True])
@pytest.mark.parametrize("limit", [None, 3, 10, 20, 100])
def test_default_search_uses_bare_highlights_and_count_only_for_intentional_limits(
    through_registry, limit
):
    calls = []

    def respond(request):
        calls.append(request)
        expected = {
            "query": "latest campus reports from public.example",
            "type": "auto",
            "contents": {"highlights": True},
        }
        if limit not in (None, 10):
            expected["numResults"] = limit
        assert json.loads(request.content) == expected
        return httpx.Response(200, json={"results": []})

    http_client = client(respond)
    provider = (
        ProviderRegistry(profile(http_client))
        if through_registry
        else ExaProvider("synthetic", http_client)
    )
    options = {"per_query_limit": limit} if limit is not None else {}
    provider.search(
        ["latest campus reports from public.example"], options, Budget({"max_cost_microusd": 10000})
    )
    assert len(calls) == 1


def test_candidate_budget_narrows_default_search_count_before_dispatch():
    calls = []

    def respond(request):
        calls.append(request)
        assert json.loads(request.content)["numResults"] == 3
        return httpx.Response(200, json={"results": []})

    registry = ProviderRegistry(profile(client(respond)))
    registry.search(["campus"], {}, Budget({"max_candidates": 3, "max_cost_microusd": 10000}))
    assert len(calls) == 1


@pytest.mark.parametrize("policy", ["include", "error"])
def test_native_date_filters_refuse_unavailable_undated_coverage_before_spending(policy):
    provider = ExaProvider("synthetic", client(lambda _: pytest.fail("unexpected dispatch")))
    budget = Budget()
    with pytest.raises(SourcesQLError, match="undated_policy='exclude'") as error:
        provider.search(
            ["campus"],
            {"published_after": "2026-01-01", "undated_policy": policy, "allow_post_filter": True},
            budget,
        )
    assert error.value.code == "unsupported_capability"
    assert provider.events == [] and budget.counts == {}


@pytest.mark.parametrize("status", [302, 402, 429, 503])
@pytest.mark.parametrize("search_type", ["auto", "deep", "deep-reasoning"])
def test_exa_failure_never_retries_or_follows_provider_redirect(status, search_type):
    calls = []
    provider = ExaProvider(
        "synthetic",
        client(
            lambda request: (
                calls.append(request)
                or httpx.Response(status, headers={"location": "https://other.example/api"})
            )
        ),
        search_type=search_type,
    )
    budget = Budget({"max_search_queries": 1, "max_search_requests": 1})
    with pytest.raises(SourcesQLError) as error:
        provider.search(["campus"], {}, budget)
    assert error.value.code == "provider_unavailable"
    assert len(calls) == 1 and budget.counts["search_requests"] == 1
    assert provider.events[0]["status"] == "failed"
    assert provider.events[0]["search_type"] == search_type


@pytest.mark.parametrize("search_type", ["auto", "deep", "deep-reasoning"])
def test_exa_timeout_is_unknown_without_resubmission(search_type):
    calls = []

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("synthetic timeout")

    provider = ExaProvider("synthetic", client(timeout), search_type=search_type)
    budget = Budget({"max_search_queries": 1, "max_search_requests": 1})
    with pytest.raises(SourcesQLError) as error:
        provider.search(["campus"], {}, budget)
    assert getattr(error.value, "remote_outcome_unknown") is True
    assert len(calls) == 1 and budget.counts["search_requests"] == 1
    assert provider.events[0]["status"] == "remote_outcome_unknown"
    assert provider.events[0]["usage"]["cost_microusd"] is None
    assert provider.events[0]["search_type"] == search_type


@pytest.mark.parametrize("mode", ["live", "cache_preferred"])
def test_contents_success_preserves_bounded_text_and_explicit_freshness(mode):
    calls = []

    def respond(request):
        calls.append(request)
        assert request.url.path == "/contents"
        expected = {
            "urls": ["https://public.example/a"],
            "text": {"maxCharacters": 16000},
        }
        if mode == "live":
            expected.update(maxAgeHours=0, livecrawlTimeout=10000)
        assert json.loads(request.content) == expected
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "exa-document",
                        "url": "https://public.example/a",
                        "text": "Original text.",
                    }
                ],
                "statuses": [{"id": "https://public.example/a", "status": "success"}],
                "costDollars": {"total": 0.001},
            },
        )

    provider = ExaProvider("synthetic", client(respond), resolver=public_dns)
    budget = Budget({"max_fetches": 1})
    row = provider.fetch(["https://public.example/a#fragment"], {"mode": mode}, budget)[0]
    assert row["content"] == "Original text." and not row["coverage"]["complete"]
    assert row["provider_document_id"] == "exa-document"
    assert len(calls) == budget.counts["fetches"] == 1
    assert provider.events[0]["usage"]["estimated_cost_microusd"] == 1000


@pytest.mark.parametrize(
    "statuses",
    [None, [], [{"status": "error"}], [{"status": "unknown"}], [{"status": "success"}] * 2, {}],
)
def test_contents_without_one_successful_status_never_promotes_returned_text(statuses):
    calls = []
    provider = ExaProvider(
        "synthetic",
        client(
            lambda request: (
                calls.append(request)
                or httpx.Response(
                    200,
                    json={
                        "results": [
                            {"url": "https://public.example/a", "text": "Do not accept this."}
                        ],
                        "statuses": statuses,
                    },
                )
            )
        ),
        resolver=public_dns,
    )
    budget = Budget({"max_fetches": 1})
    row = provider.fetch(["https://public.example/a"], {}, budget)[0]
    assert row["status"] == "fetch_failed" and row["content"] is None
    assert len(calls) == budget.counts["fetches"] == 1


@pytest.mark.parametrize(
    "returned",
    ["https://other.example/a", "http://127.0.0.1/a", "https://public.example/redirected"],
)
def test_contents_cannot_replace_the_approved_source_url(returned):
    calls = []
    provider = ExaProvider(
        "synthetic",
        client(
            lambda request: (
                calls.append(request)
                or httpx.Response(
                    200,
                    json={
                        "results": [{"url": returned, "text": "Unapproved redirected text."}],
                        "statuses": [{"status": "success"}],
                    },
                )
            )
        ),
        resolver=public_dns,
    )
    budget = Budget({"max_fetches": 1})
    with pytest.raises(SourcesQLError) as error:
        provider.fetch(["https://public.example/a"], {}, budget)
    assert error.value.code == "unauthorized"
    assert len(calls) == budget.counts["fetches"] == 1


@pytest.mark.parametrize("url", ["https://unapproved.example/a", "http://127.0.0.1/a"])
def test_registry_refuses_unapproved_exa_fetch_before_disclosing_url(url):
    registry = ProviderRegistry(profile(client(lambda _: pytest.fail("unexpected dispatch"))))
    budget = Budget({"max_cost_microusd": 10000})
    with pytest.raises(SourcesQLError) as error:
        registry.fetch([url], {}, budget)
    assert error.value.code == "unauthorized"
    assert budget.counts == {} and registry.events == []


@pytest.mark.parametrize("search_type", ["auto", "deep", "deep-reasoning"])
def test_oversized_exa_response_stops_after_the_single_attempt(search_type):
    calls = []
    provider = ExaProvider(
        "synthetic",
        client(
            lambda request: calls.append(request) or httpx.Response(200, content=b"x" * 2097153)
        ),
        search_type=search_type,
    )
    budget = Budget({"max_search_queries": 1, "max_search_requests": 1})
    with pytest.raises(SourcesQLError) as error:
        provider.search(["campus"], {}, budget)
    assert error.value.code == "invalid_output"
    assert len(calls) == budget.counts["search_requests"] == 1


@pytest.mark.parametrize("through_registry", [False, True])
@pytest.mark.parametrize("search_type", ["auto", "deep", "deep-reasoning"])
@pytest.mark.parametrize("resolved", ["deep", "", None])
def test_trusted_search_type_controls_dispatch_and_retains_provider_telemetry(
    through_registry, search_type, resolved
):
    calls = []

    def respond(request):
        calls.append(request)
        assert json.loads(request.content) == {
            "query": "Tennessee public water utility capital projects",
            "type": search_type,
            "numResults": 3,
            "contents": {"highlights": True},
        }
        return httpx.Response(
            200,
            json={
                "requestId": "synthetic-deep-request",
                "results": [],
                "resolvedSearchType": resolved,
                "costDollars": {"total": 0.012},
            },
        )

    http_client = client(respond)
    provider = (
        ProviderRegistry(
            {**profile(http_client), "search_type": search_type, "approved_cost_microusd": 20000}
        )
        if through_registry
        else ExaProvider("synthetic", http_client, search_type=search_type)
    )
    budget = Budget({"max_cost_microusd": 20000})
    provider.search(
        ["Tennessee public water utility capital projects"],
        {"per_query_limit": 3, "search_type": "untrusted-override", "type": "fast"},
        budget,
    )
    assert len(calls) == 1
    event = provider.events[0]
    assert event["status"] == "completed"
    assert event["search_type"] == search_type
    assert event["resolved_search_type"] == resolved
    assert event["usage"]["estimated_cost_microusd"] == 12000
    # The resolved type is deprecated provider telemetry, never a mode switch.
    capabilities = provider.capabilities()
    assert (capabilities["search"] if through_registry else capabilities)[
        "search_type"
    ] == search_type


@pytest.mark.parametrize("through_registry", [False, True])
@pytest.mark.parametrize("search_type", [None, "fast", "deep-lite", "research", "DEEP", [], {}])
def test_unsupported_trusted_search_type_is_rejected_before_dispatch(through_registry, search_type):
    http_client = client(lambda _: pytest.fail("unexpected dispatch"))
    with pytest.raises(SourcesQLError, match="Unsupported Exa search type") as error:
        if through_registry:
            ProviderRegistry({**profile(http_client), "search_type": search_type})
        else:
            ExaProvider("synthetic", http_client, search_type=search_type)
    assert error.value.code == "unsupported_capability"


@pytest.mark.parametrize("search_type", ["deep", "deep-reasoning"])
def test_broad_variadic_queries_preserve_each_query_limit_hit_lineage_and_attempt_counts(
    search_type,
):
    queries = [
        "Tennessee public water districts capital plans",
        "Tennessee municipal water utilities",
    ]
    calls = []

    def respond(request):
        body = json.loads(request.content)
        query_index = len(calls)
        calls.append(request)
        assert body == {
            "query": queries[query_index],
            "type": search_type,
            "numResults": 5,
            "contents": {"highlights": True},
        }
        # Each response is separately bounded; a provider over-return cannot
        # consume the other query's allowance. Shared source hits are merged.
        return httpx.Response(
            200,
            json={
                "requestId": f"synthetic-broad-{query_index}",
                "results": [
                    {
                        "url": "https://public.example/shared"
                        if rank == 0
                        else f"https://public.example/{query_index}/{rank}",
                        "highlights": ["Original source excerpt."],
                    }
                    for rank in range(6)
                ],
                "output": {"content": "Unrequested synthesis must never become source text."},
            },
        )

    registry = ProviderRegistry({**profile(client(respond)), "search_type": search_type})
    budget = Budget(
        {
            "max_search_queries": 2,
            "max_search_requests": 2,
            "max_candidates": 10,
            "max_cost_microusd": 10000,
        }
    )
    rows = registry.search(queries, {"per_query_limit": 8}, budget)
    assert len(calls) == 2 and len(rows) == 9
    assert budget.counts == {"search_queries": 2, "search_requests": 2, "candidates": 10}
    assert len(registry.hits) == 10
    shared = next(row for row in rows if row["url"] == "https://public.example/shared")
    assert [hit["query"] for hit in shared["hits"]] == queries
    assert [hit["query_index"] for hit in shared["hits"]] == [0, 1]
    for query_index, query in enumerate(queries):
        hits = [hit for hit in registry.hits if hit["query_index"] == query_index]
        assert [hit["rank"] for hit in hits] == [1, 2, 3, 4, 5]
        assert all(hit["query"] == query for hit in hits)
        assert all(hit["request_id"] == f"synthetic-broad-{query_index}" for hit in hits)
    assert all(row["content"] == "Original source excerpt." for row in rows)
    assert registry.capabilities()["search"]["additional_queries"] is False


@pytest.mark.parametrize("search_type", ["deep", "deep-reasoning"])
def test_broad_query_request_budget_stops_before_second_dispatch(search_type):
    calls = []
    provider = ExaProvider(
        "synthetic",
        client(lambda request: calls.append(request) or httpx.Response(200, json={"results": []})),
        search_type=search_type,
    )
    budget = Budget({"max_search_queries": 2, "max_search_requests": 1})
    with pytest.raises(SourcesQLError) as error:
        provider.search(["public water districts", "municipal water utilities"], {}, budget)
    assert error.value.code == "budget_exhausted"
    assert len(calls) == len(provider.events) == 1
    assert budget.counts == {"search_queries": 2, "search_requests": 1}


@pytest.mark.parametrize(
    "search_type,read_timeout", [("auto", 20), ("deep", 20), ("deep-reasoning", 60)]
)
def test_owned_client_timeout_allows_deep_reasoning_latency_without_unbounded_waits(
    search_type, read_timeout
):
    provider = ExaProvider("synthetic", search_type=search_type)
    try:
        assert provider.client.timeout.read == read_timeout
        assert provider.client.timeout.connect == read_timeout
    finally:
        provider.client.close()


@pytest.mark.parametrize("through_registry", [False, True])
def test_intentional_hundred_result_search_bounds_provider_over_return(through_registry):
    calls = []

    def respond(request):
        calls.append(request)
        assert json.loads(request.content) == {
            "query": "regional campus construction and power delivery",
            "type": "auto",
            "numResults": 100,
            "contents": {"highlights": True},
        }
        return httpx.Response(
            200,
            json={
                "requestId": "wide-request",
                "results": [
                    {"url": f"https://public.example/{i}", "highlights": [f"Source {i}."]}
                    for i in range(110)
                ],
            },
        )

    http_client = client(respond)
    provider = (
        ProviderRegistry(profile(http_client))
        if through_registry
        else ExaProvider("synthetic", http_client)
    )
    budget = Budget({"max_candidates": 100, "max_cost_microusd": 10000})
    rows = provider.search(
        ["regional campus construction and power delivery"], {"per_query_limit": 100}, budget
    )
    assert len(calls) == len(provider.events) == 1
    assert len(rows) == len(provider.hits) == 100
    assert [row["hits"][0]["rank"] for row in rows] == list(range(1, 101))
    assert all(
        row["content_basis"] == "excerpt" and not row["coverage"]["complete"] for row in rows
    )
    assert budget.counts["search_queries"] == budget.counts["search_requests"] == 1
    if through_registry:
        assert budget.counts["candidates"] == 100


@pytest.mark.parametrize(
    "provider_class,limit", [(ExaProvider, 101), (BraveProvider, 21), (SerperProvider, 21)]
)
def test_each_provider_retains_its_own_documented_result_ceiling(provider_class, limit):
    provider = provider_class("synthetic", client(lambda _: pytest.fail("unexpected dispatch")))
    budget = Budget()
    with pytest.raises(SourcesQLError, match="per_query_limit") as error:
        provider.search(["construction"], {"per_query_limit": limit}, budget)
    assert error.value.code == "invalid_request"
    assert provider.events == [] and budget.counts == {}


def test_concurrent_exa_queries_preserve_input_order_and_independent_source_versions():
    queries = [f"independent research angle {i}" for i in range(6)]
    barrier = threading.Barrier(3)
    lock = threading.Lock()
    active = peak = 0
    completion_order = []

    def respond(request):
        nonlocal active, peak
        query_index = queries.index(json.loads(request.content)["query"])
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            barrier.wait(timeout=2)
            time.sleep((2 - query_index % 3) * 0.01)
            return httpx.Response(
                200,
                json={
                    "requestId": f"request-{query_index}",
                    "results": [
                        {
                            "url": "https://public.example/shared",
                            "highlights": [f"Independently returned version {query_index}."],
                        },
                        {
                            "url": f"https://public.example/{query_index}",
                            "highlights": ["Another source."],
                        },
                    ],
                },
            )
        finally:
            with lock:
                active -= 1
                completion_order.append(query_index)

    provider = ExaProvider("synthetic", client(respond))
    budget = Budget({"max_search_queries": 6, "max_search_requests": 6, "max_concurrency": 3})
    rows = provider.search(queries, {"per_query_limit": 2}, budget)
    assert peak == 3 and active == 0
    assert completion_order != list(range(6))
    assert [event["query_index"] for event in provider.events] == list(range(6))
    assert all(event["status"] == "completed" for event in provider.events)
    assert [(hit["query_index"], hit["rank"]) for hit in provider.hits] == [
        (query_index, rank) for query_index in range(6) for rank in (1, 2)
    ]
    assert [row["hits"][0]["request_id"] for row in rows] == [
        f"request-{query_index}" for query_index in range(6) for _ in range(2)
    ]
    shared = [row for row in rows if row["url"] == "https://public.example/shared"]
    assert len({row["source_version_id"] for row in shared}) == 6
    assert budget.counts == {"search_queries": 6, "search_requests": 6}


def test_exa_concurrency_one_keeps_sequential_dispatch_and_owner_thread_reservations():
    calls = []
    reservations = []
    owner_thread = threading.get_ident()

    def observe(counter, amount):
        reservations.append((counter, amount, threading.get_ident()))

    def respond(request):
        calls.append(json.loads(request.content)["query"])
        assert len(reservations) == len(calls) * 2
        return httpx.Response(200, json={"results": []})

    provider = ExaProvider("synthetic", client(respond))
    budget = Budget({"max_concurrency": 1}, on_reserve=observe)
    provider.search(["first angle", "second angle", "third angle"], {}, budget)
    assert calls == ["first angle", "second angle", "third angle"]
    assert all(thread_id == owner_thread for _, _, thread_id in reservations)
    assert [counter for counter, _, _ in reservations] == ["search_queries", "search_requests"] * 3


@pytest.mark.parametrize("transport_unknown", [False, True])
def test_exa_concurrent_failure_drains_started_attempts_without_retry_or_more_queries(
    transport_unknown,
):
    barrier = threading.Barrier(2)
    calls = []

    def respond(request):
        query = json.loads(request.content)["query"]
        calls.append(query)
        barrier.wait(timeout=2)
        if query == "first":
            if transport_unknown:
                raise httpx.ReadTimeout("synthetic timeout")
            return httpx.Response(429)
        time.sleep(0.03)
        return httpx.Response(200, json={"results": []})

    provider = ExaProvider("synthetic", client(respond))
    budget = Budget({"max_concurrency": 2})
    with pytest.raises(SourcesQLError) as error:
        provider.search(["first", "second", "never dispatched"], {}, budget)
    assert error.value.code == "provider_unavailable"
    assert sorted(calls) == ["first", "second"]
    assert budget.counts == {"search_queries": 2, "search_requests": 2}
    assert [event["status"] for event in provider.events] == [
        "remote_outcome_unknown" if transport_unknown else "failed",
        "completed",
    ]


def test_exa_cancellation_after_reservation_prevents_disclosure_without_refunding_attempt():
    def cancel(counter, amount):
        if counter == "search_requests":
            budget.cancelled = True

    budget = Budget({"max_concurrency": 1}, on_reserve=cancel)
    provider = ExaProvider("synthetic", client(lambda _: pytest.fail("unexpected dispatch")))
    with pytest.raises(SourcesQLError) as error:
        provider.search(["private research intent", "second"], {}, budget)
    assert error.value.code == "cancelled"
    assert budget.counts == {"search_queries": 1, "search_requests": 1}
    assert [event["status"] for event in provider.events] == ["not_dispatched"]


def test_exa_dispatch_deadline_stops_later_queries_without_retry(monkeypatch):
    now = [0.0]
    monkeypatch.setattr("sourcesql.providers.search.monotonic", lambda: now[0])
    calls = []

    def respond(request):
        calls.append(request)
        now[0] = 2.0
        return httpx.Response(200, json={"results": []})

    provider = ExaProvider("synthetic", client(respond))
    budget = Budget({"max_concurrency": 1, "dispatch_deadline_seconds": 1})
    with pytest.raises(SourcesQLError, match="deadline") as error:
        provider.search(["first", "never dispatched"], {}, budget)
    assert error.value.code == "budget_exhausted"
    assert len(calls) == 1
    assert budget.counts == {"search_queries": 1, "search_requests": 1}
    assert provider.events[0]["status"] == "completed"
