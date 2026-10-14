"""Offline engine/store boundary checks; this file does not qualify OS isolation."""

from __future__ import annotations

import json
import os
import threading
import uuid

import pytest

from open_webql.contracts import Column, Table, WebQLError, digest
from open_webql.engine import Engine
from open_webql.execution.worker_process import evaluate


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


def counts(engine):
    with engine.store.db() as db:
        return tuple(
            db.execute(f"SELECT count(*) FROM {name}").fetchone()[0] for name in ("results", "runs")
        )


def make_engine(tmp_path, **kwargs):
    return Engine(tmp_path / "store", worker=reference_worker, **kwargs)


def imported(engine, classification="synthetic_fixture"):
    return engine.import_table(
        [{"key": "secret", "logical_type": "VARCHAR"}],
        [{"secret": "SYNTHETIC-PRIVATE-VALUE"}],
        data_classification=classification,
    )


def make_bundle(records, root):
    body = {"format": "open-webql.engine-bundle.v1", "root_result_id": root, "results": records}
    return {**body, "content_sha256": digest(body)}


def bundle_record(rid, *, key="value", value="fixture", parents=None):
    table = Table([Column(key)], [{key: value}]).to_dict()
    return {
        "metadata": {
            "result_id": rid,
            "content_sha256": digest(table),
            "row_ids": ["foreign-row"],
            "data_classification": "synthetic_fixture",
            "parents": parents or [],
        },
        "table": table,
    }


def test_private_disclosure_refusal_precedes_worker_and_provider_dispatch(tmp_path):
    calls = []
    engine = Engine(tmp_path / "store", worker=lambda *a, **k: calls.append(a))
    result = imported(engine, "private_local")
    with pytest.raises(WebQLError) as error:
        engine.query(
            query="SELECT WEB_SEARCH(secret) AS found FROM input.private_source",
            inputs={"private_source": {"result_id": result["result_id"]}},
        )
    assert error.value.code == "disclosure_required"
    assert calls == []


@pytest.mark.parametrize(
    "logical_type,value,nullable",
    [
        ("BIGINT", "not-an-integer", True),
        ("BIGINT", 1.25, True),
        ("BOOLEAN", "false", True),
        ("DATE", "2026-02-31", True),
        ("TIMESTAMPTZ", "2026-10-13T12:00:00", True),
        ("VARCHAR", None, False),
    ],
)
def test_import_rejects_values_that_violate_declared_type_before_visibility(
    tmp_path, logical_type, value, nullable
):
    engine = make_engine(tmp_path)
    with pytest.raises(WebQLError):
        engine.import_table(
            [{"key": "value", "logical_type": logical_type, "nullable": nullable}],
            [{"value": value}],
            data_classification="synthetic_fixture",
        )
    assert counts(engine) == (0, 0)


def test_invalid_row_identity_cannot_leave_completed_import_run(tmp_path):
    engine = make_engine(tmp_path)
    with pytest.raises(WebQLError):
        engine.import_table(
            [{"key": "value"}],
            [{"value": "fixture"}],
            row_ids=[{"not": "a string identity"}],
            data_classification="synthetic_fixture",
        )
    assert counts(engine) == (0, 0)


def test_quota_failed_import_has_no_completed_receipt_or_published_result(tmp_path):
    engine = make_engine(tmp_path)
    engine.store.quota = 0
    with pytest.raises(WebQLError) as error:
        imported(engine)
    assert error.value.code == "budget_exhausted"
    with engine.store.db() as db:
        receipts = [json.loads(r[0]) for r in db.execute("SELECT receipt FROM runs")]
    assert not any(r["status"] in {"completed", "partial"} for r in receipts)
    assert counts(engine)[0] == 0


def test_private_receipt_cannot_be_read_by_private_disabled_launcher(tmp_path):
    owner = make_engine(tmp_path)
    result = imported(owner, "private_local")
    restricted = make_engine(tmp_path, allow_private=False)
    with pytest.raises(WebQLError) as error:
        restricted.run_status(result["run_id"])
    assert error.value.code == "unauthorized"


def test_private_bytes_not_read_before_private_disabled_refusal(tmp_path, monkeypatch):
    owner = make_engine(tmp_path)
    result = imported(owner, "private_local")
    restricted = make_engine(tmp_path, allow_private=False)
    from pathlib import Path

    original = Path.read_bytes

    def read(path):
        if path.name == result["result_id"] + ".json":
            pytest.fail("Private result bytes were read before authorization refusal")
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", read)
    with pytest.raises(WebQLError) as error:
        restricted.read_result(result["result_id"])
    assert error.value.code == "unauthorized"


