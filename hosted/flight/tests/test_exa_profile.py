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
