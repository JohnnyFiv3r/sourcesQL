"""Literal relations use typed provider-free binding before actual effects."""

from __future__ import annotations

import json

import httpx
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.planner import execute_plan, validate_plan
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.semantic import OpenAIEmbeddingProvider
from sourcesql.sql.admission import admit


def worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {name: table.to_dict() for name, table in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [Column(item["key"], item["logical_type"], item["nullable"]) for item in result["columns"]],
        result["rows"],
    )


@pytest.mark.parametrize(
    "expression,actual,expected",
    [
        ("SEM_MATCH(content,'criterion')", True, True),
        ("SEM_SCORE(content,'criterion')", 0.25, 0.25),
        ("SEM_EXTRACT(content,'criterion')", "known", "known"),
        ("SEM_EXTRACT(content,'criterion',type := 'BIGINT')", 7, 7),
        (
            "SEM_EXTRACT(content,'criterion',name := 'documented name')",
            {"name": "known"},
            {"name": "known"},
        ),
        (
            "SEM_EXTRACT_ALL(content,'criterion',name := 'documented name')",
            [{"name": "known"}],
            [{"name": "known"}],
        ),
        ("SEM_EXTRACT_ALL(content,'criterion')", ["alpha", "beta"], ["alpha", "beta"]),
        ("SEM_NORM(content,'criterion')", {"alpha": "group"}, "group"),
        ("SOURCE_WINDOW(content,1,1)", "l", "l"),
    ],
)
def test_literal_relation_binding_never_dispatches_external_work(expression, actual, expected):
    plan = admit(
        f"WITH candidate AS (SELECT 'alpha' AS content) SELECT {expression} AS value FROM candidate",
        {},
        {},
    )
    assert validate_plan(plan, {}, worker) is None
    calls = []

    def dispatch(operator, arguments, options):
        calls.append((operator, arguments))
        return actual

    result = execute_plan(plan, {}, dispatch, worker)
    assert result.rows == [{"value": expected}]
    assert len(calls) == 1, "Only the actual execution may use the coordinator callback"


@pytest.mark.parametrize("operator", ["WEB_SEARCH", "WEB_FETCH"])
def test_acquisition_binding_stays_empty_and_preserves_output_schema(operator):
    query = f"SELECT title,url FROM {operator}('https://public.example/source')"
    plan = admit(query, {}, {})
    assert validate_plan(plan, {}, worker) is None


@pytest.mark.parametrize("operator", ["WEB_SEARCH", "WEB_FETCH"])
def test_projected_acquisition_binding_preserves_unnest_struct_schema(operator):
    plan = admit(
        f"""WITH candidate AS (SELECT 'https://public.example/source' AS query),
      acquired AS (SELECT {operator}(query) AS hits FROM candidate),
      expanded AS (SELECT UNNEST(hits) AS hit FROM acquired)
      SELECT hit.title AS title,hit.url AS url FROM expanded""",
        {},
        {},
    )
    assert validate_plan(plan, {}, worker) is None


def test_collection_extraction_binding_preserves_projected_unnest_fields():
    plan = admit(
        """WITH candidate AS (SELECT 'alpha and beta' AS content),
      extracted AS (SELECT SEM_EXTRACT_ALL(content,'entries',name := 'documented name') AS items FROM candidate),
      expanded AS (SELECT UNNEST(items) AS item FROM extracted)
      SELECT item.name AS name FROM expanded""",
        {},
        {},
    )
    calls = []

    def dispatch(*args):
        calls.append(args)
        return [{"name": "alpha"}, {"name": "beta"}]

    result = execute_plan(plan, {}, dispatch, worker)
    assert result.rows == [{"name": "alpha"}, {"name": "beta"}]
    assert len(calls) == 1


def test_aggregate_over_empty_input_can_produce_a_binding_row():
    inputs = {"docs": Table([Column("content", "VARCHAR")], [{"content": "alpha"}])}
    plan = admit(
        """WITH candidate AS (
      SELECT CAST(COUNT(*) AS VARCHAR) AS content FROM input.docs)
      SELECT SEM_SCORE(content,'criterion') AS relevance FROM candidate""",
        {},
        {key: table.columns for key, table in inputs.items()},
    )
    calls = []

    def dispatch(operator, arguments, options):
        calls.append((operator, arguments))
        return 0.5

    result = execute_plan(plan, inputs, dispatch, worker)
    assert result.rows == [{"relevance": 0.5}]
    assert calls == [("SEM_SCORE", ["1", "criterion"])]


