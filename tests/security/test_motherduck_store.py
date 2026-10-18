"""Real local DuckDB qualification of the remote store's durable job fences.

No MotherDuck endpoint or providers are called. Worker isolation is qualified in
its dedicated suite; relational fixture evaluation here uses the reference worker.
"""

from __future__ import annotations

import json
import uuid

import duckdb
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical, digest
from sourcesql.engine import Engine
from sourcesql.storage.motherduck import MotherDuckStore, timestamp
from test_engine_boundaries import reference_worker

NAMESPACE = "a" * 64


@pytest.fixture
def make_store(tmp_path):
    path = tmp_path / "durable.duckdb"

    def factory(namespace=NAMESPACE, quota=100 * 1024 * 1024):
        return MotherDuckStore(
            database="synthetic_test",
            namespace=namespace,
            quota=quota,
            connector=lambda: duckdb.connect(str(path)),
        )

    return factory


def engine(store, tmp_path):
    return Engine(
        tmp_path / "unused-local", store=store, worker=reference_worker, allow_private=False
    )


def seed_job(store, *, request=None, operation="query", flight_version=1):
    job_id, flight_id, run_id = (str(uuid.uuid4()) for _ in range(3))
    request = request or {"query": "SELECT 7 AS n", "profile": "fixture", "request_id": job_id}
    stamp = timestamp()
    with store.db() as db:
        db.execute(
            "INSERT INTO jobs(id,request_id,operation,request_hash,request_json,status,"
            "created_at,updated_at,flight_id,flight_version,max_runtime_sec) "
            "VALUES(?::UUID,?::UUID,?,?,?,'dispatching',?,?,?::UUID,?,120)",
            [
                job_id,
                job_id,
                operation,
                digest(request),
                canonical(request).decode(),
                stamp,
                stamp,
                flight_id,
                flight_version,
            ],
        )
    return job_id, {"flight_id": flight_id, "run_id": run_id, "flight_version": 1}


def claim(store, job_id, context):
    token = str(uuid.uuid4())
    result = store.claim_job(job_id, token, flight_context=context)
    assert result is not None
    store.bind_job(job_id, token)
    return token, result


def job(store, job_id):
    with store.db() as db:
        return store._job(db, job_id)


def counts(store):
    with store.db() as db:
        return tuple(
            db.execute(f"SELECT count(*) FROM {name}").fetchone()[0] for name in ("results", "runs")
        )


def import_request():
    return {
        "columns": [{"key": "n", "logical_type": "BIGINT"}, {"key": "f", "logical_type": "DOUBLE"}],
        "rows": [{"n": 9007199254740993, "f": 1.0000001}],
        "data_classification": "synthetic_fixture",
    }


def pending_run(store, job_id):
    run_id = "run_test_" + uuid.uuid4().hex
    pending = {
        "run_id": run_id,
        "request_id": str(uuid.uuid4()),
        "status": "running",
        "receipt_revision": 0,
        "result_id": None,
    }
    store.begin_run({"request_id": pending["request_id"]}, pending)
    result_id = "wq_test_" + uuid.uuid4().hex
    receipt = {
        **pending,
        "status": "completed",
        "result_id": result_id,
        "receipt_revision": 1,
        "plan_complete": True,
    }
    metadata = {
        "result_id": result_id,
        "run_id": run_id,
        "receipt": receipt,
        "data_classification": "synthetic_fixture",
        "parents": [],
    }
    return run_id, Table([Column("n", "BIGINT")], [{"n": 1}]), metadata


def test_import_reopens_from_an_independent_store_with_exact_numeric_values(make_store, tmp_path):
    store = make_store()
    result = engine(store, tmp_path).import_table(**import_request())
    reopened = make_store()
    metadata, table = reopened.read(result["result_id"])
    assert table.rows == [{"n": 9007199254740993, "f": 1.0000001}]
    assert type(table.rows[0]["n"]) is int
    assert type(table.rows[0]["f"]) is float
    assert metadata["receipt"]["status"] == "completed"
    assert (
        engine(reopened, tmp_path).read_result(result["result_id"])["rows"][0]["n"]
        == "9007199254740993"
    )


def test_owner_namespace_isolation_and_colliding_schema_owner_are_enforced(make_store, tmp_path):
    first = make_store()
    result = engine(first, tmp_path).import_table(**import_request())
    second = make_store(namespace="b" * 64)
    with pytest.raises(SourcesQLError) as error:
        second.authorize(result["result_id"])
    assert error.value.code == "unauthorized"
    with pytest.raises(SourcesQLError) as error:
        make_store(namespace="a" * 32 + "b" * 32)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("mismatch", ["flight", "run", "version", "missing_version"])
