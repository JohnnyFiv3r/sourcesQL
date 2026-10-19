"""Real planner checks for bounded request lookup, using no remote storage."""

from __future__ import annotations

import json
import sqlite3

import duckdb
import pytest

from sourcesql.contracts import SourcesQLError, canonical
from sourcesql.storage.motherduck import MotherDuckStore
from sourcesql.storage.store import Store


@pytest.fixture(params=["sqlite", "duckdb"])
def store(request, tmp_path):
    if request.param == "sqlite":
        return Store(tmp_path / "local")
    path = tmp_path / "motherduck-fixture.duckdb"
    return MotherDuckStore(
        database="synthetic_request_lookup",
        namespace="a" * 64,
        connector=lambda: duckdb.connect(str(path)),
    )


def seed_records(store, count=10000):
    records = [
        (
            "run_index_" + str(index),
            "00000000-0000-4000-8000-" + f"{index:012d}",
            "synthetic_hash",
            canonical({"run_id": "run_index_" + str(index), "status": "running"}).decode(),
        )
        for index in range(count)
    ]
    with store.db() as db:
        connection = db.connection if isinstance(store, MotherDuckStore) else db
        connection.executemany("INSERT INTO runs VALUES(?,?,?,?)", records)
    return records


def test_request_lookup_uses_index_over_accumulated_history(store):
    records = seed_records(store)
    selected = records[len(records) // 2]
    assert store.lookup_request(selected[1]) == json.loads(selected[3])
    sql = "SELECT receipt FROM runs WHERE lower(request_id)=? LIMIT 2"
    with store.db() as db:
        if isinstance(store, MotherDuckStore):
            plan = db.connection.execute("EXPLAIN ANALYZE " + sql, [selected[1]]).fetchone()[1]
            assert "Index Scan" in plan, plan
        else:
            plan = db.execute("EXPLAIN QUERY PLAN " + sql, [selected[1]]).fetchall()
            assert any("USING INDEX" in row[3] for row in plan), plan
            assert all("SCAN runs" not in row[3] for row in plan), plan


def test_case_insensitive_index_retains_mixed_case_and_ambiguous_legacy_requests(store):
    mixed = "aB123456-aBcD-4AbC-aBcD-aBcDeF123456"
    first = {"run_id": "run_mixed", "status": "running"}
    with store.db() as db:
        db.execute(
            "INSERT INTO runs VALUES(?,?,?,?)",
            ("run_mixed", mixed, "hash_a", canonical(first).decode()),
        )
    assert store.lookup_request(mixed.lower()) == first
    assert store.lookup_request(mixed.upper()) == first
    with store.db() as db:
        db.execute(
            "INSERT INTO runs VALUES(?,?,?,?)",
            (
                "run_ambiguous",
                mixed.upper(),
                "hash_b",
                canonical({"run_id": "run_ambiguous", "status": "failed"}).decode(),
            ),
        )
    with pytest.raises(SourcesQLError) as error:
        store.lookup_request(mixed.lower())
    assert error.value.code == "idempotency_conflict"
    with store.db() as db:
        assert db.execute("SELECT count(*) FROM runs").fetchone()[0] == 2


def test_existing_sqlite_store_gains_lookup_index_without_rewriting_history(tmp_path):
    root = tmp_path / "legacy"
    root.mkdir()
    database = root / "control.sqlite"
    receipt = canonical({"run_id": "run_legacy", "status": "running"}).decode()
    with sqlite3.connect(database) as db:
        db.execute(
            "CREATE TABLE runs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,receipt TEXT NOT NULL)"
        )
        db.execute(
            "INSERT INTO runs VALUES(?,?,?,?)",
            ("run_legacy", "AB123456-ABCD-4ABC-ABCD-ABCDEF123456", "original_hash", receipt),
        )
    store = Store(root)
    with store.db() as db:
        plan = db.execute(
            "EXPLAIN QUERY PLAN SELECT receipt FROM runs WHERE lower(request_id)=? LIMIT 2",
            ("ab123456-abcd-4abc-abcd-abcdef123456",),
        ).fetchall()
        assert any("USING INDEX" in row[3] for row in plan), plan
        assert db.execute("SELECT request_hash,receipt FROM runs").fetchone() == (
            "original_hash",
            receipt,
        )
    assert store.lookup_request("ab123456-abcd-4abc-abcd-abcdef123456")["run_id"] == "run_legacy"
    # Initialization remains safe and does not add duplicate records or indices.
    reopened = Store(root)
    with reopened.db() as db:
        assert db.execute("SELECT count(*) FROM runs").fetchone()[0] == 1
