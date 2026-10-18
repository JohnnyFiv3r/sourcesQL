"""Coordinator batch contracts with synthetic leaves and no external calls."""

from __future__ import annotations

import asyncio
from time import monotonic

import pytest
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from sourcesql.contracts import Budget, Column, SemanticOutcome, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.planner import execute_plan
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.semantic import PydanticSemanticProvider
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.common import source_record
from sourcesql.providers.fixture import FixtureProvider
from sourcesql.sql.admission import admit


def worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {key: table.to_dict() for key, table in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [
            Column(column["key"], column["logical_type"], column["nullable"])
            for column in result["columns"]
        ],
        result["rows"],
    )


def docs():
    return Table(
        [Column("id", "BIGINT"), Column("content")],
        [{"id": 3, "content": "third"}, {"id": 1, "content": None}, {"id": 2, "content": "second"}],
        [
            {("content",): ["source-third"]},
            {("content",): ["source-null"]},
            {("content",): ["source-second"]},
        ],
    )


def execute(query, *, dispatch=None, semantic_batch=None, score_batch=None):
    inputs = {"docs": docs()}
    plan = admit(query, {}, {key: table.columns for key, table in inputs.items()})
    return execute_plan(
        plan,
        inputs,
        dispatch or (lambda *args: pytest.fail("unexpected scalar dispatch")),
        worker,
        score_batch=score_batch,
        semantic_batch=semantic_batch,
    )


def test_batch_preserves_original_row_identities_null_slots_and_diagnostic_refs():
    seen = []

    def batch(operator, calls):
        seen.append(operator)
        assert [args[0] for args, _ in calls] == ["third", None, "second"]
        assert [context["_input_lineage"] for _, context in calls] == [
            ["source-third"],
            ["source-null"],
            ["source-second"],
        ]
        assert len({id(context["_lineage_output"]) for _, context in calls}) == 3
        for index, (_, context) in enumerate(calls):
            context["_lineage_output"][()] = [f"diagnostic-{index}"]
        return ["third fact", None, "second fact"]

    result = execute(
        "SELECT id,SEM_EXTRACT(content,'one fact') AS fact FROM input.docs ORDER BY id",
        semantic_batch=batch,
    )
    assert seen == ["SEM_EXTRACT"]
    assert result.rows == [
        {"id": 1, "fact": None},
        {"id": 2, "fact": "second fact"},
        {"id": 3, "fact": "third fact"},
    ]
    assert [tags[("fact",)] for tags in result.lineage] == [
        ["diagnostic-1"],
        ["diagnostic-2"],
        ["diagnostic-0"],
    ]


def test_match_batch_shortlists_before_extraction_without_reordering_candidates():
    seen = []

    def batch(operator, calls):
        seen.append((operator, [args[0] for args, _ in calls]))
        return [True, None, False] if operator == "SEM_MATCH" else ["useful fact"]

    result = execute(
        "SELECT id,SEM_EXTRACT(content,'fact') AS fact FROM input.docs WHERE SEM_MATCH(content,'relevance')",
        semantic_batch=batch,
    )
    assert seen == [("SEM_MATCH", ["third", None, "second"]), ("SEM_EXTRACT", ["third"])]
    assert result.rows == [{"id": 3, "fact": "useful fact"}]


def test_real_engine_batches_distinct_source_hashes_by_computation_not_attribution(
    tmp_path, monkeypatch
):
    batches = []

    def search(self, queries, options, budget):
        budget.reserve("search_queries", limit="max_search_queries")
        budget.reserve("search_requests", limit="max_search_requests")
        self.events.append({"kind": "search", "status": "completed"})
        return [
            source_record(
                f"https://fixture.example/{index}",
                f"Distinct source {index} " * (index + 1),
                provider="fixture",
                basis="synthetic_fixture",
            )
            for index in range(3)
        ]

    def score_many(self, texts, criterion, options, budget):
        batches.append((list(texts), criterion))
        return [
            SemanticOutcome(float(index), "processed", usage={"requests": 0})
            for index in range(len(texts))
        ]

    monkeypatch.setattr(FixtureProvider, "search", search)
    monkeypatch.setattr(ProviderRegistry, "score_many", score_many)
    result = Engine(tmp_path, worker=worker).query(
        query="SELECT SEM_SCORE(content,'a distinct shared ranking criterion') AS score FROM WEB_SEARCH('broad terminology',per_query_limit := 3)"
    )
    assert len(batches) == 1 and len(batches[0][0]) == 3
    assert len({source["content_sha256"] for source in result["source_versions"]}) == 3
    assert result["rows"] == [{"score": 0.0}, {"score": 1.0}, {"score": 2.0}]


def test_score_callback_and_collection_normalization_keep_their_distinct_contracts():
    normalizations, scores = [], []

    def dispatch(operator, args, context):
        assert operator == "SEM_NORM"
        normalizations.append(args[0])
        return [value.upper() for value in args[0]]

    def score(calls):
        scores.append([args[0] for args, _ in calls])
        return [0.3, None, 0.2]

    result = execute(
        "SELECT id,SEM_SCORE(content,'specific criterion') AS score,SEM_NORM(content,'equivalent values') AS normalized FROM input.docs ORDER BY id",
        dispatch=dispatch,
        score_batch=score,
        semantic_batch=lambda *args: pytest.fail("unexpected generative batch"),
    )
    assert normalizations == [["third", "second"]]
    assert scores == [["third", None, "second"]]
    assert result.rows[0] == {"id": 1, "score": None, "normalized": None}


