"""Hosted Brave/Serper policy plus real-adapter dispatch using synthetic HTTP."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry

spec = importlib.util.spec_from_file_location(
    "hosted_search_policy", Path(__file__).resolve().parents[1] / "exa_profile.py"
)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def environment(provider, **overrides):
    prefix = "SOURCESQL_" + provider.upper()
    return {
        "SOURCESQL_ALLOW_LIVE_" + provider.upper(): "1",
        prefix + "_SECRET_NAME": "sourcesql_" + provider,
        prefix + "_REQUEST_COST_MICROUSD": "5000",
        "sourcesql_" + provider + "_" + provider.upper() + "_API_KEY": "SAFE-SYNTHETIC-KEY",
        **overrides,
    }


def request(profile_name, **overrides):
    return {
        "profile": profile_name,
        "source_mode": "allow_excerpt",
        "query": "SELECT title,url FROM WEB_SEARCH('public archives')",
        "budgets": {**policy.LIMITS, "dispatch_deadline_seconds": 60, "max_cost_microusd": 50_000},
        **overrides,
    }


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_configuration_binds_only_selected_profile_and_public_policy(provider):
    env = environment(provider)
    settings = policy.load_configuration(env)
    descriptor = {
        "approved_cost_microusd": 50_000,
        "provider": provider,
        "request_cost_microusd": 5_000,
        "secret_name": "sourcesql_" + provider,
        "version": provider + "-search.v1",
    }
    assert settings["allowed_profiles"] == ("fixture", provider)
    assert settings["descriptor"] == descriptor
    assert settings["provider_policy_sha256"] == hashlib.sha256(
        json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert "SAFE-SYNTHETIC-KEY" not in json.dumps(settings)
    assert settings["profiles"][provider]["allowed_source_hosts"] == []
    policy.validate_request(request(provider), settings, env)
    for other in {"exa", "exa_deep", "brave", "serper"} - {provider}:
        with pytest.raises(SourcesQLError):
            policy.validate_request(request(other), settings, env)


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_real_adapter_limits_results_and_preserves_lineage_and_unknown_billing(provider, monkeypatch):
    env = environment(provider)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = policy.load_configuration(env)
    captured = []

    def respond(call):
        captured.append(call)
        if provider == "brave":
            assert call.url.host == "api.search.brave.com"
            assert call.headers["X-Subscription-Token"] == "SAFE-SYNTHETIC-KEY"
            assert call.url.params["count"] == "5"
            assert call.url.params["extra_snippets"] == "true"
            return httpx.Response(200, json={"web": {"results": [
                {"title": "Public archive", "url": "https://example.org/archive", "description": "Evidence excerpt"}
            ]}})
        assert call.url.host == "google.serper.dev"
        assert call.headers["X-API-KEY"] == "SAFE-SYNTHETIC-KEY"
        assert json.loads(call.content)["num"] == 5
        return httpx.Response(200, json={"organic": [
            {"title": "Public archive", "link": "https://example.org/archive", "snippet": "Evidence excerpt"}
        ]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        registry = ProviderRegistry({**settings["profiles"][provider], "http_client": client})
        budget = Budget(request(provider)["budgets"])
        registry.preflight(["WEB_SEARCH"], budget)
        rows = registry.search(["public archives", "archival collections"], {}, budget)
        assert len(captured) == 2 and len(rows) == 1
        assert len(rows[0]["hits"]) == 2
        assert {hit["query_index"] for hit in rows[0]["hits"]} == {0, 1}
        assert rows[0]["content_basis"] == "excerpt" and rows[0]["coverage"]["complete"] is False
        for event in registry.search_provider.events:
            assert event["usage"]["cost_microusd"] is None
            assert event["usage"]["cost_basis"] == "unavailable"
        with pytest.raises(SourcesQLError) as error:
            registry.search(["third request"], {}, budget)
        assert error.value.code == "budget_exhausted"
        assert len(captured) == 2


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_policy_refuses_implicit_enablement_mixed_providers_and_invalid_estimates(provider):
    assert policy.load_configuration({provider.upper() + "_API_KEY": "SAFE-KEY"})["allowed_profiles"] == ("fixture",)
    with pytest.raises(ValueError):
        policy.load_configuration(environment(provider, SOURCESQL_ALLOW_LIVE_EXA="1"))
    for value in ["", "0", "-1", "1.5", "50001", "1000001"]:
        with pytest.raises(ValueError):
            policy.load_configuration(environment(provider, **{
                "SOURCESQL_" + provider.upper() + "_REQUEST_COST_MICROUSD": value
            }))
    with pytest.raises(ValueError):
        policy.load_configuration(environment(provider, **{
            "SOURCESQL_" + provider.upper() + "_POLICY_VERSION": "unknown.v1"
        }))


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_policy_rejects_unaffordable_attempts_missing_secret_and_expensive_work(provider):
    env = environment(provider)
    settings = policy.load_configuration(env)
    for overrides in [
        {"budgets": {**request(provider)["budgets"], "max_cost_microusd": 9_999}},
        {"budgets": {**request(provider)["budgets"], "max_fetches": 1}},
        {"budgets": {**request(provider)["budgets"], "max_model_requests": 1}},
        {"budgets": {**request(provider)["budgets"], "dispatch_deadline_seconds": 61}},
        {"source_mode": "require_document"}, {"provider": "exa"},
    ]:
        with pytest.raises(SourcesQLError):
            policy.validate_request(request(provider, **overrides), settings, env)
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(provider), settings, {})
    assert error.value.code == "provider_unavailable"


def test_legacy_exa_v1_fingerprint_modes_and_deadline_are_unchanged():
    env = {
        "SOURCESQL_ALLOW_LIVE_EXA": "1",
        "SOURCESQL_EXA_POLICY_VERSION": "exa-search.v1",
        "SOURCESQL_EXA_SECRET_NAME": "sourcesql_exa",
        "sourcesql_exa_EXA_API_KEY": "SAFE-KEY",
    }
    settings = policy.load_configuration(env)
    assert settings["provider_policy_sha256"] == "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004"
    assert settings["allowed_profiles"] == ("fixture", "exa")
    policy.validate_request(request("exa"), settings, env)
    with pytest.raises(SourcesQLError):
        policy.validate_request(request("exa_deep"), settings, env)
