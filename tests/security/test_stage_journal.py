"""Immutable stage checkpoints in real local SQLite and owner-scoped DuckDB."""

import json

import duckdb
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical, digest
from sourcesql.storage.motherduck import MotherDuckStore
from sourcesql.storage.stages import (
    MAX_FAILURE_METADATA_BYTES,
    MAX_STAGE_BYTES,
)
from sourcesql.storage.store import Store


@pytest.fixture(params=["sqlite", "duckdb"])
def stores(tmp_path, request):
    def create(owner="a", quota=100 * 1024 * 1024):
        if request.param == "sqlite":
            return Store(tmp_path / owner, quota=quota)
        return MotherDuckStore(
            database="synthetic_test",
            namespace=owner * 64,
            quota=quota,
            connector=lambda: duckdb.connect(str(tmp_path / "control.duckdb")),
        )

    return create


def test_intent_is_durable_before_dispatch_and_only_its_creator_can_start_effect(stores):
    store = stores()
    assert store.stage_read("run_one", "stage_one") is None
    intent, created = store.stage_begin("run_one", "stage_one")
    assert created and intent["status"] == "intent"
    assert intent["value"] is None
    reopened = stores()
    assert reopened.stage_read("run_one", "stage_one") == intent
    duplicate, created = reopened.stage_begin("run_one", "stage_one")
    assert not created and duplicate == intent
    # An intent left by a lost worker is uncertainty, never retry permission.
    assert reopened.stage_summaries("run_one")["stages"][0]["status"] == "intent"


def test_completed_checkpoint_preserves_full_canonical_payload_across_reopening(stores):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    value = {"rows": [{"content": "日本語 retained source", "amount": None}], "usage": [3, 0.5]}
    completed = store.stage_finish("run_one", "stage_one", value)
    assert completed["status"] == "completed" and completed["value"] == value
    assert stores().stage_read("run_one", "stage_one") == completed
    with store.db() as db:
        payload = db.execute("SELECT value_json FROM execution_stages").fetchone()[0]
        assert json.loads(payload) == {
            "version": "stage-value.v1",
            "content_sha256": digest(["run_one", "stage_one", value]),
            "value": value,
        }
        assert payload == canonical(json.loads(payload)).decode()
        assert store.stage_bytes(db) >= len(payload.encode("utf-8"))


@pytest.mark.parametrize("terminal", ["completed", "rejected", "outcome_unknown"])
def test_terminal_checkpoint_never_changes_or_authorizes_reexecution(stores, terminal):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    if terminal == "completed":
        original = store.stage_finish("run_one", "stage_one", {"original": 1})
    else:
        original = store.stage_fail(
            "run_one", "stage_one", "provider_timeout", terminal == "outcome_unknown"
        )
    assert original["status"] == terminal
    reopened = stores()
    state, created = reopened.stage_begin("run_one", "stage_one")
    assert not created and state == original
    assert reopened.stage_finish("run_one", "stage_one", {"replacement": 2}) == original
    assert reopened.stage_fail("run_one", "stage_one", "provider_error", False) == original
    assert reopened.stage_read("run_one", "stage_one") == original


@pytest.mark.parametrize("code", ["private-error-api-key", {"private": "body"}, None, ""])
def test_arbitrary_failure_details_never_persist(stores, code):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    failed = store.stage_fail("run_one", "stage_one", code, False)
    assert failed["error_code"] == "execution_failed"
    assert "private" not in json.dumps(failed)
    with store.db() as db:
        raw = db.execute("SELECT error_code,value_json FROM execution_stages").fetchone()
        assert raw == ("execution_failed", None)


def test_summary_is_bounded_and_never_reads_or_returns_saved_payloads(stores):
    store = stores()
    for index in range(130):
        key = f"stage_{index:03}"
        store.stage_begin("run_one", key)
        store.stage_finish("run_one", key, {"private_source": "DO-NOT-RETURN"})
    summary = stores().stage_summaries("run_one")
    assert len(summary["stages"]) == 128
    assert summary["total"] == 130 and summary["omitted"] == 2
    assert summary["stages"][0]["stage_key"] == "stage_000"
    assert "DO-NOT-RETURN" not in json.dumps(summary)
    assert all(set(stage) == {"stage_key", "status", "error_code"} for stage in summary["stages"])
    assert store.stage_summaries("run_one", limit=1)["omitted"] == 129
    assert store.stage_summaries("run_other") == {"stages": [], "total": 0, "omitted": 0}


