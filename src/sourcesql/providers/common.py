"""Retained source representations and bounded HTTP dispatch primitives."""

from __future__ import annotations

from datetime import datetime, timezone
from copy import deepcopy
import hashlib
from html.parser import HTMLParser
import ipaddress
import json
import re
import socket
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit
from uuid import uuid4

import httpx

from ..contracts import Budget, SourcesQLError, digest
from ..provider_rates import DEEPSEEK_REQUEST_COST_MICROUSD


class ProviderTransportError(SourcesQLError):
    remote_outcome_unknown = True
    effect_state = "outcome_unknown"


def provider_effect_state(status: Any) -> str:
    """Translate bounded adapter event state, without guessing from error codes."""
    if status is None or status in {"reserved", "not_dispatched"}:
        return "not_dispatched"
    if status == "failed":
        return "rejected"
    if status in {"completed", "completed_validation_failed", "invalid_output"}:
        return "completed_unretained"
    return "outcome_unknown"


_EXA_ERROR_TAGS = {
    "INVALID_API_KEY",
    "NO_MORE_CREDITS",
    "API_KEY_BUDGET_EXCEEDED",
    "TEAM_BUDGET_EXCEEDED",
    "FEATURE_DISABLED",
    "PROHIBITED_CONTENT",
    "CONTENT_FILTER_ERROR",
    "RATE_LIMIT_EXCEEDED",
    "SERVICE_OVERLOADED",
    "INVALID_REQUEST_BODY",
    "INVALID_REQUEST",
    "INVALID_NUM_RESULTS",
    "NUM_RESULTS_EXCEEDED",
    "INVALID_JSON_SCHEMA",
    "SUBPAGES_LIMIT_EXCEEDED",
}


def provider_http_error(response: httpx.Response, provider: str | None = None) -> SourcesQLError:
    """Keep bounded routing facts, never provider messages, headers or arbitrary tags.

    A provider's refusal says nothing about whether its depleted balance was free
    or purchased. Likewise, a rate limit does not establish a billing shortage.
    """
    error = SourcesQLError("provider_unavailable", "Provider request failed", "acquisition")
    error.effect_state = "rejected"
    error.remote_outcome_unknown = False
    error.http_status = response.status_code
    tag = None
    if provider == "exa":
        raw = bytearray()
        try:
            for chunk in response.iter_bytes():
                if len(raw) + len(chunk) > 16_384:
                    break
                raw.extend(chunk)
            else:
                body = json_object(bytes(raw))
                if isinstance(body.get("tag"), str) and body["tag"] in _EXA_ERROR_TAGS:
                    tag = error.provider_error_tag = body["tag"]
                request_id = body.get("requestId")
                if isinstance(request_id, str) and re.fullmatch(r"[0-9a-fA-F]{16,64}", request_id):
                    error.request_id = request_id
        except (SourcesQLError, httpx.HTTPError, RecursionError):
            # The HTTP refusal is known even when optional diagnostics are absent.
            pass
    retry_after = response.headers.get("Retry-After", "")
    if re.fullmatch(r"[0-9]{1,8}", retry_after):
        seconds = int(retry_after)
        if seconds <= 604_800:
            error.retry_after_seconds = seconds
    if provider in {"exa", "brave", "serper", "deepseek"} and response.status_code in {402, 429}:
        limit_kind = (
            "rate"
            if response.status_code == 429
            else "credits"
            if tag == "NO_MORE_CREDITS"
            else "spend"
            if tag in {"API_KEY_BUDGET_EXCEEDED", "TEAM_BUDGET_EXCEEDED"}
            else "unknown"
        )
        error.provider_capacity = {
            "resource": "search_model_budget",
            "reason": "provider_limit",
            "period": "unknown",
            "allowance": "unknown",
            "services": [provider],
            "limit_kind": limit_kind,
            "http_status": response.status_code,
            **(
                {"retry_after_seconds": error.retry_after_seconds}
                if hasattr(error, "retry_after_seconds")
                else {}
            ),
        }
    return error


