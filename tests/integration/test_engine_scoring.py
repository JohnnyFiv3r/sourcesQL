"""Batched scoring through the coordinator; all HTTP and sources are synthetic."""

import json

import httpx
import pytest

from sourcesql.contracts import Column, Table, SourcesQLError
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.semantic import OpenAIEmbeddingProvider
from sourcesql.providers.tokenization import get_embedding_tokenizer


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


def setup_engine(tmp_path, monkeypatch, reply):
    original = ProviderRegistry.__init__

    def configured(self, profile=None):
        original(self, profile)
        self.embedding_provider = OpenAIEmbeddingProvider(
            "text-embedding-3-small",
            "synthetic-not-a-key",
            httpx.Client(transport=httpx.MockTransport(reply)),
        )

    # The trusted live-mode grant is synthetic; MockTransport is the only HTTP path.
    monkeypatch.setattr(ProviderRegistry, "__init__", configured)
    engine = Engine(
        tmp_path / "engine",
        worker=reference_worker,
        profiles={
            "mock": {
                "mode": "live",
                "provider": "exa",
                "allow_live": True,
                "approved_cost_microusd": 1,
                "metering_policy": "estimated",
            }
        },
    )
    saved = engine.import_table(
        [{"key": "id", "logical_type": "BIGINT"}, {"key": "content"}],
        [{"id": i, "content": value} for i, value in enumerate(["alpha", "beta", "alpha", None])],
        data_classification="synthetic_fixture",
    )
    arguments = {
        "inputs": {
            "docs": {
                "result_id": saved["result_id"],
                "view": "original",
                "amendment_revision": None,
            }
        },
        "profile": "mock",
        "budgets": {"max_cost_microusd": 1, "max_semantic_documents": 0},
    }
    return engine, arguments


QUERY = (
    "SELECT id, SEM_SCORE(content, 'specific criterion') AS relevance FROM input.docs ORDER BY id"
)


def test_batch_usage_cache_unknowns_and_row_identity_survive_engine_execution(
    tmp_path, monkeypatch
):
    requests = []

    def reply(request):
        inputs = json.loads(request.content)["input"]
        requests.append(inputs)
        assert inputs == ["alpha", "beta", "specific criterion"]
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 2, "embedding": [1, 0]},
                    {"index": 0, "embedding": [1, 0]},
                    {"index": 1, "embedding": [-1, 0]},
                ],
                "usage": {"total_tokens": 9},
            },
        )

    engine, arguments = setup_engine(tmp_path, monkeypatch, reply)
    result = engine.query(query=QUERY, **arguments)
    assert result["rows"] == [
        {"id": str(i), "relevance": score} for i, score in enumerate([1.0, -1.0, 1.0, None])
    ]
    receipt = result["receipt"]
    assert receipt["counts"]["model_requests"] == 1
    encoder = get_embedding_tokenizer("text-embedding-3-small")
    assert receipt["counts"]["input_tokens"] == sum(
        len(encoder.encode_ordinary(text)) for text in ("alpha", "beta", "specific criterion")
    )
    assert receipt["counts"]["scoring_documents"] == 2
    assert receipt["counts"].get("semantic_documents", 0) == 0
    assert receipt["settlement_status"] == "settled"
    assert sum(u.get("requests", 0) for u in receipt["usage"]) == 1
    assert sum(u.get("input_tokens", 0) for u in receipt["usage"]) == 9
    assert not result["evidence"]  # Ranking is not evidence of a claim.

    reopened = engine.query(query=QUERY, **arguments)
    assert reopened["rows"] == result["rows"]
    assert len(requests) == 1  # Durable score cache, no second HTTP request.
    assert reopened["receipt"]["counts"].get("model_requests", 0) == 0

    monkeypatch.setattr(OpenAIEmbeddingProvider, "CONTRACT_VERSION", "test.changed-token-contract")
    rescored = engine.query(query=QUERY, **arguments)
    assert rescored["rows"] == result["rows"]
    assert len(requests) == 2  # Changed scoring semantics cannot reuse older scores.


def test_failed_batch_never_becomes_zero_or_retries_duplicate_rows(tmp_path, monkeypatch):
    requests = []

    def reply(request):
        requests.append(request)
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    engine, arguments = setup_engine(tmp_path, monkeypatch, reply)
    result = engine.query(query=QUERY, **arguments)
    assert result["rows"] == [{"id": str(i), "relevance": None} for i in range(4)]
    assert len(requests) == 1
    receipt = result["receipt"]
    assert receipt["settlement_status"] == "pending"
    assert sum(u.get("requests", 0) for u in receipt["usage"]) == 1
    assert receipt["provider_events"][-1]["failure"]["code"] == "provider_timeout"


def test_scoring_document_budget_stops_before_http(tmp_path, monkeypatch):
    engine, arguments = setup_engine(tmp_path, monkeypatch, lambda _: pytest.fail("HTTP over cap"))
    arguments["budgets"]["max_candidates"] = 1
    with pytest.raises(SourcesQLError) as error:
        engine.query(query=QUERY, **arguments)
    assert error.value.code == "budget_exhausted"


def test_cache_event_cannot_settle_a_reserved_request_with_unknown_dispatch(tmp_path, monkeypatch):
    engine, arguments = setup_engine(tmp_path, monkeypatch, lambda _: pytest.fail("no HTTP"))

    def interrupted(self, texts, criterion, options, budget):
        self._extra_events.append({"kind": "embedding_cache", "status": "cache_hit"})
        budget.reserve("model_requests", limit="max_model_requests")
        raise SourcesQLError("cancelled", "Synthetic interruption after reservation", "dispatch")

    monkeypatch.setattr(ProviderRegistry, "score_many", interrupted)
    with pytest.raises(SourcesQLError, match="Synthetic interruption"):
        engine.query(query=QUERY, **arguments)
    with engine.store.db() as db:
        receipts = [json.loads(row[0]) for row in db.execute("SELECT receipt FROM runs").fetchall()]
    failed = next(receipt for receipt in receipts if receipt["status"] == "cancelled")
    assert failed["unsettled_requests"] == 1
    assert failed["settlement_status"] == "pending"
