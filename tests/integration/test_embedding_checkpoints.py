"""Real coordinator/embedding restart boundaries with mock HTTP only."""

import json
from contextlib import contextmanager
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

import sourcesql.engine as engine_module
import sourcesql.providers.semantic as semantic_module
from sourcesql.contracts import Budget, Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.semantic import OpenAIEmbeddingProvider


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
        [Column(c["key"], c["logical_type"], c["nullable"]) for c in result["columns"]],
        result["rows"],
    )


def latest_run(engine):
    with engine.store.db() as db:
        row = db.execute("SELECT receipt FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
    return json.loads(row[0])


@pytest.fixture
def harness(tmp_path, monkeypatch):
    state = SimpleNamespace(
        requests=[], input_limit=8192, batch_limit=2, after_response=None, failure=None, clock=0.0
    )
    original = ProviderRegistry.__init__

    def reply(request):
        inputs = json.loads(request.content)["input"]
        state.requests.append(inputs)
        if state.failure is not None and len(state.requests) == 2:
            if state.failure == "timeout":
                raise httpx.ReadTimeout("PRIVATE-TRANSPORT-DETAIL", request=request)
            if state.failure == "rejected":
                return httpx.Response(429, json={"error": "PRIVATE-PROVIDER-BODY"})
            vector = [0.0, 0.0] if state.failure == "zero" else [float("inf"), 0.0]
            return httpx.Response(
                200,
                content=json.dumps(
                    {
                        "data": [{"index": i, "embedding": vector} for i in range(len(inputs))],
                    }
                ).encode(),
            )
        if state.after_response is not None:
            action, state.after_response = state.after_response, None
            action()
        return httpx.Response(
            200,
            json={
                "data": [{"index": index, "embedding": [1.0, 0.0]} for index in range(len(inputs))],
                "usage": {"total_tokens": len(inputs)},
            },
        )

    def initialize(registry, profile=None):
        original(registry, profile)
        registry.embedding_provider = OpenAIEmbeddingProvider(
            "text-embedding-3-small",
            "not-a-live-key",
            httpx.Client(transport=httpx.MockTransport(reply)),
        )
        registry.embedding_provider.MAX_INPUT_TOKENS = state.input_limit
        registry.embedding_provider.MAX_BATCH_INPUTS = state.batch_limit

    def score_many(registry, texts, criterion, options, budget):
        return registry.embedding_provider.score_many(texts, criterion, options, budget)

    monkeypatch.setattr(ProviderRegistry, "__init__", initialize)
    monkeypatch.setattr(ProviderRegistry, "score_many", score_many)
    monkeypatch.setattr(engine_module, "time", SimpleNamespace(monotonic=lambda: state.clock))
    monkeypatch.setattr(semantic_module, "monotonic", lambda: state.clock)
    state.engine = Engine(tmp_path, worker=worker)
    state.reopen = lambda: Engine(tmp_path, worker=worker)

    def request(texts, **extra):
        saved = state.engine.import_table(
            [{"key": "content", "logical_type": "VARCHAR", "nullable": False}],
            [{"content": text} for text in texts],
            data_classification="synthetic_fixture",
        )
        return {
            "query": "SELECT SEM_SCORE(content,'criterion') AS score FROM input.saved",
            "inputs": {"saved": {"result_id": saved["result_id"]}},
            "partial_policy": "strict",
            **extra,
        }

    state.request = request
    return state


def test_strict_invalid_sibling_cannot_discard_a_later_completed_score(harness):
    harness.input_limit = 2
    request = harness.request(["too many distinct words here", "valid"])
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**request)
    assert failure.value.code == "invalid_output"
    failed = latest_run(harness.engine)
    assert failed["settlement_status"] == "settled"
    assert [stage["status"] for stage in failed["checkpoints"]["stages"]] == ["completed"]
    with harness.engine.store.db() as db:
        retained = json.loads(db.execute("SELECT value FROM semantic_cache").fetchone()[0])
    assert retained["status"] == "processed" and retained["value"] == 1.0
    assert retained["usage"]["requests"] == 1
    with pytest.raises(SourcesQLError) as repeated:
        harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert repeated.value.code == "invalid_output"
    assert harness.requests == [["valid", "criterion"]]


def test_later_deadline_preserves_completed_scores_and_resumes_only_untouched_inputs(harness):
    request = harness.request(["alpha", "beta"], budgets={"dispatch_deadline_seconds": 5})
    harness.after_response = lambda: setattr(harness, "clock", 6.0)
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**request)
    assert failure.value.code == "budget_exhausted"
    failed = latest_run(harness.engine)
    assert failed["settlement_status"] == "settled"
    assert failed["counts"]["model_requests"] == 1
    assert [stage["status"] for stage in failed["checkpoints"]["stages"]] == ["completed"]
    result = harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert result["rows"] == [{"score": 1.0}, {"score": 1.0}]
    assert harness.requests == [["alpha", "criterion"], ["beta", "criterion"]]
    assert result["receipt"]["counts"]["model_requests"] == 2
    assert sum(usage.get("requests", 0) for usage in result["receipt"]["usage"]) == 1


