"""Profile identity excludes runtime credentials through one shared recipe."""

from __future__ import annotations

import uuid

import pytest

import sourcesql.engine as engine_module
from sourcesql.contracts import SourcesQLError, digest
from sourcesql.engine import Engine


def test_profile_revision_preserves_historical_digest_and_excludes_credential_handles():
    retained = {"mode": "fixture", "provider": "fixture", "operator_revision": 2}
    runtime = {
        "API_KEY": "synthetic-key",
        "access_token": "synthetic-token",
        "HTTP_CLIENT": object(),
        "MODEL_ADAPTER": object(),
        "embedding_adapter": object(),
    }
    assert engine_module.profile_revision({**retained, **runtime}) == digest(retained)
    rotated = {key: object() for key in runtime}
    assert engine_module.profile_revision({**retained, **rotated}) == digest(retained)
    assert engine_module.profile_revision({**retained, "operator_revision": 3}) != digest(retained)


def test_query_and_guarded_lookup_share_profile_revision_recipe(tmp_path, monkeypatch):
    engine = Engine(tmp_path / "engine", worker=lambda *a, **k: pytest.fail("No worker needed"))
    promoted = engine.import_table(
        columns=[{"key": "value", "logical_type": "VARCHAR"}],
        rows=[{"value": "retained"}],
        provenance={
            "materialization_contract": "sourcesql.app-effective.v1",
            "amendment_revision": 1,
        },
        data_classification="public_web",
    )
    payload = {
        "columns": [{"key": "value", "logical_type": "VARCHAR"}],
        "rows": [{"value": "retained"}],
        "provenance": {
            "materialization_contract": "sourcesql.app-effective.v1",
            "amendment_revision": 1,
        },
        "data_classification": "public_web",
    }
    observed = []

    def revision(profile):
        observed.append(dict(profile))
        return "test_shared_profile_revision"

    monkeypatch.setattr(engine_module, "profile_revision", revision)
    # Persist the engine's real admitted request without executing a query: this
    # is a known running operation, not a manufactured completed result.
    request = {
        "query": "SELECT value FROM input.saved",
        "request_id": str(uuid.uuid4()),
        "inputs": {
            "saved": {
                "result_id": promoted["result_id"],
                "view": "effective",
                "amendment_revision": 1,
            }
        },
    }
    original_begin = engine.store.begin_run

    def stop_after_admission(pinned, receipt):
        assert pinned["profile_revision"] == "test_shared_profile_revision"
        original_begin(pinned, receipt)
        return receipt, False

    monkeypatch.setattr(engine.store, "begin_run", stop_after_admission)
    retained = engine.query(**request)
    assert retained["result_id"] is None
    assert (
        engine.lookup_request(
            request["request_id"], expected_request=request, materializations={"saved": payload}
        )["compatible"]
        is True
    )
    assert len(observed) == 2
    assert observed[0] == observed[1] == {"mode": "fixture", "provider": "fixture"}


def test_guarded_lookup_accepts_credential_rotation_but_refuses_changed_operator_policy(tmp_path):
    engine = Engine(tmp_path / "engine", worker=lambda *a, **k: pytest.fail("No worker needed"))
    payload = {
        "columns": [{"key": "value", "logical_type": "VARCHAR"}],
        "rows": [{"value": "retained"}],
        "data_classification": "public_web",
        "provenance": {
            "materialization_contract": "sourcesql.app-effective.v1",
            "amendment_revision": 1,
        },
    }
    promoted = engine.import_table(**payload)
    request = {
        "query": "SELECT value FROM input.saved",
        "request_id": str(uuid.uuid4()),
        "inputs": {
            "saved": {
                "result_id": promoted["result_id"],
                "view": "effective",
                "amendment_revision": 1,
            }
        },
    }
    # No worker executes: a real persisted receipt models an already known run.
    profile = engine.profiles["fixture"]
    profile["api_key"] = "synthetic-original-key"
    engine.store.begin_run(
        request,
        {
            "run_id": "run_profile_" + uuid.uuid4().hex,
            "request_id": request["request_id"],
            "status": "running",
            "receipt_revision": 0,
            "result_id": None,
            "parents": [request["inputs"]["saved"]],
            "resume_request": request,
            "profile_revision": digest({"mode": "fixture", "provider": "fixture"}),
        },
    )
    profile["api_key"] = "synthetic-rotated-key"
    assert (
        engine.lookup_request(
            request["request_id"], expected_request=request, materializations={"saved": payload}
        )["compatible"]
        is True
    )
    profile["operator_revision"] = 2
    with pytest.raises(SourcesQLError) as error:
        engine.lookup_request(
            request["request_id"], expected_request=request, materializations={"saved": payload}
        )
    assert error.value.code == "idempotency_conflict"
