"""Model capacity routing uses explicit provider facts and no new paid requests."""

import asyncio
import json

import httpx
import pytest
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.models.function import FunctionModel

from sourcesql.contracts import Budget
from sourcesql.providers.semantic import OpenAIEmbeddingProvider, PydanticSemanticProvider


def semantic_provider(monkeypatch, handler, base_url=None):
    monkeypatch.setattr(
        "openai.DefaultAsyncHttpxClient",
        lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs),
    )
    return PydanticSemanticProvider.openai(
        "synthetic-model", "synthetic-key", retries=2, base_url=base_url
    )


@pytest.mark.parametrize(
    "code,error_type,limit_kind",
    [
        ("credit_balance_exhausted", "insufficient_quota", "credits"),
        ("organization_spend_limit_exceeded", "insufficient_quota", "spend"),
        ("project_spend_limit_exceeded", "insufficient_quota", "spend"),
        ("organization_usage_limit_exceeded", "insufficient_quota", "unknown"),
        ("insufficient_quota", "insufficient_quota", "unknown"),
        ("slow_down", "rate_limit_error", "rate"),
        ("rate_limit_exceeded", "rate_limit_error", "rate"),
        ("PRIVATE-CODE", "PRIVATE-TYPE", "unknown"),
    ],
)
@pytest.mark.parametrize("operation", ["semantic", "embedding"])
def test_native_openai_refusal_is_metered_once_and_routes_capacity_safely(
    monkeypatch, code, error_type, limit_kind, operation
):
    calls = []

    def reject(request):
        calls.append(request)
        return httpx.Response(
            429,
            headers={"retry-after": "11"},
            json={
                "error": {
                    "code": code,
                    "type": error_type,
                    "message": "PRIVATE-MESSAGE-AND-KEY",
                    "param": "PRIVATE-PARAM",
                }
            },
        )

    adapter = (
        semantic_provider(monkeypatch, reject)
        if operation == "semantic"
        else OpenAIEmbeddingProvider(
            "text-embedding-3-small",
            "synthetic",
            httpx.Client(transport=httpx.MockTransport(reject)),
        )
    )
    try:
        budget = Budget({"max_model_requests": 3})
        outcome = (
            adapter.semantic("SEM_EXTRACT", "source", "entity", {}, {}, budget)
            if operation == "semantic"
            else adapter.score("source", "criterion", {}, budget)
        )
        assert outcome.status == "failed"
        assert len(calls) == budget.counts["model_requests"] == 1
        failure = outcome.usage["failure"]
        assert failure["code"] == "provider_http_error"
        assert failure["http_status"] == 429
        assert failure["provider_capacity"] == {
            "resource": "search_model_budget",
            "reason": "provider_limit",
            "period": "unknown",
            "allowance": "unknown",
            "services": ["openai"],
            "http_status": 429,
            "limit_kind": limit_kind,
            "retry_after_seconds": 11,
        }
        assert adapter.events[0]["provider_capacity"] == failure["provider_capacity"]
        assert "PRIVATE" not in json.dumps({"usage": outcome.usage, "events": adapter.events})
    finally:
        if operation == "semantic":
            asyncio.run(adapter.model.client.close())


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://compatible.example/v1/embeddings",
        "https://api.openai.com.private.example/v1/embeddings",
        "http://api.openai.com/v1/embeddings",
        "https://api.openai.com:444/v1/embeddings",
        "https://api.openai.com/v1/embeddings?key=PRIVATE",
    ],
)
def test_compatible_embedding_refusal_is_not_attributed_to_openai(endpoint):
    adapter = OpenAIEmbeddingProvider(
        "text-embedding-3-small",
        "synthetic",
        httpx.Client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    402,
                    json={
                        "error": {
                            "code": "credit_balance_exhausted",
                            "type": "insufficient_quota",
                        }
                    },
                )
            )
        ),
        endpoint=endpoint,
    )
    outcome = adapter.score("source", "criterion", {}, Budget())
    assert outcome.usage["failure"]["http_status"] == 402
    assert "provider_capacity" not in outcome.usage["failure"]
    assert "provider_capacity" not in adapter.events[0]


def test_compatible_semantic_endpoint_is_not_attributed_to_openai(monkeypatch):
    adapter = semantic_provider(
        monkeypatch,
        lambda _: httpx.Response(
            429,
            json={
                "error": {
                    "code": "credit_balance_exhausted",
                    "type": "insufficient_quota",
                    "message": "PRIVATE",
                }
            },
        ),
        base_url="https://compatible.example/v1",
    )
    try:
        outcome = adapter.semantic("SEM_EXTRACT", "source", "entity", {}, {}, Budget())
        assert outcome.usage["failure"]["http_status"] == 429
        assert "provider_capacity" not in outcome.usage["failure"]
        assert "provider_capacity" not in adapter.events[0]
    finally:
        asyncio.run(adapter.model.client.close())


def test_unidentified_function_model_cannot_claim_openai_capacity():
    def reject(*_):
        raise ModelHTTPError(429, "synthetic", {"error": {"code": "credit_balance_exhausted"}})

    adapter = PydanticSemanticProvider(FunctionModel(reject))
    outcome = adapter.semantic("SEM_EXTRACT", "source", "entity", {}, {}, Budget())
    assert "provider_capacity" not in outcome.usage["failure"]
    assert "provider_capacity" not in adapter.events[0]


@pytest.mark.parametrize("status", [402, 429])
@pytest.mark.parametrize("body", [b"PRIVATE", b"PRIVATE" * 5000, b'{"error":{"code":["PRIVATE"]}}'])
def test_malformed_or_oversized_embedding_refusal_body_keeps_safe_status(status, body):
    adapter = OpenAIEmbeddingProvider(
        "text-embedding-3-small",
        "synthetic",
        httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status, content=body))),
    )
    outcome = adapter.score("source", "criterion", {}, Budget())
    assert outcome.usage["failure"]["provider_capacity"]["limit_kind"] == "unknown"
    assert "PRIVATE" not in json.dumps({"usage": outcome.usage, "events": adapter.events})


@pytest.mark.parametrize("status", [401, 403, 503])
def test_model_auth_and_server_failures_are_not_account_capacity(monkeypatch, status):
    adapter = semantic_provider(
        monkeypatch,
        lambda _: httpx.Response(
            status,
            json={
                "error": {
                    "code": "credit_balance_exhausted",
                    "message": "PRIVATE",
                }
            },
        ),
    )
    try:
        outcome = adapter.semantic("SEM_EXTRACT", "source", "entity", {}, {}, Budget())
        assert "provider_capacity" not in outcome.usage["failure"]
        assert "provider_capacity" not in adapter.events[0]
    finally:
        asyncio.run(adapter.model.client.close())
