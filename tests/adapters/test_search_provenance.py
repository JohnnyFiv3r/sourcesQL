"""Search coverage and typed provenance; HTTP responses are synthetic only."""

import json

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.common import project_search_provenance, source_record
from sourcesql.providers.fixture import FixtureProvider
from sourcesql.providers.search import BraveProvider, ExaProvider, SerperProvider


def client(reply):
    return httpx.Client(transport=httpx.MockTransport(reply), trust_env=False)


def test_typed_projection_preserves_overlapping_hits_and_legacy_nullable_metadata():
    row = source_record("https://public.example/a", "retained source")
    row["hits"] = [
        {
            "provider": "exa",
            "search_id": "search_one",
            "query": "first facet",
            "query_index": 0,
            "rank": 4,
            "request_id": "provider-request",
            "source_version_id": row["source_version_id"],
        },
        {"provider": "exa", "query": "second facet", "query_index": 1, "rank": 2},
    ]
    assert project_search_provenance(row) is row
    assert row["search_hit_count"] == row["search_query_count"] == 2
    assert row["best_search_rank"] == 2
    assert row["search_hits"][1]["search_id"] is None
    assert row["search_hits"][1]["request_id"] is None
    assert "source_version_id" not in row["search_hits"][0]
    assert row["hits"][0]["source_version_id"] == row["source_version_id"]


def test_fetch_only_source_has_empty_search_metadata_without_invented_rank_or_queries():
    row = project_search_provenance(source_record("https://public.example/a", "source"))
    assert row["search_hits"] == []
    assert row["search_hit_count"] == row["search_query_count"] == 0
    assert row["best_search_rank"] is None


def test_registry_merges_overlap_without_collapsing_independent_source_versions():
    queries = ["planning", "progress", "changed report"]

    def reply(request):
        query = json.loads(request.content)["query"]
        return httpx.Response(
            200,
            json={
                "requestId": "provider-" + query,
                "results": [
                    {
                        "url": "https://public.example/shared",
                        "highlights": ["changed source" if query == queries[2] else "same source"],
                    }
                ],
            },
        )

    registry = ProviderRegistry(
        {
            "mode": "live",
            "provider": "exa",
            "api_key": "synthetic",
            "http_client": client(reply),
            "allow_live": True,
            "approved_cost_microusd": 1,
            "metering_policy": "estimated",
        }
    )
    rows = registry.search(
        queries,
        {"per_query_limit": 1, "source_mode": "allow_excerpt"},
        Budget({"max_cost_microusd": 1}),
    )
    assert len(rows) == 2
    first = project_search_provenance(rows[0])
    changed = project_search_provenance(rows[1])
    assert first["url"] == changed["url"]
    assert first["source_version_id"] != changed["source_version_id"]
    assert first["search_hit_count"] == first["search_query_count"] == 2
    assert [hit["query"] for hit in first["search_hits"]] == queries[:2]
    assert [hit["rank"] for hit in first["search_hits"]] == [1, 1]
    assert [hit["request_id"] for hit in first["search_hits"]] == [
        "provider-planning",
        "provider-progress",
    ]
    assert changed["search_hit_count"] == 1
    coverage = registry.search_provider.search_coverage[0]
    assert coverage["requested_queries"] == 3
    assert coverage["corpus_complete"] is False
    assert coverage["coverage"] == "provider_returned_hits_only"
    assert [q["status"] for q in coverage["queries"]] == ["completed"] * 3
    assert sum(q["retained_hits"] for q in coverage["queries"]) == 3
    assert len(registry.hits) == 3


