"""Brave v1 and Exa HTTP adapters. No provider switching or hidden retries."""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from copy import deepcopy
from datetime import date, datetime
from time import monotonic
from typing import Any

import httpx

from ..contracts import Budget, SourcesQLError
from .common import (
    api_json,
    normalized_text,
    normalized_url,
    provider_usage,
    project_search_provenance,
    resolve_public,
    search_coverage_record,
    search_hit,
    source_record,
)


def search_options(options: dict, *, maximum: int = 20) -> int:
    if options.get("query_time") is not None:
        raise SourcesQLError(
            "unsupported_capability", "Historical search is not implemented", "acquisition"
        )
    count = options.get("per_query_limit", 20)
    if type(count) is not int or not 1 <= count <= maximum:
        raise SourcesQLError(
            "invalid_request",
            f"per_query_limit must be between 1 and {maximum}",
            "acquisition",
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
                raise SourcesQLError(
                    "invalid_request", "Invalid publication date filter", "acquisition"
                ) from None
    return count


def validate_queries(queries: list[str]) -> None:
    if not queries or any(
        not isinstance(q, str) or not q.strip() or len(q) > 2000 for q in queries
    ):
        raise SourcesQLError(
            "invalid_request", "Search requires nonempty bounded queries", "acquisition"
        )


def publication_filter(rows: list[dict], options: dict) -> list[dict]:
    if not any(options.get(k) is not None for k in ("published_after", "published_before")):
        return rows
    policy = options.get("undated_policy")
    if policy not in {"include", "exclude", "error"}:
        raise SourcesQLError(
            "invalid_request", "Publication filtering requires undated_policy", "acquisition"
        )
    result = []
    for row in rows:
        value = row.get("published_at")
        if value is None:
            if policy == "error":
                raise SourcesQLError(
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
        self.search_coverage: list[dict] = []

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
            raise SourcesQLError(
                "unsupported_capability",
                "Brave publication filtering requires explicit post-filter permission",
                "acquisition",
            )
        # Validate the missing-date policy before dispatch, even for zero returned hits.
        if dated:
            publication_filter([], options)
        if not self.api_key:
            raise SourcesQLError(
                "provider_unavailable", "Brave credentials are not configured", "acquisition"
            )
        result = []
        coverage = search_coverage_record("brave", queries, count)
        self.search_coverage.append(coverage)
        for query_index, query in enumerate(queries):
            query_coverage = coverage["queries"][query_index]
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
                "search_id": coverage["search_id"],
                "status": "dispatched",
                "usage": provider_usage("brave"),
            }
            self.events.append(event)
            query_coverage["status"] = "dispatched"
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
                    raise SourcesQLError("invalid_output", "Invalid Brave results", "acquisition")
                query_coverage["returned_hits"] = len(hits)
                rows = []
                for rank, hit in enumerate(hits[:count], 1):
                    if not isinstance(hit, dict) or not isinstance(hit.get("url"), str):
                        raise SourcesQLError("invalid_output", "Invalid Brave hit", "acquisition")
                    description = hit.get("description")
                    snippet = (
                        normalized_text(description, html=True)
                        if isinstance(description, str)
                        else None
                    )
                    extras = hit.get("extra_snippets") or []
                    if not isinstance(extras, list) or any(not isinstance(s, str) for s in extras):
                        raise SourcesQLError(
                            "invalid_output", "Invalid Brave excerpts", "acquisition"
                        )
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
                        search_hit("brave", coverage["search_id"], query, query_index, rank)
                    ]
                    project_search_provenance(row)
                    self.hits.extend(row["hits"])
                    rows.append(row)
                event.update(
                    status="completed",
                    usage=provider_usage("brave", body),
                    more_results_available=body.get("query", {}).get("more_results_available"),
                )
                retained = publication_filter(rows, options)
                query_coverage.update(status="completed", retained_hits=len(retained))
                result.extend(retained)
            except SourcesQLError as error:
                event["status"] = (
                    "remote_outcome_unknown"
                    if getattr(error, "remote_outcome_unknown", False)
                    else "failed"
                )
                query_coverage["status"] = event["status"]
                raise
        return result


