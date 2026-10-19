"""Effective-view parentage and request lookup against both real storage adapters.

MotherDuckStore uses a local DuckDB connector here. These tests do not contact
MotherDuck, dispatch Flights/providers, or qualify the OS worker sandbox.
"""

from __future__ import annotations

from copy import deepcopy
import uuid

import duckdb
import pytest

from sourcesql.contracts import SourcesQLError
from sourcesql.engine import Engine
from sourcesql.storage.motherduck import MotherDuckStore
from test_engine_boundaries import reference_worker

CONTRACT = "sourcesql.app-effective.v1"
COLUMNS = [
    {"key": "entity", "logical_type": "VARCHAR", "nullable": False},
    {"key": "count", "logical_type": "BIGINT", "nullable": False},
    {"key": "amount", "logical_type": "DECIMAL(38,6)", "nullable": True},
    {"key": "active", "logical_type": "BOOLEAN", "nullable": False},
    {"key": "tags", "logical_type": "BIGINT[]", "nullable": False},
    {
        "key": "details",
        "logical_type": "STRUCT(name VARCHAR, ordinal BIGINT)",
        "nullable": False,
    },
]
ORIGINAL_ROW = {
    "entity": "Synthetic campus α",
    "count": "9007199254740993",
    "amount": "12345678901234567890.123456",
    "active": False,
    "tags": ["9007199254740993", "2"],
    "details": {"name": "Synthetic source", "ordinal": "9007199254740995"},
}
CORRECTED_ROW = {**ORIGINAL_ROW, "amount": None, "active": True}


@pytest.fixture(params=["local", "motherduck-local"])
def make_engine(request, tmp_path):
    """Return independent stores backed by the actual production adapter classes."""

    def factory(name="owner", *, allow_private=True):
        root = tmp_path / name
        root.mkdir(exist_ok=True)
        calls = []

        def worker(*args, **kwargs):
            calls.append(args[0])
            return reference_worker(*args, **kwargs)

        store = None
        if request.param == "motherduck-local":
            path = root / "durable.duckdb"
            store = MotherDuckStore(
                database="synthetic_materialization_test",
                namespace="a" * 64,
                connector=lambda: duckdb.connect(str(path)),
            )
        engine = Engine(root / "engine", store=store, worker=worker, allow_private=allow_private)
        return engine, calls

    return factory


def pin(result, *, effective=False):
    return {
        "result_id": result["result_id"],
        "view": "effective" if effective else "original",
        "amendment_revision": 1 if effective else None,
    }


def graph(engine, *, private_refresh=False, current_recipe=True, request_id=None):
    baseline = engine.import_table(
        columns=deepcopy(COLUMNS),
        rows=[deepcopy(ORIGINAL_ROW)],
        row_ids=["baseline_row"],
        data_classification="public_web",
    )
    refresh = engine.import_table(
        columns=[{"key": "observation", "logical_type": "VARCHAR", "nullable": False}],
        rows=[{"observation": "Synthetic refresh establishes corrected active state"}],
        row_ids=["refresh_row"],
        data_classification="private_local" if private_refresh else "public_web",
    )
    parents = sorted([baseline["result_id"], refresh["result_id"]])
    provenance = {
        "snapshot_id": "corrected_baseline",
        "view": "effective",
        "amendment_revision": 1,
        "dependencies": parents,
    }
    if current_recipe:
        provenance["materialization_contract"] = CONTRACT
    promoted = engine.import_table(
        columns=deepcopy(COLUMNS),
        rows=[deepcopy(CORRECTED_ROW)],
        row_ids=["baseline_row"],
        # Python must independently upgrade private ancestry even if a caller
        # supplies public_web; the app's classification join is not its authority.
        data_classification="public_web",
        parents=[
            {"result_id": result_id, "view": "original", "amendment_revision": None}
            for result_id in parents
        ],
        provenance=provenance,
    )
    request = {
        "query": "SELECT * FROM input.corrected",
        "request_id": request_id or str(uuid.uuid4()),
        "inputs": {"corrected": pin(promoted, effective=True)},
    }
    downstream = engine.query(**request)
    return baseline, refresh, promoted, downstream, request


def durable_state(engine):
    """Raw persisted state is inspected only to prove refusal did not reactivate it."""
    with engine.store.db() as db:
        return {
            "results": db.execute("SELECT id,revoked,metadata FROM results ORDER BY id").fetchall(),
            "runs": db.execute("SELECT id,receipt FROM runs ORDER BY id").fetchall(),
        }


