"""Search research profiles fetch public HTML/text without an Exa dependency."""

from __future__ import annotations

import socket

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry


def profile(provider, client, resolver, **changes):
    return {
        "mode": "live",
        "provider": provider,
        "api_key": "SAFE-SYNTHETIC-KEY",
        "allow_live": True,
        "approved_cost_microusd": 50_000,
        "metering_policy": "estimated",
        "allow_public_source_hosts": True,
        "allowed_source_hosts": [],
        "fetch_client": client,
        "resolver": resolver,
        **changes,
    }


def resolve(host, port, **kwargs):
    address = "10.0.0.2" if host == "private.example" else "93.184.216.34"
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_public_grant_fetches_source_and_public_redirect_using_pinned_direct_http(provider):
    calls = []

    def reply(request):
        calls.append(request)
        assert request.url.host == "93.184.216.34"
        assert "SAFE-SYNTHETIC-KEY" not in str(request.headers)
        if request.url.path == "/start":
            assert request.headers["host"] == "source.example"
            return httpx.Response(302, headers={"location": "https://archive.example/article"})
        assert request.headers["host"] == "archive.example"
        assert request.extensions["sni_hostname"] == "archive.example"
        return httpx.Response(
            200, headers={"content-type": "text/html"}, text="<p>Capacity is 500 MW.</p>"
        )

    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        registry = ProviderRegistry(profile(provider, client, resolve))
        budget = Budget({"max_cost_microusd": 50_000, "max_fetches": 2})
        registry.preflight({"WEB_FETCH"}, budget)
        rows = registry.fetch(["https://source.example/start"], {}, budget)
    assert len(calls) == 2
    assert budget.counts["fetches"] == 2
    assert rows[0]["status"] == "acquired"
    assert rows[0]["url"] == "https://archive.example/article"
    assert rows[0]["original_url"] == "https://source.example/start"
    assert rows[0]["content"] == "Capacity is 500 MW."
    assert rows[0]["provider"] == "http"


@pytest.mark.parametrize("provider", ["brave", "serper"])
@pytest.mark.parametrize("grant", [False, "true", 1, None])
def test_empty_host_list_requires_exact_boolean_public_grant_before_dispatch(provider, grant):
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected HTTP"))
    ) as client:
        registry = ProviderRegistry(
            profile(provider, client, resolve, allow_public_source_hosts=grant)
        )
        budget = Budget({"max_cost_microusd": 50_000})
        with pytest.raises(SourcesQLError) as refused:
            registry.preflight({"WEB_FETCH"}, budget)
        assert refused.value.code == "unauthorized"
        with pytest.raises(SourcesQLError):
            registry.fetch(["https://source.example/article"], {}, budget)
        assert budget.counts == {} and registry.events == []


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_public_fetch_grant_does_not_allow_private_redirect_or_expose_provider_key(provider):
    calls = []

    def reply(request):
        calls.append(request)
        return httpx.Response(302, headers={"location": "http://private.example/metadata"})

    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        registry = ProviderRegistry(profile(provider, client, resolve))
        budget = Budget({"max_cost_microusd": 50_000, "max_fetches": 2})
        rows = registry.fetch(["https://source.example/article"], {}, budget)
    assert len(calls) == 1
    assert rows[0]["status"] == "fetch_failed"
    assert rows[0]["error_code"] == "unauthorized"
    assert rows[0]["content"] is None
    assert rows[0]["failure_reason"] == "blocked_host"
    assert budget.counts["fetches"] == 1
    assert "SAFE-SYNTHETIC-KEY" not in str(calls[0].headers)


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_explicit_host_allowlist_still_blocks_an_unapproved_public_redirect(provider):
    calls = []

    def reply(request):
        calls.append(request)
        return httpx.Response(302, headers={"location": "https://archive.example/article"})

    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        registry = ProviderRegistry(
            profile(
                provider,
                client,
                resolve,
                allow_public_source_hosts=False,
                allowed_source_hosts=["source.example"],
            )
        )
        rows = registry.fetch(
            ["https://source.example/article"], {}, Budget({"max_cost_microusd": 50_000})
        )
    assert len(calls) == 1
    assert rows[0]["error_code"] == "unauthorized"


def raising(error):
    def reply(request):
        raise error

    return reply


@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        (
            lambda _: httpx.Response(200, headers={"content-type": "application/pdf"}),
            "unsupported_type",
        ),
        (
            lambda _: httpx.Response(
                200, headers={"content-type": "text/html"}, content=b"x" * 3_000_000
            ),
            "too_large",
        ),
        (
            lambda _: httpx.Response(404, headers={"content-type": "text/html"}, text="gone"),
            "http_error",
        ),
        (
            lambda _: httpx.Response(404, headers={"content-type": "application/json"}, text="{}"),
            "http_error",
        ),
        (
            lambda _: httpx.Response(302, headers={"location": "https://source.example/a"}),
            "too_many_redirects",
        ),
        (lambda _: httpx.Response(302), "too_many_redirects"),
        (
            lambda _: httpx.Response(
                200, headers={"content-type": "text/plain; charset=utf-8"}, content=b"\xff\xfe"
            ),
            "unsupported_type",
        ),
        (raising(httpx.ReadTimeout("slow")), "timeout"),
        (raising(httpx.ConnectError("refused")), "transport_error"),
    ],
)
def test_fetch_failure_records_a_reason_code_for_each_failure_kind(reply, reason):
    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        registry = ProviderRegistry(profile("brave", client, resolve))
        rows = registry.fetch(
            ["https://source.example/a"],
            {},
            Budget({"max_cost_microusd": 50_000, "max_fetches": 9}),
        )
    assert rows[0]["status"] == "fetch_failed"
    assert rows[0]["failure_reason"] == reason


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_private_url_among_public_ones_is_a_blocked_row_and_is_never_dispatched(provider):
    hosts = []

    def reply(request):
        hosts.append(request.headers["host"])
        return httpx.Response(
            200, headers={"content-type": "text/plain"}, text="Capacity is 500 MW."
        )

    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        registry = ProviderRegistry(profile(provider, client, resolve))
        rows = registry.fetch(
            ["https://a.example/1", "https://private.example/2", "https://b.example/3"],
            {},
            Budget({"max_cost_microusd": 50_000, "max_fetches": 9}),
        )
    assert hosts == ["a.example", "b.example"]
    assert [r["status"] for r in rows] == ["acquired", "fetch_failed", "acquired"]
    assert rows[1]["url"] == "https://private.example/2"
    assert rows[1]["failure_reason"] == "blocked_host"


def test_url_outside_an_explicit_allowlist_is_a_blocked_row():
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, headers={"content-type": "text/plain"}, text="ok")
        ),
        trust_env=False,
    ) as client:
        registry = ProviderRegistry(
            profile(
                "brave",
                client,
                resolve,
                allow_public_source_hosts=False,
                allowed_source_hosts=["a.example"],
            )
        )
        rows = registry.fetch(
            ["https://a.example/1", "https://other.example/2"], {}, Budget({"max_cost_microusd": 1})
        )
    assert [r.get("failure_reason") for r in rows] == [None, "blocked_host"]
