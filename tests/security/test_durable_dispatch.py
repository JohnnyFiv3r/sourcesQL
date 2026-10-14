"""Separate coordinators share durable cancellation, authorization and dispatch intent."""

import uuid

import httpx
import pytest

from open_webql.contracts import WebQLError
from open_webql.engine import Engine
from open_webql.providers.fixture import FixtureProvider
from test_engine_boundaries import reference_worker


def test_another_coordinator_cancellation_prevents_atomic_publication(tmp_path, monkeypatch):
    engine = Engine(tmp_path, worker=reference_worker)
    other = Engine(tmp_path, worker=reference_worker)
    commit = engine.store.commit

    def cancel_before_commit(table, metadata):
        other.cancel(metadata["run_id"])
        return commit(table, metadata)

    monkeypatch.setattr(engine.store, "commit", cancel_before_commit)
    with pytest.raises(WebQLError, match="Run cancelled"):
        engine.query(query="SELECT 7 AS value")
    with engine.store.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 0
        receipt = engine.store.run(db.execute("SELECT id FROM runs").fetchone()[0])
    assert receipt["status"] == "cancelled" and receipt["result_id"] is None


def test_revocation_during_execution_prevents_child_visibility(tmp_path, monkeypatch):
    engine = Engine(tmp_path, worker=reference_worker)
    parent = engine.import_table([{"key": "value"}], [{"value": "fixture"}])
    commit = engine.store.commit

    def revoke_before_commit(table, metadata):
        engine.store.revoke(parent["result_id"])
        return commit(table, metadata)

    monkeypatch.setattr(engine.store, "commit", revoke_before_commit)
    with pytest.raises(WebQLError):
        engine.query(
            query="SELECT value FROM input.p", inputs={"p": {"result_id": parent["result_id"]}}
        )
    with engine.store.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 1


def test_stale_cancel_cannot_replace_completed_receipt(tmp_path):
    engine = Engine(tmp_path, worker=reference_worker)
    result = engine.query(query="SELECT 7 AS value")
    published = result["receipt"]
    stale = {**published, "status": "cancelled", "result_id": None, "receipt_revision": 0}
    actual = Engine(tmp_path, worker=reference_worker).store.update_run(stale)
    assert actual == published
    assert engine.run_status(result["run_id"])["status"] == "completed"


def test_dispatch_intent_is_durable_before_effect_and_retry_does_not_repeat(tmp_path, monkeypatch):
    engine = Engine(tmp_path, worker=reference_worker)
    request = {
        "query": "SELECT url FROM WEB_SEARCH('fictional campuses')",
        "request_id": str(uuid.uuid4()),
    }
    effects = []

    def interrupted_search(self, queries, options, budget):
        budget.reserve("search_requests", limit="max_search_requests")
        with engine.store.db() as db:
            receipt = engine.store.run(db.execute("SELECT id FROM runs").fetchone()[0])
        assert receipt["counts"]["search_requests"] == 1
        assert receipt["dispatch_intents"][0]["counter"] == "search_requests"
        effects.append("attempt")
        raise SystemExit("Simulated interrupted coordinator")

    monkeypatch.setattr(FixtureProvider, "search", interrupted_search)
    with pytest.raises(SystemExit):
        engine.query(**request)
    retry = Engine(tmp_path, worker=reference_worker).query(**request)
    assert effects == ["attempt"]
    assert retry["result_id"] is None and retry["receipt"]["status"] == "running"


def test_missing_scorer_refuses_before_search_transport(tmp_path):
    effects = []
    client = httpx.Client(transport=httpx.MockTransport(lambda request: effects.append(request)))
    engine = Engine(
        tmp_path,
        worker=reference_worker,
        profiles={
            "live-test": {
                "mode": "live",
                "provider": "exa",
                "api_key": "synthetic-test-key",
                "http_client": client,
                "allow_live": True,
                "approved_cost_microusd": 100,
                "metering_policy": "estimated",
            }
        },
    )
    with pytest.raises(WebQLError, match="No embedding scorer"):
        engine.query(
            query="SELECT SEM_SCORE(content, 'relevance to campuses') AS score FROM WEB_SEARCH('campuses')",
            profile="live-test",
            budgets={"max_cost_microusd": 100},
        )
    assert effects == []