def test_job_claim_refuses_unreviewed_flight_context(make_store, mismatch):
    store = make_store()
    job_id, context = seed_job(store, flight_version=None if mismatch == "missing_version" else 1)
    if mismatch == "flight":
        context["flight_id"] = str(uuid.uuid4())
    elif mismatch == "run":
        with store.db() as db:
            db.execute(
                "UPDATE jobs SET flight_run_id=?::UUID WHERE id=?::UUID",
                [str(uuid.uuid4()), job_id],
            )
    elif mismatch == "version":
        context["flight_version"] = 2
    with pytest.raises(SourcesQLError) as error:
        store.claim_job(job_id, str(uuid.uuid4()), flight_context=context)
    assert error.value.code == "unauthorized"
    saved = job(store, job_id)
    assert saved["status"] == "dispatching" and saved["claim_token"] is None
    assert counts(store) == (0, 0)


def test_claim_is_once_only_even_for_same_flight_run(make_store):
    first = make_store()
    job_id, context = seed_job(first)
    token, claimed = claim(first, job_id, context)
    assert claimed["request"]["profile"] == "fixture"
    second = make_store()
    assert second.claim_job(job_id, str(uuid.uuid4()), flight_context=context) is None
    saved = job(second, job_id)
    assert str(saved["claim_token"]) == token and saved["status"] == "running"


def test_query_publishes_job_result_and_receipt_together(make_store, tmp_path):
    store = make_store()
    job_id, context = seed_job(store)
    token, claimed = claim(store, job_id, context)
    result = engine(store, tmp_path).query(**claimed["request"])
    saved = job(make_store(), job_id)
    assert saved["status"] == "completed" and saved["result_id"] == result["result_id"]
    assert saved["engine_run_id"] == result["receipt"]["run_id"]
    assert store.run(saved["engine_run_id"])["status"] == "completed"
    assert store.read(saved["result_id"])[0]["receipt"] == store.run(saved["engine_run_id"])
    assert counts(store) == (1, 1)
    assert (
        store.finish_job(job_id, token, saved["result_id"], saved["engine_run_id"])["status"]
        == "completed"
    )


def test_failure_after_result_insert_rolls_back_all_publication(make_store):
    store = make_store()
    job_id, context = seed_job(store)
    claim(store, job_id, context)
    run_id, table, metadata = pending_run(store, job_id)
    connector = store.connector
    fail = [True]

    class FaultingConnection:
        def __init__(self):
            self.connection = connector()

        def execute(self, sql, parameters=None):
            if fail[0] and sql.startswith("UPDATE jobs SET status='completed'"):
                fail[0] = False
                raise duckdb.Error("SYNTHETIC-TRANSACTION-FAILURE")
            return self.connection.execute(sql, parameters or [])

        def close(self):
            self.connection.close()

    store.connector = FaultingConnection
    with pytest.raises(SourcesQLError) as error:
        store.commit(table, metadata)
    assert error.value.code == "storage_unavailable"
    assert counts(store) == (0, 1)
    assert store.run(run_id)["status"] == "running"
    saved = job(store, job_id)
    assert saved["status"] == "running" and saved["result_id"] is None


def test_cancellation_after_run_begin_prevents_result_publication(make_store):
    store = make_store()
    job_id, context = seed_job(store)
    claim(store, job_id, context)
    run_id, table, metadata = pending_run(store, job_id)
    with store.db() as db:
        db.execute(
            "UPDATE jobs SET status='cancelled',cancel_requested=true WHERE id=?::UUID", [job_id]
        )
    with pytest.raises(SourcesQLError) as error:
        store.commit(table, metadata)
    assert error.value.code == "cancelled"
    assert counts(store) == (0, 1) and store.run(run_id)["result_id"] is None
    assert job(store, job_id)["status"] == "cancelled"


def test_quota_failure_keeps_no_result_and_records_safe_failed_job(make_store, tmp_path):
    store = make_store(quota=1)
    request = import_request()
    job_id, context = seed_job(store, request=request, operation="import_table")
    token, _ = claim(store, job_id, context)
    with pytest.raises(SourcesQLError) as error:
        engine(store, tmp_path).import_table(**request)
    assert error.value.code == "budget_exhausted"
    assert counts(store) == (0, 1)
    saved = job(store, job_id)
    assert saved["result_id"] is None and store.run(saved["engine_run_id"])["status"] == "failed"
    store.fail_job(job_id, token, error.value.code, "SECRET-MUST-NOT-BE-RETAINED")
    failed = job(store, job_id)
    assert failed["status"] == "failed" and failed["error_code"] == "budget_exhausted"
    assert "SECRET" not in failed["error_message"]


