"""Bound model output before dispatch and retain safe failure/settlement distinctions."""

import asyncio
import json

import httpx
import pytest
from pydantic import ValidationError
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers.semantic import PydanticSemanticProvider, output_schema


@pytest.mark.parametrize("fields", [{}, {"name": "entity name"}])
@pytest.mark.parametrize("options,maximum", [({}, 8), ({"max_items": 2}, 2), ({"max_items": 0}, 0)])
def test_all_output_schema_has_the_exact_configured_item_bound(fields, options, maximum):
    schema = output_schema("SEM_EXTRACT_ALL", fields, options)
    variants = schema.model_json_schema()["properties"]["value"]["anyOf"]
    assert next(v for v in variants if v["type"] == "array")["maxItems"] == maximum
    item = {"name": "synthetic"} if fields else "synthetic"
    schema.model_validate({"value": [item] * maximum, "status": "supported_text", "support": []})
    with pytest.raises(ValidationError):
        schema.model_validate(
            {"value": [item] * (maximum + 1), "status": "supported_text", "support": []}
        )


@pytest.mark.parametrize("maximum", [-1, 9, True, "2"])
def test_invalid_all_limit_is_refused_before_model_dispatch(maximum):
    provider = PydanticSemanticProvider(FunctionModel(lambda *_: pytest.fail("unexpected model")))
    budget = Budget()
    with pytest.raises(SourcesQLError) as error:
        provider.semantic(
            "SEM_EXTRACT_ALL", "source", "entities", {}, {"max_items": maximum}, budget
        )
    assert error.value.code == "invalid_request"
    assert provider.events == [] and budget.counts == {}


def test_all_model_prompt_and_schema_share_the_bound_and_oversized_output_is_invalid():
    calls = []

    def model(messages, info):
        calls.append(messages)
        instructions = info.instructions or ""
        assert "SEM_EXTRACT_ALL must return at most 2 items" in instructions
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {"value": ["one", "two", "three"], "status": "supported_text", "support": []},
                )
            ],
            usage=RequestUsage(input_tokens=12, output_tokens=8),
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    budget = Budget()
    outcome = provider.semantic(
        "SEM_EXTRACT_ALL", "one two three", "entities", {}, {"max_items": 2}, budget
    )
    assert outcome.value is None and outcome.status == "invalid_output"
    assert outcome.usage["validation_error"]["code"] == "invalid_output"
    assert outcome.usage["failure"]["error_type"] == "schema"
    assert outcome.usage["failure"]["remote_outcome_unknown"] is False
    assert budget.counts == {"model_requests": 1, "input_tokens": 12, "output_tokens": 8}
    assert len(calls) == 1 and provider.events[0]["status"] == "completed_validation_failed"


@pytest.mark.parametrize(
    "kind,code",
    [
        ("timeout", "provider_timeout"),
        ("connection", "provider_connection_error"),
        ("http", "provider_http_error"),
        ("unknown", "provider_error"),
    ],
)
def test_failed_model_calls_have_safe_taxonomy_without_retry_or_settlement_loss(kind, code):
    secret = "synthetic-credential-DO-NOT-EXPOSE"
    request = httpx.Request("POST", "https://private.example/?key=" + secret)
    errors = {
        "timeout": httpx.ReadTimeout(secret, request=request),
        "connection": httpx.ConnectError(secret, request=request),
        "http": ModelHTTPError(429, "synthetic-model", {"secret": secret}),
        "unknown": RuntimeError(secret),
    }
    calls = []

    def model(*_):
        calls.append(1)
        raise errors[kind]

    provider = PydanticSemanticProvider(FunctionModel(model), retries=2)
    budget = Budget({"max_model_requests": 3})
    outcome = provider.semantic("SEM_EXTRACT", "source", "entity", {}, {}, budget)
    assert outcome.value is None and outcome.status == "failed"
    assert outcome.usage["failure"]["code"] == code
    assert outcome.usage["failure"]["error_type"] == kind
    assert outcome.usage["failure"]["remote_outcome_unknown"] is (kind != "http")
    assert outcome.usage["failure"]["retryable"] is False
    assert provider.events[0]["status"] == (
        "failed" if kind == "http" else "remote_outcome_unknown"
    )
    assert provider.events[0]["error_code"] == code
    assert len(calls) == budget.counts["model_requests"] == 1
    serialized = json.dumps({"usage": outcome.usage, "events": provider.events})
    assert secret not in serialized and "private.example" not in serialized
    if kind == "http":
        assert outcome.usage["failure"]["http_status"] == 429


