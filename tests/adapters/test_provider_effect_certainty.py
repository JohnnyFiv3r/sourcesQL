"""Mocked provider outcomes keep refusal, uncertainty and lost retention distinct."""

import json

import httpx
import pytest
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers.search import ExaProvider
from sourcesql.providers.semantic import OpenAIEmbeddingProvider, PydanticSemanticProvider


class Journal:
    def __init__(self, finish_error=None):
        self.started, self.completed, self.failures = [], [], []
        self.finish_error = finish_error

    def begin(self, operator, arguments, options):
        self.started.append((operator, arguments))
        return "stage_one", None, False

    def finish(self, *args):
        if self.finish_error is not None:
            raise self.finish_error
        self.completed.append(args)

    def fail(self, key, error):
        self.failures.append(
            {
                "key": key,
                "code": error.code,
                "effect_state": error.effect_state,
                "remote_outcome_unknown": error.remote_outcome_unknown,
            }
        )

    def callbacks(self):
        return {"begin": self.begin, "finish": self.finish, "fail": self.fail}


def exa(handler, journal, key="synthetic"):
    provider = ExaProvider(
        key, httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)
    )
    provider.stage_journal = journal.callbacks()
    return provider


def search_response(**overrides):
    return httpx.Response(
        200,
        json={
            "results": [{"url": "https://fictional.example/source", "highlights": ["Source."]}],
            "costDollars": {"total": 0.012},
            **overrides,
        },
    )


@pytest.mark.parametrize("cause", ["missing_credentials", "cancelled", "allowance", "reserved"])
def test_search_stage_without_a_request_is_replayable_and_ignores_unrelated_events(
    cause, monkeypatch
):
    calls, journal = [], Journal()
    provider = exa(
        lambda request: calls.append(request),
        journal,
        key="" if cause == "missing_credentials" else "synthetic",
    )
    # A prior invocation's unknown effect must not classify this stage.
    provider.events.append(
        {"search_id": "another_search", "query_index": 0, "status": "dispatched"}
    )
    budget = Budget({"max_search_requests": 0} if cause == "allowance" else {})
    if cause == "cancelled":
        budget.cancelled = True
    if cause == "reserved":
        checks = []

        def stop_before_transport(*args):
            checks.append(1)
            if len(checks) == 2:
                raise SourcesQLError("budget_exhausted", "Synthetic dispatch deadline", "dispatch")

        monkeypatch.setattr(provider, "_check_dispatch", stop_before_transport)
    with pytest.raises(SourcesQLError):
        provider.search(["public question"], {}, budget)
    assert calls == [] and len(journal.started) == len(journal.failures) == 1
    assert journal.failures[0]["effect_state"] == "not_dispatched"
    assert journal.failures[0]["remote_outcome_unknown"] is False


@pytest.mark.parametrize("status", [402, 429])
def test_search_http_refusal_is_known_and_does_not_retry(status):
    calls, journal = [], Journal()

    def refuse(request):
        calls.append(request)
        return httpx.Response(status, json={"message": "PRIVATE-DETAIL"})

    provider = exa(refuse, journal)
    with pytest.raises(SourcesQLError):
        provider.search(["public question"], {}, Budget())
    assert len(calls) == 1 and provider.events[0]["status"] == "failed"
    assert journal.failures[0]["effect_state"] == "rejected"
    assert journal.failures[0]["remote_outcome_unknown"] is False
    assert "PRIVATE" not in json.dumps({"events": provider.events, "failures": journal.failures})


def test_search_transport_loss_keeps_unknown_outcome_and_does_not_retry():
    calls, journal = [], Journal()

    def timeout(request):
        calls.append(request)
        raise httpx.ReadTimeout("PRIVATE-DETAIL", request=request)

    provider = exa(timeout, journal)
    with pytest.raises(SourcesQLError):
        provider.search(["public question"], {}, Budget())
    assert len(calls) == 1 and provider.events[0]["status"] == "remote_outcome_unknown"
    assert journal.failures[0]["effect_state"] == "outcome_unknown"
    assert journal.failures[0]["remote_outcome_unknown"] is True


@pytest.mark.parametrize("cause", ["invalid_rows", "parse_exception", "accounting", "journal"])
def test_completed_search_usage_survives_local_processing_and_retention_failures(
    cause, monkeypatch
):
    calls = []
    journal = Journal(
        SourcesQLError("budget_exhausted", "Synthetic retention quota")
        if cause == "journal"
        else None
    )

    def respond(request):
        calls.append(request)
        return (
            search_response(results=[{"url": 5}]) if cause == "invalid_rows" else search_response()
        )

    provider, budget = exa(respond, journal), Budget()
    if cause == "parse_exception":

        def parse_failure(*args):
            raise OSError("PRIVATE-PARSE-DETAIL")

        monkeypatch.setattr(provider, "_rows", parse_failure)
    if cause == "accounting":

        def reserve(counter, amount):
            if counter == "candidates":
                raise SourcesQLError("budget_exhausted", "Synthetic accounting failure")

        budget.on_reserve = reserve
    with pytest.raises((SourcesQLError, OSError)):
        provider.search(["public question"], {}, budget)
    assert len(calls) == 1 and provider.events[0]["status"] == "completed"
    assert provider.events[0]["usage"]["estimated_cost_microusd"] == 12_000
    assert journal.failures[0]["effect_state"] == "completed_unretained"
    assert journal.failures[0]["remote_outcome_unknown"] is False
    assert journal.completed == []