@pytest.mark.parametrize("private_refresh", [False, True])
def test_promoted_and_downstream_results_reauthorize_every_recorded_contributor(
    make_engine, private_refresh
):
    engine, calls = make_engine()
    baseline, refresh, promoted, downstream, request = graph(
        engine, private_refresh=private_refresh
    )
    expected_classification = "private_derived" if private_refresh else "public_web"
    assert promoted["data_classification"] == expected_classification
    assert downstream["data_classification"] == (
        "private_derived" if private_refresh else "synthetic_fixture"
    )
    assert promoted["rows"] == downstream["rows"] == [CORRECTED_ROW]
    assert promoted["row_ids"] == ["baseline_row"]
    assert {parent["result_id"] for parent in promoted["parents"]} == {
        baseline["result_id"],
        refresh["result_id"],
    }
    assert promoted["lineage_precision"] == "input_set"
    assert promoted["replay_level"] == "values_only"
    assert promoted["evidence"] == []
    assert engine.export(downstream["result_id"])["root_result_id"] == downstream["result_id"]
    dispatched = len(calls)
    engine.store.revoke(refresh["result_id"])

    for result in (promoted, downstream):
        for action in (
            lambda result=result: engine.read_result(result["result_id"]),
            lambda result=result: engine.export(result["result_id"]),
            lambda result=result: engine.query(
                query="SELECT * FROM input.saved", inputs={"saved": pin(result)}
            ),
        ):
            with pytest.raises(SourcesQLError) as error:
                action()
            assert error.value.code == "unauthorized"
    with pytest.raises(SourcesQLError) as error:
        engine.query(**request)
    assert error.value.code == "unauthorized"
    assert len(calls) == dispatched
    assert engine.read_result(baseline["result_id"])["rows"] == [ORIGINAL_ROW]
    assert set(engine.export(baseline["result_id"])["results"]) == {baseline["result_id"]}


@pytest.mark.parametrize("private_refresh", [False, True])
def test_bundle_restore_remaps_authoritative_parents_and_cannot_reactivate_revoked_source(
    make_engine, private_refresh
):
    source, _ = make_engine("source")
    baseline, refresh, promoted, downstream, _ = graph(source, private_refresh=private_refresh)
    bundle = source.export(downstream["result_id"])
    destination, calls = make_engine("destination")
    restored = destination.import_bundle(bundle)
    mapping = restored["result_mapping"]
    assert set(mapping) == {
        baseline["result_id"],
        refresh["result_id"],
        promoted["result_id"],
        downstream["result_id"],
    }
    assert all(original != remapped for original, remapped in mapping.items())
    saved = destination.read_result(mapping[promoted["result_id"]])
    assert {parent["result_id"] for parent in saved["parents"]} == {
        mapping[baseline["result_id"]],
        mapping[refresh["result_id"]],
    }
    assert saved["rows"] == [CORRECTED_ROW]
    assert saved["columns"] == promoted["columns"]
    assert saved["row_ids"] == promoted["row_ids"]
    assert saved["data_classification"] == promoted["data_classification"]
    assert saved["provenance"]["materialization_contract"] == CONTRACT
    assert saved["provenance"]["amendment_revision"] == 1
    # Inherited provenance is descriptive and can retain foreign IDs; only
    # authoritative metadata.parents is remapped and used for authorization.
    assert saved["provenance"]["dependencies"] == promoted["provenance"]["dependencies"]
    assert set(saved["provenance"]["dependencies"]).isdisjoint(
        parent["result_id"] for parent in saved["parents"]
    )
    assert destination.read_result(mapping[downstream["result_id"]])["rows"] == [CORRECTED_ROW]
    assert calls == []
    destination.store.revoke(mapping[refresh["result_id"]])
    before = durable_state(destination)
    with pytest.raises(SourcesQLError) as error:
        destination.import_bundle(bundle)
    assert error.value.code == "idempotency_conflict"
    assert durable_state(destination) == before
    assert calls == []
    for original in (promoted, downstream):
        with pytest.raises(SourcesQLError) as error:
            destination.read_result(mapping[original["result_id"]])
        assert error.value.code == "unauthorized"
    assert destination.read_result(mapping[baseline["result_id"]])["rows"] == [ORIGINAL_ROW]
    # Revocation is local authority, not an automatic recall of another store.
    assert source.read_result(promoted["result_id"])["rows"] == [CORRECTED_ROW]


