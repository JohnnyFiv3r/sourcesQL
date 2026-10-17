"""Native DuckDB store boundaries with synthetic embedding HTTP only.

These count the real MotherDuckStore connector/transaction path, without a
MotherDuck account. They prove bounded storage work, not hosted latency.
"""

from __future__ import annotations

import json
import math
from types import SimpleNamespace
from uuid import uuid4

import duckdb
import httpx
import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical, digest
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.semantic import OpenAIEmbeddingProvider
from sourcesql.storage.motherduck import MotherDuckStore, timestamp


def worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {key: value.to_dict() for key, value in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [
            Column(column["key"], column["logical_type"], column["nullable"])
            for column in result["columns"]
        ],
        result["rows"],
    )


@pytest.fixture
def cloud_scoring(tmp_path, monkeypatch):
    original = ProviderRegistry.__init__
    active = None

    def initialize(registry, profile=None):
        original(registry, profile)
        state = active

        def reply(request):
            inputs = json.loads(request.content)["input"]
            state.requests.append(inputs)
            if state.after_response is not None:
                action, state.after_response = state.after_response, None
                action()
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": index, "embedding": [1.0, 0.0]} for index in range(len(inputs))
                    ],
                    "usage": {"total_tokens": len(inputs)},
                },
            )

        registry.embedding_provider = OpenAIEmbeddingProvider(
            "text-embedding-3-small",
            "synthetic-not-a-provider-key",
            httpx.Client(transport=httpx.MockTransport(reply)),
        )
        registry.embedding_provider.MAX_BATCH_INPUTS = state.batch_size

    monkeypatch.setattr(ProviderRegistry, "__init__", initialize)
    monkeypatch.setattr(
        ProviderRegistry,
        "score_many",
        lambda registry, texts, criterion, options, budget: registry.embedding_provider.score_many(
            texts, criterion, options, budget
        ),
    )

    def make(count, *, batch_size=128, bound_job=False):
        nonlocal active
        state = SimpleNamespace(
            requests=[], connections=0, after_response=None, batch_size=batch_size
        )
        active = state
        database = tmp_path / ("storage-" + uuid4().hex + ".duckdb")

        def connector():
            state.connections += 1
            return duckdb.connect(str(database))

        state.store = MotherDuckStore("synthetic_storage", "a" * 64, connector=connector)
        state.engine = Engine(tmp_path / uuid4().hex, store=state.store, worker=worker)
        saved = state.engine.import_table(
            [{"key": "id", "logical_type": "BIGINT"}, {"key": "content"}],
            [{"id": index, "content": f"synthetic source {index}"} for index in range(count)],
            data_classification="synthetic_fixture",
        )
        state.parent_id = saved["result_id"]
        state.request = {
            "query": "SELECT id, SEM_SCORE(content,'criterion') AS relevance "
            "FROM input.docs ORDER BY id",
            "inputs": {"docs": {"result_id": state.parent_id}},
            "budgets": {"max_candidates": max(100, count)},
        }
        if bound_job:
            state.job_id, state.claim = str(uuid4()), str(uuid4())
            request_id, flight_id = str(uuid4()), str(uuid4())
            state.request["request_id"] = request_id
            with state.store.db() as db:
                db.execute(
                    "INSERT INTO jobs(id,request_id,operation,request_hash,request_json,status,"
                    "created_at,updated_at,flight_id,flight_version,claim_token,max_runtime_sec) "
                    "VALUES(?::UUID,?::UUID,'query',?,?,'running',?,?,?::UUID,1,?::UUID,120)",
                    [
                        state.job_id,
                        request_id,
                        digest(state.request),
                        canonical(state.request).decode(),
                        timestamp(),
                        timestamp(),
                        flight_id,
                        state.claim,
                    ],
                )
            state.store.bind_job(state.job_id, state.claim)
        state.connections = 0
        return state

    return make


def test_scoring_transactions_follow_http_batches_not_candidate_rows(cloud_scoring):
    observed = []
    for count in (32, 512):
        state = cloud_scoring(count)
        result = state.engine.query(**state.request)
        batches = math.ceil((count + 1) / 128)
        assert len(state.requests) == batches
        assert result["row_count"] == count
        assert result["rows"] == [
            {"id": str(index), "relevance": 1.0} for index in range(min(count, 100))
        ]
        _, full = state.store.read(result["result_id"])
        assert full.rows == [{"id": index, "relevance": 1.0} for index in range(count)]
        assert result["receipt"]["counts"]["scoring_documents"] == count
        assert sum(usage.get("requests", 0) for usage in result["receipt"]["usage"]) == batches
        observed.append(state.connections)
        assert state.connections <= 60 + 12 * batches
        state.connections = 0
        warm = state.engine.query(**state.request)
        assert warm["rows"] == result["rows"]
        assert len(state.requests) == batches
        assert warm["receipt"]["counts"]["cache_hits"] == count
        assert state.connections <= 60
    assert observed[1] - observed[0] <= 12 * (5 - 1)


@pytest.mark.parametrize("change", ["revoke", "cancel", "lease"])
def test_next_embedding_batch_rechecks_dependency_cancellation_and_claim(cloud_scoring, change):
    state = cloud_scoring(5, batch_size=2, bound_job=True)

    def change_durable_control():
        if change == "revoke":
            state.store.revoke(state.parent_id)
        else:
            with state.store.db() as db:
                if change == "cancel":
                    db.execute(
                        "UPDATE jobs SET status='cancelled',cancel_requested=true WHERE id=?::UUID",
                        [state.job_id],
                    )
                else:
                    db.execute(
                        "UPDATE jobs SET claim_token=?::UUID WHERE id=?::UUID",
                        [str(uuid4()), state.job_id],
                    )

    state.after_response = change_durable_control
    with pytest.raises(SourcesQLError) as failure:
        state.engine.query(**state.request)
    assert failure.value.code == ("cancelled" if change == "cancel" else "unauthorized")
    assert len(state.requests) == 1
    with state.store.db() as db:
        stages = db.execute("SELECT status FROM execution_stages").fetchall()
        cached = db.execute("SELECT value FROM semantic_cache").fetchall()
        result_count = db.execute("SELECT count(*) FROM results").fetchone()[0]
    assert stages == [("completed",)]
    assert len(cached) == 1 and json.loads(cached[0][0])["status"] == "processed"
    assert result_count == 1  # Only the preexisting input, no published score table.


def test_final_batch_cancellation_cannot_publish_cached_scores(cloud_scoring):
    state = cloud_scoring(1, batch_size=2, bound_job=True)

    def cancel_after_last_http():
        with state.store.db() as db:
            db.execute(
                "UPDATE jobs SET status='cancelled',cancel_requested=true WHERE id=?::UUID",
                [state.job_id],
            )

    state.after_response = cancel_after_last_http
    with pytest.raises(SourcesQLError) as failure:
        state.engine.query(**state.request)
    assert failure.value.code == "cancelled"
    assert len(state.requests) == 1
    with state.store.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM semantic_cache").fetchone()[0] == 1
