"""Regression boundaries for journal replay, lifetime, and cumulative allowances.

Both durable store implementations run locally. The coordinator regression uses
the reference SQL worker and NULL fixture inputs; no provider network is used.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import re
import sqlite3
import threading
from uuid import uuid4

import duckdb
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical, digest
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.fixture import FixtureProvider
from sourcesql.storage.motherduck import MotherDuckStore
from sourcesql.storage.store import Store


@pytest.fixture(params=["sqlite", "duckdb"])
def stores(tmp_path, request):
    def create(owner="main", quota=100 * 1024 * 1024):
        if request.param == "sqlite":
            return Store(tmp_path / owner, quota=quota)
        path = tmp_path / (owner + ".duckdb")
        return MotherDuckStore(
            database="synthetic_test",
            namespace=digest(owner),
            quota=quota,
            connector=lambda: duckdb.connect(str(path)),
        )

    return create


def receipt(run="run_root", *, parent=None, counts=None):
    return {
        "run_id": run,
        "journal_id": "run_root",
        "request_id": str(uuid4()),
        "continuation_of": parent,
        "status": "running",
        "settlement_status": "settled",
        "unsettled_requests": 0,
        "receipt_revision": 0,
        "result_id": None,
        "plan_complete": False,
        "counts": counts or {},
        "parents": [],
        "data_classification": "synthetic_fixture",
    }


def begin(store, value):
    request = {"request_id": value["request_id"], "continuation_of": value["continuation_of"]}
    return store.begin_run(request, value)


def fail(store, value, *, counts=None, settlement="settled"):
    failed = {
        **value,
        "status": "failed",
        "counts": counts if counts is not None else value["counts"],
        "settlement_status": settlement,
        "receipt_revision": 1,
    }
    return store.update_run(failed)


def stage_bytes(store):
    with store.db() as db:
        return store.stage_bytes(db)


def size(store):
    with store.db() as db:
        return store.retained_size(db)


def publication(value, *, payload="qualified", result_id="wq_qualified"):
    terminal = {
        **value,
        "status": "completed",
        "result_id": result_id,
        "plan_complete": True,
        "receipt_revision": 2,
    }
    table = Table([Column("value")], [{"value": payload}])
    return table, {
        "result_id": result_id,
        "run_id": value["run_id"],
        "receipt": terminal,
        "row_ids": ["row_qualified"],
        "parents": [],
        "data_classification": "synthetic_fixture",
    }


def reference_worker(sql, tables, parameters=None, timeout=30):
    value = evaluate(
        {
            "sql": sql,
            "tables": {key: table.to_dict() for key, table in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [Column(c["key"], c["logical_type"], c["nullable"]) for c in value["columns"]],
        value["rows"],
    )


def latest_run(engine):
    with engine.store.db() as db:
        run = db.execute("SELECT id FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()[0]
    return engine.run_status(run)


def test_proven_not_dispatched_stage_requires_explicit_rearm(stores):
    store = stores()
    store.stage_begin("journal", "deadline")
    stopped = store.stage_fail(
        "journal", "deadline", "budget_exhausted", False, not_dispatched=True
    )
    assert stopped["status"] == "not_dispatched"
    retained, created = stores().stage_begin("journal", "deadline")
    assert not created and retained == stopped
    rearmed, created = store.stage_begin("journal", "deadline", retry_not_dispatched=True)
    assert created and rearmed["status"] == "intent"
    assert rearmed["error_code"] is None
    completed = store.stage_finish("journal", "deadline", {"answer": None})
    assert completed["status"] == "completed"
    retained, created = stores().stage_begin("journal", "deadline", retry_not_dispatched=True)
    assert not created and retained == completed


@pytest.mark.parametrize("kind", ["legacy_rejected", "outcome_unknown", "completed_unretained"])
def test_explicit_rearm_never_replays_dispatched_or_legacy_uncertain_work(stores, kind):
    store = stores()
    store.stage_begin("journal", "effect")
    terminal = store.stage_fail(
        "journal",
        "effect",
        "storage_unavailable" if kind == "completed_unretained" else "provider_unavailable",
        kind == "outcome_unknown",
        completed_unretained=kind == "completed_unretained",
    )
    assert (
        terminal["status"]
        == {
            "legacy_rejected": "rejected",
            "outcome_unknown": "outcome_unknown",
            "completed_unretained": "completed_unretained",
        }[kind]
    )
    retained, created = stores().stage_begin("journal", "effect", retry_not_dispatched=True)
    assert not created and retained == terminal


def test_terminal_metadata_remains_writable_with_no_remaining_payload_quota(stores):
    store = stores()
    store.stage_begin("journal", "effect")
    reserved = stage_bytes(store)
    store.quota = size(store)
    terminal = store.stage_fail(
        "journal", "effect", "storage_unavailable", False, completed_unretained=True
    )
    assert terminal["status"] == "completed_unretained"
    assert stage_bytes(store) <= reserved
    with pytest.raises(SourcesQLError, match="quota"):
        store.stage_begin("journal", "new_effect")


def test_continuation_must_name_latest_failed_head_and_duplicate_request_recovers(stores):
    store = stores()
    root = receipt()
    begin(store, root)
    fail(store, root, counts={"model_requests": 1})
    child = receipt("run_child", parent=root["run_id"], counts={"model_requests": 1})
    saved, created = begin(stores(), child)
    assert created and saved["run_id"] == child["run_id"]
    failed_child = fail(store, child, counts={"model_requests": 2})
    duplicate, created = begin(stores(), child)
    assert not created and duplicate == failed_child
    stale = receipt("run_stale", parent=root["run_id"], counts={"model_requests": 1})
    with pytest.raises(SourcesQLError):
        begin(stores(), stale)
    next_child = receipt("run_next", parent=child["run_id"], counts={"model_requests": 2})
    _, created = begin(stores(), next_child)
    assert created
    with store.db() as db:
        assert db.execute("SELECT count(*) FROM runs").fetchone()[0] == 3


@pytest.mark.parametrize("state,settlement", [("running", "settled"), ("failed", "pending")])
def test_continuation_cannot_claim_running_or_unsettled_head(stores, state, settlement):
    store = stores()
    root = receipt()
    begin(store, root)
    if state == "failed":
        fail(store, root, settlement=settlement)
    child = receipt("run_child", parent=root["run_id"])
    with pytest.raises(SourcesQLError):
        begin(stores(), child)
    with store.db() as db:
        assert db.execute("SELECT count(*) FROM runs").fetchone()[0] == 1


def test_concurrent_continuation_claims_admit_only_one_child(tmp_path):
    first = Store(tmp_path / "concurrent")
    second = Store(tmp_path / "concurrent")
    root = receipt()
    begin(first, root)
    fail(first, root, counts={"search_requests": 1})
    gate = threading.Barrier(2)

    def claim(store, run):
        child = receipt(run, parent=root["run_id"], counts={"search_requests": 1})
        gate.wait(timeout=5)
        try:
            _, created = begin(store, child)
            return "created" if created else "duplicate"
        except SourcesQLError:
            return "refused"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = [
            pool.submit(claim, first, "run_first"),
            pool.submit(claim, second, "run_second"),
        ]
        assert sorted(future.result(timeout=10) for future in outcomes) == ["created", "refused"]
    with first.db() as db:
        assert db.execute("SELECT count(*) FROM runs").fetchone()[0] == 2


def test_publication_reclaims_only_its_journal_and_cannot_reopen_ancestor(stores):
    store = stores()
    root = receipt()
    begin(store, root)
    store.stage_begin("run_root", "source")
    store.stage_finish("run_root", "source", {"content": "old source"})
    fail(store, root, counts={"search_requests": 1})
    child = receipt("run_child", parent=root["run_id"], counts={"search_requests": 1})
    begin(store, child)
    store.stage_begin("other_failed_journal", "retained")
    store.stage_finish("other_failed_journal", "retained", {"content": "must survive"})
    store.commit(*publication(child))
    reopened = stores()
    assert list(reopened.iter_stage_keys("run_root")) == []
    assert reopened.stage_read("other_failed_journal", "retained")["value"] == {
        "content": "must survive"
    }
    for parent in (root["run_id"], child["run_id"]):
        with pytest.raises(SourcesQLError):
            begin(reopened, receipt("run_replay_" + parent, parent=parent))
    with pytest.raises(SourcesQLError):
        reopened.stage_begin("run_root", "source")


def test_publication_credits_released_checkpoint_bytes_before_quota_admission(stores):
    store = stores()
    root = receipt()
    begin(store, root)
    store.stage_begin("run_root", "source")
    store.stage_finish("run_root", "source", {"content": "x" * 200_000})
    table, metadata = publication(root, payload="y" * 10_000)
    reference = stores("reference")
    begin(reference, root)
    reference.commit(table, metadata)
    final_size = size(reference)
    store.quota = final_size + 1024
    assert size(store) > store.quota
    store.commit(table, metadata)
    assert stores().read(metadata["result_id"])[1].rows == table.rows
    assert list(store.iter_stage_keys("run_root")) == []
    assert size(store) <= store.quota


def test_publication_database_failure_rolls_back_checkpoint_cleanup(stores, monkeypatch):
    store = stores()
    root = receipt()
    begin(store, root)
    store.stage_begin("run_root", "source")
    completed = store.stage_finish("run_root", "source", {"content": "recover me"})
    before = stage_bytes(store)
    original = store.db

    class FailInsert:
        def __init__(self, db):
            self.db = db

        def execute(self, sql, parameters=None):
            if re.match(r"\s*INSERT\s+INTO\s+results\b", sql, flags=re.IGNORECASE):
                raise SourcesQLError("storage_unavailable", "Synthetic publication stop", "storage")
            return self.db.execute(sql, parameters or [])

    @contextmanager
    def interrupted():
        with original() as db:
            yield FailInsert(db)

    monkeypatch.setattr(store, "db", interrupted)
    with pytest.raises(SourcesQLError, match="publication stop"):
        store.commit(*publication(root))
    reopened = stores()
    assert reopened.stage_read("run_root", "source") == completed
    assert stage_bytes(reopened) == before
    assert reopened.run(root["run_id"])["status"] == "running"
    with reopened.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 0
    reopened.commit(*publication(root))
    assert reopened.read("wq_qualified")[1].rows == [{"value": "qualified"}]


def test_journal_pagination_remains_complete_beyond_old_256_stage_ceiling(tmp_path):
    store = Store(tmp_path / "wide")
    keys = [f"stage_{index:04}" for index in range(300)]
    for key in keys:
        store.stage_begin("journal", key)
    assert store.stage_keys("journal") == keys[:128]
    assert store.stage_keys("journal", limit=128, after=keys[127]) == keys[128:256]
    assert store.stage_keys("journal", after=keys[255]) == keys[256:]
    assert list(store.iter_stage_keys("journal")) == keys
    assert store.stage_summaries("journal")["total"] == 300


@pytest.mark.parametrize(
    "invalid", ["", "x" * 129, "private SQL; DROP TABLE execution_stages", None]
)
def test_stage_key_iteration_validates_journal_and_cursor_identities(stores, invalid):
    store = stores()
    with pytest.raises(SourcesQLError) as failure:
        store.stage_keys(invalid)
    assert failure.value.code == "invalid_request"
    with pytest.raises(SourcesQLError):
        list(store.iter_stage_keys(invalid))
    if invalid is not None:
        with pytest.raises(SourcesQLError):
            store.stage_keys("journal", after=invalid)


@pytest.mark.parametrize("limit", [0, -1, 1001, True])
def test_stage_key_pagination_rejects_unbounded_or_noninteger_page_sizes(stores, limit):
    with pytest.raises(SourcesQLError) as failure:
        stores().stage_keys("journal", limit=limit)
    assert failure.value.code == "invalid_request"


def test_normal_stage_writes_do_not_rescan_or_hex_encode_retained_payloads(tmp_path, monkeypatch):
    store = Store(tmp_path / "counter")
    store.stage_begin("journal", "unicode")
    store.stage_finish("journal", "unicode", {"content": "日本語 é" * 100})
    before = stage_bytes(store)
    reopened = Store(tmp_path / "counter")
    assert stage_bytes(reopened) == before
    original, statements = reopened.db, []

    @contextmanager
    def traced():
        with original() as db:
            db.set_trace_callback(statements.append)
            yield db

    monkeypatch.setattr(reopened, "db", traced)
    reopened.stage_begin("journal", "next")
    reopened.stage_finish("journal", "next", {"content": "new"})
    assert stage_bytes(reopened) > before
    assert not any(
        "execution_stages" in sql.lower()
        and ("hex(" in sql.lower() or ("sum(" in sql.lower() and "value_json" in sql.lower()))
        for sql in statements
    )


def test_existing_utf8_checkpoint_rows_migrate_once_without_losing_values(tmp_path):
    root = tmp_path / "legacy"
    root.mkdir()
    value = {"content": "日本語 é"}
    envelope = {
        "version": "stage-value.v1",
        "content_sha256": digest(["journal", "source", value]),
        "value": value,
    }
    with sqlite3.connect(root / "control.sqlite") as db:
        db.execute(
            "CREATE TABLE execution_stages(journal_id TEXT NOT NULL,stage_key TEXT NOT NULL,"
            "status TEXT NOT NULL,value_json TEXT,error_code TEXT,PRIMARY KEY(journal_id,stage_key))"
        )
        db.execute(
            "INSERT INTO execution_stages VALUES(?,?,'completed',?,NULL)",
            ["journal", "source", canonical(envelope).decode()],
        )
    migrated = Store(root)
    assert migrated.stage_read("journal", "source")["value"] == value
    accounted = stage_bytes(migrated)
    assert accounted >= len(canonical(envelope))
    assert stage_bytes(Store(root)) == accounted


def test_legacy_published_journal_migration_recovers_full_quota_and_preserves_failed_work(stores):
    store = stores()
    root = receipt()
    begin(store, root)
    store.commit(*publication(root))
    failed = receipt("run_failed")
    failed["journal_id"] = failed["run_id"]
    begin(store, failed)
    fail(store, failed)
    store.stage_begin("run_failed", "recoverable")
    unfinished_value = {"content": "日本語 source retained for recovery"}
    store.stage_finish("run_failed", "recoverable", unfinished_value)
    old_value = {"content": "x" * 200_000}
    old_envelope = {
        "version": "stage-value.v1",
        "content_sha256": digest(["run_root", "legacy_source", old_value]),
        "value": old_value,
    }
    with store.db() as db:
        db.execute(
            "INSERT INTO execution_stages VALUES(?,?,'completed',?,NULL)",
            ["run_root", "legacy_source", canonical(old_envelope).decode()],
        )
        db.execute("DROP TABLE execution_stage_usage")
        db.execute("DROP TABLE execution_journals")
    migrated = stores(quota=32 * 1024)
    assert list(migrated.iter_stage_keys("run_root")) == []
    assert migrated.stage_read("run_failed", "recoverable")["value"] == unfinished_value
    assert migrated.read("wq_qualified")[1].rows == [{"value": "qualified"}]
    assert size(migrated) < migrated.quota
    with pytest.raises(SourcesQLError):
        migrated.stage_begin("run_root", "legacy_source")
    with pytest.raises(SourcesQLError):
        begin(migrated, receipt("run_old_ancestor", parent=root["run_id"]))
    migrated.stage_begin("new_journal", "source")
    migrated.stage_finish("new_journal", "source", {"content": "new research can proceed"})
    accounted = stage_bytes(migrated)
    reopened = stores(quota=32 * 1024)
    assert stage_bytes(reopened) == accounted
    assert list(reopened.iter_stage_keys("run_root")) == []
    assert reopened.stage_read("run_failed", "recoverable")["value"] == unfinished_value


def test_recovery_tolerates_continuation_publication_between_key_page_and_payload_read(
    stores, tmp_path, monkeypatch
):
    store = stores()
    root = receipt()
    begin(store, root)
    store.stage_begin("run_root", "source")
    store.stage_finish("run_root", "source", {"operator": "WEB_SEARCH", "data": []})
    fail(store, root, counts={"search_requests": 1})
    child = receipt("run_child", parent=root["run_id"], counts={"search_requests": 1})
    begin(store, child)
    original = store.iter_stage_keys

    def publish_between_page_and_payload(journal):
        keys = list(original(journal))
        assert keys == ["source"]
        store.commit(*publication(child))
        yield from keys

    monkeypatch.setattr(store, "iter_stage_keys", publish_between_page_and_payload)
    engine = Engine(tmp_path / "unused_recovery", store=store, worker=reference_worker)
    with pytest.raises(SourcesQLError) as unavailable:
        engine.recover_run(root["run_id"])
    assert unavailable.value.code == "not_found"
    assert store.run(root["run_id"])["counts"] == {"search_requests": 1}
    assert store.run(child["run_id"])["counts"] == {"search_requests": 1}
    assert store.read("wq_qualified")[1].rows == [{"value": "qualified"}]
    assert stage_bytes(store) == 0


def test_admitted_null_semantic_query_finishes_more_than_256_stages_without_provider_calls(
    tmp_path,
):
    engine = Engine(tmp_path / "wide_engine", worker=reference_worker)
    saved = engine.import_table(
        [{"key": "content"}], [{"content": None}], data_classification="synthetic_fixture"
    )
    first = ", ".join(f"SEM_EXTRACT(content, 'field {i}') AS f{i}" for i in range(128))
    second = ", ".join(f"SEM_EXTRACT(f0, 'field {128 + i}') AS g{i}" for i in range(128))
    query = (
        f"WITH first AS (SELECT {first} FROM input.saved), "
        f"second AS (SELECT {second} FROM first) "
        "SELECT SEM_EXTRACT(g0, 'field 256') AS result FROM second"
    )
    result = engine.query(
        query=query,
        inputs={"saved": {"result_id": saved["result_id"]}},
        budgets={"max_model_requests": 0},
    )
    assert result["rows"] == [{"result": None}]
    assert result["receipt"]["counts"].get("model_requests", 0) == 0
    assert result["receipt"]["provider_events"] == []
    assert result["receipt"]["checkpoints"]["total"] == 257
    assert list(engine.store.iter_stage_keys(result["receipt"]["journal_id"])) == []


def test_deadline_after_intent_before_dispatch_resumes_without_repeating_paid_work(
    tmp_path, monkeypatch
):
    original = FixtureProvider.search
    calls = {"entered": 0, "dispatched": 0}

    def stopped_before_dispatch(self, queries, options, budget):
        calls["entered"] += 1
        if calls["entered"] == 1:
            raise SourcesQLError("budget_exhausted", "Synthetic dispatch deadline", "dispatch")
        calls["dispatched"] += 1
        return original(self, queries, options, budget)

    monkeypatch.setattr(FixtureProvider, "search", stopped_before_dispatch)
    engine = Engine(tmp_path / "deadline", worker=reference_worker)
    with pytest.raises(SourcesQLError, match="dispatch deadline"):
        engine.query(
            query="SELECT title FROM WEB_SEARCH('aurora',per_query_limit := 1)",
            source_mode="allow_excerpt",
            budgets={"max_candidates": 1},
        )
    failed = latest_run(engine)
    assert failed["settlement_status"] == "settled"
    assert failed["provider_events"] == []
    assert failed["counts"].get("search_requests", 0) == 0
    assert [item["status"] for item in failed["checkpoints"]["stages"]] == ["not_dispatched"]
    fresh = Engine(tmp_path / "deadline", worker=reference_worker)
    result = fresh.resume_run(failed["run_id"], str(uuid4()))
    assert result["rows"] and result["receipt"]["status"] == "completed"
    assert result["receipt"]["counts"]["search_requests"] == 1
    assert result["receipt"]["counts"]["candidates"] == 1
    assert calls == {"entered": 2, "dispatched": 1}


def test_completed_provider_call_with_checkpoint_write_failure_is_never_replayed(
    tmp_path, monkeypatch
):
    original, dispatched = FixtureProvider.search, []

    def search(self, queries, options, budget):
        dispatched.extend(queries)
        result = original(self, queries, options, budget)
        assert self.events[-1]["status"] == "completed"
        return result

    def unavailable(*args, **kwargs):
        raise SourcesQLError("storage_unavailable", "Synthetic checkpoint write failure", "storage")

    monkeypatch.setattr(FixtureProvider, "search", search)
    engine = Engine(tmp_path / "unretained", worker=reference_worker)
    monkeypatch.setattr(engine.store, "stage_finish", unavailable)
    with pytest.raises(SourcesQLError, match="checkpoint write failure"):
        engine.query(
            query="SELECT title FROM WEB_SEARCH('aurora',per_query_limit := 1)",
            source_mode="allow_excerpt",
            budgets={"max_candidates": 1},
        )
    failed = latest_run(engine)
    assert failed["settlement_status"] == "settled"
    assert failed["counts"]["search_requests"] == 1
    assert failed["counts"]["candidates"] == 1
    assert failed["provider_events"][0]["status"] == "completed"
    assert [item["status"] for item in failed["checkpoints"]["stages"]] == ["completed_unretained"]
    with pytest.raises(SourcesQLError) as repeated:
        Engine(tmp_path / "unretained", worker=reference_worker).resume_run(
            failed["run_id"], str(uuid4())
        )
    assert repeated.value.code == "storage_unavailable"
    assert dispatched == ["aurora"]
