"""Explicit research budgets expand intake without expanding ordinary defaults."""

from __future__ import annotations

import json

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry


def test_ordinary_runs_keep_their_existing_small_intake_budgets():
    limits = Budget().limits
    assert limits["max_search_queries"] == 8
    assert limits["max_search_requests"] == 16
    assert limits["max_candidates"] == 200
    assert limits["max_cost_microusd"] == 0
    allowance = Budget()
    allowance.reserve("candidates", 200)
    with pytest.raises(SourcesQLError) as error:
        allowance.reserve("candidates")
    assert error.value.code == "budget_exhausted"
    assert allowance.counts["candidates"] == 200


@pytest.mark.parametrize(
    ("counter", "ceiling"),
    [
        ("search_queries", 32),
        ("search_requests", 48),
        ("candidates", 2500),
    ],
)
def test_explicit_research_limits_are_finite_shared_reservations(counter, ceiling):
    observed = []
    budget = Budget({"max_" + counter: ceiling}, on_reserve=lambda *event: observed.append(event))
    budget.reserve(counter, ceiling)
    with pytest.raises(SourcesQLError) as error:
        budget.reserve(counter)
    assert error.value.code == "budget_exhausted"
    assert budget.counts == {counter: ceiling}
    assert observed == [(counter, ceiling)]
    with pytest.raises(SourcesQLError) as error:
        Budget({"max_" + counter: ceiling + 1})
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize("value", [True, False, -1, 1.5, "32", None, float("inf")])
@pytest.mark.parametrize("name", ["max_search_queries", "max_search_requests", "max_candidates"])
def test_research_overrides_still_require_nonnegative_json_integers(name, value):
    with pytest.raises(SourcesQLError) as error:
        Budget({name: value})
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize(("provider", "maximum"), [("exa", 100), ("brave", 20), ("serper", 20)])
def test_result_count_is_authorized_for_the_selected_adapter_before_http(provider, maximum):
    calls = []

    def respond(request):
        calls.append(request)
        if provider == "brave":
            assert request.url.params["count"] == str(maximum)
            return httpx.Response(200, json={"web": {"results": []}})
        body = json.loads(request.content)
        assert body["numResults" if provider == "exa" else "num"] == maximum
        return httpx.Response(200, json={"results": []} if provider == "exa" else {"organic": []})

    with httpx.Client(transport=httpx.MockTransport(respond), trust_env=False) as client:
        registry = ProviderRegistry(
            {
                "mode": "live",
                "provider": provider,
                "api_key": "SAFE-SYNTHETIC-KEY",
                "allow_live": True,
                "approved_cost_microusd": 50_000,
                "metering_policy": "estimated",
                "http_client": client,
            }
        )
        budget = Budget({"max_cost_microusd": 50_000})
        registry.search(["coverage query"], {"per_query_limit": maximum}, budget)
        assert len(calls) == 1
        calls.clear()
        before = dict(budget.counts)
        with pytest.raises(SourcesQLError) as error:
            registry.search(["coverage query"], {"per_query_limit": maximum + 1}, budget)
        assert error.value.code == "invalid_request"
        assert calls == [] and budget.counts == before


def test_fixture_profile_does_not_inherit_the_exa_result_count_ceiling():
    registry = ProviderRegistry()
    allowance = Budget()
    with pytest.raises(SourcesQLError) as error:
        registry.search(["coverage query"], {"per_query_limit": 21}, allowance)
    assert error.value.code == "invalid_request"
    assert registry.events == [] and allowance.counts == {}
