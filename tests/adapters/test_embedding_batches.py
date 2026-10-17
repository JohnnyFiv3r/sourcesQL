"""Scoring batches preserve row identity, budgets and unresolved outcomes."""

import json
from time import monotonic

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers.semantic import OpenAIEmbeddingProvider
from sourcesql.providers.tokenization import get_embedding_tokenizer


def tokens(*texts):
    encoder = get_embedding_tokenizer("text-embedding-3-small")
    return sum(len(encoder.encode_ordinary(text)) for text in texts)


def provider(handler):
    return OpenAIEmbeddingProvider(
        "text-embedding-3-small",
        "not-a-live-key",
        httpx.Client(transport=httpx.MockTransport(handler)),
    )


def vectors_response(request, vectors=None, tokens=7):
    inputs = json.loads(request.content)["input"]
    vectors = vectors or [[1.0, 0.0] for _ in inputs]
    return httpx.Response(
        200,
        json={
            "data": [
                {"index": i, "embedding": vector}
                for i, vector in reversed(list(enumerate(vectors)))
            ],
            "usage": {"total_tokens": tokens},
        },
    )


def test_batch_deduplicates_and_maps_out_of_order_vectors_to_every_original_row():
    requests = []

    def reply(request):
        inputs = json.loads(request.content)["input"]
        requests.append(inputs)
        assert inputs == ["alpha", "beta", "criterion"]
        return vectors_response(request, [[1, 0], [-1, 0], [1, 0]])

    scorer, budget = provider(reply), Budget()
    outcomes = scorer.score_many(["alpha", "beta", "alpha", None], "criterion", {}, budget)
    assert requests == [["alpha", "beta", "criterion"]]
    assert [o.value for o in outcomes] == [1.0, -1.0, 1.0, None]
    assert [o.status for o in outcomes] == ["processed"] * 3 + ["unprocessed"]
    assert sum(o.usage["requests"] for o in outcomes) == 1
    assert sum(o.usage["input_tokens"] for o in outcomes) == 7
    reserved = tokens("alpha", "beta", "criterion")
    assert sum(o.usage["reserved_input_tokens"] for o in outcomes) == reserved
    assert budget.counts == {"input_tokens": reserved, "model_requests": 1}
    assert scorer.events[-1]["usage"] == {"requests": 1, "input_tokens": 7}


def test_scalar_api_keeps_request_order_and_reuses_cached_inputs_for_new_criterion():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        return vectors_response(request)

    scorer = provider(reply)
    scorer.score("source", "criterion", {}, Budget())
    assert scorer.score("source", "criterion", {}, Budget()).usage["embedding_cache_hit"]
    new_criterion = scorer.score("source", "different", {}, Budget())
    assert new_criterion.value == 1
    assert requests == [["source", "criterion"], ["different"]]
    assert new_criterion.usage["requests"] == 1
    assert any(event["kind"] == "embedding_cache" for event in scorer.events)


def test_exact_bounded_input_cache_is_scoped_by_model_and_endpoint():
    requests = []

    def reply(request):
        requests.append((str(request.url), json.loads(request.content)))
        return vectors_response(request)

    scorer = provider(reply)
    first = scorer.score("abcdef", "criterion", {"window_chars": 3}, Budget())
    second = scorer.score("abcXYZ", "criterion", {"window_chars": 3}, Budget())
    assert second.usage["embedding_cache_hit"] and second.usage["requests"] == 0
    assert first.usage["content_sha256"] != second.usage["content_sha256"]
    assert second.usage["input_omitted_characters"] == 3
    scorer.model = "text-embedding-3-large"
    scorer.score("abcdef", "criterion", {"window_chars": 3}, Budget())
    scorer.endpoint = "https://embedding.example/v1/embeddings"
    scorer.score("abcdef", "criterion", {"window_chars": 3}, Budget())
    assert len(requests) == 3


def test_multiple_batches_embed_shared_criterion_once_and_charge_each_request_once():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        return vectors_response(request)

    scorer, budget = provider(reply), Budget()
    scorer.MAX_BATCH_INPUTS = 3
    outcomes = scorer.score_many(["a", "b", "c", "d", "e"], "criterion", {}, budget)
    assert requests == [["a", "b", "criterion"], ["c", "d", "e"]]
    assert all(o.status == "processed" for o in outcomes)
    assert sum(o.usage["requests"] for o in outcomes) == 2
    assert sum(o.usage["input_tokens"] for o in outcomes) == 14
    assert budget.counts["model_requests"] == 2