def capture_provider_failure(event: dict, error: SourcesQLError) -> None:
    """Copy only adapter-created failure diagnostics into the durable receipt."""
    for name in (
        "http_status",
        "provider_error_tag",
        "request_id",
        "retry_after_seconds",
        "provider_capacity",
    ):
        if hasattr(error, name):
            event[name] = deepcopy(getattr(error, name))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.suppressed = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in {"script", "style", "template"}:
            self.suppressed += 1
        elif tag in {"p", "div", "br", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "template"}:
            self.suppressed = max(0, self.suppressed - 1)
        elif tag in {"p", "div", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.suppressed:
            self.parts.append(data)


def normalized_text(text: str, *, html: bool = False) -> str:
    if html:
        parser = _Text()
        parser.feed(text)
        text = "".join(parser.parts)
    # Coordinates always refer to this exact retained representation, in code points.
    return "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip())


def normalized_url(url: str) -> str:
    try:
        parts = urlsplit(url)
        port = parts.port
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
        ):
            raise ValueError
        host = parts.hostname.encode("idna").decode().lower().rstrip(".")
        if ":" in host:
            host = f"[{host}]"
        netloc = host if port in {None, 80 if parts.scheme == "http" else 443} else f"{host}:{port}"
        return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
    except (ValueError, UnicodeError):
        raise SourcesQLError("invalid_request", "Invalid HTTP source URL", "acquisition") from None


def search_coverage_record(provider: str, queries: list[str], limit: int) -> dict[str, Any]:
    """One local search invocation, distinct from a provider request or an entity."""
    return {
        "search_id": "search_" + uuid4().hex,
        "provider": provider,
        "requested_queries": len(queries),
        "requested_per_query_limit": limit,
        "coverage": "provider_returned_hits_only",
        "corpus_complete": False,
        "queries": [
            {
                "query_index": index,
                "query": query,
                "requested_limit": limit,
                "status": "not_dispatched",
                "returned_hits": None,
                "retained_hits": 0,
                "request_id": None,
            }
            for index, query in enumerate(queries)
        ],
    }


def search_hit(
    provider: str,
    search_id: str,
    query: str,
    query_index: int,
    rank: int,
    request_id: Any = None,
) -> dict[str, Any]:
    return {
        "provider": provider,
        "search_id": search_id,
        "query": query,
        "query_index": query_index,
        "rank": rank,
        "request_id": request_id if isinstance(request_id, str) else None,
    }


def project_search_provenance(row: dict[str, Any]) -> dict[str, Any]:
    """Expose typed hit metadata while retaining the original source-version lineage.

    A shared URL/content version can have several hits. Counts describe search
    coverage only; they never imply distinct entities, exhaustive recall or truth.
    Legacy hit records may omit search_id/request_id, which remain SQL NULL.
    """
    hits = []
    for hit in row.get("hits", []):
        hits.append(
            {
                key: hit.get(key) if isinstance(hit.get(key), str) else None
                for key in ("provider", "search_id", "query", "request_id")
            }
            | {
                key: hit.get(key) if type(hit.get(key)) is int else None
                for key in ("query_index", "rank")
            }
        )
    row.update(
        search_hits=hits,
        search_hit_count=len(hits),
        search_query_count=len(
            {(hit["provider"], hit["search_id"], hit["query_index"], hit["query"]) for hit in hits}
        ),
        best_search_rank=min(
            (hit["rank"] for hit in hits if hit["rank"] is not None), default=None
        ),
    )
    return row


def source_record(
    url: str,
    content: str | None,
    *,
    title: str | None = None,
    snippet: str | None = None,
    basis: str = "document",
    published_at: str | None = None,
    acquired_at: str | None = None,
    retrieved_at: str | None = None,
    provider: str = "fixture",
    complete: bool = True,
) -> dict[str, Any]:
    url = normalized_url(url)
    content = normalized_text(content) if content is not None else None
    content_sha256 = text_hash(content) if content is not None else None
    representation = {
        "url": url,
        "content_sha256": content_sha256,
        "basis": basis,
        "normalization": "text-v1",
        "complete": complete,
    }
    return {
        "document_id": "doc_" + digest(url)[:24],
        "url": url,
        "title": title,
        "snippet": snippet,
        "content": content,
        "content_basis": basis,
        "published_at": published_at,
        "provider_acquired_at": acquired_at,
        "retrieved_at": retrieved_at or utc_now(),
        "source_version_id": "src_" + digest(representation),
        "content_sha256": content_sha256,
        "normalization_version": "text-v1",
        "provider": provider,
        "search_hits": [],
        "search_hit_count": 0,
        "search_query_count": 0,
        "best_search_rank": None,
        "coverage": {
            "start": 0,
            "end": len(content or ""),
            "complete": complete,
            "scope": "whole_source" if complete else "provider_returned_text",
        },
        "windows": [{"start": 0, "end": len(content)}] if content else [],
        "status": "acquired",
    }