@pytest.mark.parametrize("kind", ["timeout", "connection"])
def test_native_openai_wrapped_transport_failure_is_classified_without_sdk_retry(monkeypatch, kind):
    calls = []

    def transport(request):
        calls.append(request)
        error = httpx.ReadTimeout if kind == "timeout" else httpx.ConnectError
        raise error("synthetic private transport detail", request=request)

    monkeypatch.setattr(
        "openai.DefaultAsyncHttpxClient",
        lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(transport), **kwargs),
    )
    provider = PydanticSemanticProvider.openai("synthetic-model", "synthetic-key", retries=2)
    try:
        budget = Budget({"max_model_requests": 3})
        outcome = provider.semantic("SEM_EXTRACT", "source", "entity", {}, {}, budget)
        assert outcome.status == "failed"
        assert outcome.usage["failure"]["code"] == (
            "provider_timeout" if kind == "timeout" else "provider_connection_error"
        )
        assert outcome.usage["failure"]["remote_outcome_unknown"] is True
        assert len(calls) == budget.counts["model_requests"] == 1
        assert "private transport detail" not in json.dumps(outcome.usage)
    finally:
        asyncio.run(provider.model.client.close())


def test_duplicate_output_json_keeps_schema_diagnostic_and_completed_usage():
    def model(_messages, info):
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    '{"value":true,"value":false,"status":"processed","support":[]}',
                )
            ],
            usage=RequestUsage(input_tokens=9, output_tokens=4),
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    outcome = provider.semantic("SEM_MATCH", "source", "entity", {}, {}, Budget())
    assert outcome.status == "invalid_output" and outcome.value is None
    assert outcome.usage["validation_error"]["code"] == "invalid_output"
    assert outcome.usage["input_tokens"] == 9 and outcome.usage["output_tokens"] == 4
    assert provider.events[0]["status"] == "completed_validation_failed"
    assert provider.events[0]["error_code"] == "invalid_output"
    assert provider.events[0]["error_type"] == "schema"


@pytest.mark.parametrize(
    "bad_support",
    [
        [],
        [{"field": "status", "quote": "Invented status"}],
        [{"field": "status", "quote": "pending"}],
    ],
)
def test_named_extraction_retains_cited_sibling_when_one_field_has_invalid_support(bad_support):
    calls = []

    def model(_messages, info):
        calls.append(1)
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": {"name": "Aurora", "status": "pending"},
                        "status": "supported_text",
                        "support": [{"field": "name", "quote": "Aurora Campus"}, *bad_support],
                    },
                )
            ],
            usage=RequestUsage(input_tokens=12, output_tokens=8),
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    budget = Budget()
    outcome = provider.semantic(
        "SEM_EXTRACT",
        "Aurora Campus is pending; status remains pending.",
        "facts",
        {"name": "campus name", "status": "grid status"},
        {},
        budget,
    )
    assert outcome.value == {"name": "Aurora", "status": None}
    assert outcome.status == "supported_text"
    assert [(span["field"], span["quote"]) for span in outcome.support] == [
        ("name", "Aurora Campus")
    ]
    assert outcome.usage["field_errors"][0]["field"] == "status"
    assert outcome.usage["field_errors"][0]["code"] == "evidence_invalid"
    assert len(calls) == budget.counts["model_requests"] == 1
    assert outcome.usage["input_tokens"] == 12 and outcome.usage["output_tokens"] == 8


def test_named_extraction_null_is_unstated_not_a_failed_sibling():
    def model(_messages, info):
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": {"name": "Aurora", "status": None},
                        "status": "supported_text",
                        "support": [{"field": "name", "quote": "Aurora Campus"}],
                    },
                )
            ]
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    outcome = provider.semantic(
        "SEM_EXTRACT", "Aurora Campus", "facts", {"name": "name", "status": "status"}, {}, Budget()
    )
    assert outcome.value == {"name": "Aurora", "status": None}
    assert "field_errors" not in outcome.usage


def test_named_extraction_all_invalid_stays_unavailable_instead_of_claiming_not_stated():
    def model(_messages, info):
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": {"name": "Invented", "status": "pending"},
                        "status": "supported_text",
                        "support": [],
                    },
                )
            ]
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    outcome = provider.semantic(
        "SEM_EXTRACT", "source", "facts", {"name": "name", "status": "status"}, {}, Budget()
    )
    assert outcome.value is None and outcome.status == "evidence_invalid"
    assert {e["field"] for e in outcome.usage["field_errors"]} == {"name", "status"}
    assert not outcome.support and len(provider.events) == 1


def all_fixture(value, support, *, fields=None, status="supported_text", options=None, text=None):
    calls = []

    def model(_messages, info):
        calls.append(1)
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": value,
                        "status": status,
                        "support": support,
                    },
                )
            ],
            usage=RequestUsage(input_tokens=20, output_tokens=10),
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    budget = Budget()
    outcome = provider.semantic(
        "SEM_EXTRACT_ALL",
        text or "Aurora Campus is proposed; Birch Campus is operating. proposed remains tentative.",
        "stated entities",
        fields or {},
        options or {},
        budget,
    )
    assert len(calls) == budget.counts["model_requests"] == 1
    return outcome, provider


