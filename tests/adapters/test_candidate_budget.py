"""Candidate intake is bounded before HTTP and counted before deduplication."""

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry


def registry(handler):
    return ProviderRegistry(
        {
            "mode": "live",
            "provider": "brave",
            "api_key": "mock-key",
            "allow_live": True,
            "approved_cost_microusd": 1000,
            "metering_policy": "estimated",
            "http_client": httpx.Client(transport=httpx.MockTransport(handler), trust_env=False),
        }
    )


def budget(max_candidates):
    return Budget({"max_candidates": max_candidates, "max_cost_microusd": 1000})


def test_lowered_candidate_cap_bounds_batch_and_counts_hits_before_dedup():
    requests = []

    def response(request):
        requests.append(request)
        count = int(request.url.params["count"])
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {"url": f"https://public.example/{i}", "description": f"fixture {i}"}
                        for i in range(count)
                    ]
                }
            },
        )

    provider = registry(response)
    allowance = budget(5)
    options = {"per_query_limit": 20, "source_mode": "allow_excerpt"}
    rows = provider.search(["first query", "second query"], options, allowance)
    assert [int(r.url.params["count"]) for r in requests] == [2, 2]
    assert allowance.counts["candidates"] == 4
    assert len(rows) == 2
    assert [hit["query_index"] for hit in rows[0]["hits"]] == [0, 1]
    assert options["per_query_limit"] == 20


def test_zero_candidate_cap_refuses_before_fake_http_effect_or_reservation():
    provider = registry(lambda _: pytest.fail("Unexpected HTTP dispatch"))
    allowance = budget(0)
    with pytest.raises(SourcesQLError) as error:
        provider.search(["query"], {}, allowance)
    assert error.value.code == "budget_exhausted"
    assert allowance.counts == {} and provider.events == []


def test_two_search_calls_share_remaining_candidate_allowance():
    requests = []

    def response(request):
        count = int(request.url.params["count"])
        requests.append(count)
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {"url": f"https://public.example/{i}", "description": f"fixture {i}"}
                        for i in range(count)
                    ]
                }
            },
        )

    provider = registry(response)
    allowance = budget(3)
    assert len(provider.search(["first"], {"per_query_limit": 2}, allowance)) == 2
    assert len(provider.search(["second"], {"per_query_limit": 2}, allowance)) == 1
    with pytest.raises(SourcesQLError) as error:
        provider.search(["third"], {"per_query_limit": 2}, allowance)
    assert error.value.code == "budget_exhausted"
    assert requests == [2, 1] and allowance.counts["candidates"] == 3
    assert allowance.counts["search_requests"] == 2


@pytest.mark.parametrize("operator", ["WEB_SEARCH", "WEB_FETCH", "SEM_MATCH"])
def test_zero_concurrency_refuses_external_work_but_allows_saved_only_preflight(operator):
    provider = ProviderRegistry()
    allowance = Budget({"max_concurrency": 0})
    provider.preflight([], allowance)
    with pytest.raises(SourcesQLError) as error:
        provider.preflight([operator], allowance)
    assert error.value.code == "budget_exhausted"
    assert allowance.counts == {} and provider.events == []