def test_callback_exception_stops_remaining_rows_with_the_shared_reservation():
    budget, effects = Budget({"max_model_requests": 3}), []
    clock = [0]

    def batch(operator, calls):
        values = []
        for args, _ in calls:
            if clock[0] >= 1:
                raise SourcesQLError("budget_exhausted", "Dispatch deadline exceeded", "dispatch")
            budget.reserve("model_requests", limit="max_model_requests")
            effects.append(args[0])
            clock[0] += 1
            values.append("completed")
        return values

    with pytest.raises(SourcesQLError) as error:
        execute("SELECT SEM_EXTRACT(content,'fact') AS fact FROM input.docs", semantic_batch=batch)
    assert error.value.code == "budget_exhausted"
    assert effects == ["third"] and budget.counts["model_requests"] == 1


def test_bad_batch_cardinality_fails_explicitly_and_binding_validation_never_calls_batch():
    with pytest.raises(SourcesQLError) as error:
        execute(
            "SELECT SEM_EXTRACT(content,'fact') AS fact FROM input.docs",
            semantic_batch=lambda *args: ["missing two rows"],
        )
    assert error.value.code == "invalid_output"
    with pytest.raises(SourcesQLError) as error:
        execute(
            "SELECT missing,SEM_EXTRACT(content,'fact') AS fact FROM input.docs",
            semantic_batch=lambda *args: pytest.fail("invalid query dispatched"),
        )
    assert error.value.code == "invalid_query"


@pytest.mark.parametrize("count", [0, 7, 8])
def test_extraction_capacity_signal_is_conservative_not_a_completion_claim(count):
    names = [f"Item {index}." for index in range(count)]
    text = " ".join(names)
    output = {
        "value": [{"name": name} for name in names],
        "status": "supported_text",
        "support": [
            {"field": "name", "item": index, "quote": name} for index, name in enumerate(names)
        ],
    }
    model = FunctionModel(
        lambda messages, info: ModelResponse([ToolCallPart(info.output_tools[0].name, output)])
    )
    result = PydanticSemanticProvider(model).semantic(
        "SEM_EXTRACT_ALL", text, "bounded items", {"name": "name"}, {}, Budget()
    )
    assert result.usage["extraction_capacity"] == {
        "max_items": 8,
        "returned_items": count,
        "may_have_more": count >= 8,
    }


def test_generative_deadline_is_checked_before_reserving_or_dispatch(monkeypatch):
    monkeypatch.setattr("sourcesql.providers.semantic.monotonic", lambda: 100)
    model = FunctionModel(lambda *args: pytest.fail("expired deadline dispatched"))
    budget = Budget()
    with pytest.raises(SourcesQLError) as error:
        PydanticSemanticProvider(model).semantic(
            "SEM_MATCH", "text", "relevance", {}, {"deadline_monotonic": 99}, budget
        )
    assert error.value.code == "budget_exhausted" and budget.counts == {}


def test_remaining_time_is_sent_as_supported_pydantic_timeout(monkeypatch):
    monkeypatch.setattr("sourcesql.providers.semantic.monotonic", lambda: 100)
    observed = []

    def answer(messages, info):
        observed.append(info.model_settings)
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"value": False, "status": "processed", "support": []},
                )
            ]
        )

    result = PydanticSemanticProvider(FunctionModel(answer)).semantic(
        "SEM_MATCH", "text", "relevance", {}, {"deadline_monotonic": 102}, Budget()
    )
    assert result.value is False
    assert observed[0]["timeout"] == 2 and observed[0]["max_tokens"] <= 4096


def test_total_deadline_stops_slow_async_leaf_and_retains_unknown_remote_outcome():
    calls = []

    async def answer(messages, info):
        calls.append(info.model_settings)
        await asyncio.sleep(10)
        pytest.fail("slow leaf escaped deadline")

    provider, budget = PydanticSemanticProvider(FunctionModel(answer)), Budget()
    result = provider.semantic(
        "SEM_MATCH", "text", "relevance", {}, {"deadline_monotonic": monotonic() + 0.03}, budget
    )
    assert len(calls) == budget.counts["model_requests"] == 1
    assert result.status == "failed" and result.usage["failure"]["code"] == "provider_timeout"
    assert result.usage["failure"]["remote_outcome_unknown"] is True
    assert provider.events[0]["status"] == "remote_outcome_unknown"


def test_validation_retry_cannot_start_another_request_after_deadline(monkeypatch):
    clock, calls = [100], []
    monkeypatch.setattr("sourcesql.providers.semantic.monotonic", lambda: clock[0])

    def answer(messages, info):
        calls.append(info)
        clock[0] = 102
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"value": "invalid Boolean", "status": "processed", "support": []},
                )
            ]
        )

    budget = Budget()
    with pytest.raises(SourcesQLError) as error:
        PydanticSemanticProvider(FunctionModel(answer), retries=1).semantic(
            "SEM_MATCH", "text", "relevance", {}, {"deadline_monotonic": 101}, budget
        )
    assert error.value.code == "budget_exhausted"
    assert len(calls) == budget.counts["model_requests"] == 1
