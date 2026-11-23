"""Safety guarantees that no other test proved: stored-result integrity and the storage quota."""

from __future__ import annotations

import json
import uuid

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.storage.store import Store


def reference_worker(sql, tables, parameters=None, timeout=30):
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


def pin(result_id):
    return {"result_id": result_id, "view": "original", "amendment_revision": None}


def make(tmp_path, **options):
    return Engine(tmp_path / "engine", worker=reference_worker, **options)


def retained_result(tmp_path):
    engine = make(tmp_path)
    saved = engine.import_table(
        [{"key": "name", "logical_type": "text", "nullable": False}],
        [{"name": "Aurora Campus"}],
    )
    return engine, saved["result_id"]


def test_stored_result_tampered_bytes_refused(tmp_path):
    engine, result_id = retained_result(tmp_path)
    path = engine.store.root / (result_id + ".json")
    data = json.loads(path.read_bytes())
    data["rows"][0]["name"] = "Altered Campus"
    path.write_text(json.dumps(data))
    with pytest.raises(SourcesQLError) as refused:
        engine.read_result(result_id)
    assert refused.value.code == "evidence_invalid", (
        "Altered stored result was returned instead of refused."
    )


def test_tampered_result_cannot_be_reused_as_an_input(tmp_path):
    engine, result_id = retained_result(tmp_path)
    path = engine.store.root / (result_id + ".json")
    data = json.loads(path.read_bytes())
    data["rows"][0]["name"] = "Altered Campus"
    path.write_text(json.dumps(data))
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT name FROM input.saved",
            inputs={"saved": pin(result_id)},
        )
    assert refused.value.code == "evidence_invalid", (
        "Altered stored result was used as a query input instead of refused."
    )


def test_stored_result_deleted_bytes_unavailable(tmp_path):
    engine, result_id = retained_result(tmp_path)
    (engine.store.root / (result_id + ".json")).unlink()
    with pytest.raises(SourcesQLError) as refused:
        engine.read_result(result_id)
    assert refused.value.code == "result_unavailable", (
        "Missing stored result was not reported unavailable."
    )


def stored_state(engine):
    with engine.store.db() as db:
        rows = db.execute("SELECT id FROM results ORDER BY id").fetchall()
        used = engine.store.retained_size(db)
    leftovers = sorted(p.name for p in engine.store.root.iterdir() if p.suffix in (".json", ".tmp"))
    return [r[0] for r in rows], leftovers, used


COLUMNS = [{"key": "name", "logical_type": "text", "nullable": False}]


def test_storage_quota_refuses_next_write(tmp_path):
    probe = make(tmp_path / "probe")
    probe.query(query="SELECT 'first' AS n")
    # A quota that holds exactly one result's retained bytes: the next write must not fit.
    quota = stored_state(probe)[2] + 10
    engine = make(tmp_path / "limited", store=Store(tmp_path / "limited" / "store", quota=quota))
    engine.query(query="SELECT 'first' AS n")
    before = stored_state(engine)
    with pytest.raises(SourcesQLError) as refused:
        engine.query(query="SELECT 'second' AS n")
    assert refused.value.code == "budget_exhausted", (
        "Write past the storage quota was accepted or left a partial result."
    )
    assert stored_state(engine)[:2] == before[:2], (
        "Write past the storage quota was accepted or left a partial result."
    )


def test_storage_quota_refuses_imported_table_without_partial_result(tmp_path):
    engine = make(tmp_path, store=Store(tmp_path / "store", quota=1000))
    before = stored_state(engine)
    with pytest.raises(SourcesQLError) as refused:
        engine.import_table(COLUMNS, [{"name": "x" * 4000}])
    assert refused.value.code == "budget_exhausted", (
        "Write past the storage quota was accepted or left a partial result."
    )
    assert stored_state(engine) == before


def test_storage_quota_refuses_imported_bundle_without_partial_result(tmp_path):
    source = make(tmp_path / "source")
    saved = source.import_table(COLUMNS, [{"name": "x" * 4000}])
    bundle = source.export(saved["result_id"])
    target = make(tmp_path / "target", store=Store(tmp_path / "target" / "store", quota=1000))
    before = stored_state(target)
    with pytest.raises(SourcesQLError) as refused:
        target.import_bundle(bundle)
    assert refused.value.code == "budget_exhausted", (
        "Write past the storage quota was accepted or left a partial result."
    )
    assert stored_state(target) == before


def import_parent(engine):
    return engine.import_table(
        COLUMNS, [{"name": "a"}, {"name": "b"}], row_ids=["parent_row_1", "parent_row_2"]
    )


def test_refresh_keeps_a_valid_explicit_row_identity(tmp_path):
    engine = make(tmp_path)
    parent = import_parent(engine)
    refreshed = engine.query(
        query="SELECT 'parent_row_1' AS rid, name FROM input.p WHERE name = 'a'",
        inputs={"p": pin(parent["result_id"])},
        row_id_column="rid",
    )
    assert refreshed["row_ids"] == ["parent_row_1"]
    assert [c["key"] for c in refreshed["columns"]] == ["name"]


