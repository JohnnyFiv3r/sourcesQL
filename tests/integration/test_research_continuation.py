"""Retained real coordinator stages; no provider network or paid calls."""

from uuid import uuid4

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.fixture import FixtureProvider


def worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {k: v.to_dict() for k, v in tables.items()},
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
        identifier = db.execute("SELECT id FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()[0]
    return engine.run_status(identifier)


def test_failed_fanout_retains_successful_sources_for_provider_free_recovery(tmp_path, monkeypatch):
    calls = []
    original = FixtureProvider.search

    def search(self, queries, options, budget):
        calls.extend(queries)
        if queries == ["fail"]:
            raise SourcesQLError("provider_http_error", "PRIVATE-REJECTION", "acquisition")
        return original(self, queries, options, budget)

    monkeypatch.setattr(FixtureProvider, "search", search)
    engine = Engine(tmp_path, worker=worker)
    with pytest.raises(SourcesQLError, match="PRIVATE-REJECTION"):
        engine.query(
            query="SELECT title, url FROM WEB_SEARCH('aurora', 'fail')", source_mode="allow_excerpt"
        )
    failed = latest_run(engine)
    assert failed["status"] == "failed"
    assert {s["status"] for s in failed["checkpoints"]["stages"]} == {"completed", "rejected"}
    reopened = Engine(tmp_path, worker=worker)
    recovered = reopened.recover_run(failed["run_id"])
    assert recovered["row_count"] > 0
    assert recovered["receipt"]["status"] == "partial"
    assert not recovered["receipt"]["plan_complete"]
    assert not recovered["provenance"]["research_complete"]
    assert recovered["source_versions"] and recovered["source_bindings"]
    reused = reopened.query(
        query="SELECT title FROM input.saved",
        inputs={"saved": {"result_id": recovered["result_id"]}},
    )
    assert reused["rows"]
    assert calls == ["aurora", "fail"]
    with pytest.raises(SourcesQLError) as error:
        reopened.resume_run(failed["run_id"], str(uuid4()))
    assert error.value.code == "provider_http_error"
    assert calls == ["aurora", "fail"]


def test_publish_failure_continues_after_restart_without_repeating_completed_work(
    tmp_path, monkeypatch
):
    calls = []
    original = FixtureProvider.search

    def search(self, queries, options, budget):
        calls.extend(queries)
        return original(self, queries, options, budget)

    monkeypatch.setattr(FixtureProvider, "search", search)
    engine = Engine(tmp_path, worker=worker)

    def stopped(*args, **kwargs):
        raise SourcesQLError("budget_exhausted", "Synthetic late execution stop", "publish")

    monkeypatch.setattr(engine.store, "commit", stopped)
    with pytest.raises(SourcesQLError):
        engine.query(
            query="SELECT title FROM WEB_SEARCH('aurora', per_query_limit := 1)",
            source_mode="allow_excerpt",
            budgets={"max_candidates": 1},
        )
    failed = latest_run(engine)
    assert failed["settlement_status"] == "settled"
    assert failed["counts"]["candidates"] == 1
    fresh = Engine(tmp_path, worker=worker)
    result = fresh.resume_run(failed["run_id"], str(uuid4()))
    assert result["rows"] and result["receipt"]["status"] == "completed"
    assert result["receipt"]["continuation_of"] == failed["run_id"]
    assert result["receipt"]["counts"]["candidates"] == 1
    assert result["receipt"]["counts"]["checkpoint_hits"] == 1
    assert calls == ["aurora"]


def test_uncertain_request_never_authorizes_continuation(tmp_path, monkeypatch):
    calls = []

    def timeout(self, queries, options, budget):
        calls.extend(queries)
        budget.reserve("search_requests")
        raise SourcesQLError("provider_timeout", "PRIVATE-TIMEOUT", "acquisition")

    monkeypatch.setattr(FixtureProvider, "search", timeout)
    engine = Engine(tmp_path, worker=worker)
    with pytest.raises(SourcesQLError):
        engine.query(query="SELECT title FROM WEB_SEARCH('aurora')", source_mode="allow_excerpt")
    failed = latest_run(engine)
    assert failed["settlement_status"] == "pending"
    with pytest.raises(SourcesQLError) as error:
        Engine(tmp_path, worker=worker).resume_run(failed["run_id"], str(uuid4()))
    assert error.value.code == "execution_outcome_unknown"
    assert calls == ["aurora"]


def test_declared_research_obligations_remain_partial_after_successful_sql(tmp_path):
    engine = Engine(tmp_path, worker=worker)
    saved = engine.import_table(
        [{"key": "entity"}, {"key": "known", "logical_type": "BIGINT"}, {"key": "unknown"}],
        [{"entity": "one", "known": 100, "unknown": None}],
        data_classification="synthetic_fixture",
    )
    result = engine.query(
        query="SELECT * FROM input.saved",
        inputs={"saved": {"result_id": saved["result_id"]}},
        research_requirements={"key_columns": ["entity"], "fields": ["unknown"], "minimum_rows": 2},
    )
    assert result["receipt"]["status"] == "completed"
    quality = result["research_quality"]
    assert quality["goal_status"] == "partial" and not quality["complete"]
    assert quality["row_shortfall"] == 1
    assert quality["gaps"][0]["status"] == "uninspected"
    assert not quality["factual_truth_verified"]
    assert (
        Engine(tmp_path, worker=worker).read_result(result["result_id"])["research_quality"]
        == quality
    )