def test_exact_batch_token_cap_splits_below_input_count_limit():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        return vectors_response(request)

    scorer = provider(reply)
    scorer.MAX_BATCH_TOKENS = 2
    outcomes = scorer.score_many(["a", "b", "c"], "key", {}, Budget())
    assert requests == [["a", "key"], ["b", "c"]]
    assert all(o.status == "processed" for o in outcomes)


def test_one_overlong_input_is_unprocessed_without_silently_truncating_other_rows():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        return vectors_response(request)

    scorer = provider(reply)
    outcomes = scorer.score_many(["é" * 8193, "valid"], "criterion", {}, Budget())
    assert outcomes[0].status == "unprocessed" and outcomes[0].value is None
    assert outcomes[0].usage["reason"] == "embedding_input_limit"
    assert "substr(content, 1, n)" in outcomes[0].usage["failure"]["message"]
    assert outcomes[0].usage["input_omitted_characters"] == 0
    assert outcomes[1].status == "processed"
    assert requests == [["valid", "criterion"]]


@pytest.mark.parametrize("criterion", [None, "", " " * 3, "é" * 8193])
def test_invalid_criterion_never_dispatches(criterion):
    scorer = provider(lambda _: pytest.fail("unexpected dispatch"))
    outcomes = scorer.score_many(["alpha", "beta"], criterion, {}, Budget())
    assert all(o.status == "unprocessed" and o.value is None for o in outcomes)


def test_same_source_and_criterion_needs_only_one_vector():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        return vectors_response(request)

    outcome = provider(reply).score("same", "same", {}, Budget())
    assert requests == [["same"]]
    assert outcome.value == 1


@pytest.mark.parametrize(
    "data",
    [
        [{"index": 0, "embedding": [1, 0]}, {"index": 0, "embedding": [1, 0]}],
        [{"index": True, "embedding": [1, 0]}, {"index": 0, "embedding": [1, 0]}],
        [{"index": 2, "embedding": [1, 0]}, {"index": 0, "embedding": [1, 0]}],
        [{"index": 0, "embedding": [1, 0]}, {"index": 1, "embedding": [1]}],
        [{"index": 0, "embedding": [1, 0]}, {"index": 1, "embedding": [0, 0]}],
        [{"index": 0, "embedding": [1, 0]}, {"index": 1, "embedding": [True, 0]}],
        [{"index": 0, "embedding": [1, 0]}],
        "invalid",
    ],
)
def test_malformed_batch_is_not_scored_or_cached(data):
    scorer = provider(lambda _: httpx.Response(200, json={"data": data}))
    outcome = scorer.score("source", "criterion", {}, Budget())
    assert outcome.value is None and outcome.status == "invalid_output"
    assert scorer._vectors == {}
    assert len(scorer.events) == 1
    assert outcome.usage["requests"] == 1


def test_successful_earlier_batch_survives_later_transport_failure_without_retry():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        if len(requests) == 2:
            raise httpx.ReadTimeout("private details must not escape")
        return vectors_response(request)

    scorer = provider(reply)
    scorer.MAX_BATCH_INPUTS = 3
    outcomes = scorer.score_many(list("abcdef"), "criterion", {}, Budget())
    assert len(requests) == 2
    assert [o.status for o in outcomes] == [
        "processed",
        "processed",
        "failed",
        "failed",
        "failed",
        "unprocessed",
    ]
    assert all(o.value is None for o in outcomes[2:])
    assert outcomes[2].usage["failure"]["remote_outcome_unknown"]
    assert outcomes[-1].usage["reason"] == "embedding_batch_interrupted"
    assert "private details" not in str(outcomes)
    assert sum(o.usage["requests"] for o in outcomes) == 2


def test_reserves_exact_tokens_before_dispatch_without_second_charge():
    budget = Budget()

    def reply(request):
        assert budget.counts == {"input_tokens": tokens("source", "criterion"), "model_requests": 1}
        return vectors_response(request, tokens=3)

    outcome = provider(reply).score("source", "criterion", {}, budget)
    assert outcome.usage["input_tokens"] == 3
    assert budget.counts["input_tokens"] == tokens("source", "criterion")


def test_insufficient_input_allowance_prevents_any_request_reservation_or_dispatch():
    budget = Budget({"max_input_tokens": 1})
    scorer = provider(lambda _: pytest.fail("unexpected dispatch"))
    with pytest.raises(SourcesQLError) as error:
        scorer.score("source", "criterion", {}, budget)
    assert error.value.code == "budget_exhausted"
    assert budget.counts == {} and scorer.events == []