@pytest.mark.parametrize(
    "bad_support",
    [
        [],
        [{"item": 0, "field": "status", "quote": "Invented status"}],
        [{"item": 0, "field": "status", "quote": "proposed"}],
    ],
)
def test_all_preserves_two_entities_and_independent_fields_when_one_quote_fails(bad_support):
    fields = {"name": "campus name", "status": "grid status"}
    outcome, _ = all_fixture(
        [
            {"name": "Aurora Campus", "status": "proposed"},
            {"name": "Birch Campus", "status": "operating"},
        ],
        [
            {"item": 0, "field": "name", "quote": "Aurora Campus"},
            {"item": 1, "field": "name", "quote": "Birch Campus"},
            {"item": 1, "field": "status", "quote": "is operating"},
            *bad_support,
        ],
        fields=fields,
    )
    assert outcome.value == [
        {"name": "Aurora Campus", "status": None},
        {"name": "Birch Campus", "status": "operating"},
    ]
    assert outcome.status == "processed"
    assert [(span["item"], span["field"]) for span in outcome.support] == [
        (0, "name"),
        (1, "name"),
        (1, "status"),
    ]
    assert outcome.usage["field_errors"] == [
        {
            "item": 0,
            "field": "status",
            "code": "evidence_invalid",
            "message": outcome.usage["field_errors"][0]["message"],
        }
    ]
    assert outcome.usage["requests"] == 1


@pytest.mark.parametrize("item", [None, -1, 0, 8])
def test_all_quotes_with_missing_or_other_item_index_cannot_support_the_second_entity(item):
    outcome, _ = all_fixture(
        [{"name": None}, {"name": "Birch Campus"}],
        [
            {
                "field": "name",
                "quote": "Birch Campus",
                **({"item": item} if item is not None else {}),
            }
        ],
        fields={"name": "campus name"},
    )
    assert outcome.value == [{"name": None}, {"name": None}]
    assert outcome.status == "evidence_invalid" and outcome.support == []
    assert outcome.usage["field_errors"][0]["item"] == 1


def test_all_legitimate_null_cell_does_not_borrow_another_field_or_create_an_error():
    outcome, _ = all_fixture(
        [
            {"name": "Aurora Campus", "status": None},
            {"name": "Birch Campus", "status": "operating"},
        ],
        [
            {"item": 0, "field": "name", "quote": "Aurora Campus"},
            {"item": 1, "field": "name", "quote": "Birch Campus"},
            {"item": 1, "field": "status", "quote": "is operating"},
        ],
        fields={"name": "campus name", "status": "grid status"},
    )
    assert outcome.value[0]["status"] is None and "field_errors" not in outcome.usage
    assert outcome.status == "supported_text"
    assert [(s["item"], s["field"]) for s in outcome.support] == [
        (0, "name"),
        (1, "name"),
        (1, "status"),
    ]


@pytest.mark.parametrize("status", ["not_stated", "no_match"])
def test_all_declared_null_items_preserve_unstated_semantics_without_errors(status):
    values = [{"name": None}, {"name": None}]
    outcome, _ = all_fixture(values, [], fields={"name": "campus name"}, status=status)
    assert outcome.value == values and outcome.status == status
    assert "field_errors" not in outcome.usage and not outcome.support


def test_all_invalid_named_items_keep_null_shape_and_unavailable_noncached_status():
    outcome, _ = all_fixture(
        [{"name": "Aurora", "status": "invented"}, {"name": "Birch", "status": "invented"}],
        [],
        fields={"name": "name", "status": "status"},
    )
    assert outcome.value == [{"name": None, "status": None}, {"name": None, "status": None}]
    assert outcome.status == "evidence_invalid"
    assert len(outcome.usage["field_errors"]) == 4 and not outcome.support
    assert outcome.status not in {
        "supported_text",
        "processed",
        "not_stated",
        "unknown",
        "no_match",
    }


def test_scalar_all_null_slots_keep_item_positions_and_the_typed_array_contract():
    from sourcesql.engine import validate_table

    outcome, _ = all_fixture(
        ["Aurora", "Birch", "Cedar"],
        [{"item": 1, "quote": "Birch"}, {"item": 2, "quote": "Cedar"}],
        text="Aurora Birch Cedar",
    )
    assert outcome.value == [None, "Birch", "Cedar"] and outcome.status == "processed"
    assert [span["item"] for span in outcome.support] == [1, 2]
    assert outcome.usage["field_errors"][0]["item"] == 0
    table = validate_table(
        [{"key": "names", "logical_type": "VARCHAR[]"}], [{"names": outcome.value}]
    )
    assert table.rows == [{"names": [None, "Birch", "Cedar"]}]


def test_all_bound_or_global_schema_failure_never_becomes_recovered_placeholder_rows():
    for values in [["name"] * 9, [5]]:
        outcome, _ = all_fixture(values, [])
        assert outcome.value is None and outcome.status == "invalid_output"
        assert "field_errors" not in outcome.usage
    unknown, _ = all_fixture(None, [], status="unknown")
    assert unknown.value is None and unknown.status == "unknown"
    empty, _ = all_fixture([], [], status="no_match")
    assert empty.value == [] and empty.status == "no_match" and "field_errors" not in empty.usage
