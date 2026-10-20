"""Bounded retained-body projections on SQLite and the real local DuckDB adapter."""

from __future__ import annotations

from contextlib import contextmanager
import json

import duckdb
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical
from sourcesql.engine import Engine
from sourcesql.feature_contracts import CELL_ORIGINS_ENCODING
from sourcesql.storage.motherduck import MotherDuckStore
from sourcesql.storage.store import Store


@pytest.fixture(params=["sqlite", "duckdb"])
def fixture(request, tmp_path, monkeypatch):
    if request.param == "sqlite":
        store = Store(tmp_path / "records")
    else:
        store = MotherDuckStore(
            "synthetic",
            "a" * 64,
            connector=lambda: duckdb.connect(str(tmp_path / "records.duckdb")),
        )
    parent = store.commit(
        Table([Column("name")], [{"name": "parent"}]),
        {"result_id": "parent", "data_classification": "public_web"},
    )
    columns = [
        Column("big", "BIGINT", False),
        Column("amount", "DECIMAL(38,12)", False),
        Column("detail", "STRUCT(name VARCHAR, flags BOOLEAN[])", False),
        Column("unknown"),
    ]
    table = Table(
        columns,
        [
            {
                "big": 9007199254740993001,
                "amount": "12345678901234567890123456.123456789012",
                "detail": {"name": "Café 🦆", "flags": [True, False]},
                "unknown": None,
            }
        ],
    )
    giant = {"source_version_id": "src_large", "content": 'Untrusted "quoted" \\ \n é🦆 ' * 35000}
    metadata = {
        "result_id": "selected",
        "data_classification": "public_web",
        "row_ids": ["row_typed"],
        "parents": [
            {
                "result_id": "parent",
                "content_sha256": parent["content_sha256"],
                "view": "original",
                "amendment_revision": None,
            }
        ],
        "provenance": {"snapshot_id": "saved", "amendment_revision": 7},
        "research_requirements": {"fields": ["big"], "key_columns": ["big"]},
        "source_bindings": {"src_large": "retained"},
        "cell_diagnostics": [{"row_id": "row_typed", "status": "unknown"}],
        "created_at": "2026-10-19T00:00:00Z",
        "profile_revision": "b" * 64,
        "query_sha256": "c" * 64,
        "receipt": {"status": "completed", "resume_request": {"private": "CONTROL_MUST_NOT_CROSS"}},
        "source_versions": [
            {"source_version_id": "src_small", "content": "Small retained document"},
            giant,
        ],
        "evidence": [
            {"row_id": "other", "marker": "excluded"},
            {"row_id": None, "status": "input_set"},
            {"row_id": "row_typed", "status": "supported_text"},
        ],
    }
    store.commit(table, metadata)
    trace = []
    original = store.db

    class Cursor:
        def __init__(self, cursor):
            self.cursor = cursor

        def fetchone(self):
            row = self.cursor.fetchone()
            trace.append(row)
            return row

        def fetchall(self):
            rows = self.cursor.fetchall()
            trace.extend(rows)
            return rows

    class Connection:
        def __init__(self, db):
            self.db = db

        def execute(self, *args):
            return Cursor(self.db.execute(*args))

    @contextmanager
    def traced():
        with original() as db:
            yield Connection(db)

    monkeypatch.setattr(store, "db", traced)
    return Engine(tmp_path / "unused", store=store, allow_private=False), store, giant, trace


def test_rows_keep_typed_values_and_public_metadata_without_corpus_transfer(fixture):
    engine, _, _, trace = fixture
    result = engine.inspect_result(result_id="selected", mode="rows", limit=1)
    assert result["rows"] == [
        {
            "big": "9007199254740993001",
            "amount": "12345678901234567890123456.123456789012",
            "detail": {"name": "Café 🦆", "flags": [True, False]},
            "unknown": None,
        }
    ]
    assert result["source_versions"] == result["evidence"] == []
    assert result["source_page"]["total"] == 2
    assert result["evidence_page"]["total"] == 3
    for key in (
        "provenance",
        "research_requirements",
        "source_bindings",
        "cell_diagnostics",
        "created_at",
        "profile_revision",
        "query_sha256",
    ):
        assert key in result
    assert "resume_request" not in result["receipt"]
    # Local table bytes may be loaded; metadata/source corpora must not cross SQL.
    assert max(len(canonical(row)) for row in trace) < 10000
    assert "CONTROL_MUST_NOT_CROSS" not in str(trace)


