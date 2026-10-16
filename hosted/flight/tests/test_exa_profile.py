"""No-network policy checks for operator-approved Exa Flight execution."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import uuid

import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.providers import ProviderRegistry


def load(name):
    path = Path(__file__).resolve().parents[1] / (name + ".py")
    specification = importlib.util.spec_from_file_location("test_hosted_" + name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


policy = load("exa_profile")
runner = load("runner")


def environment(**overrides):
    return {
        "SOURCESQL_ALLOW_LIVE_EXA": "1",
        "SOURCESQL_EXA_APPROVED_COST_MICROUSD": "50000",
        "SOURCESQL_EXA_SECRET_NAME": "sourcesql_exa",
        "sourcesql_exa_EXA_API_KEY": "SAFE-SYNTHETIC-EXA-CREDENTIAL",
        **overrides,
    }


def request(**overrides):
    return {
        "query": "SELECT title,url FROM WEB_SEARCH('public research')",
        "profile": "exa",
        "source_mode": "allow_excerpt",
        "budgets": {**policy.LIMITS, "max_cost_microusd": 50_000},
        **overrides,
    }


def test_fixture_remains_default_even_when_a_key_is_present():
    settings = policy.load_configuration({"EXA_API_KEY": "SAFE-SYNTHETIC-CREDENTIAL"})
    assert settings == {
        "profiles": {},
        "allowed_profiles": ("fixture",),
        "provider_policy_sha256": None,
        "descriptor": None,
    }
    policy.validate_request({"query": "SELECT 1"}, settings, {})


def test_live_policy_uses_only_secret_reference_and_exact_public_fingerprint():
    env = environment()
    settings = policy.load_configuration(env)
    profile = settings["profiles"]["exa"]
    descriptor = {
        "version": "exa-research.v2",
        "approved_cost_microusd": 50_000,
        "search_types": {
            "exa": "auto",
            "exa_deep": "deep",
            "exa_deep_reasoning": "deep-reasoning",
        },
        "secret_name": "sourcesql_exa",
    }
    expected = hashlib.sha256(
        json.dumps(descriptor, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
            "ascii"
        )
    ).hexdigest()
    assert settings["provider_policy_sha256"] == expected
    assert expected == "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901"
    assert settings["descriptor"] == descriptor
    assert settings["allowed_profiles"] == ("fixture", "exa", "exa_deep", "exa_deep_reasoning")
    assert profile["api_key_env"] == "sourcesql_exa_EXA_API_KEY"
    assert profile["allowed_source_hosts"] == [] and profile["fetch_adapter"] == "exa"
    assert profile["metering_policy"] == "estimated"
    assert profile["search_type"] == "auto"
    assert profile["hosted_profile_fingerprint"] == expected
    assert not {"model", "embedding", "private_disclosure", "api_key"} & set(profile)
    assert env["sourcesql_exa_EXA_API_KEY"] not in json.dumps(settings)
    policy.validate_request(request(), settings, env)


def test_default_approval_and_local_direct_key_reference():
    env = {"SOURCESQL_ALLOW_LIVE_EXA": "1", "EXA_API_KEY": "SAFE-LOCAL-KEY"}
    settings = policy.load_configuration(env)
    assert settings["descriptor"] == {
        "version": "exa-research.v2",
        "approved_cost_microusd": 50_000,
        "search_types": policy.SEARCH_TYPES,
        "secret_name": None,
    }
    assert settings["profiles"]["exa"]["api_key_env"] == "EXA_API_KEY"
    policy.validate_request(request(), settings, env)


def test_key_rotation_does_not_expose_or_change_public_policy():
    original = policy.load_configuration(environment())
    rotated = policy.load_configuration(environment(sourcesql_exa_EXA_API_KEY="SAFE-ROTATED-KEY"))
    assert original == rotated
    changed_grant = policy.load_configuration(
        environment(SOURCESQL_EXA_APPROVED_COST_MICROUSD="10000")
    )
    assert original["provider_policy_sha256"] != changed_grant["provider_policy_sha256"]


@pytest.mark.parametrize(
    ("name", "search_type"),
    [("exa", "auto"), ("exa_deep", "deep"), ("exa_deep_reasoning", "deep-reasoning")],
)
def test_all_live_profiles_bind_exact_mode_and_share_secret_reference(name, search_type):
    env = environment()
    settings = policy.load_configuration(env)
    profile = settings["profiles"][name]
    assert profile["search_type"] == search_type
    assert profile["mode"] == "live" and profile["provider"] == "exa"
    assert profile["api_key_env"] == "sourcesql_exa_EXA_API_KEY"
    assert profile["hosted_profile_fingerprint"] == settings["provider_policy_sha256"]
    assert not {"api_key", "model", "embedding", "private_disclosure"} & set(profile)
    policy.validate_request(request(profile=name), settings, env)


@pytest.mark.parametrize("name", ["unknown", "exa_agent", "deep", None, {"mode": "live"}])
def test_request_cannot_supply_an_unreviewed_profile(name):
    env = environment()
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(profile=name), policy.load_configuration(env), env)
    assert error.value.code == "unsupported_capability"


@pytest.mark.parametrize(
    "override",
    [
        {"mode": "fixture"},
        {"provider": "exa"},
        {"search_type": "auto"},
        {"api_key": "SAFE-REQUEST-KEY"},
        {"api_key_env": "OTHER_KEY"},
        {"hosted_profile_fingerprint": "0" * 64},
    ],
)
def test_request_cannot_override_provider_policy(override):
    env = environment()
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(**override), policy.load_configuration(env), env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize(
    "override",
    [
        {"mode": "fixture"},
        {"provider": "brave"},
        {"search_type": "deep"},
        {"hosted_profile_fingerprint": "0" * 64},
    ],
)
def test_unbound_or_changed_trusted_profile_fails_closed(override):
    env = environment()
    settings = policy.load_configuration(env)
    settings["profiles"]["exa"].update(override)
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("approval", ["0", "-1", "1.0", "true", "1000001", ""])
def test_unbounded_or_noninteger_approvals_are_rejected(approval):
    with pytest.raises(ValueError):
        policy.load_configuration(environment(SOURCESQL_EXA_APPROVED_COST_MICROUSD=approval))


@pytest.mark.parametrize("name", ["bad-name", "MOTHERDUCK_TOKEN", "name'quoted", "a" * 64])
def test_secret_reference_must_have_the_reviewed_shape(name):
    with pytest.raises(ValueError):
        policy.load_configuration(environment(SOURCESQL_EXA_SECRET_NAME=name))


def test_live_requires_explicit_flag_and_available_secret():
    with pytest.raises(ValueError):
        policy.load_configuration(environment(SOURCESQL_ALLOW_LIVE_EXA="true"))
    disabled = policy.load_configuration({})
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(), disabled, environment())
    assert error.value.code == "unsupported_capability"
    enabled = policy.load_configuration(environment())
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(), enabled, {})
    assert error.value.code == "provider_unavailable"


@pytest.mark.parametrize("name", list(policy.LIMITS))
def test_query_cannot_expand_any_trusted_execution_limit(name):
    env = environment()
    settings = policy.load_configuration(env)
    limits = {**policy.LIMITS, "max_cost_microusd": 50_000}
    limits[name] += 1
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(budgets=limits), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize(
    "limits",
    [
        {"max_cost_microusd": 50_000},
        {**policy.LIMITS, "max_cost_microusd": 50_001},
        {**policy.LIMITS, "max_cost_microusd": 0},
    ],
)
def test_missing_limits_or_cost_above_grant_fail_before_dispatch(limits):
    env = environment()
    with pytest.raises(SourcesQLError):
        policy.validate_request(request(budgets=limits), policy.load_configuration(env), env)


def test_source_mode_cannot_expand_to_automatic_document_fetch():
    env = environment()
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(
            request(source_mode="require_document"), policy.load_configuration(env), env
        )
    assert error.value.code == "unsupported_capability"


@pytest.mark.parametrize("operator", ["WEB_FETCH", "SEM_MATCH", "SEM_EXTRACT", "SEM_SCORE"])
def test_explain_blocks_every_non_search_external_operator(operator):
    with pytest.raises(SourcesQLError) as error:
        policy.validate_explain({"plan": {"stages": [{"stage": "external", "operator": operator}]}})
    assert error.value.code == "unsupported_capability"
    policy.validate_explain({"plan": {"stages": [{"stage": "external", "operator": "WEB_SEARCH"}]}})


@pytest.mark.parametrize("name", list(policy.SEARCH_TYPES))
def test_core_preflight_has_no_model_embedding_or_fetch_grant(name):
    env = environment()
    profile = policy.load_configuration(env)["profiles"][name]
    with patch.dict("os.environ", env, clear=True):
        registry = ProviderRegistry(profile)
    for operator in ("SEM_EXTRACT", "SEM_SCORE", "WEB_FETCH"):
        with pytest.raises(SourcesQLError):
            registry.preflight({operator}, Budget(request()["budgets"]))
    assert registry.events == []


@pytest.mark.parametrize("name", ["fixture", *policy.SEARCH_TYPES])
def test_runner_binds_trusted_policy_and_explains_every_live_profile(tmp_path, monkeypatch, name):
    env = environment()
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = policy.load_configuration(env)
    captured = {}

    class Store:
        def claim_job(self, identity, token, **kwargs):
            captured["claim"] = kwargs
            return {
                "operation": "query",
                "request": request(profile=name),
                "provider_policy_sha256": settings["provider_policy_sha256"],
            }

        def bind_job(self, *args):
            captured["bound"] = True

        def finish_job(self, *args):
            captured["verified"] = True

        def fail_job(self, *args):
            raise AssertionError("Unexpected execution failure")

    class Engine:
        def __init__(self, **kwargs):
            assert captured["bound"] is True and kwargs["allow_private"] is False
            assert "fixture" not in kwargs["profiles"]
            captured["profiles"] = kwargs["profiles"]

        def explain(self, **kwargs):
            captured["explained_profile"] = kwargs["profile"]
            return {"plan": {"stages": [{"stage": "external", "operator": "WEB_SEARCH"}]}}

        def query(self, **kwargs):
            return {
                "result_id": "result_fixture",
                "receipt": {"status": "completed", "plan_complete": True, "run_id": "run_fixture"},
            }

    report = {}
    with patch("sourcesql.engine.Engine", Engine):
        runner.execute_job(
            Store(), {"job_id": str(uuid.uuid4())}, report, tmp_path, policy, settings
        )
    assert captured["claim"]["allowed_profiles"] == ("fixture", *policy.SEARCH_TYPES)
    assert captured["claim"]["provider_policy_sha256"] == settings["provider_policy_sha256"]
    assert captured["profiles"] == settings["profiles"]
    assert captured.get("explained_profile") == (None if name == "fixture" else name)
    assert captured["verified"] is True and report["status"] == "completed"


@pytest.mark.parametrize("name", list(policy.SEARCH_TYPES))
@pytest.mark.parametrize("fingerprint", [None, "0" * 64])
def test_runner_refuses_a_live_job_bound_to_another_policy_before_engine(
    tmp_path, monkeypatch, name, fingerprint
):
    env = environment()
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = policy.load_configuration(env)
    captured = {}

    class Store:
        def claim_job(self, *args, **kwargs):
            return {
                "operation": "query",
                "request": request(profile=name),
                "provider_policy_sha256": fingerprint,
            }

        def bind_job(self, *args):
            pass

        def fail_job(self, identity, token, code, message):
            captured["failure"] = code

    report = {}
    with patch("sourcesql.engine.Engine", side_effect=AssertionError("Engine must not start")):
        runner.execute_job(
            Store(), {"job_id": str(uuid.uuid4())}, report, tmp_path, policy, settings
        )
    assert captured["failure"] == "unauthorized"
    assert report["status"] == "failed" and report["error_code"] == "unauthorized"


def research_environment(*, model=False, **overrides):
    return environment(
        **{
            "SOURCESQL_EXA_POLICY_VERSION": "exa-research.v3",
            **(
                {
                    "SOURCESQL_OPENAI_MODEL": "gpt-4.1-mini",
                    "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai",
                    "sourcesql_openai_OPENAI_API_KEY": "SAFE-SYNTHETIC-MODEL-CREDENTIAL",
                }
                if model
                else {}
            ),
            **overrides,
        }
    )


def research_request(settings, **overrides):
    return request(
        **{
            "budgets": {**settings["descriptor"]["limits"], "max_cost_microusd": 50_000},
            **overrides,
        }
    )


@pytest.mark.parametrize("configured_model", [False, True])
def test_research_v3_fingerprints_effective_limits_model_and_only_secret_references(
    configured_model,
):
    env = research_environment(model=configured_model)
    settings = policy.load_configuration(env)
    model = (
        {
            "name": "gpt-4.1-mini",
            "secret_name": "sourcesql_openai",
            "version": "openai-structured.v1",
        }
        if configured_model
        else None
    )
    limits = {
        "max_search_queries": 32,
        "max_search_requests": 48,
        "max_candidates": 2500,
        "max_fetches": 40,
        "max_semantic_documents": 40,
        "max_model_requests": 96,
        "max_concurrency": 4,
        "dispatch_deadline_seconds": 100,
        "max_output_rows": 1000,
        "max_output_bytes": 4_194_304,
        "max_input_tokens": 200_000,
        "max_output_tokens": 16_000,
    }
    if not configured_model:
        limits.update(
            max_semantic_documents=0, max_model_requests=0, max_input_tokens=0, max_output_tokens=0
        )
    descriptor = {
        "approved_cost_microusd": 50_000,
        "limits": limits,
        "model": model,
        "search_types": policy.SEARCH_TYPES,
        "secret_name": "sourcesql_exa",
        "version": "exa-research.v3",
    }
    assert settings["descriptor"] == descriptor
    assert (
        settings["provider_policy_sha256"]
        == hashlib.sha256(
            json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode("ascii")
        ).hexdigest()
    )
    for name, search_type in policy.SEARCH_TYPES.items():
        profile = settings["profiles"][name]
        assert profile["search_type"] == search_type
        assert profile["fetch_adapter"] == "exa"
        assert profile["allowed_source_hosts"] == []
        assert profile["allow_public_source_hosts"] is True
        assert profile.get("model") == (
            {
                "name": "gpt-4.1-mini",
                "api_key_env": "sourcesql_openai_OPENAI_API_KEY",
                "retries": 0,
            }
            if configured_model
            else None
        )
        assert not {"embedding", "private_disclosure", "base_url", "api_key"} & set(profile)
    assert "SAFE-SYNTHETIC" not in json.dumps(settings)
    rotated = policy.load_configuration(
        {
            **env,
            "sourcesql_exa_EXA_API_KEY": "ROTATED-EXA-KEY",
            "sourcesql_openai_OPENAI_API_KEY": "ROTATED-MODEL-KEY",
        }
    )
    assert rotated == settings


@pytest.mark.parametrize("version", ["exa-search.v1", "exa-research.v2"])
def test_legacy_configuration_keeps_search_only_grants_and_ignores_unrelated_model_env(version):
    settings = policy.load_configuration(environment(SOURCESQL_EXA_POLICY_VERSION=version))
    with_model = policy.load_configuration(
        research_environment(model=True, **{"SOURCESQL_EXA_POLICY_VERSION": version})
    )
    assert with_model == settings
    for profile in settings["profiles"].values():
        assert "model" not in profile and "allow_public_source_hosts" not in profile
    assert "limits" not in settings["descriptor"] and "model" not in settings["descriptor"]
    for budgets in [
        {**policy.LIMITS, "max_search_queries": 3, "max_cost_microusd": 50_000},
        {**policy.LIMITS, "max_candidates": 11, "max_cost_microusd": 50_000},
    ]:
        budgets["dispatch_deadline_seconds"] = 60
        with pytest.raises(SourcesQLError):
            policy.validate_request(request(budgets=budgets), settings, environment())


@pytest.mark.parametrize(
    "overrides",
    [
        {"SOURCESQL_OPENAI_MODEL": "gpt-4.1-mini"},
        {"SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai"},
        {"SOURCESQL_OPENAI_MODEL": "", "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai"},
        {
            "SOURCESQL_OPENAI_MODEL": "https://other.example/model",
            "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai",
        },
        {
            "SOURCESQL_OPENAI_MODEL": "openai/gpt-4.1-mini",
            "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai",
        },
        {"SOURCESQL_OPENAI_MODEL": "gpt model", "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai"},
        {"SOURCESQL_OPENAI_MODEL": "g" * 129, "SOURCESQL_OPENAI_SECRET_NAME": "sourcesql_openai"},
        {"SOURCESQL_OPENAI_MODEL": "gpt-4.1-mini", "SOURCESQL_OPENAI_SECRET_NAME": "BAD_NAME"},
        {"SOURCESQL_OPENAI_MODEL": "gpt-4.1-mini", "SOURCESQL_OPENAI_SECRET_NAME": "a" * 64},
    ],
)
def test_research_model_configuration_is_an_optional_validated_pair(overrides):
    with pytest.raises(ValueError):
        policy.load_configuration(research_environment(**overrides))


@pytest.mark.parametrize("configured_model", [False, True])
@pytest.mark.parametrize("source_mode", ["allow_excerpt", "require_document"])
def test_research_v3_admits_broad_budget_and_source_mode_without_promising_complete_documents(
    configured_model, source_mode
):
    env = research_environment(model=configured_model)
    settings = policy.load_configuration(env)
    policy.validate_request(research_request(settings, source_mode=source_mode), settings, env)
    assert not settings["profiles"]["exa"].get("assume_complete")


@pytest.mark.parametrize(
    "credential", ["sourcesql_exa_EXA_API_KEY", "sourcesql_openai_OPENAI_API_KEY"]
)
@pytest.mark.parametrize("value", [None, "", "bad key", "bad\nkey", "x" * 4097])
def test_research_v3_checks_both_configured_credentials_before_dispatch(credential, value):
    env = research_environment(model=True)
    settings = policy.load_configuration(env)
    if value is None:
        del env[credential]
    else:
        env[credential] = value
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(settings), settings, env)
    assert error.value.code == "provider_unavailable"


@pytest.mark.parametrize("name", list(policy.RESEARCH_LIMITS))
def test_research_request_cannot_expand_any_effective_ceiling(name):
    env = research_environment(model=True)
    settings = policy.load_configuration(env)
    requested = research_request(settings)
    requested["budgets"][name] += 1
    with pytest.raises(SourcesQLError):
        policy.validate_request(requested, settings, env)


@pytest.mark.parametrize(
    "name",
    [
        "max_semantic_documents",
        "max_model_requests",
        "max_input_tokens",
        "max_output_tokens",
    ],
)
def test_research_without_model_cannot_reserve_semantic_work(name):
    env = research_environment()
    settings = policy.load_configuration(env)
    requested = research_request(settings)
    requested["budgets"][name] = 1
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(requested, settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize(
    "change",
    [
        {"allow_public_source_hosts": False},
        {"allowed_source_hosts": ["private.example"]},
        {"fetch_adapter": "http"},
        {"approved_cost_microusd": 1_000_000},
        {"api_key_env": "UNREVIEWED_EXA_KEY"},
        {"model": None},
        {
            "model": {
                "name": "gpt-4.1-mini",
                "api_key_env": "sourcesql_openai_OPENAI_API_KEY",
                "retries": 1,
            }
        },
        {
            "model": {
                "name": "gpt-4.1-mini",
                "api_key_env": "sourcesql_openai_OPENAI_API_KEY",
                "retries": 0,
                "base_url": "https://other.example/v1",
            }
        },
    ],
)
def test_research_profile_cannot_drift_from_its_public_policy(change):
    env = research_environment(model=True)
    settings = policy.load_configuration(env)
    settings["profiles"]["exa"].update(change)
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(settings), settings, env)
    assert error.value.code == "unauthorized"


def test_research_effective_limits_cannot_change_under_the_same_fingerprint():
    env = research_environment()
    settings = policy.load_configuration(env)
    settings["descriptor"]["limits"]["max_candidates"] = 2499
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(settings), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("configured_model", [False, True])
def test_research_explain_grants_only_configured_operators(configured_model):
    settings = policy.load_configuration(research_environment(model=configured_model))
    allowed = {"WEB_SEARCH", "WEB_FETCH"}
    if configured_model:
        allowed.update({"SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"})
    for operator in allowed:
        policy.validate_explain(
            {
                "plan": {
                    "stages": [
                        {"stage": "external", "operator": operator},
                    ]
                }
            },
            settings,
        )
    for operator in {"SEM_SCORE", "WEB_CRAWL", "SEM_MATCH"} - allowed:
        with pytest.raises(SourcesQLError) as error:
            policy.validate_explain(
                {
                    "plan": {
                        "stages": [
                            {"stage": "external", "operator": operator},
                        ]
                    }
                },
                settings,
            )
        assert error.value.code == "unsupported_capability"
    with pytest.raises(SourcesQLError):
        policy.validate_explain(
            {
                "plan": {
                    "stages": [
                        {"stage": "external", "operator": "WEB_FETCH"},
                    ]
                }
            }
        )
    policy.validate_explain({"plan": {"stages": []}}, policy.load_configuration({}))


@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
def test_opt_in_reasoning_effort_is_bound_to_the_model_profile_and_public_policy(effort):
    env = research_environment(
        model=True, SOURCESQL_OPENAI_MODEL="gpt-6-astra", SOURCESQL_OPENAI_REASONING_EFFORT=effort
    )
    settings = policy.load_configuration(env)
    assert settings["descriptor"]["model"] == {
        "name": "gpt-6-astra",
        "secret_name": "sourcesql_openai",
        "version": "openai-structured.v1",
        "reasoning_effort": effort,
    }
    for profile in settings["profiles"].values():
        assert profile["model"] == {
            "name": "gpt-6-astra",
            "api_key_env": "sourcesql_openai_OPENAI_API_KEY",
            "retries": 0,
            "reasoning_effort": effort,
        }
    policy.validate_request(research_request(settings), settings, env)
    without_effort = policy.load_configuration(
        {key: value for key, value in env.items() if key != "SOURCESQL_OPENAI_REASONING_EFFORT"}
    )
    assert settings["provider_policy_sha256"] != without_effort["provider_policy_sha256"]
    assert "reasoning_effort" not in without_effort["descriptor"]["model"]
    if effort == "low":
        assert (
            settings["provider_policy_sha256"]
            == "a2415a6fbb03bd46204b7fc2d450ffd9fd342496374d97ade2e6cfe125eda3b8"
        )
    settings["profiles"]["exa"]["model"]["reasoning_effort"] = (
        "medium" if effort == "low" else "low"
    )
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(settings), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("effort", ["", "none", "minimal", "LOW", "ultra", "auto", 1])
def test_reasoning_effort_refuses_unknown_values(effort):
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(model=True, SOURCESQL_OPENAI_REASONING_EFFORT=effort)
        )


@pytest.mark.parametrize("model", [False, True])
@pytest.mark.parametrize("version", ["exa-search.v1", "exa-research.v2"])
def test_reasoning_effort_is_not_enabled_on_legacy_policies(model, version):
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(
                model=model,
                SOURCESQL_EXA_POLICY_VERSION=version,
                SOURCESQL_OPENAI_REASONING_EFFORT="low",
            )
        )


def test_reasoning_effort_cannot_exist_without_the_model_pair():
    with pytest.raises(ValueError):
        policy.load_configuration(research_environment(SOURCESQL_OPENAI_REASONING_EFFORT="low"))


@pytest.mark.parametrize("key", ["reasoning_effort", "reasoningEffort"])
def test_request_cannot_override_the_trusted_reasoning_effort(key):
    env = research_environment(model=True, SOURCESQL_OPENAI_REASONING_EFFORT="low")
    settings = policy.load_configuration(env)
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(research_request(settings, **{key: "high"}), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("configured_model", [False, True])
@pytest.mark.parametrize("profile", list(policy.SEARCH_TYPES))
def test_explicit_research_v3_accepts_exact_two_dollars_across_configuration_and_request(
    configured_model, profile
):
    env = research_environment(
        model=configured_model, SOURCESQL_EXA_APPROVED_COST_MICROUSD="2000000"
    )
    settings = policy.load_configuration(env)
    assert settings["descriptor"]["approved_cost_microusd"] == 2_000_000
    assert settings["profiles"][profile]["approved_cost_microusd"] == 2_000_000
    requested = research_request(
        settings,
        profile=profile,
        budgets={**settings["descriptor"]["limits"], "max_cost_microusd": 2_000_000},
    )
    policy.validate_request(requested, settings, env)
    requested["budgets"]["max_cost_microusd"] += 1
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(requested, settings, env)
    assert error.value.code == "unauthorized"


def test_research_v3_configuration_rejects_above_two_dollars_and_keeps_default():
    with pytest.raises(ValueError):
        policy.load_configuration(
            research_environment(SOURCESQL_EXA_APPROVED_COST_MICROUSD="2000001")
        )
    env = research_environment()
    del env["SOURCESQL_EXA_APPROVED_COST_MICROUSD"]
    settings = policy.load_configuration(env)
    assert settings["descriptor"]["approved_cost_microusd"] == 50_000
    policy.validate_request(research_request(settings), settings, env)


@pytest.mark.parametrize("version", ["exa-search.v1", "exa-research.v2"])
def test_legacy_exa_approval_remains_bounded_to_one_dollar(version):
    with pytest.raises(ValueError):
        policy.load_configuration(
            environment(
                SOURCESQL_EXA_POLICY_VERSION=version,
                SOURCESQL_EXA_APPROVED_COST_MICROUSD="1000001",
            )
        )
    env = environment(
        SOURCESQL_EXA_POLICY_VERSION=version,
        SOURCESQL_EXA_APPROVED_COST_MICROUSD="1000000",
    )
    settings = policy.load_configuration(env)
    limits = {**policy.LIMITS, "max_cost_microusd": 1_000_000}
    if version == "exa-search.v1":
        limits["dispatch_deadline_seconds"] = 60
    policy.validate_request(request(budgets=limits), settings, env)
    limits["max_cost_microusd"] += 1
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(budgets=limits), settings, env)
    assert error.value.code == "unauthorized"


@pytest.mark.parametrize("provider", ["brave", "serper"])
def test_other_hosted_provider_approvals_remain_bounded_to_one_dollar(provider):
    prefix = "SOURCESQL_" + provider.upper()
    env = {
        "SOURCESQL_ALLOW_LIVE_" + provider.upper(): "1",
        prefix + "_APPROVED_COST_MICROUSD": "1000001",
        prefix + "_REQUEST_COST_MICROUSD": "1000",
        prefix + "_SECRET_NAME": "sourcesql_" + provider,
    }
    with pytest.raises(ValueError):
        policy.load_configuration(env)
    env[prefix + "_APPROVED_COST_MICROUSD"] = "1000000"
    env["sourcesql_" + provider + "_" + provider.upper() + "_API_KEY"] = "SYNTHETIC-KEY"
    settings = policy.load_configuration(env)
    limits = {**policy.LIMITS, "dispatch_deadline_seconds": 60, "max_cost_microusd": 1_000_000}
    policy.validate_request(request(profile=provider, budgets=limits), settings, env)
    limits["max_cost_microusd"] += 1
    with pytest.raises(SourcesQLError) as error:
        policy.validate_request(request(profile=provider, budgets=limits), settings, env)
    assert error.value.code == "unauthorized"
