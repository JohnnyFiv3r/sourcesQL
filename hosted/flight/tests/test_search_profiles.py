"""Hosted search policy plus real-adapter dispatch using synthetic HTTP."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import socket

import httpx
import pytest
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.engine import Engine
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.semantic import PydanticSemanticProvider

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


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
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
    assert (
        settings["provider_policy_sha256"]
        == hashlib.sha256(
            json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    assert "SAFE-SYNTHETIC-KEY" not in json.dumps(settings)
    assert settings["profiles"][provider]["allowed_source_hosts"] == []
    policy.validate_request(request(provider), settings, env)
    for other in {"exa", "exa_deep", "brave", "serper", "deepseek"} - {provider}:
        with pytest.raises(SourcesQLError):
            policy.validate_request(request(other), settings, env)


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
def test_real_adapter_limits_results_and_preserves_lineage_and_unknown_billing(
    provider, monkeypatch
):
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
            return httpx.Response(
                200,
                json={
                    "web": {
                        "results": [
                            {
                                "title": "Public archive",
                                "url": "https://example.org/archive",
                                "description": "Evidence excerpt",
                            }
                        ]
                    }
                },
            )
        if provider == "deepseek":
            assert call.url.host == "api.deepseek.com"
            assert call.url.path == "/v1/tools/search"
            assert call.headers["authorization"] == "Bearer SAFE-SYNTHETIC-KEY"
            assert json.loads(call.content)["count"] == 5
            assert json.loads(call.content)["need_content"] is True
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "title": "Public archive",
                            "url": "https://example.org/archive",
                            "snippet": "Evidence excerpt",
                            "summary": "A provider summary is not source content",
                            "content": "Evidence excerpt",
                            "date": "2026-10-18T00:00:00Z",
                            "rerank_score": 2.5,
                            "authority": 3,
                        }
                    ]
                },
            )
        assert call.url.host == "google.serper.dev"
        assert call.headers["X-API-KEY"] == "SAFE-SYNTHETIC-KEY"
        assert json.loads(call.content)["num"] == 5
        return httpx.Response(
            200,
            json={
                "organic": [
                    {
                        "title": "Public archive",
                        "link": "https://example.org/archive",
                        "snippet": "Evidence excerpt",
                    }
                ]
            },
        )

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        registry = ProviderRegistry({**settings["profiles"][provider], "http_client": client})
        budget = Budget(request(provider)["budgets"])
        registry.preflight(["WEB_SEARCH"], budget)
        rows = registry.search(["public archives", "archival collections"], {}, budget)
        assert len(captured) == 2 and len(rows) == 1
        assert len(rows[0]["hits"]) == 2
        assert {hit["query_index"] for hit in rows[0]["hits"]} == {0, 1}
        assert rows[0]["content_basis"] == (
            "provider_text" if provider == "deepseek" else "excerpt"
        )
        assert rows[0]["coverage"]["complete"] is False
        for event in registry.search_provider.events:
            assert event["usage"]["cost_microusd"] is None
            assert event["usage"]["cost_basis"] == (
                "published_rate_estimate" if provider == "deepseek" else "unavailable"
            )
        with pytest.raises(SourcesQLError) as error:
            registry.search(["third request"], {}, budget)
        assert error.value.code == "budget_exhausted"
        assert len(captured) == 2


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
def test_policy_refuses_implicit_enablement_mixed_providers_and_invalid_estimates(provider):
    assert policy.load_configuration({provider.upper() + "_API_KEY": "SAFE-KEY"})[
        "allowed_profiles"
    ] == ("fixture",)
    with pytest.raises(ValueError):
        policy.load_configuration(environment(provider, SOURCESQL_ALLOW_LIVE_EXA="1"))
    for value in ["", "0", "-1", "1.5", "50001", "1000001"]:
        with pytest.raises(ValueError):
            policy.load_configuration(
                environment(
                    provider, **{"SOURCESQL_" + provider.upper() + "_REQUEST_COST_MICROUSD": value}
                )
            )
    with pytest.raises(ValueError):
        policy.load_configuration(
            environment(
                provider, **{"SOURCESQL_" + provider.upper() + "_POLICY_VERSION": "unknown.v1"}
            )
        )


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
def test_policy_rejects_unaffordable_attempts_missing_secret_and_expensive_work(provider):
    env = environment(provider)
    settings = policy.load_configuration(env)
    for overrides in [
        {"budgets": {**request(provider)["budgets"], "max_cost_microusd": 9_999}},
        {"budgets": {**request(provider)["budgets"], "max_fetches": 1}},
        {"budgets": {**request(provider)["budgets"], "max_model_requests": 1}},
        {"budgets": {**request(provider)["budgets"], "dispatch_deadline_seconds": 61}},
        {"source_mode": "require_document"},
        {"provider": "exa"},
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
    assert (
        settings["provider_policy_sha256"]
        == "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004"
    )
    assert settings["allowed_profiles"] == ("fixture", "exa")
    policy.validate_request(request("exa"), settings, env)
    with pytest.raises(SourcesQLError):
        policy.validate_request(request("exa_deep"), settings, env)


@pytest.mark.parametrize("version", ["deepseek-search.v1", "deepseek-research.v1"])
def test_deepseek_request_estimate_is_bound_and_not_below_published_unit_rate(version):
    env = environment(
        "deepseek",
        SOURCESQL_DEEPSEEK_POLICY_VERSION=version,
        SOURCESQL_DEEPSEEK_REQUEST_COST_MICROUSD="750",
    )
    settings = policy.load_configuration(env)
    profile = settings["profiles"]["deepseek"]
    assert profile["request_cost_microusd"] == 750
    assert profile.get("fetch_adapter") == (
        "deepseek" if version == "deepseek-research.v1" else None
    )
    policy.validate_request(request("deepseek"), settings, env)
    profile["request_cost_microusd"] = 1
    with pytest.raises(SourcesQLError, match="policy mismatch"):
        policy.validate_request(request("deepseek"), settings, env)
    with pytest.raises(ValueError, match="published unit rate"):
        policy.load_configuration({**env, "SOURCESQL_DEEPSEEK_REQUEST_COST_MICROUSD": "749"})


def research_environment(provider, *, model=True, embedding=True, **overrides):
    prefix = "SOURCESQL_" + provider.upper()
    return environment(
        provider,
        **{
            prefix + "_POLICY_VERSION": policy.SEARCH_RESEARCH_POLICY_VERSIONS[provider],
            prefix + "_APPROVED_COST_MICROUSD": "1000000",
            **(
                {
                    "SOURCESQL_OPENAI_MODEL": "gpt-4.1-mini",
                    "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_model",
                    "SOURCESQL_OPENAI_REASONING_EFFORT": "low",
                    "sourcesql_model_OPENAI_API_KEY": "SYNTHETIC-MODEL-KEY",
                }
                if model
                else {}
            ),
            **(
                {
                    "SOURCESQL_OPENAI_EMBEDDING_MODEL": "text-embedding-3-small",
                    "SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME": "sourcesql_embedding",
                    "sourcesql_embedding_OPENAI_API_KEY": "SYNTHETIC-EMBEDDING-KEY",
                }
                if embedding
                else {}
            ),
            **overrides,
        },
    )


def research_request(provider, settings, **overrides):
    return request(
        provider,
        budgets={**settings["descriptor"]["limits"], "max_cost_microusd": 1_000_000},
        **overrides,
    )


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize("embedding", [False, True])
def test_research_descriptor_binds_optional_semantics_independently_of_search(
    provider, model, embedding
):
    env = research_environment(provider, model=model, embedding=embedding)
    settings = policy.load_configuration(env)
    descriptor = settings["descriptor"]
    assert descriptor["version"] == policy.SEARCH_RESEARCH_POLICY_VERSIONS[provider]
    assert descriptor["provider"] == provider
    assert descriptor["secret_name"] == "sourcesql_" + provider
    assert descriptor["approved_cost_microusd"] == 1_000_000
    assert descriptor["request_cost_microusd"] == 5_000
    assert settings["allowed_profiles"] == ("fixture", provider)
    assert descriptor["model"] == (
        {
            "name": "gpt-4.1-mini",
            "secret_name": "sourcesql_model",
            "version": "openai-structured.v1",
            "reasoning_effort": "low",
        }
        if model
        else None
    )
    assert descriptor.get("embedding") == (
        {
            "name": "text-embedding-3-small",
            "secret_name": "sourcesql_embedding",
            "version": "openai-embeddings.v2",
        }
        if embedding
        else None
    )
    assert descriptor["limits"] == policy._research_limits(
        descriptor["model"], descriptor.get("embedding")
    )
    assert descriptor["limits"]["dispatch_deadline_seconds"] == 100
    assert (
        settings["provider_policy_sha256"]
        == hashlib.sha256(
            json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode("ascii")
        ).hexdigest()
    )
    profile = settings["profiles"][provider]
    assert profile["allow_public_source_hosts"] is True
    assert profile["allowed_source_hosts"] == []
    assert profile.get("fetch_adapter") == ("deepseek" if provider == "deepseek" else None)
    if provider == "deepseek":
        assert profile["request_cost_microusd"] == descriptor["request_cost_microusd"]
    assert profile.get("model") == (
        {
            "name": "gpt-4.1-mini",
            "api_key_env": "sourcesql_model_OPENAI_API_KEY",
            "retries": 0,
            "reasoning_effort": "low",
        }
        if model
        else None
    )
    assert "SYNTHETIC-" not in json.dumps(settings)
    for source_mode in ["allow_excerpt", "require_document"]:
        requested = research_request(provider, settings, source_mode=source_mode)
        if provider == "deepseek" and source_mode == "require_document":
            for credentials in (env, {}):
                with pytest.raises(SourcesQLError, match="complete document coverage") as error:
                    policy.validate_request(requested, settings, credentials)
                assert error.value.code == "unsupported_capability"
        else:
            policy.validate_request(requested, settings, env)
    allowed = {"WEB_SEARCH", "WEB_FETCH", "SOURCE_WINDOW"}
    if model:
        allowed.update(policy.SEMANTIC_OPERATORS)
    if embedding:
        allowed.add("SEM_SCORE")
    for operator in allowed:
        policy.validate_explain(
            {"plan": {"stages": [{"stage": "external", "operator": operator}]}}, settings
        )
    for operator in {"SEM_SCORE", *policy.SEMANTIC_OPERATORS, "WEB_CRAWL"} - allowed:
        with pytest.raises(SourcesQLError, match="Operator is not enabled"):
            policy.validate_explain(
                {"plan": {"stages": [{"stage": "external", "operator": operator}]}}, settings
            )
    rotated = {
        key: "ROTATED-KEY" if key.endswith("_API_KEY") else value for key, value in env.items()
    }
    assert policy.load_configuration(rotated) == settings


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
def test_legacy_search_profiles_ignore_semantic_settings_and_retain_fingerprint(provider):
    original = policy.load_configuration(environment(provider))
    enabled = research_environment(
        provider,
        **{
            "SOURCESQL_" + provider.upper() + "_POLICY_VERSION": provider + "-search.v1",
            "SOURCESQL_" + provider.upper() + "_APPROVED_COST_MICROUSD": "50000",
        },
    )
    assert policy.load_configuration(enabled) == original
    for operator in {"WEB_FETCH", "SEM_SCORE", *policy.SEMANTIC_OPERATORS}:
        with pytest.raises(SourcesQLError):
            policy.validate_explain(
                {"plan": {"stages": [{"stage": "external", "operator": operator}]}}, original
            )


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
@pytest.mark.parametrize("credential", ["search", "model", "embedding"])
@pytest.mark.parametrize("value", [None, "", "bad key", "bad\nkey", "x" * 4097])
def test_research_credentials_must_be_exact_bound_validated_secrets(provider, credential, value):
    env = research_environment(provider)
    settings = policy.load_configuration(env)
    key = {
        "search": "sourcesql_" + provider + "_" + provider.upper() + "_API_KEY",
        "model": "sourcesql_model_OPENAI_API_KEY",
        "embedding": "sourcesql_embedding_OPENAI_API_KEY",
    }[credential]
    if value is None:
        del env[key]
    else:
        env[key] = value
    env.update(OPENAI_API_KEY="UNRELATED-KEY", EXA_API_KEY="UNRELATED-KEY")
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(provider, settings), settings, env)
    assert error.value.code == "provider_unavailable"


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
@pytest.mark.parametrize("name", list(policy.RESEARCH_LIMITS))
def test_research_request_cannot_exceed_execution_ceiling(provider, name):
    env = research_environment(provider)
    settings = policy.load_configuration(env)
    requested = research_request(provider, settings)
    requested["budgets"][name] += 1
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(requested, settings, env)
    assert error.value.code in {"unauthorized", "invalid_request"}


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
@pytest.mark.parametrize(
    "change",
    [
        {"allow_public_source_hosts": False},
        {"allowed_source_hosts": ["private.example"]},
        {"fetch_adapter": "exa"},
        {"approved_cost_microusd": 2_000_000},
        {"api_key_env": "UNRELATED_KEY"},
        {"model": None},
        {"embedding": None},
    ],
)
def test_research_runtime_profile_cannot_drift_from_descriptor(provider, change):
    env = research_environment(provider)
    settings = policy.load_configuration(env)
    settings["profiles"][provider].update(change)
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(provider, settings), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
@pytest.mark.parametrize(
    "override",
    [
        {"model": {"name": "unreviewed-model"}},
        {"embedding": {"name": "unreviewed-embedding"}},
        {"fetch_adapter": "exa"},
        {"allow_public_source_hosts": False},
        {"allowed_source_hosts": ["private.example"]},
        {"provider": "exa"},
    ],
)
def test_research_request_cannot_override_trusted_provider_or_semantic_settings(provider, override):
    env = research_environment(provider)
    settings = policy.load_configuration(env)
    requested = research_request(provider, settings)
    requested.update(override)
    with pytest.raises(SourcesQLError, match="cannot be overridden") as error:
        policy.validate_request(requested, settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
def test_research_cost_reservations_and_explicit_version_are_still_required(provider):
    prefix = "SOURCESQL_" + provider.upper()
    env = research_environment(provider, **{prefix + "_APPROVED_COST_MICROUSD": "2000000"})
    settings = policy.load_configuration(env)
    requested = research_request(provider, settings)
    policy.validate_request(requested, settings, env)
    requested["budgets"]["max_cost_microusd"] = 239_999
    with pytest.raises(SourcesQLError, match="cost estimate"):
        policy.validate_request(requested, settings, env)
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(provider, **{prefix + "_APPROVED_COST_MICROUSD": "2000001"})
        )
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(provider, **{prefix + "_POLICY_VERSION": "exa-research.v3"})
        )
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(
                provider, SOURCESQL_OPENAI_MODEL="https://unreviewed.example/model"
            )
        )
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(provider, SOURCESQL_OPENAI_EMBEDDING_MODEL="unknown-embedding")
        )


@pytest.mark.parametrize("provider", ["brave", "serper", "deepseek"])
def test_research_search_fetch_semantics_and_embeddings_use_selected_adapters(
    provider, monkeypatch, tmp_path
):
    env = research_environment(provider)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = policy.load_configuration(env)
    policy.validate_request(research_request(provider, settings), settings, env)
    model_calls, outputs, http_calls = [], [], []

    def model_output(messages, info):
        model_calls.append(messages)
        assert not info.function_tools
        return ModelResponse([ToolCallPart(info.output_tools[0].name, outputs.pop(0))])

    def model_factory(name, key, **kwargs):
        assert (name, key) == ("gpt-4.1-mini", "SYNTHETIC-MODEL-KEY")
        assert kwargs == {"base_url": None, "retries": 0, "reasoning_effort": "low"}
        return PydanticSemanticProvider(FunctionModel(model_output))

    monkeypatch.setattr(PydanticSemanticProvider, "openai", staticmethod(model_factory))

    def respond(call):
        http_calls.append(call)
        if call.url.host == "api.search.brave.com":
            assert (
                provider == "brave" and call.headers["X-Subscription-Token"] == "SAFE-SYNTHETIC-KEY"
            )
            return httpx.Response(
                200,
                json={
                    "web": {
                        "results": [
                            {
                                "title": "Aurora",
                                "url": "https://example.org/archive",
                                "description": "Aurora",
                            }
                        ]
                    }
                },
            )
        if call.url.host == "google.serper.dev":
            assert provider == "serper" and call.headers["X-API-KEY"] == "SAFE-SYNTHETIC-KEY"
            return httpx.Response(
                200,
                json={
                    "organic": [
                        {
                            "title": "Aurora",
                            "link": "https://example.org/archive",
                            "snippet": "Aurora",
                        }
                    ]
                },
            )
        if call.url.host == "api.deepseek.com":
            assert provider == "deepseek"
            assert call.headers["authorization"] == "Bearer SAFE-SYNTHETIC-KEY"
            if call.url.path == "/v1/tools/search":
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {
                                "title": "Aurora",
                                "url": "https://example.org/archive",
                                "snippet": "Aurora",
                                "summary": "An independently generated summary",
                                "content": "Aurora",
                            }
                        ]
                    },
                )
            assert call.url.path == "/v1/tools/fetch"
            assert json.loads(call.content) == {"url": "https://example.org/archive"}
            return httpx.Response(200, json={"title": "Aurora", "content": "Aurora 500"})
        if call.url.host == "93.184.216.34":
            assert call.headers["host"] == "example.org"
            assert "authorization" not in call.headers and "x-api-key" not in call.headers
            return httpx.Response(200, text="Aurora 500", headers={"content-type": "text/plain"})
        assert call.url.host == "api.openai.com" and call.url.path == "/v1/embeddings"
        assert call.headers["authorization"] == "Bearer SYNTHETIC-EMBEDDING-KEY"
        return httpx.Response(
            200,
            json={
                "data": [{"index": 0, "embedding": [1, 0]}, {"index": 1, "embedding": [1, 1]}],
                "usage": {"total_tokens": 5},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(respond), trust_env=False) as client:
        profile = {
            **settings["profiles"][provider],
            "http_client": client,
            "fetch_client": client,
            "resolver": lambda host, port, **kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))
            ],
        }
        profile["embedding"] = {**profile["embedding"], "client": client}
        registry = ProviderRegistry(profile)
        budget = Budget(research_request(provider, settings)["budgets"])
        registry.preflight(
            [
                "WEB_SEARCH",
                "WEB_FETCH",
                "SEM_MATCH",
                "SEM_EXTRACT",
                "SEM_EXTRACT_ALL",
                "SEM_NORM",
                "SEM_SCORE",
            ],
            budget,
        )
        hits = registry.search(["public archive"], {}, budget)
        row = registry.fetch([hits[0]["url"]], {}, budget)[0]
        assert row["content"] == "Aurora 500"
        assert row["coverage"]["complete"] is (provider != "deepseek")
        assert row["content_basis"] == ("provider_text" if provider == "deepseek" else "document")
        support = {"quote": "Aurora", "start": 0, "end": 6, "field": "value"}
        outputs.append({"value": True, "status": "processed", "support": [support]})
        assert (
            registry.semantic("SEM_MATCH", row["content"], "is named campus", {}, {}, budget).value
            is True
        )
        outputs.append({"value": "Aurora", "status": "supported_text", "support": [support]})
        result = registry.semantic(
            "SEM_EXTRACT",
            row["content"],
            "campus name",
            {},
            {"source_version_id": row["source_version_id"]},
            budget,
        )
        assert (
            result.value == "Aurora"
            and result.support[0]["source_version_id"] == row["source_version_id"]
        )
        outputs.append(
            {"value": ["Aurora"], "status": "supported_text", "support": [{**support, "item": 0}]}
        )
        assert registry.semantic(
            "SEM_EXTRACT_ALL", row["content"], "campus names", {}, {}, budget
        ).value == ["Aurora"]
        outputs.append({"entries": [{"original": "Aurora", "normalized": "Aurora Campus"}]})
        assert registry.semantic("SEM_NORM", ["Aurora"], "same campus", {}, {}, budget).value == [
            "Aurora Campus"
        ]
        score = registry.semantic("SEM_SCORE", row["content"], "campus", {}, {}, budget)
        assert score.status == "processed" and score.value == pytest.approx(0.70710678)
        assert len(model_calls) == 4 and len(http_calls) == 3
        assert budget.counts["model_requests"] == 5
        # Run the configured profile through the real SQL coordinator/sandbox,
        # retaining exact per-cell support in a qualified answer table.
        outputs.extend(
            [
                {"value": True, "status": "processed", "support": [support]},
                {"value": "Aurora", "status": "supported_text", "support": [support]},
            ]
        )
        query = """WITH fetched AS (
            SELECT url,WEB_FETCH(url) AS docs FROM WEB_SEARCH('public archive')
        ), qualified AS (
            SELECT url,docs[1].content AS content FROM fetched
            WHERE SEM_MATCH(docs[1].content,'is named campus')
        ) SELECT SEM_EXTRACT(content,'campus name') AS name,
            SEM_SCORE(content,'campus') AS score,url FROM qualified"""
        requested = research_request(provider, settings)
        requested["query"] = query
        policy.validate_request(requested, settings, env)

        class MockedRegistry(ProviderRegistry):
            def __init__(self, configured):
                injected = {
                    **configured,
                    "http_client": client,
                    "fetch_client": client,
                    "resolver": profile["resolver"],
                    "embedding": {**configured["embedding"], "client": client},
                }
                super().__init__(injected)

        monkeypatch.setattr("sourcesql.providers.ProviderRegistry", MockedRegistry)
        engine = Engine(
            tmp_path / "engine",
            profiles=settings["profiles"],
            before_dispatch=lambda explanation: policy.validate_explain(explanation, settings),
        )
        result = engine.query(**requested)
        assert result["receipt"]["status"] == "completed"
        assert result["rows"] == [
            {
                "name": "Aurora",
                "score": pytest.approx(0.70710678),
                "url": "https://example.org/archive",
            }
        ]
        evidence = [item for item in result["evidence"] if item.get("column_key") == "name"]
        assert len(evidence) == 1
        assert evidence[0]["row_id"] == result["row_ids"][0]
        assert evidence[0]["support"][0]["quote"] == "Aurora"
        assert evidence[0]["source_version_id"]
        assert result["receipt"]["counts"]["search_requests"] == 1
        assert result["receipt"]["counts"]["fetches"] == 1
        assert result["receipt"]["counts"]["model_requests"] == 3
        assert len(http_calls) == 6 and len(model_calls) == 6
        # Search and fetch are independently optional for retained sources.
        outputs.append({"value": "Aurora", "status": "supported_text", "support": [support]})
        reused_request = research_request(provider, settings)
        reused_request.update(
            query="SELECT SEM_EXTRACT(content,'name of campus') AS name FROM input.saved "
            + (
                "WHERE content = 'Aurora 500'"
                if provider == "deepseek"
                else "WHERE content_basis='document'"
            ),
            inputs={"saved": {"result_id": result["result_id"], "view": "sources"}},
        )
        reused_request["budgets"].update(
            max_search_queries=0, max_search_requests=0, max_fetches=0, max_cost_microusd=1000
        )
        policy.validate_request(reused_request, settings, env)
        reused = engine.query(**reused_request)
        assert reused["rows"] == [{"name": "Aurora"}]
        assert reused["receipt"]["counts"].get("search_requests", 0) == 0
        assert reused["receipt"]["counts"].get("fetches", 0) == 0
        assert len(http_calls) == 6 and len(model_calls) == 7
