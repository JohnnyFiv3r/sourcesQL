"""Explicit trusted provider profiles. The default dispatches only synthetic fixtures."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit

from ..contracts import Budget, SemanticOutcome, SourcesQLError
from .common import SafeFetcher, normalized_url, resolve_public, project_search_provenance
from .fixture import FixtureProvider
from .deepseek import DeepSeekProvider
from .search import BraveProvider, ExaProvider, SerperProvider, search_options, validate_queries
from .semantic import OpenAIEmbeddingProvider, PydanticSemanticProvider, TYPES

__all__ = [
    "ProviderRegistry",
    "FixtureProvider",
    "BraveProvider",
    "ExaProvider",
    "SerperProvider",
    "DeepSeekProvider",
    "SafeFetcher",
    "PydanticSemanticProvider",
    "OpenAIEmbeddingProvider",
]


class ProviderRegistry:
    def __init__(self, profile: dict | None = None):
        self.profile = dict(profile or {})
        self.mode = self.profile.get("mode", "fixture")
        if self.mode not in {"fixture", "live"}:
            raise SourcesQLError("invalid_request", "Provider mode must be fixture or live")
        self.fixture = FixtureProvider(self.profile.get("fixture_version", "t1"))
        self.search_provider: Any = self.fixture
        self.semantic_provider: Any = self.fixture
        self.embedding_provider: Any = self.fixture
        self.fetch_provider: Any = self.fixture
        self._extra_events: list[dict] = []
        if self.mode == "live":
            provider = self.profile.get("provider", "brave")
            providers = {
                "brave": BraveProvider,
                "exa": ExaProvider,
                "serper": SerperProvider,
                "deepseek": DeepSeekProvider,
            }
            if provider not in providers:
                raise SourcesQLError("unsupported_capability", "Unknown search provider")
            credentials = self.profile.get("api_key")
            if credentials is None and self.profile.get("api_key_env"):
                credentials = os.environ.get(self.profile["api_key_env"])
            kwargs = {"api_key": credentials or "", "client": self.profile.get("http_client")}
            if provider == "exa":
                kwargs["search_type"] = self.profile.get("search_type", "auto")
            if provider == "deepseek":
                kwargs["request_cost_microusd"] = self.profile.get("request_cost_microusd", 750)
            if provider in {"exa", "deepseek"} and self.profile.get("resolver") is not None:
                kwargs["resolver"] = self.profile["resolver"]
            self.search_provider = providers[provider](**kwargs)
            self.fetch_provider = SafeFetcher(
                client=self.profile.get("fetch_client"),
                allowed_hosts=(
                    None
                    if self.profile.get("allow_public_source_hosts") is True
                    else self.profile.get("allowed_source_hosts")
                ),
                **({"resolver": self.profile["resolver"]} if self.profile.get("resolver") else {}),
            )
            if provider in {"exa", "deepseek"} and self.profile.get("fetch_adapter") == provider:
                self.fetch_provider = self.search_provider
            self.semantic_provider = None
            self.embedding_provider = None
            if self.profile.get("semantic_provider") is not None:
                self.semantic_provider = self.profile["semantic_provider"]
            elif self.profile.get("model") is not None:
                model_config = self.profile["model"]
                if isinstance(model_config, dict):
                    key = model_config.get("api_key") or os.environ.get(
                        model_config.get("api_key_env", "")
                    )
                    if key:
                        self.semantic_provider = PydanticSemanticProvider.openai(
                            model_config["name"],
                            key,
                            base_url=model_config.get("base_url"),
                            retries=model_config.get("retries", 0),
                            reasoning_effort=model_config.get("reasoning_effort"),
                        )
                else:
                    self.semantic_provider = PydanticSemanticProvider(model_config)
            if self.profile.get("embedding_provider") is not None:
                self.embedding_provider = self.profile["embedding_provider"]
            elif isinstance(self.profile.get("embedding"), dict):
                config = self.profile["embedding"]
                key = config.get("api_key") or os.environ.get(config.get("api_key_env", ""))
                if key:
                    self.embedding_provider = OpenAIEmbeddingProvider(
                        config["name"],
                        key,
                        client=config.get("client"),
                        endpoint=config.get("endpoint", "https://api.openai.com/v1/embeddings"),
                        encoding_name=config.get("encoding"),
                    )

    @property
    def events(self) -> list[dict]:
        providers = [
            self.search_provider,
            self.fetch_provider,
            self.semantic_provider,
            self.embedding_provider,
        ]
        result = list(self._extra_events)
        seen = set()
        for provider in providers:
            if provider is not None and id(provider) not in seen:
                seen.add(id(provider))
                result.extend(getattr(provider, "events", []))
        return result

    @property
    def hits(self) -> list[dict]:
        return self.search_provider.hits

    def capabilities(self) -> dict:
        return {
            "mode": self.mode,
            "search": self.search_provider.capabilities(),
            "semantic": {
                "implemented": True,
                "configured": self.semantic_provider is not None,
                "live_qualified": False,
                "operators": ["SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"],
            },
            "score": {
                "implemented": True,
                "configured": self.embedding_provider is not None,
                "live_qualified": False,
                "basis": "fixture_lookup_only"
                if self.mode == "fixture"
                else "configured_embeddings",
                **(
                    {
                        "input_max_tokens": OpenAIEmbeddingProvider.MAX_INPUT_TOKENS,
                        "batch_max_tokens": OpenAIEmbeddingProvider.MAX_BATCH_TOKENS,
                        "batch_max_inputs": OpenAIEmbeddingProvider.MAX_BATCH_INPUTS,
                        "adapter_version": OpenAIEmbeddingProvider.CONTRACT_VERSION,
                        "token_accounting": "model_tokenizer_before_dispatch",
                    }
                    if isinstance(self.embedding_provider, OpenAIEmbeddingProvider)
                    else {}
                ),
            },
            "metering": "fixture" if self.mode == "fixture" else "estimated_only",
            "token_limits": "output_per_request_and_reported_totals",
            "fetch": {"implemented": True, "live_qualified": False, "formats": ["html", "text"]},
        }

    def _authorize(self, budget: Budget) -> None:
        if self.mode == "fixture":
            return
        approved = self.profile.get("approved_cost_microusd")
        if (
            self.profile.get("allow_live") is not True
            or type(approved) is not int
            or approved <= 0
            or budget.limits.get("max_cost_microusd", 0) <= 0
            or budget.limits["max_cost_microusd"] > approved
        ):
            raise SourcesQLError(
                "unauthorized", "Live dispatch requires a trusted finite spending grant", "dispatch"
            )
        if self.profile.get("metering_policy", "strict") != "estimated":
            raise SourcesQLError(
                "unsupported_capability",
                "This profile cannot enforce strict total cash/token metering",
                "dispatch",
            )

    def preflight(self, operators, budget: Budget) -> None:
        """Refuse unavailable profile capabilities before any provider can acquire data."""
        operators = set(operators) - {"SOURCE_WINDOW"}
        if not operators:
            return
        if budget.limits["max_concurrency"] < 1:
            raise SourcesQLError(
                "budget_exhausted", "External concurrency allowance exhausted", "dispatch"
            )
        self._authorize(budget)
        if "WEB_SEARCH" in operators and not self.search_provider.capabilities().get(
            "configured", True
        ):
            raise SourcesQLError(
                "provider_unavailable", "Search credentials are not configured", "acquisition"
            )
        if "SEM_SCORE" in operators and self.embedding_provider is None:
            raise SourcesQLError(
                "unsupported_capability", "No embedding scorer is configured", "semantic"
            )
        if "SEM_SCORE" in operators and isinstance(
            self.embedding_provider, OpenAIEmbeddingProvider
        ):
            self.embedding_provider.preflight()
        if (
            operators.intersection({"SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"})
            and self.semantic_provider is None
        ):
            raise SourcesQLError(
                "unsupported_capability", "No semantic model is configured", "semantic"
            )
        if (
            self.mode == "live"
            and "WEB_FETCH" in operators
            and not self.profile.get("allowed_source_hosts")
            and self.profile.get("allow_public_source_hosts") is not True
        ):
            raise SourcesQLError(
                "unauthorized", "Live fetch requires permitted source hosts", "acquisition"
            )

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        self._authorize(budget)
        validate_queries(queries)
        if isinstance(self.search_provider, DeepSeekProvider):
            self.search_provider.validate_queries(queries)
        search_settings = (
            {"per_query_limit": 10, **options}
            if self.mode == "live" and self.profile.get("provider") in {"exa", "deepseek"}
            else options
        )
        requested_limit = search_options(
            search_settings,
            maximum=(
                {"exa": 100, "deepseek": 50}.get(self.profile.get("provider", ""), 20)
                if self.mode == "live"
                else 20
            ),
        )
        remaining = budget.limits["max_candidates"] - budget.counts.get("candidates", 0)
        per_query_limit = min(requested_limit, remaining // len(queries))
        if per_query_limit < 1 and not hasattr(self, "stage_call"):
            raise SourcesQLError("budget_exhausted", "Candidate allowance exhausted", "acquisition")
        bounded_options = {**options, "per_query_limit": per_query_limit}
        if isinstance(self.search_provider, ExaProvider) and hasattr(self, "stage_journal"):
            self.search_provider.stage_journal = self.stage_journal
            self.search_provider.stage_options = {**options, "per_query_limit": requested_limit}
            rows = self.search_provider.search(
                queries, {**options, "per_query_limit": requested_limit}, budget
            )
        elif hasattr(self, "stage_call"):
            rows = []
            for index, query in enumerate(queries):

                def acquire_query():
                    available = budget.limits["max_candidates"] - budget.counts.get("candidates", 0)
                    bound = min(requested_limit, available // (len(queries) - index))
                    if bound < 1:
                        raise SourcesQLError(
                            "budget_exhausted", "Candidate allowance exhausted", "dispatch"
                        )
                    found = self.search_provider.search(
                        [query], {**options, "per_query_limit": bound}, budget
                    )
                    # Count intake before checkpoint completion. Reuse must never
                    # bypass a candidate reservation lost after acquisition.
                    budget.reserve("candidates", len(found), "max_candidates")
                    return found

                found, reused = self.stage_call(
                    "WEB_SEARCH",
                    [query],
                    {**options, "per_query_limit": requested_limit},
                    acquire_query,
                )
                rows.extend(found)
        else:
            rows = self.search_provider.search(queries, bounded_options, budget)
            budget.reserve("candidates", len(rows), "max_candidates")
        # Keep query membership while preserving independently acquired source versions.
        deduplicated: dict[tuple, dict] = {}
        for row in rows:
            for hit in row.get("hits", []):
                hit.update(
                    url=row["url"],
                    document_id=row["document_id"],
                    source_version_id=row["source_version_id"],
                )
            key = (row["url"], row["source_version_id"])
            if key in deduplicated:
                deduplicated[key]["hits"].extend(row.get("hits", []))
            else:
                deduplicated[key] = row
        rows = list(deduplicated.values())
        if options.get("source_mode") == "require_document":
            missing = [r["url"] for r in rows if not r["coverage"]["complete"]]
            if missing:
                fetched = {
                    normalized_url(r.get("original_url", r["url"])): r
                    for r in self.fetch(missing, {}, budget)
                }
                assured = []
                for row in rows:
                    if row["url"] in missing:
                        fetch_row = fetched.get(row["url"])
                        if (
                            fetch_row is None
                            or fetch_row.get("status") != "acquired"
                            or not fetch_row["coverage"]["complete"]
                        ):
                            raise SourcesQLError(
                                "provider_unavailable",
                                "Required complete source text could not be acquired",
                                "acquisition",
                            )
                        fetch_row["hits"] = row.get("hits", [])
                        row = fetch_row
                    assured.append(row)
                rows = assured
        return [project_search_provenance(row) for row in rows]

    def fetch(self, urls: list[str], options: dict, budget: Budget) -> list[dict]:
        self._authorize(budget)
        if not isinstance(urls, list) or any(not isinstance(url, str) for url in urls):
            raise SourcesQLError("invalid_request", "Fetch URLs must be strings", "acquisition")
        if self.mode == "live":
            allowed = self.profile.get("allowed_source_hosts")
            public_sources = self.profile.get("allow_public_source_hosts") is True
            if not public_sources and (not isinstance(allowed, list) or not allowed):
                raise SourcesQLError(
                    "unauthorized", "Live fetch requires permitted source hosts", "acquisition"
                )
            for url in urls:
                host = urlsplit(normalized_url(url)).hostname
                if not public_sources and host not in (
                    allowed if isinstance(allowed, list) else []
                ):
                    raise SourcesQLError(
                        "unauthorized", "Source destination is not permitted", "acquisition"
                    )
                resolver = self.profile.get("resolver")
                resolve_public(url, resolver) if resolver else resolve_public(url)
        if isinstance(self.fetch_provider, DeepSeekProvider):
            self.fetch_provider.validate_fetch(urls, options)
        if hasattr(self, "stage_call"):
            rows = []
            for url in urls:
                found, _ = self.stage_call(
                    "WEB_FETCH",
                    [url],
                    options,
                    lambda url=url: self.fetch_provider.fetch([url], options, budget),
                )
                rows.extend(found)
        else:
            rows = self.fetch_provider.fetch(urls, options, budget)
        if options.get("source_mode") == "require_document" and any(
            row.get("status") == "acquired" and not row.get("coverage", {}).get("complete")
            for row in rows
        ):
            raise SourcesQLError(
                "provider_unavailable",
                "Required complete source text could not be acquired",
                "acquisition",
            )
        return rows

    def semantic(
        self,
        operator: str,
        text: Any,
        instruction: str,
        fields: dict[str, str],
        options: dict,
        budget: Budget,
    ) -> SemanticOutcome:
        self._authorize(budget)
        if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 4000:
            raise SourcesQLError(
                "invalid_request", "Semantic instruction must be bounded nonempty text", "semantic"
            )
        if options.get("type", "VARCHAR") not in TYPES:
            raise SourcesQLError(
                "unsupported_capability", "Unsupported extraction type", "semantic"
            )
        if operator == "SEM_SCORE":
            if self.embedding_provider is None:
                raise SourcesQLError(
                    "unsupported_capability", "No embedding scorer is configured", "semantic"
                )
            if self.mode == "fixture":
                return self.fixture.semantic(operator, text, instruction, fields, options, budget)
            return self.embedding_provider.score(text, instruction, options, budget)
        if self.semantic_provider is None:
            raise SourcesQLError(
                "unsupported_capability", "No semantic model is configured", "semantic"
            )
        return self.semantic_provider.semantic(operator, text, instruction, fields, options, budget)

    def score_many(self, texts: list, criterion: str, options: dict, budget: Budget):
        """One admitted scoring stage; a scorer must preserve every input position."""
        self._authorize(budget)
        if not isinstance(criterion, str) or not criterion.strip() or len(criterion) > 4000:
            raise SourcesQLError(
                "invalid_request", "Semantic instruction must be bounded nonempty text", "semantic"
            )
        if self.embedding_provider is None:
            raise SourcesQLError(
                "unsupported_capability", "No embedding scorer is configured", "semantic"
            )
        batch = getattr(self.embedding_provider, "score_many", None)
        if self.mode != "fixture" and callable(batch):
            return batch(texts, criterion, options, budget)
        return [self.semantic("SEM_SCORE", text, criterion, {}, options, budget) for text in texts]
