"""Provider refusals retain routing facts without leaking provider error bodies."""

import json
import socket

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers.common import read_response
from sourcesql.providers.search import BraveProvider, ExaProvider, SerperProvider


def provider(kind, response):
    calls = []

    def reply(request):
        calls.append(request)
        return response

    client = httpx.Client(transport=httpx.MockTransport(reply), trust_env=False)
    factory = {"exa": ExaProvider, "brave": BraveProvider, "serper": SerperProvider}[kind]
    return factory("synthetic", client=client), calls


@pytest.mark.parametrize("kind", ["exa", "brave", "serper"])
@pytest.mark.parametrize("status,limit_kind", [(402, "unknown"), (429, "rate")])
def test_known_provider_refusals_remain_distinct_from_free_allowance(kind, status, limit_kind):
    adapter, calls = provider(
        kind, httpx.Response(status, headers={"Retry-After": "17"}, json={"error": "PRIVATE-BODY"})
    )
    budget = Budget({"max_search_queries": 1, "max_search_requests": 1})
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, budget)
    assert len(calls) == 1
    capacity = failed.value.provider_capacity
    assert capacity == {
        "resource": "search_model_budget",
        "reason": "provider_limit",
        "period": "unknown",
        "allowance": "unknown",
        "services": [kind],
        "limit_kind": limit_kind,
        "http_status": status,
        "retry_after_seconds": 17,
    }
    assert adapter.events[0]["provider_capacity"] == capacity
    assert adapter.events[0]["http_status"] == status
    assert adapter.events[0]["status"] == "failed"
    assert "PRIVATE" not in json.dumps(adapter.events)
    assert "PRIVATE" not in str(failed.value)


@pytest.mark.parametrize(
    "tag,limit_kind",
    [
        ("NO_MORE_CREDITS", "credits"),
        ("API_KEY_BUDGET_EXCEEDED", "spend"),
        ("TEAM_BUDGET_EXCEEDED", "spend"),
    ],
)
def test_exa_retains_only_documented_billing_tags_and_bounded_request_ids(tag, limit_kind):
    request_id = "67207943fab9832d162b5317f4cca830"
    adapter, calls = provider(
        "exa",
        httpx.Response(
            402,
            json={
                "tag": tag,
                "requestId": request_id,
                "error": "PRIVATE-MESSAGE",
                "other": "PRIVATE",
            },
        ),
    )
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    event = adapter.events[0]
    assert len(calls) == 1
    assert failed.value.provider_capacity["limit_kind"] == limit_kind
    assert failed.value.provider_capacity["allowance"] == "unknown"
    assert event["provider_error_tag"] == tag
    assert event["request_id"] == request_id
    assert "PRIVATE" not in json.dumps(event)


@pytest.mark.parametrize(
    "body",
    [
        {"tag": "PRIVATE-TAG", "requestId": "PRIVATE REQUEST ID", "error": "PRIVATE"},
        {"tag": ["NO_MORE_CREDITS"], "requestId": 2},
        {"tag": {"NO_MORE_CREDITS": True}},
    ],
)
def test_unknown_or_malformed_diagnostics_do_not_mask_known_http_refusal(body):
    adapter, _ = provider("exa", httpx.Response(402, json=body))
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    event = adapter.events[0]
    assert failed.value.provider_capacity["limit_kind"] == "unknown"
    assert "provider_error_tag" not in event and "request_id" not in event
    assert "PRIVATE" not in json.dumps(event)


@pytest.mark.parametrize("retry_after", ["PRIVATE", "-1", "1.5", "99999999999999", "604801"])
def test_arbitrary_or_unbounded_retry_after_is_omitted(retry_after):
    adapter, _ = provider("exa", httpx.Response(429, headers={"Retry-After": retry_after}))
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    assert "retry_after_seconds" not in failed.value.provider_capacity
    assert "retry_after_seconds" not in adapter.events[0]


@pytest.mark.parametrize("status", [400, 401, 403, 503, 504])
def test_other_http_errors_are_not_labeled_account_capacity_or_retried(status):
    adapter, calls = provider("exa", httpx.Response(status, json={"tag": "SERVICE_OVERLOADED"}))
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    assert len(calls) == 1
    assert not hasattr(failed.value, "provider_capacity")
    assert "provider_capacity" not in adapter.events[0]


def test_oversized_error_body_is_not_retained_and_does_not_hide_402():
    adapter, _ = provider("exa", httpx.Response(402, content=b"PRIVATE" * 5000))
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    assert failed.value.provider_capacity["limit_kind"] == "unknown"
    assert "PRIVATE" not in json.dumps(adapter.events)


def test_deeply_nested_diagnostics_do_not_hide_known_http_refusal():
    adapter, _ = provider("exa", httpx.Response(402, content=b"{" + b'"x":{' * 1500 + b"}" * 1501))
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    assert failed.value.provider_capacity["limit_kind"] == "unknown"


def test_generic_source_http_refusal_is_not_provider_account_capacity():
    with pytest.raises(SourcesQLError) as failed:
        read_response(httpx.Response(402, json={"tag": "NO_MORE_CREDITS"}), 2000)
    assert failed.value.http_status == 402
    assert not hasattr(failed.value, "provider_capacity")


def test_exa_url_failure_inside_successful_contents_response_is_not_account_capacity():
    adapter, calls = provider(
        "exa",
        httpx.Response(
            200,
            json={
                "requestId": "synthetic",
                "results": [],
                "statuses": [
                    {
                        "id": "https://public.example/doc",
                        "status": "error",
                        "error": {"tag": "CRAWL_HTTP_402", "httpStatusCode": 402},
                    }
                ],
            },
        ),
    )
    adapter.resolver = lambda host, port, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))
    ]
    rows = adapter.fetch(["https://public.example/doc"], {}, Budget())
    assert rows[0]["status"] == "fetch_failed"
    assert len(calls) == 1
    assert "provider_capacity" not in adapter.events[0]


def test_transport_timeout_has_unknown_remote_outcome_and_no_capacity_guess():
    calls = []

    def reply(request):
        calls.append(request)
        raise httpx.ReadTimeout("PRIVATE", request=request)

    adapter = ExaProvider("synthetic", client=httpx.Client(transport=httpx.MockTransport(reply)))
    with pytest.raises(SourcesQLError) as failed:
        adapter.search(["test query"], {}, Budget())
    assert len(calls) == 1
    assert failed.value.remote_outcome_unknown is True
    assert adapter.events[0]["status"] == "remote_outcome_unknown"
    assert "provider_capacity" not in adapter.events[0]