def test_evidence_source_pages_and_unicode_chunks_preserve_global_identity(fixture):
    engine, _, giant, trace = fixture
    result = engine.inspect_result(
        result_id="selected", mode="evidence", limit=1, source_offset=1, max_bytes=65536
    )
    assert result["evidence_page"]["total"] == 2
    assert [row.get("status") for row in result["evidence"]] == ["input_set", "supported_text"]
    page = result["source_page"]
    assert page["next_offset"] is None and page["complete"] is False
    assert page["chunk_required"]["record_index"] == 1
    assert page["chunk_required"]["next_offset_after_chunk"] is None
    encoded = ""
    offset = 0
    while True:
        chunk = engine.inspect_result(
            result_id="selected",
            collection="source_versions",
            record_index=1,
            chunk_offset=offset,
            max_bytes=65536,
        )
        assert chunk["offset_unit"] == "unicode_code_points"
        assert chunk["content_sha256"] == result["content_sha256"]
        encoded += chunk["json_chunk"]
        if chunk["next_chunk_offset"] is None:
            break
        assert chunk["next_chunk_offset"] > offset
        offset = chunk["next_chunk_offset"]
    assert json.loads(encoded) == giant
    assert max(len(canonical(row)) for row in trace) < 65536


def test_every_page_and_chunk_reauthorizes_contributing_parent(fixture):
    engine, store, _, _ = fixture
    engine.inspect_result(result_id="selected", collection="source_versions", record_index=1)
    store.revoke("parent")
    for params in (
        {"mode": "rows"},
        {"mode": "evidence"},
        {"collection": "source_versions", "record_index": 1, "chunk_offset": 1},
        {"collection": "rows", "record_index": 0},
    ):
        with pytest.raises(SourcesQLError) as error:
            engine.inspect_result(result_id="selected", **params)
        assert error.value.code == "unauthorized"


def test_private_parent_and_wrong_pin_are_not_bypassed(fixture):
    engine, store, _, _ = fixture
    with store.db() as db:
        raw = db.execute("SELECT metadata FROM results WHERE id='parent'").fetchone()[0]
        meta = json.loads(raw)
        meta["data_classification"] = "private_local"
        db.execute("UPDATE results SET metadata=? WHERE id='parent'", [canonical(meta).decode()])
    with pytest.raises(SourcesQLError) as error:
        engine.inspect_result(result_id="selected", collection="evidence", record_index=0)
    assert error.value.code == "unauthorized"
    with store.db() as db:
        meta["data_classification"] = "public_web"
        db.execute("UPDATE results SET metadata=? WHERE id='parent'", [canonical(meta).decode()])
        selected = json.loads(
            db.execute("SELECT metadata FROM results WHERE id='selected'").fetchone()[0]
        )
        selected["parents"][0]["content_sha256"] = "f" * 64
        db.execute(
            "UPDATE results SET metadata=? WHERE id='selected'", [canonical(selected).decode()]
        )
    with pytest.raises(SourcesQLError) as error:
        engine.inspect_result(result_id="selected", mode="rows")
    assert error.value.code == "evidence_invalid"


def test_inspection_rejects_unsafe_identity_and_incomplete_chunk_request(fixture):
    engine, _, _, _ = fixture
    for args in (
        {"result_id": "../outside"},
        {"result_id": "selected", "collection": "evidence"},
        {"result_id": "selected", "record_index": 0},
    ):
        with pytest.raises(SourcesQLError) as error:
            engine.inspect_result(**args)
        assert error.value.code == "invalid_request"


def test_compact_and_named_cell_origins_have_one_canonical_import_identity(tmp_path):
    engine = Engine(tmp_path / "store")
    parent = engine.import_table(
        columns=[{"key": "value", "logical_type": "VARCHAR"}],
        rows=[{"value": "Retained value"}],
        row_ids=["same_row"],
        data_classification="public_web",
    )
    request = {
        "columns": [{"key": "value", "logical_type": "VARCHAR"}],
        "rows": [{"value": "Retained value"}],
        "row_ids": ["same_row"],
        "data_classification": "public_web",
        "parents": [
            {"result_id": parent["result_id"], "view": "original", "amendment_revision": None}
        ],
        "provenance": {
            "materialization_contract": "sourcesql.app-effective.v2",
            "amendment_revision": 0,
        },
    }
    named = [
        {
            "row_id": "same_row",
            "column_key": "value",
            "result_id": parent["result_id"],
            "source_row_id": "same_row",
            "source_column_key": "value",
        }
    ]
    compact = {"encoding": CELL_ORIGINS_ENCODING, "cells": [[0, 0, 0]]}
    first = engine.import_table(**request, cell_origins=named)
    assert engine.import_table(**request, cell_origins=compact)["result_id"] == first["result_id"]
    for coordinates in ([1, 0, 0], [0, 1, 0], [0, 0, 1], [True, 0, 0], [0, -1, 0], [0, 0]):
        with pytest.raises(SourcesQLError):
            engine.import_table(
                **request, cell_origins={"encoding": CELL_ORIGINS_ENCODING, "cells": [coordinates]}
            )


def test_source_chunks_still_check_retained_result_integrity(fixture):
    engine, store, _, _ = fixture
    if store.inspection_dialect == "sqlite":
        (store.root / "selected.json").write_text('{"corrupt":true}')
    else:
        with store.db() as db:
            db.execute("UPDATE results SET payload='{}' WHERE id='selected'")
    with pytest.raises(SourcesQLError) as error:
        engine.inspect_result(result_id="selected", collection="source_versions", record_index=0)
    assert error.value.code == "evidence_invalid"