def test_idempotent_query_survives_restart_without_worker_dispatch(tmp_path):
    engine = make_engine(tmp_path)
    request = {"query": "SELECT 7 AS value", "request_id": str(uuid.uuid4())}
    first = engine.query(**request)
    restarted = Engine(
        tmp_path / "store", worker=lambda *_args, **_kwargs: pytest.fail("Retry dispatched")
    )
    second = restarted.query(**request)
    assert second["result_id"] == first["result_id"]
    assert second["rows"] == [{"value": 7}]
    with pytest.raises(WebQLError) as error:
        restarted.query(**{**request, "query": "SELECT 8 AS value"})
    assert error.value.code == "idempotency_conflict"


def test_revoked_ancestor_blocks_saved_reads_and_idempotent_reuse(tmp_path):
    engine = make_engine(tmp_path)
    parent = imported(engine)
    request = {
        "query": "SELECT secret FROM input.previous",
        "request_id": str(uuid.uuid4()),
        "inputs": {"previous": {"result_id": parent["result_id"]}},
    }
    child = engine.query(**request)
    engine.store.revoke(parent["result_id"])
    with pytest.raises(WebQLError):
        engine.read_result(child["result_id"])
    with pytest.raises(WebQLError):
        engine.query(**request)


def test_tampered_bundle_and_cyclic_graph_are_refused_without_visibility(tmp_path):
    engine = make_engine(tmp_path)
    one = bundle_record("foreign-one")
    bundle = make_bundle({"foreign-one": one}, "foreign-one")
    bundle["results"]["foreign-one"]["table"]["rows"][0]["value"] = "tamper"
    with pytest.raises(WebQLError):
        engine.import_bundle(bundle)
    assert counts(engine) == (0, 0)
    one = bundle_record("foreign-one", parents=[{"result_id": "foreign-two"}])
    two = bundle_record("foreign-two", parents=[{"result_id": "foreign-one"}])
    with pytest.raises(WebQLError):
        engine.import_bundle(make_bundle({"foreign-one": one, "foreign-two": two}, "foreign-one"))
    assert counts(engine) == (0, 0)


def test_bundle_schema_failure_has_no_visible_ancestors(tmp_path):
    engine = make_engine(tmp_path)
    parent = bundle_record("foreign-parent")
    invalid_root = bundle_record(
        "foreign-root",
        key="constructor",
        parents=[
            {"result_id": "foreign-parent", "content_sha256": parent["metadata"]["content_sha256"]}
        ],
    )
    with pytest.raises(WebQLError):
        engine.import_bundle(
            make_bundle({"foreign-parent": parent, "foreign-root": invalid_root}, "foreign-root")
        )
    assert counts(engine) == (0, 0)


def test_bundle_parent_content_pin_must_match_exact_ancestor(tmp_path):
    engine = make_engine(tmp_path)
    parent = bundle_record("foreign-parent")
    child = bundle_record(
        "foreign-child", parents=[{"result_id": "foreign-parent", "content_sha256": "0" * 64}]
    )
    with pytest.raises(WebQLError) as error:
        engine.import_bundle(
            make_bundle({"foreign-parent": parent, "foreign-child": child}, "foreign-child")
        )
    assert error.value.code == "evidence_invalid"
    assert counts(engine) == (0, 0)


def test_bundle_root_identity_must_match_record_identity(tmp_path):
    engine = make_engine(tmp_path)
    record = bundle_record("different-identity")
    with pytest.raises(WebQLError):
        engine.import_bundle(make_bundle({"foreign-root": record}, "foreign-root"))
    assert counts(engine) == (0, 0)


def test_bundle_roundtrip_retains_available_source_text_and_evidence(tmp_path):
    owner = Engine(tmp_path / "source", worker=reference_worker)
    result = owner.query(
        query="SELECT url,SEM_EXTRACT(content,'project name') AS project FROM WEB_SEARCH('Aurora')"
    )
    assert result["source_versions"] and result["evidence"]
    reopened = Engine(tmp_path / "destination", worker=reference_worker).import_bundle(
        owner.export(result["result_id"])
    )
    assert reopened["rows"] == result["rows"]
    assert reopened["source_versions"] == result["source_versions"]
    assert reopened["evidence"] == result["evidence"]