def provider_usage(
    provider: str, body: dict | None = None, *, operation: str | None = None
) -> dict[str, Any]:
    usage: dict[str, Any] = {
        "provider": provider,
        "requests": 1,
        "cost_microusd": None,
        "cost_basis": "unavailable",
        "cost_unavailable_reason": "provider_did_not_report_billing",
    }
    if provider == "fixture":
        usage.update(
            cost_microusd=0, cost_basis="fixture_no_spending", cost_unavailable_reason=None
        )
    elif provider == "deepseek" and body is not None:
        # Published nonempty-request pricing is an estimate, never an invoice.
        # A malformed body or transport timeout cannot establish a free request.
        billable = None
        if operation == "search" and isinstance(body.get("results"), list):
            billable = bool(body["results"])
        elif operation == "fetch" and isinstance(body.get("content"), str):
            billable = bool(body["content"].strip())
        if billable is not None:
            usage.update(
                estimated_cost_microusd=DEEPSEEK_REQUEST_COST_MICROUSD if billable else 0,
                cost_basis="published_rate_estimate",
                cost_unavailable_reason="published_rate_is_not_billing",
            )
    elif body and isinstance(body.get("costDollars"), dict):
        total = body["costDollars"].get("total")
        if type(total) in {int, float} and total >= 0 and total < float("inf"):
            usage.update(
                estimated_cost_microusd=round(total * 1_000_000),
                cost_basis="provider_estimate",
                cost_unavailable_reason="response_estimate_is_not_billing",
            )
    return usage


def json_object(raw: bytes) -> dict[str, Any]:
    def unique_pairs(pairs: list) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=unique_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, UnicodeError):
        raise SourcesQLError(
            "invalid_output", "Provider returned invalid JSON", "acquisition"
        ) from None


def read_response(
    response: httpx.Response, max_bytes: int, *, provider: str | None = None
) -> bytes:
    if response.status_code >= 400:
        raise provider_http_error(response, provider)
    content = bytearray()
    for chunk in response.iter_bytes():
        if len(content) + len(chunk) > max_bytes:
            raise SourcesQLError(
                "invalid_output", "Provider response exceeds byte limit", "acquisition"
            )
        content.extend(chunk)
    return bytes(content)


def api_json(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    headers: dict,
    params: dict | None = None,
    body: dict | None = None,
    max_bytes: int = 2_097_152,
    provider: str | None = None,
) -> dict:
    try:
        with client.stream(
            method, url, headers=headers, params=params, json=body, follow_redirects=False
        ) as response:
            if response.is_redirect:
                error = SourcesQLError(
                    "provider_unavailable", "Unexpected API redirect", "acquisition"
                )
                error.effect_state = "rejected"
                raise error
            try:
                return json_object(read_response(response, max_bytes, provider=provider))
            except SourcesQLError as error:
                if response.is_success:
                    # A successful response followed by local parsing/size
                    # rejection is paid work, never a pre-dispatch refusal.
                    error.effect_state = "completed_unretained"
                raise
    except httpx.HTTPError:
        transport_error = ProviderTransportError(
            "provider_unavailable", "Provider transport failed", "acquisition"
        )
        raise transport_error from None


def resolve_public(url: str, resolver: Callable = socket.getaddrinfo) -> tuple[str, str, int]:
    """Validate every DNS address and pin the connection to a validated address."""
    parsed = urlsplit(normalized_url(url))
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in {80, 443}:
        raise SourcesQLError("unauthorized", "Source port is not permitted", "acquisition")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise SourcesQLError("unauthorized", "Source address is not public", "acquisition")
    try:
        addresses = {entry[4][0] for entry in resolver(host, port, type=socket.SOCK_STREAM)}
        if not addresses:
            raise ValueError
        for value in addresses:
            addr = ipaddress.ip_address(value)
            if not addr.is_global or (
                addr.version == 6
                and addr.ipv4_mapped is not None
                and not addr.ipv4_mapped.is_global
            ):
                raise ValueError
    except (ValueError, OSError):
        raise SourcesQLError(
            "unauthorized", "Source address is not public", "acquisition"
        ) from None
    return host, sorted(addresses)[0], port