def test_admission_failure_retains_its_code_without_a_run_result_or_private_message(
    make_store, tmp_path
):
    store = make_store()
    request = {"query": "SELECT random() AS private_column_marker", "profile": "fixture"}
    job_id, context = seed_job(store, request=request)
    token, claimed = claim(store, job_id, context)
    with pytest.raises(SourcesQLError) as error:
        engine(store, tmp_path).explain(**claimed["request"])
    assert error.value.code == "unsupported_query"
    assert counts(store) == (0, 0)
    store.fail_job(job_id, token, error.value.code, "PRIVATE-RAW-EXCEPTION-MUST-NOT-BE-RETAINED")
    reopened = make_store()
    failed = job(reopened, job_id)
    assert failed["status"] == "failed"
    assert failed["error_code"] == "unsupported_query"
    assert failed["error_message"] == "Research execution failed safely"
    assert failed["engine_run_id"] is None and failed["result_id"] is None
    assert "PRIVATE" not in failed["error_message"]
    assert counts(reopened) == (0, 0)
    reopened.fail_job(job_id, token, "provider_unavailable", "A later error cannot replace it")
    assert job(reopened, job_id)["error_code"] == "unsupported_query"


@pytest.mark.parametrize(
    "provider_code",
    ["provider_timeout", "provider_connection_error", "provider_http_error", "provider_error"],
)
def test_provider_failure_code_survives_reopen_without_retaining_provider_text(
    make_store, provider_code
):
    store = make_store()
    job_id, context = seed_job(store)
    token, _ = claim(store, job_id, context)
    store.fail_job(job_id, token, provider_code, "PRIVATE-PROVIDER-BODY-AND-KEY")

    reopened = make_store()
    saved = job(reopened, job_id)
    assert saved["status"] == "failed"
    assert saved["error_code"] == provider_code
    assert saved["error_message"] == "Research execution failed safely"
    assert saved["result_id"] is None and saved["engine_run_id"] is None
    assert "PRIVATE" not in json.dumps(saved, default=str)
    assert counts(reopened) == (0, 0)

    reopened.fail_job(job_id, token, "provider_unavailable", "LATER-PRIVATE-ERROR")
    final = job(reopened, job_id)
    assert final["error_code"] == provider_code
    assert final["error_message"] == saved["error_message"]


@pytest.mark.parametrize("unreviewed_code", ["unknown_provider_code", "", None])
def test_unreviewed_failure_codes_fall_back_without_retaining_raw_details(
    make_store, unreviewed_code
):
    store = make_store()
    job_id, context = seed_job(store)
    token, _ = claim(store, job_id, context)
    store.fail_job(job_id, token, unreviewed_code, "PRIVATE-RAW-DETAILS")
    saved = job(make_store(), job_id)
    assert saved["status"] == "failed"
    assert saved["error_code"] == "execution_failed"
    assert saved["error_message"] == "Research execution failed safely"
    assert "PRIVATE" not in json.dumps(saved, default=str)


def test_identical_import_completes_second_job_without_duplicate_result(make_store, tmp_path):
    first = make_store()
    request = import_request()
    first_id, first_context = seed_job(first, request=request, operation="import_table")
    claim(first, first_id, first_context)
    original = engine(first, tmp_path).import_table(**request)
    second = make_store()
    second_id, second_context = seed_job(second, request=request, operation="import_table")
    second_token, _ = claim(second, second_id, second_context)
    retained = engine(second, tmp_path).import_table(**request)
    saved = job(second, second_id)
    assert original["result_id"] == retained["result_id"] == saved["result_id"]
    assert counts(second) == (1, 1)
    assert job(second, first_id)["status"] == saved["status"] == "completed"
    assert (
        second.finish_job(second_id, second_token, saved["result_id"], saved["engine_run_id"])[
            "status"
        ]
        == "completed"
    )