def test_private_store_files_are_scoped_to_launching_os_account(tmp_path):
    previous = os.umask(0)
    try:
        engine = make_engine(tmp_path)
        result = imported(engine, "private_local")
    finally:
        os.umask(previous)
    assert engine.store.root.stat().st_mode & 0o077 == 0
    assert (engine.store.root / (result["result_id"] + ".json")).stat().st_mode & 0o077 == 0
    assert (engine.store.root / "control.sqlite").stat().st_mode & 0o077 == 0


def test_publication_receipt_pin_survives_later_settlement_revision(tmp_path):
    engine = make_engine(tmp_path)
    result = engine.query(query="SELECT 7 AS value")
    old_receipt = result["receipt"]
    later = {
        **old_receipt,
        "receipt_revision": old_receipt["receipt_revision"] + 1,
        "usage": [{"cost_microusd": None, "state": "billing_unavailable_after_settlement"}],
    }
    engine.store.update_run(later)
    reread = engine.read_result(result["result_id"])
    assert reread["content_sha256"] == result["content_sha256"]
    assert reread["receipt"]["receipt_revision"] == reread["receipt_revision"]
    assert reread["receipt"] == old_receipt


def test_post_commit_control_failure_cannot_leave_failed_run_with_visible_result(
    tmp_path, monkeypatch
):
    engine = make_engine(tmp_path)
    update = engine.store.update_run
    first = True

    def crash_once(receipt):
        nonlocal first
        if first:
            first = False
            raise OSError("Synthetic crash after result commit")
        update(receipt)

    monkeypatch.setattr(engine.store, "update_run", crash_once)
    try:
        engine.query(query="SELECT 7 AS value")
    except WebQLError:
        pass
    with engine.store.db() as db:
        receipts = [json.loads(r[0]) for r in db.execute("SELECT receipt FROM runs")]
    assert len(receipts) == 1
    assert not (
        receipts[0]["status"] in {"failed", "cancelled"} and receipts[0]["result_id"] is not None
    )


def test_cancelled_query_cannot_publish_and_terminal_transition_gets_new_revision(tmp_path):
    entered, release = threading.Event(), threading.Event()

    def blocked_worker(sql, tables, parameters=None, timeout=30):
        if "worker_probe" not in sql:
            entered.set()
            assert release.wait(3)
        return reference_worker(sql, tables, parameters, timeout)

    engine = Engine(tmp_path / "store", worker=blocked_worker)
    errors = []

    def run():
        try:
            engine.query(query="SELECT 7 AS value")
        except WebQLError as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert entered.wait(3)
        with engine.store.db() as db:
            run_id = db.execute("SELECT id FROM runs").fetchone()[0]
        cancelled = engine.cancel(run_id)
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive() and errors[0].code == "cancelled"
    final = engine.run_status(run_id)
    assert final["status"] == "cancelled" and final["result_id"] is None
    assert counts(engine)[0] == 0
    assert final["receipt_revision"] > cancelled["receipt_revision"]


def test_late_provider_timeout_cannot_erase_cancellation_or_unknown_settlement(
    tmp_path, monkeypatch
):
    entered, release = threading.Event(), threading.Event()

    class MockRegistry:
        def __init__(self, profile):
            self.events, self.hits = [], []

        def preflight(self, operators, budget):
            pass

        def search(self, queries, options, budget):
            budget.reserve("search_queries", limit="max_search_queries")
            budget.reserve("search_requests", limit="max_search_requests")
            event = {"kind": "search", "status": "dispatched", "usage": {"cost_microusd": None}}
            self.events.append(event)
            entered.set()
            assert release.wait(3)
            event["status"] = "remote_outcome_unknown"
            raise WebQLError("provider_unavailable", "Synthetic provider timeout", "acquisition")

    import open_webql.providers

    monkeypatch.setattr(open_webql.providers, "ProviderRegistry", MockRegistry)
    engine = make_engine(tmp_path)
    errors = []

    def run():
        try:
            engine.query(query="SELECT url FROM WEB_SEARCH('synthetic request')")
        except WebQLError as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    try:
        assert entered.wait(3)
        with engine.store.db() as db:
            run_id = db.execute("SELECT id FROM runs").fetchone()[0]
        assert engine.cancel(run_id)["status"] == "cancelled"
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive() and errors
    final = engine.run_status(run_id)
    assert final["status"] == "cancelled"
    assert final["settlement_status"] == "pending" and final["unsettled_requests"] == 1
    assert final["result_id"] is None and counts(engine)[0] == 0