def test_completed_null_is_distinct_from_unknown_or_missing_stage(stores):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    completed = store.stage_finish("run_one", "stage_one", None)
    assert completed["status"] == "completed" and completed["value"] is None
    assert stores().stage_read("run_one", "stage_one") == completed


def test_canonical_payload_mutation_is_detected_before_checkpoint_reuse(stores):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    store.stage_finish("run_one", "stage_one", {"content": "original retained source"})
    with store.db() as db:
        envelope = json.loads(db.execute("SELECT value_json FROM execution_stages").fetchone()[0])
        envelope["value"]["content"] = "mutated retained source"
        db.execute("UPDATE execution_stages SET value_json=?", [canonical(envelope).decode()])
    with pytest.raises(SourcesQLError) as error:
        stores().stage_read("run_one", "stage_one")
    assert error.value.code == "evidence_invalid"
    with pytest.raises(SourcesQLError):
        store.stage_begin("run_one", "stage_one")
    with pytest.raises(SourcesQLError):
        store.stage_finish("run_one", "stage_one", {"replacement": True})


def test_checksum_does_not_admit_noncanonical_or_unversioned_checkpoint_bytes(stores):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    store.stage_finish("run_one", "stage_one", {"value": 1})
    with store.db() as db:
        raw = db.execute("SELECT value_json FROM execution_stages").fetchone()[0]
        db.execute("UPDATE execution_stages SET value_json=?", [" " + raw])
    with pytest.raises(SourcesQLError) as error:
        store.stage_read("run_one", "stage_one")
    assert error.value.code == "evidence_invalid"
    with store.db() as db:
        db.execute("UPDATE execution_stages SET value_json=?", [canonical({"value": 1}).decode()])
    with pytest.raises(SourcesQLError):
        store.stage_read("run_one", "stage_one")


def test_valid_checkpoint_envelope_cannot_be_swapped_to_another_stage(stores):
    store = stores()
    for key in ("stage_one", "stage_two"):
        store.stage_begin("run_one", key)
        store.stage_finish("run_one", key, {"original_stage": key})
    with store.db() as db:
        payload = db.execute(
            "SELECT value_json FROM execution_stages WHERE stage_key=?", ["stage_one"]
        ).fetchone()[0]
        db.execute(
            "UPDATE execution_stages SET value_json=? WHERE stage_key=?", [payload, "stage_two"]
        )
    with pytest.raises(SourcesQLError) as error:
        store.stage_read("run_one", "stage_two")
    assert error.value.code == "evidence_invalid"


def test_checksum_envelope_overhead_is_included_in_the_retained_quota(stores):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    value = {"payload": "x" * 80}
    with store.db() as db:
        baseline = store.retained_size(db)
    store.quota = baseline + len(canonical(value)) + len("completed") - len("intent")
    with pytest.raises(SourcesQLError, match="quota"):
        store.stage_finish("run_one", "stage_one", value)
    assert store.stage_read("run_one", "stage_one")["status"] == "intent"


