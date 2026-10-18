"""Fixed DeepSeek Search/Fetch API. Summaries and ranking are metadata, not evidence."""

from __future__ import annotations

import math
from time import monotonic
from urllib.parse import urlsplit

import httpx

from ..contracts import Budget, SourcesQLError
from .common import (
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


class DeepSeekProvider:
    endpoint = "https://api.deepseek.com/v1/tools"

    def __init__(
        self,
        api_key: str,
        client: httpx.Client | None = None,
        resolver=None,
        *,
        request_cost_microusd: int = 750,
    ):
        if type(request_cost_microusd) is not int or request_cost_microusd < 750:
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
    def _rows(body: dict) -> list[dict]:
        hits = body.get("results")
        if not isinstance(hits, list):
            raise SourcesQLError("invalid_output", "Invalid DeepSeek results", "acquisition")
        rows = []
        for hit in hits:
            if not isinstance(hit, dict) or not isinstance(hit.get("url"), str):
                raise SourcesQLError("invalid_output", "Invalid DeepSeek hit", "acquisition")
            for key in ("url", "title", "snippet", "summary", "content"):
                if key in hit and not isinstance(hit[key], str):
                    raise SourcesQLError(
                        "invalid_output", "Invalid DeepSeek source text", "acquisition"
                    )
                if key in hit:
                    try:
                        hit[key].encode("utf-8")
                    except UnicodeError:
                        raise SourcesQLError(
                            "invalid_output", "Invalid DeepSeek source encoding", "acquisition"
                        ) from None
            content = hit.get("content")
            if content is None:
                raise SourcesQLError(
                    "invalid_output", "Missing DeepSeek page content", "acquisition"
                )
            score, authority = hit.get("rerank_score"), hit.get("authority")
            if score is not None and (
                type(score) not in {int, float} or not math.isfinite(score) or not 0 <= score <= 3
            ):
                raise SourcesQLError(
                    "invalid_output", "Invalid DeepSeek ranking metadata", "acquisition"
                )
            if authority is not None and (type(authority) is not int or not -1 <= authority <= 4):
                raise SourcesQLError(
                    "invalid_output", "Invalid DeepSeek authority metadata", "acquisition"
                )
            row = source_record(
                hit["url"],
                content if normalized_text(content) else None,
                title=hit.get("title"),
                snippet=hit.get("snippet"),
                basis="provider_text",
                complete=False,
                published_at=actual_date(hit.get("date")),
                provider="deepseek",
            )
            row["provider_metadata"] = {
                "summary": hit.get("summary"),
                "rerank_score": score,
                "authority": authority,
            }
            rows.append(row)
        return rows

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        self.validate_queries(queries)
        if options.get("source_mode") == "require_document":
            raise SourcesQLError(
                "unsupported_capability",
                "DeepSeek cannot establish complete source documents; use allow_excerpt",
                "acquisition",
            )
        count = search_options({"per_query_limit": 10, **options}, maximum=50)
        include, exclude = (
            self._domains(options, "include_domains"),
            self._domains(options, "exclude_domains"),
        )
        dated = any(options.get(k) is not None for k in ("published_after", "published_before"))
        if dated and options.get("allow_post_filter") is not True:
            raise SourcesQLError(
                "unsupported_capability",
                "DeepSeek publication filtering requires explicit post-filter permission",
                "acquisition",
            )
        if dated:
            publication_filter([], options)
        coverage = search_coverage_record("deepseek", queries, count)
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
                parsed = self._rows(body)[:count]
                for rank, row in enumerate(parsed, 1):
                    row["hits"] = [
                        search_hit("deepseek", coverage["search_id"], query, index, rank)
                    ]
                    project_search_provenance(row)
                retained = publication_filter(parsed, options)
                retained = [
                    row
                    for row in retained
                    if (
                        not include
                        or any(
                            (urlsplit(row["url"]).hostname or "") == host
                            or (urlsplit(row["url"]).hostname or "").endswith("." + host)
                            for host in include
                        )
                    )
                    and not any(
                        (urlsplit(row["url"]).hostname or "") == host
                        or (urlsplit(row["url"]).hostname or "").endswith("." + host)
                        for host in exclude
                    )
                ]
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

    def validate_fetch(self, urls: list[str], options: dict) -> list[str]:
        """Validate the complete batch before registry checkpoint splitting can dispatch."""
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
        if not isinstance(urls, list) or any(
            not isinstance(url, str) or not url or len(url) > 8192 for url in urls
        ):
            raise SourcesQLError(
                "invalid_request", "DeepSeek fetch requires bounded HTTP URLs", "acquisition"
            )
        try:
            for url in urls:
                url.encode("utf-8")
        except UnicodeError:
            raise SourcesQLError(
                "invalid_request", "DeepSeek fetch requires valid Unicode URLs", "acquisition"
            ) from None
        requested = [normalized_url(url) for url in urls]
        try:
            for url in requested:
                url.encode("utf-8")
        except UnicodeError:
            raise SourcesQLError(
                "invalid_request", "DeepSeek fetch requires valid Unicode URLs", "acquisition"
            ) from None
        if any(len(url) > 8192 for url in requested):
            raise SourcesQLError(
                "invalid_request", "DeepSeek fetch requires bounded HTTP URLs", "acquisition"
            )
        for url in requested:
            if self.resolver is None:
                resolve_public(url)
            else:
                resolve_public(url, self.resolver)
        return requested

    def fetch(self, urls: list[str], options: dict, budget: Budget) -> list[dict]:
        requested = self.validate_fetch(urls, options)
        deadline, rows = monotonic() + budget.limits["dispatch_deadline_seconds"], []
        for url in requested:
            body, event = self._request("fetch", {"url": url}, budget, deadline)
            try:
                if not isinstance(body.get("title"), str) or not isinstance(
                    body.get("content"), str
                ):
                    raise SourcesQLError(
                        "invalid_output", "Invalid DeepSeek fetched text", "acquisition"
                    )
                try:
                    body["title"].encode("utf-8")
                    body["content"].encode("utf-8")
                except UnicodeError:
                    raise SourcesQLError(
                        "invalid_output", "Invalid DeepSeek source encoding", "acquisition"
                    ) from None
                if not normalized_text(body["content"]):
                    rows.append(
                        {
                            "url": url,
                            "content": None,
                            "content_basis": None,
                            "status": "fetch_failed",
                            "error_code": "provider_unavailable",
                        }
                    )
                else:
                    row = source_record(
                        url,
                        body["content"],
                        title=body["title"],
                        basis="provider_text",
                        complete=False,
                        provider="deepseek",
                    )
                    row["acquisition_mode"] = "cache_preferred"
                    rows.append(row)
            except SourcesQLError as error:
                self._failure(event, error)
                raise
        return rows