def test_a_completed_stage_survives_loss_of_the_secondary_score_cache(harness):
    request = harness.request(["alpha", "beta"], budgets={"dispatch_deadline_seconds": 5})
    harness.after_response = lambda: setattr(harness, "clock", 6.0)
    with pytest.raises(SourcesQLError):
        harness.engine.query(**request)
    failed = latest_run(harness.engine)
    with harness.engine.store.db() as db:
        db.execute("DELETE FROM semantic_cache")
    result = harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert result["rows"] == [{"score": 1.0}, {"score": 1.0}]
    assert harness.requests == [["alpha", "criterion"], ["beta", "criterion"]]
    assert any(usage.get("state") == "checkpoint_reuse" for usage in result["receipt"]["usage"])


def test_cancellation_after_a_valid_response_retains_the_score_for_explicit_new_work(harness):
    request = harness.request(["alpha", "beta"])

    def cancel():
        for budget in harness.engine.active.values():
            budget.cancelled = True

    harness.after_response = cancel
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**request)
    assert failure.value.code == "cancelled"
    cancelled = latest_run(harness.engine)
    assert cancelled["status"] == "cancelled"
    with pytest.raises(SourcesQLError):
        harness.reopen().resume_run(cancelled["run_id"], str(uuid4()))
    result = harness.reopen().query(**request)
    assert result["receipt"]["status"] == "completed"
    assert harness.requests == [["alpha", "criterion"], ["beta", "criterion"]]


@pytest.mark.parametrize(
    "kind,code,certainty",
    [
        ("rejected", "provider_http_error", "rejected"),
        ("timeout", "execution_outcome_unknown", "outcome_unknown"),
        ("zero", "invalid_output", "completed_unretained"),
        ("nonfinite", "invalid_output", "completed_unretained"),
    ],
)
def test_rejected_and_uncertain_scoring_batches_cannot_be_replayed_after_restart(
    harness, kind, code, certainty
):
    harness.failure = kind
    request = harness.request(["alpha", "beta", "gamma"])
    with pytest.raises(SourcesQLError):
        harness.engine.query(**request)
    failed = latest_run(harness.engine)
    stages = [stage["status"] for stage in failed["checkpoints"]["stages"]]
    assert stages.count("completed") == 1
    assert stages.count(certainty) == 1
    assert failed["settlement_status"] == ("pending" if kind == "timeout" else "settled")
    with pytest.raises(SourcesQLError) as repeated:
        harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert repeated.value.code == code
    assert harness.requests == [["alpha", "criterion"], ["beta", "gamma"]]


def test_current_run_scores_keep_actual_usage_and_duplicate_positions_are_free(harness):
    result = harness.engine.query(**harness.request(["alpha", "beta", "alpha"]))
    assert result["rows"] == [{"score": 1.0}] * 3
    assert harness.requests == [["alpha", "criterion"], ["beta"]]
    assert result["receipt"]["counts"]["model_requests"] == 2
    usage = result["receipt"]["usage"]
    assert sum(item.get("requests", 0) for item in usage) == 2
    assert sum(item.get("input_tokens", 0) for item in usage) == 3
    assert usage[-1]["state"] == "run_reuse"
    assert not any(item.get("state") == "cache_reuse" for item in usage)


def test_a_successful_http_response_without_valid_scores_cannot_authorize_replay(harness):
    harness.batch_limit = 1
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**harness.request(["alpha"]))
    assert failure.value.code == "invalid_output"
    failed = latest_run(harness.engine)
    assert [stage["status"] for stage in failed["checkpoints"]["stages"]] == [
        "completed_unretained"
    ]
    assert failed["provider_events"][0]["status"] == "invalid_output"
    with pytest.raises(SourcesQLError) as repeated:
        harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert repeated.value.code == "invalid_output"
    assert harness.requests == [["criterion"]]


def test_scoring_checkpoint_failure_is_not_mislabeled_as_provider_output(harness, monkeypatch):
    def unavailable(*args):
        raise SourcesQLError("storage_unavailable", "Synthetic storage failure", "storage")

    monkeypatch.setattr(harness.engine.store, "stage_finish", unavailable)
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**harness.request(["alpha"]))
    assert failure.value.code == "storage_unavailable"
    failed = latest_run(harness.engine)
    assert failed["provider_events"][0]["status"] == "completed"
    assert failed["provider_events"][0]["usage"]["input_tokens"] == 2
    assert [stage["status"] for stage in failed["checkpoints"]["stages"]] == [
        "completed_unretained"
    ]
    # The response is known, but losing its saved scores cannot authorize replay.
    with harness.engine.store.db() as db:
        db.execute("DELETE FROM semantic_cache")
    with pytest.raises(SourcesQLError) as repeated:
        harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert repeated.value.code == "storage_unavailable"
    assert harness.requests == [["alpha", "criterion"]]


