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
