"""Provider templates retain safe defaults and expose a usable approved fetch path."""

import json
from pathlib import Path
import socket

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.provider_rates import DEEPSEEK_REQUEST_COST_MICROUSD
from sourcesql.providers import ProviderRegistry


def deepseek_example():
    profiles = json.loads(
        (Path(__file__).resolve().parents[2] / "examples/profiles.example.json").read_text()
    )
    profile = profiles["deepseek"]
    # Retrieval tests do not configure placeholder semantic models or inspect keys.
    profile.pop("model")
    profile.pop("embedding")
    return profile


def public_dns(host, port, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))]


def test_deepseek_template_still_refuses_unapproved_live_fetch():
    profile = deepseek_example()
    assert profile["allow_public_source_hosts"] is True
    assert profile["allow_live"] is False
    assert profile["approved_cost_microusd"] == 0
    assert profile["allowed_source_hosts"] == []

    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected provider request")),
        trust_env=False,
    ) as client:
        profile.update(
            api_key="synthetic",
            http_client=client,
            resolver=lambda *args, **kwargs: pytest.fail("Unexpected DNS lookup"),
        )
        registry = ProviderRegistry(profile)
        budget = Budget({"max_cost_microusd": DEEPSEEK_REQUEST_COST_MICROUSD})
        for invoke in [
            lambda: registry.preflight({"WEB_FETCH"}, budget),
            lambda: registry.fetch(["https://official.example/article"], {}, budget),
        ]:
            with pytest.raises(SourcesQLError) as refused:
                invoke()
            assert refused.value.code == "unauthorized"
        assert budget.counts == {} and registry.events == []


@pytest.mark.parametrize("public_grant", [True, False])
def test_approved_deepseek_template_fetches_with_public_grant_or_explicit_hosts(public_grant):
    calls, lookups = [], []

    def reply(request):
        calls.append(request)
        assert request.url == "https://api.deepseek.com/v1/tools/fetch"
        assert json.loads(request.content) == {"url": "https://official.example/article"}
        assert request.headers["authorization"] == "Bearer synthetic"
        return httpx.Response(200, json={"title": "Source", "content": "Original source text."})

    def resolve(host, port, **kwargs):
        lookups.append(host)
        return public_dns(host, port, **kwargs)

    profile = deepseek_example()
    if not public_grant:
        profile.pop("allow_public_source_hosts")
        profile["allowed_source_hosts"] = ["official.example"]
    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        profile.update(
            allow_live=True,
            approved_cost_microusd=DEEPSEEK_REQUEST_COST_MICROUSD,
            api_key="synthetic",
            http_client=client,
            resolver=resolve,
        )
        registry = ProviderRegistry(profile)
        budget = Budget(
            {"max_cost_microusd": DEEPSEEK_REQUEST_COST_MICROUSD, "max_fetches": 1}
        )
        registry.preflight({"WEB_FETCH"}, budget)
        rows = registry.fetch(["https://official.example/article"], {}, budget)
    assert len(calls) == 1
    assert lookups == ["official.example"]
    assert rows[0]["url"] == "https://official.example/article"
    assert rows[0]["content"] == "Original source text."
    assert rows[0]["provider"] == "deepseek"
    assert rows[0]["coverage"]["complete"] is False
    assert budget.counts["fetches"] == 1
    assert budget.counts["estimated_provider_cost_microusd"] == DEEPSEEK_REQUEST_COST_MICROUSD


def test_deepseek_template_without_source_authorization_refuses_before_provider_http():
    profile = deepseek_example()
    profile.pop("allow_public_source_hosts")
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected provider request")),
        trust_env=False,
    ) as client:
        profile.update(
            allow_live=True,
            approved_cost_microusd=DEEPSEEK_REQUEST_COST_MICROUSD,
            api_key="synthetic",
            http_client=client,
            resolver=lambda *args, **kwargs: pytest.fail("Unexpected DNS lookup"),
        )
        registry = ProviderRegistry(profile)
        budget = Budget({"max_cost_microusd": DEEPSEEK_REQUEST_COST_MICROUSD})
        for invoke in [
            lambda: registry.preflight({"WEB_FETCH"}, budget),
            lambda: registry.fetch(["https://official.example/article"], {}, budget),
        ]:
            with pytest.raises(SourcesQLError) as refused:
                invoke()
            assert refused.value.code == "unauthorized"
        assert budget.counts == {} and registry.events == []


def test_deepseek_template_public_grant_does_not_disclose_private_source_url():
    profile = deepseek_example()
    lookups = []

    def private_dns(host, port, **kwargs):
        lookups.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.2", port))]

    with httpx.Client(
        transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected provider request")),
        trust_env=False,
    ) as client:
        profile.update(
            allow_live=True,
            approved_cost_microusd=DEEPSEEK_REQUEST_COST_MICROUSD,
            api_key="synthetic",
            http_client=client,
            resolver=private_dns,
        )
        registry = ProviderRegistry(profile)
        budget = Budget({"max_cost_microusd": DEEPSEEK_REQUEST_COST_MICROUSD})
        with pytest.raises(SourcesQLError) as refused:
            registry.fetch(["https://private.example/research"], {}, budget)
        assert refused.value.code == "unauthorized"
        assert lookups == ["private.example"]
        assert budget.counts == {} and registry.events == []