def test_payload_byte_bound_counts_utf8_and_retains_intent_after_refusal(stores):
    store = stores()
    store.stage_begin("run_one", "stage_valid")
    value = "é" * ((MAX_STAGE_BYTES - 2) // 2)
    assert len(canonical(value)) == MAX_STAGE_BYTES
    assert store.stage_finish("run_one", "stage_valid", value)["status"] == "completed"
    store.stage_begin("run_one", "stage_large")
    with pytest.raises(SourcesQLError, match="byte allowance") as oversized:
        store.stage_finish("run_one", "stage_large", value + "x")
    assert oversized.value.code == "budget_exhausted"
    assert stores().stage_read("run_one", "stage_large")["status"] == "intent"


@pytest.mark.parametrize("value", [float("nan"), {"not_json": {1, 2}}])
def test_noncanonical_payload_is_rejected_without_publication(stores, value):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    with pytest.raises(SourcesQLError) as error:
        store.stage_finish("run_one", "stage_one", value)
    assert error.value.code == "invalid_output"
    assert store.stage_read("run_one", "stage_one")["status"] == "intent"


def test_stage_storage_counts_toward_result_storage_and_other_stage_payloads(stores):
    store = stores(quota=1100)
    store.stage_begin("run_one", "stage_one")
    store.stage_finish("run_one", "stage_one", "x" * 800)
    store.stage_begin("run_one", "stage_two")
    with pytest.raises(SourcesQLError, match="quota"):
        store.stage_finish("run_one", "stage_two", "x" * 200)
    with pytest.raises(SourcesQLError, match="quota"):
        store.commit(Table([Column("value")], [{"value": "x" * 200}]), {})
    assert store.stage_read("run_one", "stage_two")["status"] == "intent"


def test_existing_result_storage_counts_before_a_new_checkpoint_value(stores):
    store = stores()
    store.commit(Table([Column("value")], [{"value": "existing result"}]), {})
    with store.db() as db:
        baseline = store.retained_size(db)
    store.quota = baseline + 64
    store.stage_begin("run_one", "stage_one")
    with pytest.raises(SourcesQLError, match="quota"):
        store.stage_finish("run_one", "stage_one", "x" * 100)


def test_postdispatch_failure_can_record_only_bounded_metadata_after_quota_exhaustion(stores):
    store = stores()
    store.stage_begin("run_one", "stage_one")
    with store.db() as db:
        before = store.retained_size(db)
    store.quota = before
    failed = store.stage_fail("run_one", "stage_one", "provider_connection_error", True)
    assert failed["status"] == "outcome_unknown"
    with store.db() as db:
        assert store.retained_size(db) - before <= MAX_FAILURE_METADATA_BYTES
    with pytest.raises(SourcesQLError, match="quota"):
        store.stage_begin("run_one", "new_stage")


def test_journal_count_uses_byte_quota_without_an_unrelated_256_stage_cap(stores):
    store = stores()
    for index in range(300):
        store.stage_begin("run_one", f"stage_{index}")
    with store.db() as db:
        store.quota = store.retained_size(db)
    with pytest.raises(SourcesQLError, match="quota"):
        store.stage_begin("run_one", "stage_over_quota")
    existing, created = store.stage_begin("run_one", "stage_0")
    assert not created and existing["status"] == "intent"
    assert store.stage_summaries("run_one")["total"] == 300


def test_owner_and_journal_namespaces_do_not_reveal_other_checkpoints(stores):
    owner_a = stores("a")
    owner_a.stage_begin("run_one", "stage_one")
    owner_a.stage_finish("run_one", "stage_one", {"owner": "a"})
    owner_b = stores("b")
    assert owner_b.stage_read("run_one", "stage_one") is None
    assert owner_b.stage_summaries("run_one")["total"] == 0
    assert owner_a.stage_read("run_other", "stage_one") is None


@pytest.mark.parametrize(
    "identity", ["", "private SQL; DROP TABLE execution_stages", "x" * 129, None]
)
def test_invalid_checkpoint_identities_never_enter_storage(stores, identity):
    store = stores()
    with pytest.raises(SourcesQLError):
        store.stage_begin(identity, "stage_one")
    with pytest.raises(SourcesQLError):
        store.stage_read("run_one", identity)
    assert store.stage_summaries("run_one")["total"] == 0


def test_finishing_or_failing_without_intent_never_creates_an_effect(stores):
    store = stores()
    with pytest.raises(SourcesQLError) as missing:
        store.stage_finish("run_one", "stage_one", {})
    assert missing.value.code == "not_found"
    with pytest.raises(SourcesQLError):
        store.stage_fail("run_one", "stage_one", "provider_error", False)
    assert store.stage_summaries("run_one")["total"] == 0
