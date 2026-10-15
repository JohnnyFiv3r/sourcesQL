"""Trusted, opt-in Exa search policy for the credential-bearing Flight parent.

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
SEARCH_TYPES = {
    "exa": "auto",
    "exa_deep": "deep",
    "exa_deep_reasoning": "deep-reasoning",
}
DEFAULT_APPROVED_COST_MICROUSD = 50_000
MAX_APPROVED_COST_MICROUSD = 1_000_000
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


def load_configuration(environment: Mapping[str, str] | None = None) -> dict:
    environment = os.environ if environment is None else environment
    enabled = environment.get("SOURCESQL_ALLOW_LIVE_EXA", "0")
    if enabled not in {"", "0", "1"}:
        raise ValueError("Live Exa enablement must be 0 or 1")
    if enabled != "1":
        return {
            "profiles": {},
            "allowed_profiles": ("fixture",),
            "provider_policy_sha256": None,
            "descriptor": None,
        }
    approval = environment.get(
        "SOURCESQL_EXA_APPROVED_COST_MICROUSD", str(DEFAULT_APPROVED_COST_MICROUSD)
    )
    if not re.fullmatch(r"[1-9][0-9]{0,6}", approval):
        raise ValueError("Exa requires a bounded positive integer approval")
    approved = int(approval)
    if approved > MAX_APPROVED_COST_MICROUSD:
        raise ValueError("Exa approval exceeds this experiment's policy ceiling")
    secret_name = environment.get("SOURCESQL_EXA_SECRET_NAME") or None
    if secret_name is not None and not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", secret_name):
        raise ValueError("Use a simple configured MotherDuck Flight secret name")
    secret_environment = "EXA_API_KEY" if secret_name is None else secret_name + "_EXA_API_KEY"
    descriptor = {
        "approved_cost_microusd": approved,
        "search_types": SEARCH_TYPES,
        "secret_name": secret_name,
        "version": POLICY_VERSION,
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
    }
    return {
        "profiles": {
            name: {**common_profile, "search_type": search_type}
            for name, search_type in SEARCH_TYPES.items()
        },
        "allowed_profiles": ("fixture", *SEARCH_TYPES),
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
    if (
        not isinstance(profile_name, str)
        or profile_name not in SEARCH_TYPES
        or profile_name not in settings["allowed_profiles"]
    ):
        raise SourcesQLError("unsupported_capability", "Hosted profile is not enabled", "dispatch")
    if set(request).intersection(
        {"mode", "provider", "search_type", "api_key", "api_key_env", "hosted_profile_fingerprint"}
    ):
        raise SourcesQLError(
            "unauthorized", "Hosted provider policy cannot be overridden", "dispatch"
        )
    profile = settings["profiles"][profile_name]
    if (
        not settings["provider_policy_sha256"]
        or profile.get("hosted_profile_fingerprint") != settings["provider_policy_sha256"]
        or profile.get("mode") != "live"
        or profile.get("provider") != "exa"
        or profile.get("search_type") != SEARCH_TYPES[profile_name]
    ):
        raise SourcesQLError("unauthorized", "Hosted provider policy mismatch", "dispatch")
    secret = environment.get(profile["api_key_env"])
    if (
        not isinstance(secret, str)
        or not secret
        or len(secret) > 4096
        or any(ord(character) < 33 or ord(character) > 126 for character in secret)
    ):
        raise SourcesQLError(
            "provider_unavailable", "Exa credentials are not configured", "dispatch"
        )
    if request.get("source_mode") != "allow_excerpt":
        raise SourcesQLError(
            "unsupported_capability", "Hosted Exa requires provider-returned text", "dispatch"
        )
    limits = Budget(request.get("budgets")).limits
    approved = profile["approved_cost_microusd"]
    if not 0 < limits["max_cost_microusd"] <= approved:
        raise SourcesQLError("unauthorized", "Request exceeds trusted Exa approval", "dispatch")
    if any(limits[name] > ceiling for name, ceiling in LIMITS.items()):
        raise SourcesQLError(
            "unauthorized", "Request exceeds trusted Exa execution limits", "dispatch"
        )


def validate_explain(explanation: dict) -> None:
    from sourcesql.contracts import SourcesQLError

    stages = explanation.get("plan", {}).get("stages", [])
    if any(
        stage.get("stage") == "external" and stage.get("operator") != "WEB_SEARCH"
        for stage in stages
    ):
        raise SourcesQLError(
            "unsupported_capability", "Hosted Exa currently supports search only", "dispatch"
        )
