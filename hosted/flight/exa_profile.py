"""Trusted, opt-in search policy for the credential-bearing Flight parent.

This module never contacts a provider or copies a secret into the profile.
Fixture mode remains the engine default; requests cannot configure this policy.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Mapping

POLICY_VERSION = "exa-research.v2"
RESEARCH_POLICY_VERSION = "exa-research.v3"
SEARCH_TYPES = {
    "exa": "auto",
    "exa_deep": "deep",
    "exa_deep_reasoning": "deep-reasoning",
}
DEFAULT_APPROVED_COST_MICROUSD = 50_000
MAX_APPROVED_COST_MICROUSD = 1_000_000
MAX_RESEARCH_APPROVED_COST_MICROUSD = 2_000_000
LIMITS = {
    "max_search_queries": 2,
    "max_search_requests": 2,
    "max_candidates": 10,
    "max_fetches": 0,
    "max_semantic_documents": 0,
    "max_model_requests": 0,
    "max_concurrency": 1,
    "dispatch_deadline_seconds": 100,
    "max_output_rows": 100,
    "max_output_bytes": 1_048_576,
    "max_input_tokens": 0,
    "max_output_tokens": 0,
}
RESEARCH_LIMITS = {
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
SEMANTIC_OPERATORS = {"SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"}
REASONING_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
SEARCH_POLICY_VERSIONS = {"brave": "brave-search.v1", "serper": "serper-search.v1"}
SEARCH_RESEARCH_POLICY_VERSIONS = {"brave": "brave-research.v2", "serper": "serper-research.v2"}


def _is_research(descriptor: dict) -> bool:
    return descriptor.get("version") in {
        RESEARCH_POLICY_VERSION,
        *SEARCH_RESEARCH_POLICY_VERSIONS.values(),
    }


def _model_configuration(environment: Mapping[str, str]) -> dict | None:
    name = environment.get("SOURCESQL_OPENAI_MODEL")
    secret_name = environment.get("SOURCESQL_OPENAI_SECRET_NAME")
    effort = environment.get("SOURCESQL_OPENAI_REASONING_EFFORT")
    if name is None and secret_name is None:
        if effort is not None:
            raise ValueError("Reasoning effort requires a configured OpenAI model and secret")
        return None
    if (
        not isinstance(name, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", name)
        or not isinstance(secret_name, str)
        or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", secret_name)
        or (effort is not None and (not isinstance(effort, str) or effort not in REASONING_EFFORTS))
    ):
        raise ValueError("Configure a simple OpenAI model and MotherDuck Flight secret together")
    return {
        "name": name,
        "secret_name": secret_name,
        "version": "openai-structured.v1",
        **({"reasoning_effort": effort} if effort is not None else {}),
    }


def _embedding_configuration(environment: Mapping[str, str]) -> dict | None:
    name = environment.get("SOURCESQL_OPENAI_EMBEDDING_MODEL")
    secret_name = environment.get("SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME")
    if name is None and secret_name is None:
        return None
    if (
        name not in {"text-embedding-3-small", "text-embedding-3-large"}
        or not isinstance(secret_name, str)
        or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", secret_name)
    ):
        raise ValueError("Configure a supported OpenAI embedding model and Flight secret together")
    return {"name": name, "secret_name": secret_name, "version": "openai-embeddings.v2"}


def _embedding_profile(embedding: dict) -> dict:
    return {
        "name": embedding["name"],
        "api_key_env": embedding["secret_name"] + "_OPENAI_API_KEY",
    }


def _research_limits(model: dict | None, embedding: dict | None = None) -> dict:
    limits = dict(RESEARCH_LIMITS)
    if model is None:
        for name in (
            "max_semantic_documents",
            "max_model_requests",
            "max_input_tokens",
            "max_output_tokens",
        ):
            limits[name] = 0
    if embedding is not None:
        for name in ("max_model_requests", "max_input_tokens"):
            limits[name] = RESEARCH_LIMITS[name]
    return limits


def _model_profile(model: dict) -> dict:
    return {
        "name": model["name"],
        "api_key_env": model["secret_name"] + "_OPENAI_API_KEY",
        "retries": 0,
        **({"reasoning_effort": model["reasoning_effort"]} if "reasoning_effort" in model else {}),
    }


def _credential_available(environment: Mapping[str, str], name: str) -> bool:
    secret = environment.get(name)
    return (
        isinstance(secret, str)
        and 0 < len(secret) <= 4096
        and all(33 <= ord(character) <= 126 for character in secret)
    )


def _approved_integer(
    environment: Mapping[str, str], key: str, default=None, *, ceiling=MAX_APPROVED_COST_MICROUSD
) -> int:
    value = environment.get(key, default)
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,6}", value):
        raise ValueError("Search requires a bounded positive integer approval")
    result = int(value)
    if result > ceiling:
        raise ValueError("Search approval exceeds the hosted policy ceiling")
    return result


def _load_search_configuration(provider: str, environment: Mapping[str, str]) -> dict:
    prefix = "SOURCESQL_" + provider.upper()
    version = environment.get(prefix + "_POLICY_VERSION", SEARCH_POLICY_VERSIONS[provider])
    research = version == SEARCH_RESEARCH_POLICY_VERSIONS[provider]
    if version not in {SEARCH_POLICY_VERSIONS[provider], SEARCH_RESEARCH_POLICY_VERSIONS[provider]}:
        raise ValueError("Unknown hosted search policy version")
    approved = _approved_integer(
        environment,
        prefix + "_APPROVED_COST_MICROUSD",
        str(DEFAULT_APPROVED_COST_MICROUSD),
        ceiling=MAX_RESEARCH_APPROVED_COST_MICROUSD if research else MAX_APPROVED_COST_MICROUSD,
    )
    request_cost = _approved_integer(environment, prefix + "_REQUEST_COST_MICROUSD")
    if request_cost > approved:
        raise ValueError("Search approval cannot cover one estimated request")
    secret_name = environment.get(prefix + "_SECRET_NAME")
    if not isinstance(secret_name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", secret_name):
        raise ValueError("Use a simple configured MotherDuck Flight secret name")
    model = _model_configuration(environment) if research else None
    embedding = _embedding_configuration(environment) if research else None
    descriptor = {
        "approved_cost_microusd": approved,
        **({"limits": _research_limits(model, embedding), "model": model} if research else {}),
        **({"embedding": embedding} if embedding is not None else {}),
        "provider": provider,
        "request_cost_microusd": request_cost,
        "secret_name": secret_name,
        "version": version,
    }
    fingerprint = hashlib.sha256(
        json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode("ascii")
    ).hexdigest()
    profile = {
        "mode": "live",
        "provider": provider,
        "api_key_env": secret_name + "_" + provider.upper() + "_API_KEY",
        "allow_live": True,
        "approved_cost_microusd": approved,
        "metering_policy": "estimated",
        "allowed_source_hosts": [],
        "hosted_profile_fingerprint": fingerprint,
        **({"allow_public_source_hosts": True} if research else {}),
        **({"model": _model_profile(model)} if model is not None else {}),
        **({"embedding": _embedding_profile(embedding)} if embedding is not None else {}),
    }
    return {
        "profiles": {provider: profile},
        "allowed_profiles": ("fixture", provider),
        "provider_policy_sha256": fingerprint,
        "descriptor": descriptor,
    }


def load_configuration(environment: Mapping[str, str] | None = None) -> dict:
    environment = os.environ if environment is None else environment
    enabled_providers = []
    for provider in ("exa", "brave", "serper"):
        enabled = environment.get("SOURCESQL_ALLOW_LIVE_" + provider.upper(), "0")
        if enabled not in {"", "0", "1"}:
            raise ValueError("Live search enablement must be 0 or 1")
        if enabled == "1":
            enabled_providers.append(provider)
    if len(enabled_providers) > 1:
        raise ValueError("Configure one live search provider per reviewed Flight")
    if not enabled_providers:
        return {
            "profiles": {},
            "allowed_profiles": ("fixture",),
            "provider_policy_sha256": None,
            "descriptor": None,
        }
    if enabled_providers[0] != "exa":
        return _load_search_configuration(enabled_providers[0], environment)
    version = environment.get("SOURCESQL_EXA_POLICY_VERSION", POLICY_VERSION)
    if version not in {"exa-search.v1", POLICY_VERSION, RESEARCH_POLICY_VERSION}:
        raise ValueError("Unknown hosted Exa policy version")
    research = version == RESEARCH_POLICY_VERSION
    if not research and any(
        key in environment
        for key in ("SOURCESQL_OPENAI_EMBEDDING_MODEL", "SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME")
    ):
        raise ValueError("Embedding scoring requires the hosted Exa research v3 policy")
    if not research and "SOURCESQL_OPENAI_REASONING_EFFORT" in environment:
        raise ValueError("Reasoning effort requires the hosted Exa research v3 policy")
    search_types = SEARCH_TYPES if version != "exa-search.v1" else {"exa": "auto"}
    model = _model_configuration(environment) if research else None
    embedding = _embedding_configuration(environment) if research else None
    approval = environment.get(
        "SOURCESQL_EXA_APPROVED_COST_MICROUSD", str(DEFAULT_APPROVED_COST_MICROUSD)
    )
    if not re.fullmatch(r"[1-9][0-9]{0,6}", approval):
        raise ValueError("Exa requires a bounded positive integer approval")
    approved = int(approval)
    ceiling = MAX_RESEARCH_APPROVED_COST_MICROUSD if research else MAX_APPROVED_COST_MICROUSD
    if approved > ceiling:
        raise ValueError("Exa approval exceeds this experiment's policy ceiling")
    secret_name = environment.get("SOURCESQL_EXA_SECRET_NAME") or None
    if secret_name is not None and not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", secret_name):
        raise ValueError("Use a simple configured MotherDuck Flight secret name")
    secret_environment = "EXA_API_KEY" if secret_name is None else secret_name + "_EXA_API_KEY"
    descriptor = {
        "approved_cost_microusd": approved,
        **({"limits": _research_limits(model, embedding), "model": model} if research else {}),
        **({"embedding": embedding} if embedding is not None else {}),
        **({"search_types": search_types} if version != "exa-search.v1" else {}),
        "secret_name": secret_name,
        "version": version,
    }
    fingerprint = hashlib.sha256(
        json.dumps(descriptor, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode(
            "ascii"
        )
    ).hexdigest()
    common_profile = {
        "mode": "live",
        "provider": "exa",
        "api_key_env": secret_environment,
        "allow_live": True,
        "approved_cost_microusd": approved,
        "metering_policy": "estimated",
        "fetch_adapter": "exa",
        "allowed_source_hosts": [],
        "hosted_profile_fingerprint": fingerprint,
        **({"allow_public_source_hosts": True} if research else {}),
        **({"model": _model_profile(model)} if model is not None else {}),
        **({"embedding": _embedding_profile(embedding)} if embedding is not None else {}),
    }
    return {
        "profiles": {
            name: {**common_profile, "search_type": search_type}
            for name, search_type in search_types.items()
        },
        "allowed_profiles": ("fixture", *search_types),
        "provider_policy_sha256": fingerprint,
        "descriptor": descriptor,
    }


def validate_request(
    request: dict, settings: dict, environment: Mapping[str, str] | None = None
) -> None:
    from sourcesql.contracts import Budget, SourcesQLError

    environment = os.environ if environment is None else environment
    profile_name = request.get("profile", "fixture")
    if profile_name == "fixture":
        return
    if not isinstance(profile_name, str) or profile_name not in settings["allowed_profiles"]:
        raise SourcesQLError("unsupported_capability", "Hosted profile is not enabled", "dispatch")
    if set(request).intersection(
        {
            "mode",
            "provider",
            "search_type",
            "api_key",
            "api_key_env",
            "hosted_profile_fingerprint",
            "model",
            "embedding",
            "fetch_adapter",
            "allowed_source_hosts",
            "allow_public_source_hosts",
            "reasoning_effort",
            "reasoningEffort",
        }
    ):
        raise SourcesQLError(
            "unauthorized", "Hosted provider policy cannot be overridden", "dispatch"
        )
    profile = settings["profiles"][profile_name]
    provider = settings["descriptor"].get("provider", "exa")
    research = _is_research(settings["descriptor"])
    if (
        not settings["provider_policy_sha256"]
        or profile.get("hosted_profile_fingerprint") != settings["provider_policy_sha256"]
        or profile.get("mode") != "live"
        or profile.get("provider") != provider
        or (provider == "exa" and profile.get("search_type") != SEARCH_TYPES.get(profile_name))
        or (provider != "exa" and profile_name != provider)
    ):
        raise SourcesQLError("unauthorized", "Hosted provider policy mismatch", "dispatch")
    if research:
        descriptor = settings["descriptor"]
        model = descriptor["model"]
        embedding = descriptor.get("embedding")
        descriptor_fingerprint = hashlib.sha256(
            json.dumps(descriptor, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode(
                "ascii"
            )
        ).hexdigest()
        expected_secret = (
            "EXA_API_KEY"
            if provider == "exa" and descriptor["secret_name"] is None
            else descriptor["secret_name"] + "_" + provider.upper() + "_API_KEY"
        )
        if (
            descriptor_fingerprint != settings["provider_policy_sha256"]
            or descriptor["limits"] != _research_limits(model, embedding)
            or profile.get("approved_cost_microusd") != descriptor["approved_cost_microusd"]
            or profile.get("api_key_env") != expected_secret
            or profile.get("allow_live") is not True
            or profile.get("metering_policy") != "estimated"
            or profile.get("allow_public_source_hosts") is not True
            or profile.get("fetch_adapter") != ("exa" if provider == "exa" else None)
            or profile.get("allowed_source_hosts") != []
            or profile.get("model") != (_model_profile(model) if model is not None else None)
            or profile.get("embedding")
            != (_embedding_profile(embedding) if embedding is not None else None)
        ):
            raise SourcesQLError("unauthorized", "Hosted research policy mismatch", "dispatch")
    if not _credential_available(environment, profile["api_key_env"]):
        raise SourcesQLError(
            "provider_unavailable", "Search credentials are not configured", "dispatch"
        )
    if (
        research
        and model is not None
        and not _credential_available(environment, profile["model"]["api_key_env"])
    ):
        raise SourcesQLError(
            "provider_unavailable", "Semantic model credentials are not configured", "dispatch"
        )
    source_modes = {"allow_excerpt", "require_document"} if research else {"allow_excerpt"}
    if (
        research
        and embedding is not None
        and not _credential_available(environment, profile["embedding"]["api_key_env"])
    ):
        raise SourcesQLError(
            "provider_unavailable", "Embedding credentials are not configured", "dispatch"
        )
    source_mode = request.get("source_mode")
    if not isinstance(source_mode, str) or source_mode not in source_modes:
        raise SourcesQLError(
            "unsupported_capability", "Hosted profile does not permit this source mode", "dispatch"
        )
    limits = Budget(request.get("budgets")).limits
    approved = profile["approved_cost_microusd"]
    if not 0 < limits["max_cost_microusd"] <= approved:
        raise SourcesQLError(
            "unauthorized", "Request exceeds trusted provider approval", "dispatch"
        )
    ceilings = dict(settings["descriptor"]["limits"] if research else LIMITS)
    if not research and (provider != "exa" or settings["descriptor"]["version"] == "exa-search.v1"):
        ceilings["dispatch_deadline_seconds"] = 60
    if any(limits[name] > ceiling for name, ceiling in ceilings.items()):
        raise SourcesQLError(
            "unauthorized", "Request exceeds trusted provider execution limits", "dispatch"
        )
    if provider != "exa":
        request_cost = settings["descriptor"]["request_cost_microusd"]
        if limits["max_search_requests"] * request_cost > limits["max_cost_microusd"]:
            raise SourcesQLError(
                "unauthorized", "Search attempts exceed the operator cost estimate", "dispatch"
            )


def validate_explain(explanation: dict, settings: dict | None = None) -> None:
    from sourcesql.contracts import SourcesQLError

    allowed = {"WEB_SEARCH", "SOURCE_WINDOW"}
    descriptor = (settings or {}).get("descriptor") or {}
    if _is_research(descriptor):
        allowed.add("WEB_FETCH")
        if descriptor["model"] is not None:
            allowed.update(SEMANTIC_OPERATORS)
        if descriptor.get("embedding") is not None:
            allowed.add("SEM_SCORE")
    stages = explanation.get("plan", {}).get("stages", [])
    if any(
        stage.get("stage") == "external" and stage.get("operator") not in allowed
        for stage in stages
    ):
        raise SourcesQLError(
            "unsupported_capability", "Operator is not enabled by the hosted profile", "dispatch"
        )