def test_expired_deadline_prevents_dispatch_and_remaining_time_caps_http_timeout():
    scorer = provider(lambda _: pytest.fail("unexpected dispatch"))
    budget = Budget()
    with pytest.raises(SourcesQLError) as error:
        scorer.score("source", "criterion", {"deadline_monotonic": monotonic() - 1}, budget)
    assert error.value.code == "budget_exhausted"
    assert budget.counts == {}

    def reply(request):
        assert 0 < request.extensions["timeout"]["read"] <= 2
        return vectors_response(request)

    outcome = provider(reply).score(
        "source", "criterion", {"deadline_monotonic": monotonic() + 2}, Budget()
    )
    assert outcome.status == "processed"


def test_nonfinite_json_response_is_invalid_and_not_cached():
    scorer = provider(lambda _: httpx.Response(200, content=b'{"data":[NaN]}'))
    outcome = scorer.score("source", "criterion", {}, Budget())
    assert outcome.status == "invalid_output" and outcome.value is None
    assert scorer.events[-1]["status"] == "invalid_output"
    assert scorer._vectors == {}


def test_new_criterion_dimensions_must_match_already_cached_documents():
    requests = []

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        if len(requests) == 1:
            return vectors_response(request)
        return vectors_response(request, [[1, 0, 0]])

    scorer = provider(reply)
    scorer.score("source", "criterion", {}, Budget())
    outcome = scorer.score("source", "new criterion", {}, Budget())
    assert outcome.status == "invalid_output" and outcome.value is None
    assert scorer._cache_key("new criterion") not in scorer._vectors


def test_trusted_cancellation_check_stops_before_next_batch_reservation():
    requests, checks = [], []
    budget = Budget()

    def check_active():
        checks.append(True)
        if len(checks) == 2:
            raise SourcesQLError("cancelled", "Run cancelled", "dispatch")

    def reply(request):
        requests.append(json.loads(request.content)["input"])
        return vectors_response(request)

    scorer = provider(reply)
    scorer.MAX_BATCH_INPUTS = 3
    with pytest.raises(SourcesQLError) as error:
        scorer.score_many(list("abcde"), "criterion", {"check_active": check_active}, budget)
    assert error.value.code == "cancelled"
    assert requests == [["a", "b", "criterion"]]
    assert budget.counts == {"input_tokens": tokens("a", "b", "criterion"), "model_requests": 1}
    assert len(scorer.events) == 1 and scorer.events[0]["status"] == "completed"


@pytest.mark.parametrize(
    "text",
    [
        "research findings " * 1500 + "distinct final finding",
        "é" * 5000,
        "<|endoftext|> retained source text <|fim_prefix|>" * 200,
    ],
)
def test_full_valid_sources_over_old_byte_and_character_limits_are_scored(text):
    assert len(text.encode("utf-8")) > 8192
    assert tokens(text) <= 8192

    def reply(request):
        assert json.loads(request.content)["input"] == [text, "criterion"]
        return vectors_response(request)

    budget = Budget({"max_input_tokens": tokens(text, "criterion")})
    outcome = provider(reply).score(text, "criterion", {}, budget)
    assert outcome.status == "processed"
    assert outcome.usage["inspected_tokens"] == tokens(text)
    assert outcome.usage["input_omitted_characters"] == 0
    assert outcome.usage["token_encoding"] == "cl100k_base"
    assert budget.counts["input_tokens"] == tokens(text, "criterion")


def test_actual_token_boundary_preserves_valid_row_and_refuses_only_oversized_row():
    valid, oversized = "é" * 8192, "é" * 8193
    assert tokens(valid) == 8192 and tokens(oversized) == 8193

    def reply(request):
        assert json.loads(request.content)["input"] == [valid, "criterion"]
        return vectors_response(request)

    outcomes = provider(reply).score_many([valid, oversized], "criterion", {}, Budget())
    assert outcomes[0].status == "processed"
    assert outcomes[1].value is None and outcomes[1].status == "unprocessed"
    assert outcomes[1].usage["reason"] == "embedding_input_limit"


def test_large_request_is_packed_by_real_tokens_not_byte_length():
    requests = []
    texts = ["é" * 8100 + str(i) for i in range(18)]
    expected = tokens(*texts, "criterion")

    def reply(request):
        values = json.loads(request.content)["input"]
        requests.append(values)
        assert tokens(*values) <= 100_000
        return vectors_response(request)

    scorer = provider(reply)
    scorer.MAX_BATCH_TOKENS = 100_000
    budget = Budget({"max_input_tokens": expected})
    outcomes = scorer.score_many(texts, "criterion", {}, budget)
    assert len(requests) == 2 and all(o.status == "processed" for o in outcomes)
    assert sum("criterion" in batch for batch in requests) == 1
    assert sum(o.usage["reserved_input_tokens"] for o in outcomes) == expected
    assert budget.counts["input_tokens"] == expected