def test_journal_failure_precedes_spending_reservations_and_http(harness, monkeypatch):
    request = harness.request(["alpha"])

    def unavailable(*args, **kwargs):
        raise SourcesQLError("storage_unavailable", "Synthetic journal failure", "storage")

    monkeypatch.setattr(harness.engine.store, "stage_begin", unavailable)
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**request)
    assert failure.value.code == "storage_unavailable"
    failed = latest_run(harness.engine)
    assert failed["settlement_status"] == "settled"
    assert not failed.get("dispatch_intents")
    assert failed["counts"].get("model_requests", 0) == 0
    assert failed["counts"].get("input_tokens", 0) == 0
    assert failed["provider_events"] == []
    assert harness.requests == []
    result = harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert result["rows"] == [{"score": 1.0}]
    assert harness.requests == [["alpha", "criterion"]]


def test_local_reservation_failure_records_an_undispatched_intent(harness):
    with pytest.raises(SourcesQLError) as failure:
        harness.engine.query(**harness.request(["alpha"], budgets={"max_model_requests": 0}))
    assert failure.value.code == "budget_exhausted"
    failed = latest_run(harness.engine)
    assert failed["settlement_status"] == "settled"
    assert not failed.get("dispatch_intents")
    assert failed["provider_events"] == []
    assert [stage["status"] for stage in failed["checkpoints"]["stages"]] == ["not_dispatched"]
    assert harness.requests == []


def test_post_reservation_storage_failure_records_no_http_dispatch(harness, monkeypatch):
    original = Budget.reserve

    def reserve(budget, counter, amount=1, limit=None):
        original(budget, counter, amount, limit)
        if counter == "model_requests":
            raise SourcesQLError(
                "storage_unavailable", "Synthetic reservation write loss", "storage"
            )

    monkeypatch.setattr(Budget, "reserve", reserve)
    with pytest.raises(SourcesQLError):
        harness.engine.query(**harness.request(["alpha"]))
    failed = latest_run(harness.engine)
    assert failed["settlement_status"] == "settled"
    assert failed["provider_events"][0]["status"] == "not_dispatched"
    assert failed["provider_events"][0]["usage"]["requests"] == 0
    assert [stage["status"] for stage in failed["checkpoints"]["stages"]] == ["not_dispatched"]
    assert harness.requests == []
    monkeypatch.setattr(Budget, "reserve", original)
    result = harness.reopen().resume_run(failed["run_id"], str(uuid4()))
    assert result["rows"] == [{"score": 1.0}]
    assert harness.requests == [["alpha", "criterion"]]


def test_2500_candidates_use_bounded_http_batch_journals(harness, monkeypatch):
    harness.batch_limit = 128
    original_db = harness.engine.store.db
    writes = {"connections": 0, "statements": 0}

    @contextmanager
    def tracked_db():
        with original_db() as db:
            writing_cache = False

            def trace(statement):
                nonlocal writing_cache
                if statement.startswith("INSERT OR REPLACE INTO semantic_cache"):
                    writes["statements"] += 1
                    if not writing_cache:
                        writes["connections"] += 1
                        writing_cache = True

            db.set_trace_callback(trace)
            yield db

    monkeypatch.setattr(harness.engine.store, "db", tracked_db)
    bindings = {}
    for part, count in enumerate([1000, 1000, 500]):
        saved = harness.engine.import_table(
            [{"key": "content"}],
            [{"content": f"source {part}_{index}"} for index in range(count)],
            data_classification="synthetic_fixture",
        )
        bindings[f"part{part}"] = {"result_id": saved["result_id"]}
    result = harness.engine.query(
        query="""WITH
            first_scores AS (SELECT SEM_SCORE(content,'criterion') AS score FROM input.part0),
            second_scores AS (SELECT SEM_SCORE(content,'criterion') AS score FROM input.part1),
            third_scores AS (SELECT SEM_SCORE(content,'criterion') AS score FROM input.part2),
            scores AS (
                SELECT max(score) AS score FROM first_scores UNION ALL
                SELECT max(score) AS score FROM second_scores UNION ALL
                SELECT max(score) AS score FROM third_scores
            ) SELECT score FROM scores ORDER BY score DESC LIMIT 1""",
        inputs=bindings,
        budgets={"max_candidates": 2500},
        partial_policy="strict",
    )
    assert result["rows"] == [{"score": 1.0}]
    assert result["receipt"]["counts"]["scoring_documents"] == 2500
    assert len(harness.requests) == 20
    checkpoints = result["receipt"]["checkpoints"]
    assert checkpoints["total"] == 20
    assert all(stage["status"] == "completed" for stage in checkpoints["stages"])
    assert sum(usage.get("requests", 0) for usage in result["receipt"]["usage"]) == 20
    assert writes == {"connections": 20, "statements": 20}
