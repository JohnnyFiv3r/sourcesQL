"""Safety guarantees that no other test proved: stored-result integrity and the storage quota."""

from __future__ import annotations

import json

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