def test_successful_search_with_invalid_json_is_completed_unretained():
    journal = Journal()
    provider = exa(lambda _: httpx.Response(200, content=b"not-json"), journal)
    with pytest.raises(SourcesQLError):
        provider.search(["public question"], {}, Budget())
    assert provider.events[0]["status"] == "completed_validation_failed"
    assert journal.failures[0]["effect_state"] == "completed_unretained"
    assert journal.failures[0]["remote_outcome_unknown"] is False


@pytest.mark.parametrize("status", [402, 429])
def test_semantic_http_refusal_is_known_and_does_not_retry(status):
    calls = []

    def refuse(*args):
        calls.append(1)
        raise ModelHTTPError(status, "synthetic-model", {"message": "PRIVATE-DETAIL"})

    provider = PydanticSemanticProvider(FunctionModel(refuse), retries=2)
    outcome = provider.semantic("SEM_EXTRACT", "source", "entity", {}, {}, Budget())
    failure = outcome.usage["failure"]
    assert len(calls) == 1 and provider.events[0]["status"] == "failed"
    assert failure["effect_state"] == "rejected" and failure["remote_outcome_unknown"] is False
    assert "PRIVATE" not in json.dumps({"usage": outcome.usage, "events": provider.events})


def test_semantic_accounting_failure_keeps_completed_usage_and_proof():
    def model(_messages, info):
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"value": None, "status": "not_stated", "support": []},
                )
            ],
            usage=RequestUsage(input_tokens=12, output_tokens=8),
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    with pytest.raises(SourcesQLError) as caught:
        provider.semantic(
            "SEM_EXTRACT", "source", "entity", {}, {}, Budget({"max_input_tokens": 1})
        )
    assert caught.value.code == "budget_exhausted"
    assert caught.value.effect_state == "completed_unretained"
    assert provider.events[0]["status"] == "completed_validation_failed"
    assert provider.events[0]["usage"]["input_tokens"] == 12
    assert provider.events[0]["usage"]["output_tokens"] == 8


@pytest.mark.parametrize(
    "cause,expected",
    [
        ("allowance", "not_dispatched"),
        ("refused", "rejected"),
        ("transport", "outcome_unknown"),
        ("invalid_vectors", "completed_unretained"),
        ("invalid_json", "completed_unretained"),
    ],
)
def test_embedding_callback_carries_response_certainty_without_retries(cause, expected):
    calls, failures = [], []

    def respond(request):
        calls.append(request)
        if cause == "refused":
            return httpx.Response(429, json={})
        if cause == "transport":
            raise httpx.ReadTimeout("PRIVATE-DETAIL", request=request)
        if cause == "invalid_json":
            return httpx.Response(200, content=b"invalid-json")
        return httpx.Response(200, json={"data": [], "usage": {"total_tokens": 7}})

    provider = OpenAIEmbeddingProvider(
        "text-embedding-3-small", "synthetic", httpx.Client(transport=httpx.MockTransport(respond))
    )
    budget = Budget({"max_model_requests": 0} if cause == "allowance" else {})
    options = {"on_score_batch_failed": lambda indices, failure: failures.append(failure)}
    if cause == "allowance":
        with pytest.raises(SourcesQLError):
            provider.score_many(["source"], "criterion", options, budget)
    else:
        provider.score_many(["source"], "criterion", options, budget)
    assert len(failures) == 1 and failures[0]["effect_state"] == expected
    assert failures[0]["remote_outcome_unknown"] is (cause == "transport")
    assert len(calls) == (0 if cause == "allowance" else 1)
    if cause == "invalid_vectors":
        assert provider.events[0]["usage"]["input_tokens"] == 7


def test_embedding_retention_failure_preserves_completed_event_and_usage():
    failures = []

    def respond(request):
        count = len(json.loads(request.content)["input"])
        return httpx.Response(
            200,
            json={
                "data": [{"index": i, "embedding": [1.0, 0.0]} for i in range(count)],
                "usage": {"total_tokens": 7},
            },
        )

    def cannot_save(*args):
        raise SourcesQLError("budget_exhausted", "Synthetic result quota")

    provider = OpenAIEmbeddingProvider(
        "text-embedding-3-small", "synthetic", httpx.Client(transport=httpx.MockTransport(respond))
    )
    with pytest.raises(SourcesQLError, match="Synthetic result quota"):
        provider.score_many(
            ["source"],
            "criterion",
            {
                "on_completed_score": cannot_save,
                "on_score_batch_failed": lambda *args: failures.append(args),
            },
            Budget(),
        )
    assert len(provider.events) == 1 and provider.events[0]["status"] == "completed"
    assert provider.events[0]["usage"]["input_tokens"] == 7 and failures == []