class ExaProvider:
    endpoint = "https://api.exa.ai"
    search_types = ("auto", "deep", "deep-reasoning")

    def __init__(
        self,
        api_key: str,
        client: httpx.Client | None = None,
        resolver=None,
        *,
        search_type: str = "auto",
    ):
        if not isinstance(search_type, str) or search_type not in self.search_types:
            raise SourcesQLError(
                "unsupported_capability", "Unsupported Exa search type", "acquisition"
            )
        self.search_type = search_type
        self.api_key = api_key
        # Deep-reasoning's documented latency exceeds the ordinary 20-second read
        # timeout. A caller-supplied client retains its explicit timeout policy.
        timeout = 60 if search_type == "deep-reasoning" else 20
        self.client = client or httpx.Client(
            timeout=timeout, trust_env=False, follow_redirects=False
        )
        self.events: list[dict] = []
        self.hits: list[dict] = []
        self.search_coverage: list[dict] = []
        self.resolver = resolver
        self.stage_journal: dict[str, Any] | None = None
        self.stage_options: dict[str, Any] | None = None

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
            "search_type": self.search_type,
            "supported_search_types": list(self.search_types),
            "multi_query": "separate_requests_with_per_query_limits_and_lineage",
            "additional_queries": False,
            "max_per_query_results": 100,
            "concurrent_queries": "budget_bounded_maximum_four",
            "fetch": True,
            "fresh_fetch": "maxAgeHours=0",
        }

    @staticmethod
    def _check_dispatch(budget: Budget, deadline: float | None = None) -> None:
        if budget.cancelled:
            raise SourcesQLError("cancelled", "Run cancelled", "dispatch")
        if deadline is not None and monotonic() >= deadline:
            raise SourcesQLError("budget_exhausted", "Dispatch deadline exhausted", "dispatch")

    def _reserve_request(self, path: str, budget: Budget, counter: str) -> dict:
        if not self.api_key:
            raise SourcesQLError(
                "provider_unavailable", "Exa credentials are not configured", "acquisition"
            )
        budget.reserve(counter, limit="max_" + counter)
        event: dict[str, Any] = {
            "kind": "fetch" if counter == "fetches" else "search",
            "provider": "exa",
            "status": "reserved",
            "usage": provider_usage("exa"),
        }
        if path == "/search":
            event["search_type"] = self.search_type
        self.events.append(event)
        return event

    def _request(
        self,
        path: str,
        body: dict,
        budget: Budget,
        counter: str,
        *,
        event: dict | None = None,
        deadline: float | None = None,
    ) -> dict:
        event = event if event is not None else self._reserve_request(path, budget, counter)
        try:
            self._check_dispatch(budget, deadline)
            event["status"] = "dispatched"
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
            if path == "/search":
                # Exa deprecates this field and may send an empty string. Retain
                # provider telemetry verbatim, without using it for dispatch.
                resolved = result.get("resolvedSearchType")
                event["resolved_search_type"] = resolved if isinstance(resolved, str) else None
            return result
        except SourcesQLError as error:
            event["status"] = (
                "not_dispatched"
                if event["status"] == "reserved"
                else (
                    "remote_outcome_unknown"
                    if getattr(error, "remote_outcome_unknown", False)
                    else "failed"
                )
            )
            raise

    def _rows(self, body: dict) -> list[dict]:
        hits = body.get("results")
        if not isinstance(hits, list):
            raise SourcesQLError("invalid_output", "Invalid Exa results", "acquisition")
        rows = []
        for hit in hits:
            if not isinstance(hit, dict) or not isinstance(hit.get("url"), str):
                raise SourcesQLError("invalid_output", "Invalid Exa hit", "acquisition")
            highlights = hit.get("highlights") or []
            if not isinstance(highlights, list) or any(not isinstance(s, str) for s in highlights):
                raise SourcesQLError("invalid_output", "Invalid Exa highlights", "acquisition")
            content = hit.get("text")
            if content is not None and not isinstance(content, str):
                raise SourcesQLError("invalid_output", "Invalid Exa source text", "acquisition")
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

    def _search_body(self, query: str, options: dict, count: int) -> dict:
        body: dict[str, Any] = {
            "query": query,
            "type": self.search_type,
            "contents": {"highlights": True},
        }
        if count != 10:
            body["numResults"] = count
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
        return body

    def _journal_search(self, queries, options, budget, count, coverage, deadline, concurrency):
        """Owner-thread journal/budget operations around bounded HTTP-only workers."""
        journal = self.stage_journal
        if not isinstance(journal, dict) or any(
            not callable(journal.get(key)) for key in ("begin", "finish", "fail")
        ):
            raise SourcesQLError(
                "invalid_request", "Invalid search checkpoint callbacks", "acquisition"
            )
        stage_options = dict(self.stage_options if self.stage_options is not None else options)
        acquired, errors, stage_keys, bounds = {}, {}, {}, {}
        owners, aliases, cached = {}, {}, set()
        pending: dict[Future, int] = {}
        next_query, pending_slots = 0, 0

        def failed(index, key, error):
            if key is None:
                return
            if not isinstance(error, SourcesQLError):
                safe_error = SourcesQLError(
                    "execution_failed", "Search stage failed", "acquisition"
                )
                event = next(
                    (
                        event
                        for event in self.events
                        if event.get("search_id") == coverage["search_id"]
                        and event.get("query_index") == index
                    ),
                    {},
                )
                setattr(
                    safe_error,
                    "remote_outcome_unknown",
                    event.get("status") in {"dispatched", "remote_outcome_unknown"},
                )
                error = safe_error
            try:
                journal["fail"](key, error)
            except Exception as journal_error:
                # A terminal write failure cannot abandon already started siblings.
                errors[index] = journal_error

        with ThreadPoolExecutor(
            max_workers=concurrency, thread_name_prefix="sourcesql-exa"
        ) as pool:
            while pending or (next_query < len(queries) and not errors):
                while not errors and next_query < len(queries) and len(pending) < concurrency:
                    index, query = next_query, queries[next_query]
                    if query in owners:
                        aliases[index] = owners[query]
                        coverage["queries"][index].update(
                            checkpoint_reused=True, reuse_query_index=owners[query]
                        )
                        next_query += 1
                        continue
                    key = None
                    try:
                        key, retained, reused = journal["begin"](
                            "WEB_SEARCH", [query], stage_options
                        )
                        stage_keys[index] = key
                        owners[query] = index
                        if reused:
                            acquired[index] = retained
                            cached.add(index)
                            coverage["queries"][index].update(
                                status="completed",
                                retained_hits=len(retained),
                                checkpoint_reused=True,
                            )
                            next_query += 1
                            continue
                        self._check_dispatch(budget, deadline)
                        available = (
                            budget.limits["max_candidates"]
                            - budget.counts.get("candidates", 0)
                            - pending_slots
                        )
                        unstarted = len(set(queries[index:]) - (set(owners) - {query}))
                        bound = min(count, available // unstarted)
                        if bound < 1:
                            raise SourcesQLError(
                                "budget_exhausted", "Candidate allowance exhausted", "dispatch"
                            )
                        budget.reserve("search_queries", limit="max_search_queries")
                        event = self._reserve_request("/search", budget, "search_requests")
                        event.update(query_index=index, search_id=coverage["search_id"])
                        coverage["queries"][index].update(status="reserved", effective_limit=bound)
                        future = pool.submit(
                            self._request,
                            "/search",
                            self._search_body(query, options, bound),
                            budget,
                            "search_requests",
                            event=event,
                            deadline=deadline,
                        )
                        bounds[index] = bound
                        pending_slots += bound
                        pending[future] = index
                        next_query += 1
                    except Exception as error:
                        errors[index] = error
                        failed(index, key, error)
                if not pending:
                    break
                done, _ = wait(pending, timeout=0.05, return_when=FIRST_COMPLETED)
                for future in sorted(done, key=pending.__getitem__):
                    index = pending.pop(future)
                    bound, key = bounds.pop(index), stage_keys[index]
                    query_coverage = coverage["queries"][index]
                    try:
                        result = future.result()
                        query_coverage.update(
                            returned_hits=len(result["results"])
                            if isinstance(result.get("results"), list)
                            else None,
                            request_id=result.get("requestId")
                            if isinstance(result.get("requestId"), str)
                            else None,
                        )
                        rows = self._rows(result)[:bound]
                        for rank, row in enumerate(rows, 1):
                            row["hits"] = [
                                search_hit(
                                    "exa",
                                    coverage["search_id"],
                                    queries[index],
                                    index,
                                    rank,
                                    result.get("requestId"),
                                )
                            ]
                            project_search_provenance(row)
                        budget.reserve("candidates", len(rows), "max_candidates")
                        journal["finish"](key, "WEB_SEARCH", rows)
                        acquired[index] = rows
                        query_coverage.update(status="completed", retained_hits=len(rows))
                    except Exception as error:
                        errors[index] = error
                        event = next(
                            (
                                event
                                for event in self.events
                                if event.get("search_id") == coverage["search_id"]
                                and event.get("query_index") == index
                            ),
                            {},
                        )
                        if event.get("status") == "completed":
                            event["status"] = "failed"
                        query_coverage["status"] = event.get("status", "failed")
                        failed(index, key, error)
                    finally:
                        pending_slots -= bound
                if not errors:
                    try:
                        self._check_dispatch(budget, deadline)
                    except SourcesQLError as error:
                        errors[next_query] = error
        for index, owner in aliases.items():
            if owner in acquired:
                acquired[index] = deepcopy(acquired[owner])
                cached.add(index)
                coverage["queries"][index].update(
                    status="completed", retained_hits=len(acquired[index]), checkpoint_reused=True
                )
        rows = []
        for index in sorted(acquired):
            for row in acquired[index]:
                if index not in cached:
                    self.hits.extend(row["hits"])
                rows.append(row)
        if errors:
            raise errors[min(errors)]
        return rows

    def search(self, queries: list[str], options: dict, budget: Budget) -> list[dict]:
        validate_queries(queries)
        count = search_options({"per_query_limit": 10, **options}, maximum=100)
        if (
            any(options.get(k) is not None for k in ("published_after", "published_before"))
            and options.get("undated_policy", "exclude") != "exclude"
        ):
            raise SourcesQLError(
                "unsupported_capability",
                "Exa native publication filters require undated_policy='exclude'",
                "acquisition",
            )
        concurrency = min(budget.limits["max_concurrency"], 4, len(queries))
        if concurrency < 1:
            raise SourcesQLError(
                "budget_exhausted", "External concurrency allowance exhausted", "dispatch"
            )
        deadline = monotonic() + budget.limits["dispatch_deadline_seconds"]
        coverage = search_coverage_record("exa", queries, count)
        self.search_coverage.append(coverage)
        if getattr(self, "stage_journal", None) is not None:
            return self._journal_search(
                queries, options, budget, count, coverage, deadline, concurrency
            )

        # Exa's additionalQueries merges all variations into one ranked result
        # pool without per-query attribution. SQL's variadic WEB_SEARCH promises
        # a limit and honest hit lineage for each input, so retain one request per
        # query; deep modes still perform Exa's internal multi-step retrieval.
        def request_body(query: str) -> dict:
            return self._search_body(query, options, count)

        def acquire(query_index: int, query: str, body: dict, event: dict) -> list[dict]:
            query_coverage = coverage["queries"][query_index]
            try:
                result = self._request(
                    "/search", body, budget, "search_requests", event=event, deadline=deadline
                )
                result_rows = []
                query_coverage.update(
                    returned_hits=len(result["results"])
                    if isinstance(result.get("results"), list)
                    else None,
                    request_id=result.get("requestId")
                    if isinstance(result.get("requestId"), str)
                    else None,
                )
                rows = self._rows(result)
                for rank, row in enumerate(rows[:count], 1):
                    row["hits"] = [
                        search_hit(
                            "exa",
                            coverage["search_id"],
                            query,
                            query_index,
                            rank,
                            result.get("requestId"),
                        )
                    ]
                    project_search_provenance(row)
                    result_rows.append(row)
                query_coverage.update(status="completed", retained_hits=len(result_rows))
                return result_rows
            except Exception:
                if event["status"] == "completed":
                    event["status"] = "failed"
                query_coverage["status"] = event["status"]
                raise

        # Only the owner thread reserves attempts and creates events. At most
        # `concurrency` requests are in flight, so failure/cancellation stops
        # further dispatch without leaving an executor queue of hidden work.
        acquired: dict[int, list[dict]] = {}
        errors: dict[int, Exception] = {}
        next_query = 0
        pending: dict[Future, int] = {}
        with ThreadPoolExecutor(
            max_workers=concurrency, thread_name_prefix="sourcesql-exa"
        ) as pool:
            while pending or (next_query < len(queries) and not errors):
                while not errors and next_query < len(queries) and len(pending) < concurrency:
                    query_index = next_query
                    query = queries[query_index]
                    try:
                        self._check_dispatch(budget, deadline)
                        budget.reserve("search_queries", limit="max_search_queries")
                        event = self._reserve_request("/search", budget, "search_requests")
                        event["query_index"] = query_index
                        event["search_id"] = coverage["search_id"]
                        coverage["queries"][query_index]["status"] = "reserved"
                        pending[
                            pool.submit(acquire, query_index, query, request_body(query), event)
                        ] = query_index
                        next_query += 1
                    except Exception as error:
                        errors[query_index] = error
                if not pending:
                    break
                done, _ = wait(pending, timeout=0.05, return_when=FIRST_COMPLETED)
                for future in sorted(done, key=pending.__getitem__):
                    query_index = pending.pop(future)
                    try:
                        acquired[query_index] = future.result()
                    except Exception as error:
                        errors[query_index] = error
                if not errors:
                    try:
                        self._check_dispatch(budget, deadline)
                    except SourcesQLError as error:
                        errors[next_query] = error
                # Already dispatched HTTP requests have bounded client timeouts.
                # Drain their outcomes before returning; never retry or abandon
                # an unknown remote effect merely because another query failed.
        rows = []
        for query_index in sorted(acquired):
            for row in acquired[query_index]:
                self.hits.extend(row["hits"])
                rows.append(row)
        if errors:
            raise errors[min(errors)]
        return rows

    def fetch(self, urls: list[str], options: dict, budget: Budget) -> list[dict]:
        # URL authorization is performed by ProviderRegistry before external disclosure.
        mode = options.get("mode", "cache_preferred")
        if mode not in {"cache_preferred", "live"}:
            raise SourcesQLError("unsupported_capability", "Unsupported fetch mode", "acquisition")
        rows = []
        # One URL per dispatch gives exact attempt accounting and per-source failure isolation.
        for url in urls:
            requested_url = normalized_url(url)
            if self.resolver is None:
                resolve_public(requested_url)
            else:
                resolve_public(requested_url, self.resolver)
            body: dict[str, Any] = {"urls": [requested_url], "text": {"maxCharacters": 16000}}
            if mode == "live":
                body.update(maxAgeHours=0, livecrawlTimeout=10000)
            result = self._request("/contents", body, budget, "fetches")
            statuses = result.get("statuses")
            successful = (
                isinstance(statuses, list)
                and len(statuses) == 1
                and isinstance(statuses[0], dict)
                and statuses[0].get("status") == "success"
            )
            acquired = self._rows(result) if successful else []
            if acquired and (len(acquired) != 1 or acquired[0]["url"] != requested_url):
                raise SourcesQLError(
                    "unauthorized", "Exa returned an unrequested source URL", "acquisition"
                )
            if not acquired or acquired[0]["content"] is None:
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
        self.search_coverage: list[dict] = []

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
            raise SourcesQLError(
                "unsupported_capability",
                "Serper publication filtering requires explicit post-filter permission",
                "acquisition",
            )
        if dated:
            publication_filter([], options)
        if not self.api_key:
            raise SourcesQLError(
                "provider_unavailable", "Serper credentials are not configured", "acquisition"
            )
        rows = []
        coverage = search_coverage_record("serper", queries, count)
        self.search_coverage.append(coverage)
        for query_index, query in enumerate(queries):
            query_coverage = coverage["queries"][query_index]
            budget.reserve("search_queries", limit="max_search_queries")
            body = {"q": query, "num": count}
            for key in ("gl", "hl"):
                if key in options:
                    body[key] = options[key]
            budget.reserve("search_requests", limit="max_search_requests")
            event = {
                "kind": "search",
                "provider": "serper",
                "search_id": coverage["search_id"],
                "query_index": query_index,
                "status": "dispatched",
                "usage": provider_usage("serper"),
            }
            self.events.append(event)
            query_coverage["status"] = "dispatched"
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
                    raise SourcesQLError("invalid_output", "Invalid Serper results", "acquisition")
                query_coverage["returned_hits"] = len(hits)
                result_rows = []
                for rank, hit in enumerate(hits[:count], 1):
                    if not isinstance(hit, dict) or not isinstance(hit.get("link"), str):
                        raise SourcesQLError("invalid_output", "Invalid Serper hit", "acquisition")
                    snippet = hit.get("snippet")
                    if snippet is not None and not isinstance(snippet, str):
                        raise SourcesQLError(
                            "invalid_output", "Invalid Serper excerpt", "acquisition"
                        )
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
                        search_hit("serper", coverage["search_id"], query, query_index, rank)
                    ]
                    project_search_provenance(row)
                    self.hits.extend(row["hits"])
                    result_rows.append(row)
                event["status"] = "completed"
                retained = publication_filter(result_rows, options)
                query_coverage.update(status="completed", retained_hits=len(retained))
                rows.extend(retained)
            except SourcesQLError as error:
                event["status"] = (
                    "remote_outcome_unknown"
                    if getattr(error, "remote_outcome_unknown", False)
                    else "failed"
                )
                query_coverage["status"] = event["status"]
                raise
        return rows
