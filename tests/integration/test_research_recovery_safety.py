"""Real coordinator recovery safety, with deliberately interrupted synthetic leaves."""

import json
from uuid import uuid4

import pytest

from sourcesql.contracts import Budget, Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.common import source_record
from sourcesql.providers.fixture import FixtureProvider


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
        [
            Column(column["key"], column["logical_type"], column["nullable"])
            for column in result["columns"]
        ],
        result["rows"],
    )


def latest_run(engine):
    with engine.store.db() as db:
        row = db.execute("SELECT receipt FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
    return engine.run_status(json.loads(row[0])["run_id"])


def test_interruption_before_candidate_accounting_cannot_leave_a_reusable_completed_stage(
    tmp_path, monkeypatch
):
    effects = []

    def search(self, queries, options, budget):
        effects.extend(queries)
        budget.reserve("search_queries", limit="max_search_queries")
        budget.reserve("search_requests", limit="max_search_requests")
        self.events.append({"kind": "search", "status": "completed"})
        return [
            source_record(
                f"https://fixture.example/{queries[0]}/{index}",
                f"{queries[0]} {index}",
                provider="fixture",
                basis="synthetic_fixture",
            )
            for index in range(options["per_query_limit"])
        ]

    original_reserve, stopped = Budget.reserve, [False]

    def interrupt(self, counter, amount=1, limit=None):
        if counter == "candidates" and not stopped[0]:
            stopped[0] = True
            raise SourcesQLError(
                "budget_exhausted", "Synthetic interruption before candidate accounting", "dispatch"
            )
        return original_reserve(self, counter, amount, limit)

    monkeypatch.setattr(FixtureProvider, "search", search)
    monkeypatch.setattr(Budget, "reserve", interrupt)
    engine = Engine(tmp_path, worker=worker)
    with pytest.raises(SourcesQLError):
        engine.query(
            query="SELECT url FROM WEB_SEARCH('first','second',per_query_limit := 2)",
            budgets={"max_candidates": 2},
        )
    failed = latest_run(engine)
    assert failed["counts"].get("candidates", 0) == 0
    assert failed["checkpoints"]["stages"][0]["status"] == "rejected"
    with pytest.raises(SourcesQLError):
        Engine(tmp_path, worker=worker).resume_run(failed["run_id"], str(uuid4()))
    assert effects == ["first"]
    with engine.store.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 0


def failed_publish(engine, monkeypatch):
    def stop(*args, **kwargs):
        raise SourcesQLError("budget_exhausted", "Synthetic publication stop", "publish")

    monkeypatch.setattr(engine.store, "commit", stop)
    with pytest.raises(SourcesQLError):
        engine.query(
            query="SELECT url FROM WEB_SEARCH($needle,per_query_limit := 1)",
            parameters={"needle": "aurora"},
            budgets={"max_candidates": 1},
        )
    return latest_run(engine)


@pytest.mark.parametrize(
    "change",
    [
        {"query": "SELECT title FROM WEB_SEARCH($needle,per_query_limit := 1)"},
        {"parameters": {"needle": "birch"}},
        {"budgets": {"max_candidates": 2}},
    ],
)
def test_continuation_cannot_change_sql_values_or_limits(tmp_path, monkeypatch, change):
    engine = Engine(tmp_path, worker=worker)
    failed = failed_publish(engine, monkeypatch)
    request = {
        **failed["resume_request"],
        **change,
        "continuation_of": failed["run_id"],
        "request_id": str(uuid4()),
    }
    with pytest.raises(SourcesQLError) as error:
        Engine(tmp_path, worker=worker).query(**request)
    assert error.value.code == "invalid_request"


def test_continuation_refuses_changed_profile(tmp_path, monkeypatch):
    engine = Engine(tmp_path, worker=worker)
    failed = failed_publish(engine, monkeypatch)
    changed = Engine(
        tmp_path,
        profiles={"fixture": {"mode": "fixture", "provider": "fixture", "fixture_version": "t2"}},
        worker=worker,
    )
    with pytest.raises(SourcesQLError) as error:
        changed.resume_run(failed["run_id"], str(uuid4()))
    assert error.value.code == "unsupported_capability"


def test_continuation_and_recovery_reauthorize_revoked_or_private_dependencies(
    tmp_path, monkeypatch
):
    engine = Engine(tmp_path, worker=worker)
    private = engine.import_table([{"key": "fact"}], [{"fact": "private value"}])

    def stop(*args, **kwargs):
        raise SourcesQLError("budget_exhausted", "Synthetic stop", "publish")

    monkeypatch.setattr(engine.store, "commit", stop)
    with pytest.raises(SourcesQLError):
        engine.query(
            query="SELECT fact FROM input.saved",
            inputs={"saved": {"result_id": private["result_id"]}},
        )
    failed = latest_run(engine)
    restricted = Engine(tmp_path, worker=worker, allow_private=False)
    with pytest.raises(SourcesQLError) as error:
        restricted.recover_run(failed["run_id"])
    assert error.value.code == "unauthorized"
    engine.store.revoke(private["result_id"])
    fresh = Engine(tmp_path, worker=worker)
    for operation in (
        lambda: fresh.resume_run(failed["run_id"], str(uuid4())),
        lambda: fresh.recover_run(failed["run_id"]),
    ):
        with pytest.raises(SourcesQLError) as error:
            operation()
        assert error.value.code == "unauthorized"


def test_recovered_excerpt_does_not_become_a_complete_document(tmp_path, monkeypatch):
    effects = []

    def search(self, queries, options, budget):
        effects.extend(queries)
        if queries == ["stop"]:
            raise SourcesQLError("provider_http_error", "Synthetic rejection", "acquisition")
        budget.reserve("search_requests", limit="max_search_requests")
        self.events.append({"kind": "search", "status": "completed"})
        return [
            source_record(
                "https://fixture.example/excerpt",
                "Aster announced a plan.",
                provider="fixture",
                complete=False,
                basis="excerpt",
            )
        ]

    monkeypatch.setattr(FixtureProvider, "search", search)
    engine = Engine(tmp_path, worker=worker)
    with pytest.raises(SourcesQLError):
        engine.query(query="SELECT url FROM WEB_SEARCH('good','stop')", source_mode="allow_excerpt")
    failed = latest_run(engine)
    recovered = Engine(tmp_path, worker=worker).recover_run(failed["run_id"])
    assert recovered["receipt"]["status"] == "partial"
    assert not recovered["receipt"]["plan_complete"]
    assert not recovered["provenance"]["research_complete"]
    assert not recovered["source_versions"][0]["coverage"]["complete"]
    with pytest.raises(SourcesQLError) as error:
        engine.query(
            query="SELECT SEM_EXTRACT(content,'claim') AS claim FROM input.saved",
            inputs={"saved": {"result_id": recovered["result_id"], "view": "sources"}},
        )
    assert error.value.code == "unsupported_capability"
    assert effects == ["good", "stop"]
