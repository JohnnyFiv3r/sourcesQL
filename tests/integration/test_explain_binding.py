"""Explain shares SQL binding and durable fences, without research side effects.

The final tests use the production protected worker. Reference evaluation in the
other tests isolates coordinator boundaries; OS denial has its own suite.
"""

from __future__ import annotations

from uuid import uuid4

import duckdb
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical, digest
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.storage.motherduck import MotherDuckStore, timestamp


def reference_worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {name: table.to_dict() for name, table in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    if "error" in result:
        raise SourcesQLError("invalid_query", "Synthetic SQL binding failed", "worker")
    return Table(
        [Column(item["key"], item["logical_type"], item["nullable"]) for item in result["columns"]],
        result["rows"],
    )


def counts(engine):
    with engine.store.db() as db:
        return tuple(
            db.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
            for name in ("results", "runs", "execution_stages", "semantic_cache")
        )


@pytest.mark.parametrize(
    "query",
    [
        "WITH candidate AS (SELECT 'Rechargeable batteries store electricity.' AS content) "
        "SELECT SEM_SCORE(content,'energy storage') AS relevance FROM candidate",
        "SELECT title,url FROM WEB_SEARCH('synthetic criterion')",
        "WITH candidate AS (SELECT 'alpha' AS content) "
        "SELECT SEM_MATCH(content,'criterion') AS eligible FROM candidate",
    ],
)
def test_explain_binds_literal_and_external_queries_without_provider_or_durable_work(
    tmp_path, monkeypatch, query
):
    import sourcesql.providers

    engine = Engine(
        tmp_path,
        profiles={"recorded": {"mode": "live", "provider": "exa"}},
        worker=reference_worker,
    )

    def forbidden(*args, **kwargs):
        raise AssertionError("Explain must not construct a provider coordinator")

    monkeypatch.setattr(sourcesql.providers.ProviderRegistry, "__init__", forbidden)
    before = counts(engine)
    explained = engine.explain(query=query, profile="recorded")
    assert explained["external_calls"] == 0
    assert explained["mode"] == "live"
    assert counts(engine) == before == (0, 0, 0, 0)
    assert engine.active == {}


@pytest.mark.parametrize(
    "query",
    [
        "SELECT title FROM WEB_SEARCH('x') GROUP BY url",
        "SELECT sum(content) AS value FROM WEB_SEARCH('x')",
        "WITH candidate AS (SELECT 'not_a_number' AS content), "
        "scored AS (SELECT content,SEM_SCORE(content,'criterion') AS score FROM candidate) "
        "SELECT CAST(content AS BIGINT) AS count,score FROM scored",
    ],
)
def test_explain_rejects_actual_relational_binding_errors_without_a_run(tmp_path, query):
    engine = Engine(tmp_path, worker=reference_worker)
    with pytest.raises(SourcesQLError) as error:
        engine.explain(query=query)
    assert error.value.code == "invalid_query"
    assert error.value.stage == "admission"
    assert counts(engine) == (0, 0, 0, 0)


@pytest.mark.parametrize("fail_probe", [False, True])
def test_each_explain_owns_and_closes_one_checked_protected_session(
    tmp_path, monkeypatch, fail_probe
):
    import sourcesql.engine as engine_module

    sessions = []

    class ProbeSession:
        def __enter__(self):
            self.calls = []
            self.closed = False
            sessions.append(self)
            return self

        def run_sql(self, sql, tables, parameters=None, timeout=30):
            self.calls.append(sql)
            assert 0 < timeout <= 30
            if fail_probe:
                raise SourcesQLError("unsupported_capability", "Synthetic launch refusal", "worker")
            return reference_worker(sql, tables, parameters, timeout)

        def __exit__(self, *args):
            self.closed = True

    monkeypatch.setattr(engine_module, "WorkerSession", ProbeSession)
    engine = Engine(tmp_path)
    engine.worker_checked = True
    for _ in range(2):
        if fail_probe:
            with pytest.raises(SourcesQLError) as error:
                engine.explain(query="SELECT 7 AS value")
            assert error.value.code == "unsupported_capability"
        else:
            assert engine.explain(query="SELECT 7 AS value")["external_calls"] == 0
    assert len(sessions) == 2
    assert all(session.closed for session in sessions)
    assert all("worker_probe" in session.calls[0] for session in sessions)
    assert counts(engine) == (0, 0, 0, 0)


def test_explain_deadline_covers_probe_and_binding_and_does_not_start_a_run(tmp_path, monkeypatch):
    import sourcesql.engine as engine_module

    clock, calls = [0.0], []
    monkeypatch.setattr(engine_module.time, "monotonic", lambda: clock[0])

    def slow_worker(sql, tables, parameters=None, timeout=30):
        calls.append((sql, timeout))
        result = reference_worker(sql, tables, parameters, timeout)
        clock[0] += 2
        return result

    engine = Engine(tmp_path, worker=slow_worker)
    with pytest.raises(SourcesQLError) as error:
        engine.explain(query="SELECT 7 AS value", budgets={"dispatch_deadline_seconds": 1})
    assert error.value.code == "budget_exhausted"
    assert error.value.stage == "worker"
    assert len(calls) == 1 and calls[0][1] == 1
    assert counts(engine) == (0, 0, 0, 0)


@pytest.mark.parametrize("change", ["revocation", "pin", "cancel", "claim"])
def test_explain_rechecks_exact_inputs_and_native_job_ownership_between_worker_stages(
    tmp_path, change
):
    path = tmp_path / "durable.duckdb"
    store = MotherDuckStore(
        database="synthetic_test",
        namespace="e" * 64,
        connector=lambda: duckdb.connect(str(path)),
    )
    calls, actions = [], []

    def worker(sql, tables, parameters=None, timeout=30):
        calls.append(sql)
        result = reference_worker(sql, tables, parameters, timeout)
        if actions:
            actions.pop()()
        return result

    engine = Engine(tmp_path / "unused", store=store, worker=worker)
    saved = engine.import_table(
        [{"key": "content", "logical_type": "VARCHAR"}],
        [{"content": "synthetic content"}],
        data_classification="synthetic_fixture",
    )
    request = {
        "query": "SELECT SEM_SCORE(content,'criterion') AS relevance FROM input.docs",
        "inputs": {"docs": {"result_id": saved["result_id"]}},
    }
    job_id, claim = str(uuid4()), str(uuid4())
    with store.db() as db:
        db.execute(
            "INSERT INTO jobs(id,request_id,operation,request_hash,request_json,status,"
            "created_at,updated_at,flight_id,flight_version,claim_token,max_runtime_sec) "
            "VALUES(?::UUID,?::UUID,'explain',?,?,'running',?,?,?::UUID,1,?::UUID,120)",
            [
                job_id,
                job_id,
                digest(request),
                canonical(request).decode(),
                timestamp(),
                timestamp(),
                str(uuid4()),
                claim,
            ],
        )
    store.bind_job(job_id, claim)

    def change_durable_state():
        if change == "revocation":
            store.revoke(saved["result_id"])
        elif change == "pin":
            # Simulate a changed immutable metadata pin after the initial read.
            with store.db() as db:
                row = db.execute(
                    "SELECT metadata FROM results WHERE id=?", [saved["result_id"]]
                ).fetchone()
                from sourcesql.engine import strict_json

                meta = strict_json(row[0])
                meta["content_sha256"] = "f" * 64
                db.execute(
                    "UPDATE results SET metadata=? WHERE id=?",
                    [canonical(meta).decode(), saved["result_id"]],
                )
        else:
            with store.db() as db:
                if change == "cancel":
                    db.execute("UPDATE jobs SET cancel_requested=true WHERE id=?::UUID", [job_id])
                else:
                    db.execute(
                        "UPDATE jobs SET claim_token=?::UUID WHERE id=?::UUID",
                        [str(uuid4()), job_id],
                    )

    before = counts(engine)
    actions.append(change_durable_state)
    with pytest.raises(SourcesQLError) as error:
        engine.explain(**request)
    assert error.value.code == {
        "revocation": "unauthorized",
        "pin": "evidence_invalid",
        "cancel": "cancelled",
        "claim": "unauthorized",
    }[change]
    assert len(calls) == 1 and "worker_probe" in calls[0]
    assert counts(engine) == before


def test_private_disclosure_refusal_precedes_explain_worker_launch(tmp_path):
    calls = []
    engine = Engine(tmp_path, worker=lambda *args, **kwargs: calls.append(args))
    saved = engine.import_table(
        [{"key": "content", "logical_type": "VARCHAR"}],
        [{"content": "private content"}],
        data_classification="private_local",
    )
    before = counts(engine)
    with pytest.raises(SourcesQLError) as error:
        engine.explain(
            query="SELECT SEM_SCORE(content,'criterion') AS relevance FROM input.docs",
            inputs={"docs": {"result_id": saved["result_id"]}},
        )
    assert error.value.code == "disclosure_required"
    assert calls == [] and counts(engine) == before


@pytest.mark.parametrize("invalid_cast", [False, True])
def test_actual_protected_explain_checks_sql_without_constructing_a_provider(
    tmp_path, monkeypatch, invalid_cast
):
    import sourcesql.providers

    def forbidden(*args, **kwargs):
        raise AssertionError("Protected explain must not construct a provider coordinator")

    monkeypatch.setattr(sourcesql.providers.ProviderRegistry, "__init__", forbidden)
    engine = Engine(tmp_path)
    content = "not_a_number" if invalid_cast else "Rechargeable batteries store electricity."
    projection = "CAST(content AS BIGINT) AS count,score" if invalid_cast else "score"
    query = (
        f"WITH candidate AS (SELECT '{content}' AS content), "
        "scored AS (SELECT content,SEM_SCORE(content,'energy storage') AS score FROM candidate) "
        f"SELECT {projection} FROM scored"
    )
    if invalid_cast:
        with pytest.raises(SourcesQLError) as error:
            engine.explain(query=query)
        assert error.value.code == "invalid_query"
        assert error.value.stage == "admission"
    else:
        assert engine.explain(query=query)["external_calls"] == 0
    assert counts(engine) == (0, 0, 0, 0)