@pytest.mark.parametrize("current_recipe", [False, True])
def test_request_lookup_is_bounded_read_only_and_distinguishes_legacy_effective_inputs(
    make_engine, current_recipe
):
    engine, calls = make_engine()
    _, refresh, _, completed, request = graph(engine, current_recipe=current_recipe)
    before = durable_state(engine)
    dispatched = len(calls)
    assert engine.lookup_request(str(uuid.uuid4())) == {"found": False}
    assert engine.lookup_request(request["request_id"]) == {
        "found": True,
        "run_id": completed["run_id"],
        "status": "completed",
        "current_recipe": current_recipe,
    }
    assert durable_state(engine) == before
    assert len(calls) == dispatched
    engine.store.revoke(refresh["result_id"])
    with pytest.raises(SourcesQLError) as error:
        engine.lookup_request(request["request_id"])
    assert error.value.code == "unauthorized"
    assert len(calls) == dispatched


def test_request_lookup_private_grant_is_rechecked_without_worker_or_write(make_engine):
    owner, _ = make_engine()
    _, _, _, _, request = graph(owner, private_refresh=True)
    restricted, calls = make_engine(allow_private=False)
    before = durable_state(owner)
    with pytest.raises(SourcesQLError) as error:
        restricted.lookup_request(request["request_id"])
    assert error.value.code == "unauthorized"
    assert calls == []
    assert durable_state(owner) == before


@pytest.mark.parametrize("status", ["running", "failed"])
def test_request_lookup_keeps_exact_unpublished_handle_without_restarting_work(make_engine, status):
    engine, calls = make_engine()
    _, _, promoted, _, _ = graph(engine)
    request_id = str(uuid.uuid4())
    run_id = "run_lookup_" + uuid.uuid4().hex
    engine.store.begin_run(
        {
            "request_id": request_id,
            "query": "SELECT 'PRIVATE-SQL-MARKER' AS value FROM input.corrected",
            "parameters": {"private_marker": "PRIVATE-PARAMETER-MARKER"},
            "inputs": {"corrected": pin(promoted, effective=True)},
        },
        {
            "run_id": run_id,
            "request_id": request_id,
            "status": status,
            "receipt_revision": 0,
            "result_id": None,
            "parents": [pin(promoted, effective=True)],
            "resume_request": {"private_payload": "PRIVATE-PAYLOAD-MARKER"},
        },
    )
    before = durable_state(engine)
    dispatched = len(calls)
    assert engine.lookup_request(request_id) == {
        "found": True,
        "run_id": run_id,
        "status": status,
        "current_recipe": True,
    }
    assert durable_state(engine) == before
    assert len(calls) == dispatched


def test_request_lookup_rejects_invalid_uuid_without_work_or_writes(make_engine):
    engine, calls = make_engine()
    before = durable_state(engine)
    for invalid in (None, "", "not-a-uuid", {}, 123):
        with pytest.raises(SourcesQLError) as error:
            engine.lookup_request(invalid)
        assert error.value.code == "invalid_request"
    assert durable_state(engine) == before
    assert calls == []


def captured_materialization(baseline, promoted):
    """The app request still pins A; Python recomputes the promoted import pin."""
    payload = {
        "columns": deepcopy(COLUMNS),
        "rows": [deepcopy(CORRECTED_ROW)],
        "row_ids": ["baseline_row"],
        "data_classification": "public_web",
        "parents": [
            {"result_id": parent["result_id"], "view": "original", "amendment_revision": None}
            for parent in promoted["parents"]
        ],
        "provenance": deepcopy(promoted["provenance"]),
    }
    return {"corrected": payload}, {"corrected": pin(baseline, effective=True)}


@pytest.mark.parametrize("private_refresh", [False, True])
def test_current_recipe_lookup_uses_python_import_identity_and_recovers_without_writes(
    make_engine, private_refresh
):
    engine, calls = make_engine()
    baseline, _, promoted, completed, normalized_request = graph(
        engine, private_refresh=private_refresh
    )
    materializations, original_inputs = captured_materialization(baseline, promoted)
    original_request = {**normalized_request, "inputs": original_inputs}
    before = durable_state(engine)
    dispatched = len(calls)
    result = engine.lookup_request(
        original_request["request_id"],
        expected_request=original_request,
        materializations=materializations,
    )
    assert result == {
        "found": True,
        "run_id": completed["run_id"],
        "status": "completed",
        "current_recipe": True,
        "compatible": True,
        "result_id": completed["result_id"],
    }
    assert durable_state(engine) == before
    assert len(calls) == dispatched
    assert original_request["inputs"]["corrected"]["result_id"] == baseline["result_id"]