@pytest.mark.parametrize(
    "sql",
    [
        pytest.param("SELECT 'parent_row_1' AS rid, name FROM input.p", id="repeated_identity"),
        pytest.param(
            "SELECT 'not_a_parent_row' AS rid, name FROM input.p WHERE name = 'a'",
            id="identity_outside_authorized_input",
        ),
        pytest.param(
            "SELECT 'parent_row_1' AS rid, name FROM input.p WHERE name = 'absent'",
            id="no_rows_to_identify",
        ),
    ],
)
def test_refresh_rejects_repeated_or_foreign_row_identity(tmp_path, sql):
    engine = make(tmp_path)
    parent = import_parent(engine)
    before = stored_state(engine)[:2]
    with pytest.raises(SourcesQLError) as refused:
        engine.query(query=sql, inputs={"p": pin(parent["result_id"])}, row_id_column="rid")
    assert (refused.value.code, refused.value.stage) == ("invalid_output", "publish"), (
        "Refresh changed row identity without refusal."
    )
    assert stored_state(engine)[:2] == before, "Refresh changed row identity without refusal."


SEARCH = "SELECT url FROM WEB_SEARCH('aurora', per_query_limit := 1)"


def run_with_dispatch_hook(tmp_path, hook):
    """Run a search query whose launcher hook misbehaves; return the raised error and final run."""
    request_id = str(uuid.uuid4())
    engine = None

    def before_dispatch(info):
        hook(engine, request_id)

    engine = make(tmp_path, before_dispatch=before_dispatch)
    with pytest.raises(SourcesQLError) as raised:
        engine.query(query=SEARCH, request_id=request_id)
    run = engine.store.lookup_request(request_id)
    return engine, raised.value, run


def fail_dispatch(engine, request_id):
    raise SourcesQLError("budget_exhausted", "Search budget exhausted", "execution")


def cancel_dispatch(engine, request_id):
    engine.cancel(engine.store.lookup_request(request_id)["run_id"])


def crash_dispatch(engine, request_id):
    raise RuntimeError("worker crashed")


def test_failed_run_settles_failed(tmp_path):
    engine, error, run = run_with_dispatch_hook(tmp_path, fail_dispatch)
    assert error.code == "budget_exhausted"
    assert run["status"] == "failed", f"Run settled as failed but receipt says {run['status']}."
    assert run["result_id"] is None
    assert run["errors"][0]["code"] == "budget_exhausted"
    reopened = Engine(tmp_path / "engine", worker=reference_worker)
    assert reopened.run_status(run["run_id"])["status"] == "failed"


def test_cancelled_run_settles_cancelled(tmp_path):
    engine, error, run = run_with_dispatch_hook(tmp_path, cancel_dispatch)
    assert error.code == "cancelled"
    assert run["status"] == "cancelled", (
        f"Run settled as cancelled but receipt says {run['status']}."
    )
    assert run["result_id"] is None
    reopened = Engine(tmp_path / "engine", worker=reference_worker)
    assert reopened.run_status(run["run_id"])["status"] == "cancelled"


def test_failed_and_cancelled_settlements_are_distinct_and_known(tmp_path):
    _, _, failed = run_with_dispatch_hook(tmp_path / "failed", fail_dispatch)
    _, _, cancelled = run_with_dispatch_hook(tmp_path / "cancelled", cancel_dispatch)
    states = {failed["status"], cancelled["status"]}
    assert states == {"failed", "cancelled"}
    assert not states & {"unknown", "running"}
    assert failed["settlement_status"] == cancelled["settlement_status"] == "settled"


def test_unexpected_exception_settles_the_run_failed(tmp_path):
    engine, error, run = run_with_dispatch_hook(tmp_path, crash_dispatch)
    assert (error.code, error.stage) == ("execution_failed", "execution")
    assert run["status"] == "failed", f"Run settled as failed but receipt says {run['status']}."
    assert run["errors"][0]["code"] == "execution_failed"
    assert engine.run_status(run["run_id"])["status"] == "failed"


def test_unexpected_exception_after_publication_returns_the_published_result(tmp_path, monkeypatch):
    engine = make(tmp_path)
    request_id = str(uuid.uuid4())
    real_read = Engine.read_result
    calls = []

    def read_once_then_crash(self, result_id, *args, **kwargs):
        calls.append(result_id)
        if len(calls) == 1:
            raise RuntimeError("read crashed after publication")
        return real_read(self, result_id, *args, **kwargs)

    monkeypatch.setattr(Engine, "read_result", read_once_then_crash)
    result = engine.query(query=SEARCH, request_id=request_id)
    run = engine.store.lookup_request(request_id)
    assert result["result_id"] == run["result_id"]
    assert run["status"] in ("completed", "partial"), (
        f"Run settled as {run['status']} although its result was published."
    )
