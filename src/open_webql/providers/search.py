"""Brave v1 and Exa HTTP adapters. No provider switching or hidden retries."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import httpx

from ..contracts import Budget, WebQLError
from .common import api_json, normalized_text, provider_usage, resolve_public, source_record


def search_options(options: dict) -> int:
    if options.get("query_time") is not None:
        raise WebQLError(
            "unsupported_capability", "Historical search is not implemented", "acquisition"
        )
    count = options.get("per_query_limit", 20)
    if type(count) is not int or not 1 <= count <= 20:
        raise WebQLError(
            "invalid_request", "per_query_limit must be between 1 and 20", "acquisition"
        )
    for name in ("published_after", "published_before"):
        value = options.get(name)
        if value is not None:
            try:
                if not isinstance(value, str):
                    raise ValueError
                if len(value) == 10:
                    date.fromisoformat(value)
                elif datetime.fromisoformat(value.replace("Z", "+00:00")).utcoffset() is None:
                    raise ValueError
            except ValueError:
                raise WebQLError(
                    "invalid_request", "Invalid publication date filter", "acquisition"
                ) from None
    return count


def validate_queries(queries: list[str]) -> None:
    if not queries or any(
        not isinstance(q, str) or not q.strip() or len(q) > 2000 for q in queries
    ):
        raise WebQLError(
            "invalid_request", "Search requires nonempty bounded queries", "acquisition"
        )


def publication_filter(rows: list[dict], options: dict) -> list[dict]:
    if not any(options.get(k) is not None for k in ("published_after", "published_before")):
        return rows
    policy = options.get("undated_policy")
    if policy not in {"include", "exclude", "error"}:
        raise WebQLError(
            "invalid_request", "Publication filtering requires undated_policy", "acquisition"
        )
    result = []
    for row in rows:
        value = row.get("published_at")
        if value is None:
            if policy == "error":
                raise WebQLError(
                    "invalid_output", "Source publication date is unavailable", "acquisition"
                )
            if policy == "include":
                result.append(row)
            continue
        day = value[:10]
        if options.get("published_after") and day < options["published_after"][:10]:
            continue
        if options.get("published_before") and day > options["published_before"][:10]:
            continue
        result.append(row)
    return result


def actual_date(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        if len(value) == 10:
            date.fromisoformat(value)
        elif datetime.fromisoformat(value.replace("Z", "+00:00")).utcoffset() is None:
            return None
        return value
    except ValueError:
        return None


class BraveProvider:
    endpoint = "https://api.search.brave.com/res/v1/web/search"

    def __init__(self, api_key: str, client: httpx.Client | None = None):
        self.api_key = api_key
        self.client = client or httpx.Client(timeout=20, trust_env=False, follow_redirects=False)
        self.events: list[dict] = []
        self.hits: list[dict] = []

    def capabilities(self) -> dict:
        return {
            "provider": "brave",
            "implemented": True,
            "configured": bool(self.api_key),
            "live_qualified": False,
            "publication_filters": "explicit_local_only",
            "historical_search": False,
            "content_basis": "excerpt",
            "cost_reporting": "unavailable",
            "pagination": "single_page_only",
        }

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        validate_queries(queries)
        count = search_options(options)
        dated = any(options.get(k) is not None for k in ("published_after", "published_before"))
        if dated and options.get("allow_post_filter") is not True:
            raise WebQLError(
                "unsupported_capability",
                "Brave publication filtering requires explicit post-filter permission",
                "acquisition",
            )
        # Validate the missing-date policy before dispatch, even for zero returned hits.
        if dated:
            publication_filter([], options)
        if not self.api_key:
            raise WebQLError(
                "provider_unavailable", "Brave credentials are not configured", "acquisition"
            )
        result = []
        for query_index, query in enumerate(queries):
            budget.reserve("search_queries", limit="max_search_queries")
            params: dict[str, Any] = {"q": query, "count": count, "extra_snippets": "true"}
            for key in ("country", "search_lang", "ui_lang", "safesearch"):
                if key in options:
                    params[key] = options[key]
            budget.reserve("search_requests", limit="max_search_requests")
            event = {
                "kind": "search",
                "provider": "brave",
                "query_index": query_index,
                "status": "dispatched",
                "usage": provider_usage("brave"),
            }
            self.events.append(event)
            try:
                body = api_json(
                    self.client,
                    "GET",
                    self.endpoint,
                    headers={"X-Subscription-Token": self.api_key, "Accept": "application/json"},
                    params=params,
                )
                hits = body.get("web", {}).get("results", [])
                if not isinstance(hits, list):
                    raise WebQLError("invalid_output", "Invalid Brave results", "acquisition")
                rows = []
                for rank, hit in enumerate(hits[:count], 1):
                    if not isinstance(hit, dict) or not isinstance(hit.get("url"), str):
                        raise WebQLError("invalid_output", "Invalid Brave hit", "acquisition")
                    description = hit.get("description")
                    snippet = (
                        normalized_text(description, html=True)
                        if isinstance(description, str)
                        else None
                    )
                    extras = hit.get("extra_snippets") or []
                    if not isinstance(extras, list) or any(not isinstance(s, str) for s in extras):
                        raise WebQLError("invalid_output", "Invalid Brave excerpts", "acquisition")
                    content = "\n".join(
                        s for s in [snippet, *(normalized_text(s, html=True) for s in extras)] if s
                    )
                    row = source_record(
                        hit["url"],
                        content or None,
                        title=hit.get("title"),
                        snippet=snippet,
                        basis="excerpt",
                        complete=False,
                        published_at=actual_date(hit.get("page_age")),
                        provider="brave",
                    )
                    row["hits"] = [
                        {
                            "provider": "brave",
                            "query": query,
                            "query_index": query_index,
                            "rank": rank,
                        }
                    ]
                    self.hits.extend(row["hits"])
                    rows.append(row)
                event.update(
                    status="completed",
                    usage=provider_usage("brave", body),
                    more_results_available=body.get("query", {}).get("more_results_available"),
                )
                result.extend(publication_filter(rows, options))
            except WebQLError as error:
                event["status"] = (
                    "remote_outcome_unknown"
                    if getattr(error, "remote_outcome_unknown", False)
                    else "failed"
                )
                raise
        return result


class ExaProvider:
    endpoint = "https://api.exa.ai"

    def __init__(self, api_key: str, client: httpx.Client | None = None, resolver=None):
        self.api_key = api_key
        self.client = client or httpx.Client(timeout=20, trust_env=False, follow_redirects=False)
        self.events: list[dict] = []
        self.hits: list[dict] = []
        self.resolver = resolver

    def capabilities(self) -> dict:
        return {
            "provider": "exa",
            "implemented": True,
            "configured": bool(self.api_key),
            "live_qualified": False,
            "publication_filters": "native",
            "historical_search": False,
            "content_basis": "provider_text_or_excerpt",
            "cost_reporting": "provider_estimate_not_billing",
            "pagination": False,
            "fetch": True,
            "fresh_fetch": "maxAgeHours=0",
        }

    def _request(self, path: str, body: dict, budget: Budget, counter: str) -> dict:
        if not self.api_key:
            raise WebQLError(
                "provider_unavailable", "Exa credentials are not configured", "acquisition"
            )
        budget.reserve(counter, limit="max_" + counter)
        event: dict[str, Any] = {
            "kind": "fetch" if counter == "fetches" else "search",
            "provider": "exa",
            "status": "dispatched",
            "usage": provider_usage("exa"),
        }
        self.events.append(event)
        try:
            result = api_json(
                self.client,
                "POST",
                self.endpoint + path,
                headers={"x-api-key": self.api_key},
                body=body,
            )
            event.update(
                status="completed",
                request_id=result.get("requestId"),
                usage=provider_usage("exa", result),
            )
            return result
        except WebQLError as error:
            event["status"] = (
                "remote_outcome_unknown"
                if getattr(error, "remote_outcome_unknown", False)
                else "failed"
            )
            raise

    def _rows(self, body: dict) -> list[dict]:
        hits = body.get("results")
        if not isinstance(hits, list):
            raise WebQLError("invalid_output", "Invalid Exa results", "acquisition")
        rows = []
        for hit in hits:
            if not isinstance(hit, dict) or not isinstance(hit.get("url"), str):
                raise WebQLError("invalid_output", "Invalid Exa hit", "acquisition")
            highlights = hit.get("highlights") or []
            if not isinstance(highlights, list) or any(not isinstance(s, str) for s in highlights):
                raise WebQLError("invalid_output", "Invalid Exa highlights", "acquisition")
            content = hit.get("text")
            if content is not None and not isinstance(content, str):
                raise WebQLError("invalid_output", "Invalid Exa source text", "acquisition")
            basis = "provider_text" if content is not None else "excerpt"
            row = source_record(
                hit["url"],
                content if content is not None else "\n".join(highlights) or None,
                title=hit.get("title"),
                snippet="\n".join(highlights) or None,
                basis=basis,
                complete=False,
                published_at=actual_date(hit.get("publishedDate")),
                acquired_at=actual_date(hit.get("crawledDate")),
                provider="exa",
            )
            row["provider_document_id"] = hit.get("id")
            rows.append(row)
        return rows

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        validate_queries(queries)
        count = search_options(options)
        rows = []
        for query_index, query in enumerate(queries):
            body: dict[str, Any] = {
                "query": query,
                "numResults": count,
                "type": "auto",
                "contents": {"text": {"maxCharacters": 16000}},
            }
            for source, target in (
                ("published_after", "startPublishedDate"),
                ("published_before", "endPublishedDate"),
            ):
                if options.get(source) is not None:
                    value = options[source]
                    body[target] = value + "T00:00:00Z" if len(value) == 10 else value
            for source, target in (
                ("include_domains", "includeDomains"),
                ("exclude_domains", "excludeDomains"),
            ):
                if source in options:
                    body[target] = options[source]
            budget.reserve("search_queries", limit="max_search_queries")
            result = self._request("/search", body, budget, "search_requests")
            for rank, row in enumerate(self._rows(result)[:count], 1):
                row["hits"] = [
                    {
                        "provider": "exa",
                        "query": query,
                        "query_index": query_index,
                        "rank": rank,
                        "request_id": result.get("requestId"),
                    }
                ]
                self.hits.extend(row["hits"])
                rows.append(row)
        return rows

    def fetch(self, urls: list[str], options: dict, budget: Budget) -> list[dict]:
        # URL authorization is performed by ProviderRegistry before external disclosure.
        mode = options.get("mode", "cache_preferred")
        if mode not in {"cache_preferred", "live"}:
            raise WebQLError("unsupported_capability", "Unsupported fetch mode", "acquisition")
        rows = []
        # One URL per dispatch gives exact attempt accounting and per-source failure isolation.
        for url in urls:
            if self.resolver is None:
                resolve_public(url)
            else:
                resolve_public(url, self.resolver)
            result = self._request(
                "/contents",
                {
                    "urls": [url],
                    "text": {"maxCharacters": 16000},
                    "maxAgeHours": 0 if mode == "live" else 24,
                },
                budget,
                "fetches",
            )
            acquired = self._rows(result)
            if not acquired:
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
                rows.extend(acquired)
        return rows


class SerperProvider:
    """Ordinary organic search, with no answer synthesis or hidden semantic provider."""

    endpoint = "https://google.serper.dev/search"

    def __init__(self, api_key: str, client: httpx.Client | None = None):
        self.api_key = api_key
        self.client = client or httpx.Client(timeout=20, trust_env=False, follow_redirects=False)
        self.events: list[dict] = []
        self.hits: list[dict] = []

    def capabilities(self) -> dict:
        return {
            "provider": "serper",
            "implemented": True,
            "configured": bool(self.api_key),
            "live_qualified": False,
            "publication_filters": "explicit_local_only",
            "historical_search": False,
            "content_basis": "excerpt",
            "cost_reporting": "unavailable",
            "pagination": "single_page_only",
        }

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        validate_queries(queries)
        count = search_options(options)
        dated = any(options.get(k) is not None for k in ("published_after", "published_before"))
        if dated and options.get("allow_post_filter") is not True:
            raise WebQLError(
                "unsupported_capability",
                "Serper publication filtering requires explicit post-filter permission",
                "acquisition",
            )
        if dated:
            publication_filter([], options)
        if not self.api_key:
            raise WebQLError(
                "provider_unavailable", "Serper credentials are not configured", "acquisition"
            )
        rows = []
        for query_index, query in enumerate(queries):
            budget.reserve("search_queries", limit="max_search_queries")
            body = {"q": query, "num": count}
            for key in ("gl", "hl"):
                if key in options:
                    body[key] = options[key]
            budget.reserve("search_requests", limit="max_search_requests")
            event = {
                "kind": "search",
                "provider": "serper",
                "status": "dispatched",
                "usage": provider_usage("serper"),
            }
            self.events.append(event)
            try:
                result = api_json(
                    self.client,
                    "POST",
                    self.endpoint,
                    headers={"X-API-KEY": self.api_key},
                    body=body,
                )
                hits = result.get("organic")
                if not isinstance(hits, list):
                    raise WebQLError("invalid_output", "Invalid Serper results", "acquisition")
                result_rows = []
                for rank, hit in enumerate(hits[:count], 1):
                    if not isinstance(hit, dict) or not isinstance(hit.get("link"), str):
                        raise WebQLError("invalid_output", "Invalid Serper hit", "acquisition")
                    snippet = hit.get("snippet")
                    if snippet is not None and not isinstance(snippet, str):
                        raise WebQLError("invalid_output", "Invalid Serper excerpt", "acquisition")
                    row = source_record(
                        hit["link"],
                        snippet,
                        title=hit.get("title"),
                        snippet=snippet,
                        basis="excerpt",
                        complete=False,
                        published_at=actual_date(hit.get("date")),
                        provider="serper",
                    )
                    row["hits"] = [
                        {
                            "query": query,
                            "query_index": query_index,
                            "rank": rank,
                            "provider": "serper",
                        }
                    ]
                    self.hits.extend(row["hits"])
                    result_rows.append(row)
                event["status"] = "completed"
                rows.extend(publication_filter(result_rows, options))
            except WebQLError as error:
                event["status"] = (
                    "remote_outcome_unknown"
                    if getattr(error, "remote_outcome_unknown", False)
                    else "failed"
                )
                raise
        return rows