def test_bundle_restore_atomically_retains_closure_root_and_mapping(make_store, tmp_path):
    source = Engine(tmp_path / "source", worker=reference_worker)
    parent = source.import_table(**import_request())
    child = source.import_table(
        [{"key": "n", "logical_type": "BIGINT"}],
        [{"n": 2}],
        data_classification="synthetic_fixture",
        parents=[{"result_id": parent["result_id"]}],
    )
    bundle = source.export(child["result_id"])
    store = make_store()
    job_id, context = seed_job(store, request={"bundle": bundle}, operation="import")
    token, _ = claim(store, job_id, context)
    restored = engine(store, tmp_path).import_bundle(bundle)
    saved = job(make_store(), job_id)
    assert saved["status"] == "completed" and saved["result_id"] == restored["result_id"]
    assert restored["result_id"] == restored["result_mapping"][child["result_id"]]
    assert json.loads(saved["output_json"]) == {"result_mapping": restored["result_mapping"]}
    assert counts(store) == (2, 2)
    assert len(store.read(restored["result_id"])[0]["parents"]) == 1
    assert (
        store.finish_job(job_id, token, saved["result_id"], saved["engine_run_id"])["status"]
        == "completed"
    )


def mock_pg_control(monkeypatch, reported_version):
    """Replace only the optional PG client; all durable tables remain real DuckDB."""
    import sys
    from types import ModuleType

    captured = {"connections": [], "queries": []}

    class Control:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def execute(self, sql, *parameters):
            captured["queries"].append((sql, parameters))
            return self

        def fetchone(self):
            return None if reported_version is None else (reported_version,)

    def connect(**kwargs):
        captured["connections"].append(kwargs)
        return Control()

    module = ModuleType("psycopg")
    module.connect = connect
    monkeypatch.setitem(sys.modules, "psycopg", module)
    monkeypatch.setenv("MOTHERDUCK_TOKEN", "SAFE-SYNTHETIC-TEST-TOKEN")
    monkeypatch.setenv("SOURCESQL_MOTHERDUCK_PG_HOST", "pg.eu-central-1-aws.motherduck.com")
    return captured


def test_remote_claim_verifies_actual_version_with_strict_tls_and_uuid_literals(
    make_store, monkeypatch
):
    import certifi

    store = make_store()
    job_id, context = seed_job(store)
    # The real PG result, rather than a caller-supplied version, is authoritative.
    context["flight_version"] = 999
    captured = mock_pg_control(monkeypatch, reported_version=1)
    store.remote = True
    token = str(uuid.uuid4())
    assert store.claim_job(job_id, token, flight_context=context) is not None
    assert captured["connections"] == [
        {
            "host": "pg.eu-central-1-aws.motherduck.com",
            "port": 5432,
            "dbname": "synthetic_test",
            "user": "user",
            "password": "SAFE-SYNTHETIC-TEST-TOKEN",
            "sslmode": "verify-full",
            "sslrootcert": certifi.where(),
            "connect_timeout": 5,
            "options": "-c statement_timeout=15000",
            "autocommit": True,
        }
    ]
    assert captured["queries"] == [
        (
            "SELECT flight_version FROM md_list_flight_runs("
            f"flight_id := '{context['flight_id']}'::UUID, \"LIMIT\" := 100) "
            f"WHERE run_id='{context['run_id']}'::UUID",
            (),
        )
    ]
    saved = job(store, job_id)
    assert saved["status"] == "running" and str(saved["claim_token"]) == token


@pytest.mark.parametrize("reported_version", [2, None])
def test_remote_control_version_mismatch_or_missing_run_never_claims(
    make_store, monkeypatch, reported_version
):
    store = make_store()
    job_id, context = seed_job(store)
    captured = mock_pg_control(monkeypatch, reported_version)
    store.remote = True
    with pytest.raises(SourcesQLError) as error:
        store.claim_job(job_id, str(uuid.uuid4()), flight_context=context)
    assert error.value.code == "unauthorized"
    assert len(captured["queries"]) == 1
    saved = job(store, job_id)
    assert saved["status"] == "dispatching" and saved["claim_token"] is None
    assert counts(store) == (0, 0)


def test_remote_control_rejects_external_host_and_non_uuid_before_connect(make_store, monkeypatch):
    store = make_store()
    job_id, context = seed_job(store)
    captured = mock_pg_control(monkeypatch, reported_version=1)
    store.remote = True
    monkeypatch.setenv("SOURCESQL_MOTHERDUCK_PG_HOST", "pg.attacker.example")
    with pytest.raises(SourcesQLError) as error:
        store.claim_job(job_id, str(uuid.uuid4()), flight_context=context)
    assert error.value.code == "invalid_request"
    with pytest.raises(ValueError):
        store.claim_job(
            job_id,
            str(uuid.uuid4()),
            flight_context={
                **context,
                "flight_id": "not-a-uuid'; SELECT 'UNTRUSTED'",
            },
        )
    assert captured == {"connections": [], "queries": []}
    assert job(store, job_id)["claim_token"] is None


