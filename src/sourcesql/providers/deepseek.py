"""Fixed DeepSeek Search/Fetch API. Summaries and ranking are metadata, not evidence."""

from __future__ import annotations

from dataclasses import dataclass
import math
from types import MappingProxyType
from typing import Mapping
from time import monotonic
from urllib.parse import urlsplit

import httpx

from ..contracts import Budget, SourcesQLError
from .common import (
    DEEPSEEK_REQUEST_COST_MICROUSD,
    api_json,
    capture_provider_failure,
    normalized_text,
    normalized_url,
    project_search_provenance,
    provider_effect_state,
    provider_usage,
    resolve_public,
    search_coverage_record,
    search_hit,
    source_record,
)
from .search import actual_date, publication_filter, search_options, validate_queries


@dataclass(frozen=True)
class _PreparedSearch:
    owner: object
    queries: tuple[str, ...]
    count: int
    filters: Mapping
    include: tuple[str, ...]
    exclude: tuple[str, ...]


@dataclass(frozen=True)
class _PreparedFetch:
    owner: object
    urls: tuple[str, ...]


class DeepSeekProvider:
    endpoint = "https://api.deepseek.com/v1/tools"

    def __init__(
        self,
        api_key: str,
        client: httpx.Client | None = None,
        resolver=None,
        *,
        request_cost_microusd: int = DEEPSEEK_REQUEST_COST_MICROUSD,
    ):
        if (
            type(request_cost_microusd) is not int
            or request_cost_microusd < DEEPSEEK_REQUEST_COST_MICROUSD
        ):
            raise SourcesQLError(
                "invalid_request", "Invalid DeepSeek request estimate", "acquisition"
            )
        self.request_cost_microusd = request_cost_microusd
        self.api_key = api_key
        self.client = client or httpx.Client(timeout=20, trust_env=False, follow_redirects=False)
        self.resolver = resolver
        self.events: list[dict] = []
        self.hits: list[dict] = []
        self.search_coverage: list[dict] = []

    def capabilities(self) -> dict:
        return {
            "provider": "deepseek",
            "implemented": True,
            "configured": bool(self.api_key),
            "live_qualified": False,
            "publication_filters": "post_filter",
            "domain_filters": "post_filter",
            "historical_search": False,
            "content_basis": "provider_text_or_unavailable",
            "source_modes": ["allow_excerpt"],
            "cost_reporting": "published_rate_estimate_not_billing",
            "pagination": "single_page_only",
            "max_per_query_results": 50,
            "max_query_characters": 128,
            "multi_query": "separate_requests_with_per_query_limits_and_lineage",
            "fetch": True,
            "fresh_fetch": False,
        }

    @staticmethod
    def validate_queries(queries: list[str]) -> None:
        validate_queries(queries)
        try:
            for query in queries:
                query.encode("utf-8")
        except UnicodeError:
            raise SourcesQLError(
                "invalid_request", "DeepSeek queries require valid Unicode text", "acquisition"
            ) from None
        if any(len(query) > 128 for query in queries):
            raise SourcesQLError(
                "invalid_request",
                "DeepSeek queries require 1 to 128 Unicode characters",
                "acquisition",
            )

    @staticmethod
    def _domains(options: dict, name: str) -> list[str]:
        values = options.get(name, [])
        if not isinstance(values, list):
            raise SourcesQLError("invalid_request", "Domain filters require lists", "acquisition")
        result = []
        for value in values:
            if not isinstance(value, str) or not value or any(c in value for c in "/:@?#"):
                raise SourcesQLError("invalid_request", "Invalid domain filter", "acquisition")
            try:
                host = value.encode("idna").decode().lower().rstrip(".")
            except UnicodeError:
                raise SourcesQLError(
                    "invalid_request", "Invalid domain filter", "acquisition"
                ) from None
            if not host or any(
                not label or not label.replace("-", "").isalnum() for label in host.split(".")
            ):
                raise SourcesQLError("invalid_request", "Invalid domain filter", "acquisition")
            result.append(host)
        return result

    @staticmethod
    def _check_dispatch(budget: Budget, deadline: float) -> None:
        if budget.cancelled:
            raise SourcesQLError("cancelled", "Run cancelled", "dispatch")
        if monotonic() >= deadline:
            raise SourcesQLError("budget_exhausted", "Dispatch deadline exhausted", "dispatch")

    @staticmethod
    def _failure(event: dict, error: SourcesQLError) -> None:
        capture_provider_failure(event, error)
        if event["status"] != "completed":
            state = getattr(error, "effect_state", None)
            event["status"] = (
                "not_dispatched"
                if event["status"] == "reserved"
                else "completed_validation_failed"
                if state == "completed_unretained"
                else "remote_outcome_unknown"
                if getattr(error, "remote_outcome_unknown", False)
                else "failed"
            )
            if event["status"] == "failed":
                event["usage"].update(
                    estimated_cost_microusd=0,
                    cost_basis="published_rate_estimate",
                    cost_unavailable_reason="published_rate_is_not_billing",
                )
        error.effect_state = provider_effect_state(event["status"])
        error.remote_outcome_unknown = error.effect_state == "outcome_unknown"

    def _request(
        self, operation: str, body: dict, budget: Budget, deadline: float, **metadata
    ) -> tuple[dict, dict]:
        if not self.api_key:
            error = SourcesQLError(
                "provider_unavailable", "DeepSeek credentials are not configured", "acquisition"
            )
            error.effect_state = "not_dispatched"
            error.remote_outcome_unknown = False
            raise error
        counter = "fetches" if operation == "fetch" else "search_requests"
        event = {
            "kind": operation,
            "provider": "deepseek",
            "status": "reserved",
            "usage": provider_usage("deepseek"),
            **metadata,
        }
        self.events.append(event)
        try:
            self._check_dispatch(budget, deadline)
            budget.reserve(counter, limit="max_" + counter)
            budget.reserve(
                "estimated_provider_cost_microusd", self.request_cost_microusd, "max_cost_microusd"
            )
            event["reservation_microusd"] = self.request_cost_microusd
            self._check_dispatch(budget, deadline)
            event["status"] = "dispatched"
            result = api_json(
                self.client,
                "POST",
                self.endpoint + "/" + operation,
                headers={"Authorization": "Bearer " + self.api_key},
                body=body,
                provider="deepseek",
            )
            event.update(
                status="completed", usage=provider_usage("deepseek", result, operation=operation)
            )
            return result, event
        except SourcesQLError as error:
            self._failure(event, error)
            raise

    @staticmethod
    def _optional_text(value) -> str | None:
        if isinstance(value, str):
            try:
                value.encode("utf-8")
                return value
            except UnicodeError:
                pass
        return None

    @classmethod
    def _rows(cls, body: dict, count: int) -> tuple[list[tuple[int, dict]], int]:
        hits = body.get("results")
        if not isinstance(hits, list):
            raise SourcesQLError("invalid_output", "Invalid DeepSeek results", "acquisition")
        rows, omitted = [], 0
        for rank, hit in enumerate(hits[:count], 1):
            if not isinstance(hit, dict) or cls._optional_text(hit.get("url")) is None:
                omitted += 1
                continue
            text = {
                key: cls._optional_text(hit.get(key))
                for key in ("title", "snippet", "summary", "content")
            }
            unavailable = [
                key for key, value in text.items() if hit.get(key) is not None and value is None
            ]
            content = text["content"]
            score, authority = hit.get("rerank_score"), hit.get("authority")
            if score is not None and (
                type(score) not in {int, float} or not math.isfinite(score) or not 0 <= score <= 3
            ):
                score = None
                unavailable.append("rerank_score")
            if authority is not None and (type(authority) is not int or not -1 <= authority <= 4):
                authority = None
                unavailable.append("authority")
            try:
                row = source_record(
                    hit["url"],
                    content if content and normalized_text(content) else None,
                    title=text["title"],
                    snippet=text["snippet"],
                    basis="provider_text",
                    complete=False,
                    published_at=actual_date(hit.get("date")),
                    provider="deepseek",
                )
            except SourcesQLError:
                # An unidentifiable hit cannot be attached to evidence; retain its omission count.
                omitted += 1
                continue
            row["provider_metadata"] = {
                "summary": text["summary"],
                "rerank_score": score,
                "authority": authority,
            }
            if row["content"] is None:
                row["content_basis"] = None
                row["provider_metadata"]["content_unavailable_reason"] = (
                    "provider_page_text_unavailable"
                )
            if unavailable:
                row["provider_metadata"]["unavailable_fields"] = unavailable
            rows.append((rank, row))
        return rows, omitted

    def prepare_search(self, queries: list[str], options: dict) -> _PreparedSearch:
        """Authorize a complete batch once, before any checkpoint can dispatch a part."""
        self.validate_queries(queries)
        if options.get("source_mode") == "require_document":
            raise SourcesQLError(
                "unsupported_capability",
                "DeepSeek cannot establish complete source documents; use allow_excerpt",
                "acquisition",
            )
        count = search_options({"per_query_limit": 10, **options}, maximum=50)
        include = tuple(self._domains(options, "include_domains"))
        exclude = tuple(self._domains(options, "exclude_domains"))
        filters = {
            key: options[key]
            for key in ("published_after", "published_before", "undated_policy")
            if key in options
        }
        dated = any(filters.get(k) is not None for k in ("published_after", "published_before"))
        if dated and options.get("allow_post_filter") is not True:
            raise SourcesQLError(
                "unsupported_capability",
                "DeepSeek publication filtering requires explicit post-filter permission",
                "acquisition",
            )
        if dated:
            publication_filter([], filters)
        return _PreparedSearch(
            self, tuple(queries), count, MappingProxyType(filters), include, exclude
        )

    @staticmethod
    def _prepared_values(
        prepared: _PreparedSearch | _PreparedFetch, expected: type, owner: object, index: int | None
    ) -> tuple[str, ...]:
        if type(prepared) is not expected or prepared.owner is not owner:
            raise SourcesQLError("invalid_request", "Invalid prepared acquisition", "acquisition")
        values = prepared.queries if isinstance(prepared, _PreparedSearch) else prepared.urls
        if index is None:
            return values
        if type(index) is not int or not 0 <= index < len(values):
            raise SourcesQLError("invalid_request", "Invalid prepared index", "acquisition")
        return (values[index],)

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        return self.search_prepared(self.prepare_search(queries, options), budget)

    def search_prepared(
        self,
        prepared: _PreparedSearch,
        budget: Budget,
        *,
        index: int | None = None,
        per_query_limit: int | None = None,
    ) -> list[dict]:
        queries = self._prepared_values(prepared, _PreparedSearch, self, index)
        count = prepared.count if per_query_limit is None else per_query_limit
        if type(count) is not int or not 1 <= count <= prepared.count:
            raise SourcesQLError("invalid_request", "Invalid prepared result bound", "acquisition")
        options, include, exclude = prepared.filters, prepared.include, prepared.exclude
        coverage = search_coverage_record("deepseek", list(queries), count)
        self.search_coverage.append(coverage)
        deadline, rows = monotonic() + budget.limits["dispatch_deadline_seconds"], []
        for index, query in enumerate(queries):
            query_coverage, event = coverage["queries"][index], None
            try:
                self._check_dispatch(budget, deadline)
                budget.reserve("search_queries", limit="max_search_queries")
                body, event = self._request(
                    "search",
                    {"query": query, "count": count, "need_content": True},
                    budget,
                    deadline,
                    search_id=coverage["search_id"],
                    query_index=index,
                )
                hits = body.get("results")
                query_coverage["returned_hits"] = len(hits) if isinstance(hits, list) else None
                ranked, omitted = self._rows(body, count)
                query_coverage["omitted_hits"] = omitted
                event["omitted_hits"] = omitted
                parsed = []
                for rank, row in ranked:
                    row["hits"] = [
                        search_hit("deepseek", coverage["search_id"], query, index, rank)
                    ]
                    project_search_provenance(row)
                    parsed.append(row)
                retained = publication_filter(parsed, dict(options))
                filtered = []
                for row in retained:
                    host = urlsplit(row["url"]).hostname or ""

                    def matches(domain):
                        return host == domain or host.endswith("." + domain)

                    if (not include or any(map(matches, include))) and not any(
                        map(matches, exclude)
                    ):
                        filtered.append(row)
                retained = filtered
                query_coverage.update(status="completed", retained_hits=len(retained))
                for row in retained:
                    self.hits.extend(row["hits"])
                rows.extend(retained)
            except SourcesQLError as error:
                if event is not None:
                    self._failure(event, error)
                    query_coverage["status"] = (
                        "failed" if event["status"] == "completed" else event["status"]
                    )
                elif (
                    len(self.events)
                    and self.events[-1].get("search_id") == coverage["search_id"]
                    and self.events[-1].get("query_index") == index
                ):
                    query_coverage["status"] = self.events[-1]["status"]
                raise
        return rows

    def prepare_fetch(
        self, urls: list[str], options: dict, *, allowed_hosts: list[str] | None = None
    ) -> _PreparedFetch:
        """Authorize every normalized URL before any paid request in this batch."""
        if options.get("source_mode") == "require_document":
            raise SourcesQLError(
                "unsupported_capability",
                "DeepSeek cannot establish complete source documents; use allow_excerpt",
                "acquisition",
            )
        if options.get("mode", "cache_preferred") != "cache_preferred":
            raise SourcesQLError(
                "unsupported_capability", "DeepSeek cannot force a fresh fetch", "acquisition"
            )
        if not isinstance(urls, list) or any(not isinstance(url, str) for url in urls):
            raise SourcesQLError(
                "invalid_request", "DeepSeek fetch requires bounded HTTP URLs", "acquisition"
            )
        requested = tuple(normalized_url(url) for url in urls)
        for url in requested:
            try:
                url.encode("utf-8")
            except UnicodeError:
                raise SourcesQLError(
                    "invalid_request", "DeepSeek fetch requires valid Unicode URLs", "acquisition"
                ) from None
            if len(url) > 8192:
                raise SourcesQLError(
                    "invalid_request", "DeepSeek fetch requires bounded HTTP URLs", "acquisition"
                )
        if allowed_hosts is not None:
            permitted = set(self._domains({"hosts": allowed_hosts}, "hosts"))
            if any(urlsplit(url).hostname not in permitted for url in requested):
                raise SourcesQLError(
                    "unauthorized", "Source destination is not permitted", "acquisition"
                )
        for url in dict.fromkeys(requested):
            if self.resolver is None:
                resolve_public(url)
            else:
                resolve_public(url, self.resolver)
        return _PreparedFetch(self, requested)

    def validate_fetch(self, urls: list[str], options: dict) -> list[str]:
        return list(self.prepare_fetch(urls, options).urls)

    def fetch(self, urls: list[str], options: dict, budget: Budget) -> list[dict]:
        return self.fetch_prepared(self.prepare_fetch(urls, options), budget)

    def fetch_prepared(
        self, prepared: _PreparedFetch, budget: Budget, *, index: int | None = None
    ) -> list[dict]:
        requested = self._prepared_values(prepared, _PreparedFetch, self, index)
        deadline, rows = monotonic() + budget.limits["dispatch_deadline_seconds"], []
        for url in requested:
            try:
                body, event = self._request("fetch", {"url": url}, budget, deadline)
            except SourcesQLError as error:
                if getattr(error, "http_status", None) not in {403, 404}:
                    raise
                rows.append(
                    {
                        "url": url,
                        "content": None,
                        "content_basis": None,
                        "status": "fetch_failed",
                        "error_code": error.code,
                    }
                )
                continue
            title, content = (
                self._optional_text(body.get("title")),
                self._optional_text(body.get("content")),
            )
            if content is None or not normalized_text(content):
                rows.append(
                    {
                        "url": url,
                        "content": None,
                        "content_basis": None,
                        "status": "fetch_failed",
                        "error_code": "provider_unavailable"
                        if content is not None
                        else "invalid_output",
                    }
                )
                # A valid HTTP response completed even when it contained unusable page text.
                event["content_unavailable"] = True
                continue
            try:
                row = source_record(
                    url,
                    content,
                    title=title,
                    basis="provider_text",
                    complete=False,
                    provider="deepseek",
                )
            except SourcesQLError as error:
                self._failure(event, error)
                raise
            row["acquisition_mode"] = "cache_preferred"
            rows.append(row)
        return rows
