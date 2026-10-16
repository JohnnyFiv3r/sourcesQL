"""Public Exa Contents grants never disclose private or unapproved destinations."""

from __future__ import annotations

import json
import socket

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry


def dns(addresses, observations):
    def resolve(host, port, **kwargs):
        observations.append((host, port))
        return [
            (
                socket.AF_INET6 if ":" in address else socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                (address, port),
            )
            for address in addresses
        ]

    return resolve


def profile(client, resolver, **overrides):
    return {
        "mode": "live",
        "provider": "exa",
        "api_key": "SAFE-SYNTHETIC-KEY",
        "allow_live": True,
        "approved_cost_microusd": 50_000,
        "metering_policy": "estimated",
        "http_client": client,
        "resolver": resolver,
        "fetch_adapter": "exa",
        "allowed_source_hosts": [],
        "allow_public_source_hosts": True,
        **overrides,
    }


@pytest.mark.parametrize("url", ["https://public.example/source", "http://public.example/source"])
def test_explicit_public_grant_fetches_only_validated_public_sources_through_exa(url):
    calls, resolved = [], []

    def respond(request):
        calls.append(request)
        assert str(request.url) == "https://api.exa.ai/contents"
        assert json.loads(request.content)["urls"] == [url]
        return httpx.Response(
            200,
            json={
                "results": [{"url": url, "text": "Source text with limited provider coverage."}],
                "statuses": [{"status": "success"}],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(respond), trust_env=False) as client:
        registry = ProviderRegistry(profile(client, dns(["93.184.216.34"], resolved)))
        allowance = Budget({"max_cost_microusd": 50_000, "max_fetches": 1})
        registry.preflight({"WEB_FETCH"}, allowance)
        rows = registry.fetch([url], {}, allowance)
    assert len(calls) == 1 and resolved
    assert allowance.counts["fetches"] == 1
    assert rows[0]["url"] == url
    assert rows[0]["content"] == "Source text with limited provider coverage."
    assert rows[0]["coverage"]["complete"] is False


@pytest.mark.parametrize("grant", [None, False, "true", 1])
def test_public_sources_require_the_exact_operator_grant_before_dns_or_disclosure(grant):
    resolved = []
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected dispatch"))
    ) as client:
        settings = profile(
            client, dns(["93.184.216.34"], resolved), allow_public_source_hosts=grant
        )
        if grant is None:
            del settings["allow_public_source_hosts"]
        registry = ProviderRegistry(settings)
        allowance = Budget({"max_cost_microusd": 50_000})
        for execute in [
            lambda: registry.preflight({"WEB_FETCH"}, allowance),
            lambda: registry.fetch(["https://public.example/source"], {}, allowance),
        ]:
            with pytest.raises(SourcesQLError) as error:
                execute()
            assert error.value.code == "unauthorized"
    assert resolved == [] and allowance.counts == {} and registry.events == []


@pytest.mark.parametrize(
    ("url", "addresses"),
    [
        ("https://localhost/source", ["93.184.216.34"]),
        ("https://service.localhost/source", ["93.184.216.34"]),
        ("https://service.internal/source", ["93.184.216.34"]),
        ("https://service.local/source", ["93.184.216.34"]),
        ("http://127.0.0.1/source", ["127.0.0.1"]),
        ("http://[::1]/source", ["::1"]),
        ("https://private.example/source", ["10.0.0.2"]),
        ("https://private.example/source", ["169.254.169.254"]),
        ("https://private.example/source", ["192.168.1.2"]),
        ("https://private.example/source", ["fd00::1"]),
        ("https://mixed.example/source", ["93.184.216.34", "10.0.0.2"]),
        ("https://mixed.example/source", ["2606:4700:4700::1111", "::1"]),
        ("https://public.example:8443/source", ["93.184.216.34"]),
        ("http://public.example:8080/source", ["93.184.216.34"]),
        ("https://empty.example/source", []),
    ],
)
def test_public_grant_still_refuses_private_mixed_or_nonstandard_destinations_before_dispatch(
    url, addresses
):
    resolved = []
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected disclosure"))
    ) as client:
        registry = ProviderRegistry(profile(client, dns(addresses, resolved)))
        allowance = Budget({"max_cost_microusd": 50_000})
        registry.preflight({"WEB_FETCH"}, allowance)
        with pytest.raises(SourcesQLError) as error:
            registry.fetch([url], {}, allowance)
    assert error.value.code == "unauthorized"
    assert allowance.counts == {} and registry.events == []


def test_every_url_is_authorized_before_any_batch_member_is_sent_to_exa():
    resolved = []

    def resolve(host, port, **kwargs):
        return dns(["93.184.216.34" if host == "public.example" else "10.0.0.2"], resolved)(
            host, port, **kwargs
        )

    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Partial batch disclosure"))
    ) as client:
        registry = ProviderRegistry(profile(client, resolve))
        allowance = Budget({"max_cost_microusd": 50_000})
        with pytest.raises(SourcesQLError):
            registry.fetch(
                ["https://public.example/source", "https://private.example/source"], {}, allowance
            )
    assert resolved == [("public.example", 443), ("private.example", 443)]
    assert allowance.counts == {} and registry.events == []


@pytest.mark.parametrize("source_mode", ["allow_excerpt", "require_document"])
def test_explicit_fetch_cannot_claim_complete_document_coverage(source_mode):
    def respond(request):
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "url": "https://public.example/source",
                        "text": "Only retained provider text, not verified complete.",
                    }
                ],
                "statuses": [{"status": "success"}],
            },
        )

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        registry = ProviderRegistry(profile(client, dns(["93.184.216.34"], [])))
        budget = Budget({"max_cost_microusd": 50_000, "max_fetches": 1})
        if source_mode == "require_document":
            with pytest.raises(SourcesQLError, match="complete source text"):
                registry.fetch(
                    ["https://public.example/source"], {"source_mode": source_mode}, budget
                )
        else:
            assert (
                registry.fetch(
                    ["https://public.example/source"], {"source_mode": source_mode}, budget
                )[0]["coverage"]["complete"]
                is False
            )
        assert budget.counts["fetches"] == 1