def test_multirow_norm_deduplicates_collection_and_keeps_unknown_null():
    plan = admit(
        """WITH candidate AS (
      SELECT 'alpha' AS content UNION ALL SELECT 'alpha' AS content
      UNION ALL SELECT 'beta' AS content)
      SELECT SEM_NORM(content,'criterion') AS normalized FROM candidate""",
        {},
        {},
    )
    calls = []

    def dispatch(operator, arguments, options):
        calls.append((operator, arguments))
        return {"alpha": "group", "beta": None}

    result = execute_plan(plan, {}, dispatch, worker)
    assert result.rows == [{"normalized": "group"}, {"normalized": "group"}, {"normalized": None}]
    assert calls == [("SEM_NORM", [["alpha", "beta"], "criterion"])]


def test_binding_still_refuses_invalid_literal_cast_before_provider_work():
    plan = admit(
        """WITH candidate AS (SELECT 'not_a_number' AS content),
      scored AS (SELECT content,SEM_SCORE(content,'criterion') AS score FROM candidate)
      SELECT CAST(content AS BIGINT) AS count,score FROM scored""",
        {},
        {},
    )
    calls = []
    with pytest.raises(SourcesQLError) as caught:
        execute_plan(plan, {}, lambda *args: calls.append(args), worker)
    assert caught.value.code == "invalid_query"
    assert calls == []


def test_binding_keeps_worker_failure_authority():
    plan = admit("SELECT 1 AS value", {}, {})

    def stopped(*args):
        raise SourcesQLError("budget_exhausted", "Synthetic worker deadline", "worker")

    with pytest.raises(SourcesQLError) as caught:
        validate_plan(plan, {}, stopped)
    assert caught.value.code == "budget_exhausted" and caught.value.stage == "worker"


@pytest.mark.parametrize(
    "query,code",
    [
        (
            "WITH candidate(content) AS (VALUES ('alpha')) SELECT SEM_MATCH(content,'criterion') AS eligible FROM candidate",
            "unsupported_query",
        ),
        (
            "WITH candidate AS (SELECT 'alpha' AS content) SELECT SEM_EXTRACT(content,'criterion',type := 'VARCHAR[]') AS value FROM candidate",
            "invalid_query",
        ),
    ],
)
def test_binding_fix_keeps_unadmitted_grammar_and_types_closed(query, code):
    # This fix does not expand the language to VALUES or array-valued EXTRACT.
    calls = []
    with pytest.raises(SourcesQLError) as caught:
        plan = admit(query, {}, {})
        execute_plan(plan, {}, lambda *args: calls.append(args), worker)
    assert caught.value.code == code
    assert calls == []


def test_actual_literal_cte_score_explain_and_execution_agree_without_provider_preflight_spend(
    tmp_path, monkeypatch
):
    requests = []

    def reply(request):
        inputs = json.loads(request.content)["input"]
        requests.append(inputs)
        return httpx.Response(
            200,
            json={
                "data": [{"index": index, "embedding": [1.0, 0.0]} for index in range(len(inputs))],
                "usage": {"total_tokens": 9},
            },
        )

    original = ProviderRegistry.__init__

    def initialize(registry, profile=None):
        original(registry, profile)
        registry.embedding_provider = OpenAIEmbeddingProvider(
            "text-embedding-3-small",
            "synthetic-not-a-provider-key",
            httpx.Client(transport=httpx.MockTransport(reply)),
        )

    monkeypatch.setattr(ProviderRegistry, "__init__", initialize)
    profile = {
        "mode": "live",
        "provider": "exa",
        "allow_live": True,
        "api_key": "synthetic-not-a-provider-key",
        "approved_cost_microusd": 10000,
        "metering_policy": "estimated",
        "embedding": {"name": "text-embedding-3-small"},
    }
    engine = Engine(tmp_path, profiles={"recorded": profile}, worker=worker)
    request = {
        "query": "WITH candidate AS (SELECT 'Rechargeable batteries store electricity.' AS content) SELECT SEM_SCORE(content,'energy storage') AS relevance FROM candidate",
        "profile": "recorded",
        "source_mode": "allow_excerpt",
        "budgets": {
            "max_search_queries": 0,
            "max_search_requests": 0,
            "max_candidates": 1,
            "max_fetches": 0,
            "max_semantic_documents": 0,
            "max_model_requests": 1,
            "max_concurrency": 1,
            "dispatch_deadline_seconds": 60,
            "max_output_rows": 1,
            "max_output_bytes": 4096,
            "max_input_tokens": 128,
            "max_output_tokens": 1,
            "max_cost_microusd": 10000,
        },
    }
    assert engine.explain(**request)["external_calls"] == 0
    assert requests == []
    result = engine.query(**request)
    assert result["rows"] == [{"relevance": 1.0}]
    assert requests == [["Rechargeable batteries store electricity.", "energy storage"]]
    assert result["receipt"]["counts"]["model_requests"] == 1