@pytest.mark.parametrize("change", ["value", "closure", "classification", "query", "profile"])
def test_current_recipe_changed_context_conflicts_before_new_import_or_dispatch(
    make_engine, change
):
    engine, calls = make_engine()
    baseline, _, promoted, _, normalized_request = graph(engine)
    materializations, original_inputs = captured_materialization(baseline, promoted)
    original_request = {**normalized_request, "inputs": original_inputs}
    payload = materializations["corrected"]
    if change == "value":
        payload["rows"][0]["entity"] = "Changed value at the same captured revision"
    elif change == "closure":
        # An ancestor can gain a contributing dependency without changing the
        # selected root's amendment count. It still changes canonical identity.
        extra = engine.import_table(
            columns=[{"key": "value", "logical_type": "VARCHAR"}],
            rows=[{"value": "New contributing dependency"}],
            data_classification="public_web",
        )
        payload["parents"].append(
            {"result_id": extra["result_id"], "view": "original", "amendment_revision": None}
        )
        payload["parents"].sort(key=lambda item: item["result_id"])
        payload["provenance"]["dependencies"] = [
            parent["result_id"] for parent in payload["parents"]
        ]
    elif change == "classification":
        payload["data_classification"] = "synthetic_fixture"
    elif change == "query":
        original_request["query"] = "SELECT entity FROM input.corrected"
    else:
        engine.profiles["fixture"]["operator_revision"] = "changed"
    assert payload["provenance"]["amendment_revision"] == 1
    assert original_request["inputs"]["corrected"]["amendment_revision"] == 1
    before = durable_state(engine)
    dispatched = len(calls)
    with pytest.raises(SourcesQLError) as error:
        engine.lookup_request(
            original_request["request_id"],
            expected_request=original_request,
            materializations=materializations,
        )
    assert error.value.code == "idempotency_conflict"
    assert durable_state(engine) == before
    assert len(calls) == dispatched


def test_request_lookup_finds_historically_uppercase_uuid_without_creating_replacement(make_engine):
    engine, calls = make_engine()
    request_id = "AB123456-ABCD-4ABC-ABCD-ABCDEF123456"
    baseline, _, promoted, completed, request = graph(engine, request_id=request_id)
    materializations, original_inputs = captured_materialization(baseline, promoted)
    before = durable_state(engine)
    dispatched = len(calls)
    for supplied in (request_id, request_id.lower()):
        saved = engine.lookup_request(supplied)
        assert saved == {
            "found": True,
            "run_id": completed["run_id"],
            "status": "completed",
            "current_recipe": True,
        }
    exact = engine.lookup_request(
        request_id,
        expected_request={**request, "inputs": original_inputs},
        materializations=materializations,
    )
    assert exact["compatible"] is True
    assert exact["result_id"] == completed["result_id"]
    assert durable_state(engine) == before
    assert len(calls) == dispatched


def test_request_lookup_refuses_ambiguous_legacy_uuid_case_rows_instead_of_picking_first(
    make_engine,
):
    engine, calls = make_engine()
    lower = "ab123456-abcd-4abc-abcd-abcdef123456"
    _, _, promoted, _, _ = graph(engine, request_id=lower)
    upper = lower.upper()
    # Earlier versions treated runs.request_id as case-sensitive VARCHAR. Retain
    # those historical rows and require explicit inspection rather than guessing
    # which spelling should own the same logical UUID after the cutover.
    engine.store.begin_run(
        {"request_id": upper, "query": "SELECT * FROM input.corrected"},
        {
            "run_id": "run_ambiguous_" + uuid.uuid4().hex,
            "request_id": upper,
            "status": "running",
            "receipt_revision": 0,
            "result_id": None,
            "parents": [pin(promoted, effective=True)],
        },
    )
    before = durable_state(engine)
    dispatched = len(calls)
    for supplied in (upper, lower):
        with pytest.raises(SourcesQLError) as error:
            engine.lookup_request(supplied)
        assert error.value.code == "idempotency_conflict"
    assert durable_state(engine) == before
    assert len(calls) == dispatched