def test_exa_coverage_distinguishes_zero_hits_over_return_and_missing_provider_request_id():
    def reply(request):
        query = json.loads(request.content)["query"]
        return httpx.Response(
            200,
            json={
                "results": []
                if query == "empty"
                else [{"url": f"https://public.example/{i}"} for i in range(3)]
            },
        )

    provider = ExaProvider("synthetic", client(reply))
    rows = provider.search(["empty", "over return"], {"per_query_limit": 1}, Budget())
    assert len(rows) == 1
    coverage = provider.search_coverage[0]
    assert [(q["returned_hits"], q["retained_hits"]) for q in coverage["queries"]] == [
        (0, 0),
        (3, 1),
    ]
    assert all(q["status"] == "completed" for q in coverage["queries"])
    assert rows[0]["search_hits"][0]["request_id"] is None
    assert rows[0]["search_hits"][0]["search_id"] == coverage["search_id"]
    assert all(event["search_id"] == coverage["search_id"] for event in provider.events)


def test_separate_search_invocations_do_not_confuse_their_zero_based_query_indices():
    provider = FixtureProvider()
    first = provider.search(["aurora"], {"per_query_limit": 1}, Budget())[0]
    second = provider.search(["aurora"], {"per_query_limit": 1}, Budget())[0]
    assert first["search_hits"][0]["query_index"] == second["search_hits"][0]["query_index"] == 0
    assert first["search_hits"][0]["search_id"] != second["search_hits"][0]["search_id"]
    first["hits"].extend(second["hits"])
    assert project_search_provenance(first)["search_query_count"] == 2
    assert len(provider.search_coverage) == 2


def test_invalid_provider_hit_keeps_known_request_coverage_without_retaining_a_source():
    provider = ExaProvider(
        "synthetic",
        client(
            lambda _: httpx.Response(
                200, json={"requestId": "known-provider-request", "results": [{"url": False}]}
            )
        ),
    )
    with pytest.raises(SourcesQLError):
        provider.search(["topic"], {}, Budget())
    query = provider.search_coverage[0]["queries"][0]
    assert query["status"] == provider.events[0]["status"] == "failed"
    assert query["request_id"] == "known-provider-request"
    assert query["returned_hits"] == 1 and query["retained_hits"] == 0
    assert provider.hits == []


def test_failed_query_and_never_dispatched_query_have_distinct_coverage():
    def reply(request):
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    provider = ExaProvider("synthetic", client(reply))
    with pytest.raises(SourcesQLError):
        provider.search(["timeout", "not started"], {}, Budget({"max_concurrency": 1}))
    coverage = provider.search_coverage[0]
    assert [q["status"] for q in coverage["queries"]] == [
        "remote_outcome_unknown",
        "not_dispatched",
    ]
    assert all(q["returned_hits"] is None for q in coverage["queries"])
    assert all(q["retained_hits"] == 0 for q in coverage["queries"])


@pytest.mark.parametrize("provider_type", [BraveProvider, SerperProvider])
def test_local_date_filter_coverage_separates_returned_from_retained_hits(provider_type):
    def reply(request):
        hits = [
            {
                "url": "https://public.example/a",
                "link": "https://public.example/a",
                "page_age": "2026-10-01",
                "date": "2026-10-01",
            },
            {"url": "https://public.example/b", "link": "https://public.example/b"},
            {
                "url": "https://public.example/c",
                "link": "https://public.example/c",
                "page_age": "2025-10-01",
                "date": "2025-10-01",
            },
        ]
        body = {"web": {"results": hits}} if provider_type is BraveProvider else {"organic": hits}
        return httpx.Response(200, json=body)

    provider = provider_type("synthetic", client(reply))
    rows = provider.search(
        ["topic"],
        {
            "per_query_limit": 3,
            "published_after": "2026-01-01",
            "undated_policy": "exclude",
            "allow_post_filter": True,
        },
        Budget(),
    )
    assert len(rows) == 1
    coverage = provider.search_coverage[0]
    assert coverage["queries"][0]["returned_hits"] == 3
    assert coverage["queries"][0]["retained_hits"] == 1
    assert rows[0]["search_hits"][0]["request_id"] is None
    assert rows[0]["best_search_rank"] == 1