class SafeFetcher:
    """HTML/text fetcher with pinned public DNS, checked redirects and byte ceilings."""

    def __init__(
        self,
        client: httpx.Client | None = None,
        resolver: Callable = socket.getaddrinfo,
        max_bytes: int = 2_097_152,
        max_redirects: int = 3,
        allowed_hosts: list[str] | None = None,
    ):
        self.client = client or httpx.Client(timeout=20, trust_env=False, follow_redirects=False)
        self.resolver, self.max_bytes, self.max_redirects = resolver, max_bytes, max_redirects
        self.events: list[dict] = []
        self.allowed_hosts = allowed_hosts

    def fetch(self, urls: list[str], options: dict, budget: Budget) -> list[dict]:
        if options.get("mode", "live") not in {"live", "cache_preferred"}:
            raise SourcesQLError("unsupported_capability", "Unsupported fetch mode", "acquisition")
        records = []
        for original in urls:
            url = normalized_url(original)
            try:
                for redirect in range(self.max_redirects + 1):
                    host, addr, port = resolve_public(url, self.resolver)
                    if self.allowed_hosts is not None and host not in self.allowed_hosts:
                        raise SourcesQLError(
                            "unauthorized", "Source destination is not permitted", "acquisition"
                        )
                    parts = urlsplit(url)
                    ip_host = f"[{addr}]" if ":" in addr else addr
                    target = urlunsplit(
                        (parts.scheme, f"{ip_host}:{port}", parts.path, parts.query, "")
                    )
                    budget.reserve("fetches", limit="max_fetches")
                    event = {
                        "kind": "fetch",
                        "url": url,
                        "status": "dispatched",
                        "usage": provider_usage("http"),
                    }
                    self.events.append(event)
                    try:
                        with self.client.stream(
                            "GET",
                            target,
                            headers={"Host": parts.netloc, "Accept": "text/html,text/plain"},
                            extensions={"sni_hostname": host},
                            follow_redirects=False,
                        ) as response:
                            if response.is_redirect:
                                event["status"] = "redirect"
                                if redirect == self.max_redirects or not response.headers.get(
                                    "location"
                                ):
                                    raise SourcesQLError(
                                        "provider_unavailable",
                                        "Fetch redirect limit",
                                        "acquisition",
                                    )
                                url = normalized_url(urljoin(url, response.headers["location"]))
                                continue
                            media = response.headers.get("content-type", "").split(";")[0].lower()
                            if media not in {"text/html", "text/plain", "application/xhtml+xml"}:
                                raise SourcesQLError(
                                    "unsupported_capability",
                                    "Only HTML/text fetch is supported",
                                    "acquisition",
                                )
                            raw = read_response(response, self.max_bytes)
                            encoding = response.encoding or "utf-8"
                            try:
                                content = normalized_text(
                                    raw.decode(encoding, errors="strict"),
                                    html=media != "text/plain",
                                )
                            except (UnicodeError, LookupError):
                                raise SourcesQLError(
                                    "invalid_output", "Invalid source text encoding", "acquisition"
                                ) from None
                        event["status"] = "completed"
                        record = source_record(url, content, provider="http", acquired_at=utc_now())
                        record["original_url"] = original
                        record["acquisition_mode"] = "live"
                        records.append(record)
                        break
                    except httpx.HTTPError:
                        event["status"] = "remote_outcome_unknown"
                        raise SourcesQLError(
                            "provider_unavailable", "Fetch transport failed", "acquisition"
                        ) from None
            except SourcesQLError as error:
                if self.events and self.events[-1]["status"] == "dispatched":
                    self.events[-1]["status"] = "failed"
                if error.code in {"budget_exhausted", "cancelled"}:
                    raise
                records.append(
                    {
                        "url": original,
                        "status": "fetch_failed",
                        "error_code": error.code,
                        "content": None,
                        "content_basis": None,
                    }
                )
        return records