def test_legacy_jobs_upgrade_adds_provider_fields_without_changing_existing_rows(make_store):
    legacy = make_store()
    job_id, _ = seed_job(legacy)
    original = job(legacy, job_id)
    with legacy.db() as db:
        db.execute("ALTER TABLE jobs DROP COLUMN provider_policy_sha256")
        db.execute("ALTER TABLE jobs DROP COLUMN provider_cost_reserved_microusd")
        db.execute("DROP TABLE provider_allowances")
    upgraded = make_store()
    saved = job(upgraded, job_id)
    assert saved["request_json"] == original["request_json"]
    assert saved["request_hash"] == original["request_hash"]
    assert saved["status"] == original["status"] == "dispatching"
    assert saved["provider_policy_sha256"] is None
    assert saved["provider_cost_reserved_microusd"] == 0
    with upgraded.db() as db:
        assert db.execute("SELECT count(*) FROM provider_allowances").fetchone()[0] == 0
    assert job(make_store(), job_id) == saved


@pytest.mark.parametrize(
    "approval",
    ["default_allowlist", "missing_hash", "wrong_hash", "missing_stored_hash", "matching"],
)
@pytest.mark.parametrize("profile", ["exa", "exa_deep", "exa_deep_reasoning"])
def test_exa_claim_requires_trusted_allowlist_and_exact_stored_policy(
    make_store, approval, profile
):
    store = make_store()
    request = {"query": "SELECT title,url FROM WEB_SEARCH('public research')", "profile": profile}
    job_id, context = seed_job(store, request=request)
    expected = digest(
        {
            "version": "exa-search.v1",
            "approved_cost_microusd": 50_000,
            "secret_name": "sourcesql_exa",
        }
    )
    if approval != "missing_stored_hash":
        with store.db() as db:
            db.execute(
                "UPDATE jobs SET provider_policy_sha256=?,provider_cost_reserved_microusd=50000 WHERE id=?::UUID",
                [expected, job_id],
            )
    kwargs = {}
    if approval != "default_allowlist":
        kwargs["allowed_profiles"] = ("fixture", "exa", "exa_deep", "exa_deep_reasoning")
        kwargs["provider_policy_sha256"] = (
            None
            if approval == "missing_hash"
            else ("f" * 64 if approval == "wrong_hash" else expected)
        )
    token = str(uuid.uuid4())
    if approval == "matching":
        claimed = store.claim_job(job_id, token, flight_context=context, **kwargs)
        assert claimed["request"]["profile"] == profile
        assert str(job(store, job_id)["claim_token"]) == token
    else:
        with pytest.raises(SourcesQLError) as error:
            store.claim_job(job_id, token, flight_context=context, **kwargs)
        assert error.value.code == "unsupported_capability"
        assert job(store, job_id)["claim_token"] is None
    assert counts(store) == (0, 0)


@pytest.mark.parametrize(
    ("statuses", "attempts", "settlement", "expected"),
    [
        (["not_dispatched"], 1, "settled", "not_dispatched"),
        (["completed"], 1, "settled", "settled"),
        (["not_dispatched", "completed"], 2, "settled", "settled"),
        (["not_dispatched"], 2, "settled", "outcome_unknown"),
        (["remote_outcome_unknown"], 1, "pending", "outcome_unknown"),
        (["unknown_status"], 1, "settled", "outcome_unknown"),
        ([None], 1, "settled", "outcome_unknown"),
        (["completed_validation_failed"], 1, "settled", "settled"),
    ],
)
def test_failed_job_reports_actual_dispatch_certainty(
    make_store, statuses, attempts, settlement, expected
):
    store = make_store()
    job_id, context = seed_job(store)
    token, _ = claim(store, job_id, context)
    run_id, _, _ = pending_run(store, job_id)
    receipt = store.run(run_id)
    receipt.update(
        status="failed",
        settlement_status=settlement,
        dispatch_intents=[{"counter": "model_requests", "amount": attempts}],
        provider_events=[{"kind": "embedding", "status": status} for status in statuses],
    )
    store.update_run(receipt)
    store.fail_job(job_id, token, "storage_unavailable", "PRIVATE-REASON", "storage")
    output = json.loads(job(store, job_id)["output_json"])
    assert output == {"stage": "storage", "provider_dispatch": expected}
