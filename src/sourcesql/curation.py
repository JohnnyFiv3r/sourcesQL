"""Explicit host-selected textual citations over already authorized source versions.

This module validates textual attribution, never the truth of a claim. It does
not discover sources, infer support from URLs/equal values, or call providers.
The caller retains responsibility for parent authorization and classification.
"""

from __future__ import annotations

import math
import re
from typing import Any, NoReturn

from sourcesql.contracts import SourcesQLError, Table, canonical, digest
from sourcesql.execution.evidence import SupportValidationContext, checked_support
from sourcesql.feature_contracts import CURATED_CITATION_CONTRACT

MAX_CITATIONS = 2048
MAX_CITATION_BYTES = 2 * 1024 * 1024
MAX_QUOTE_CHARACTERS = 12000
_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
_FORBIDDEN_KEYS = {"constructor", "prototype", "__proto__"}
_FIELDS = {"match", "column_key", "source_version_id", "quote", "start", "end"}
_REQUIRED = {"match", "column_key", "source_version_id", "quote"}


def _invalid() -> NoReturn:
    raise SourcesQLError("invalid_request", "Invalid curated citation contract", "admission")


def _key(value: Any) -> bool:
    return (
        isinstance(value, str)
        and _KEY.fullmatch(value) is not None
        and value not in _FORBIDDEN_KEYS
    )


def _wire_selector(value: Any, depth: int = 0) -> Any:
    """Normalize JSON numbers while preserving lossless strings and JSON types."""
    if depth > 8:
        _invalid()
    if value is None or type(value) is bool:
        return value
    if isinstance(value, str):
        if len(value) > 8000:
            _invalid()
        return value
    if type(value) is int:
        # Public DOUBLE values can exceed JavaScript's safe integer range.
        # Lossless integer/decimal columns use strings and never match numbers.
        if value.bit_length() > 1024:
            _invalid()
        return value
    if type(value) is float:
        if not math.isfinite(value):
            _invalid()
        return int(value) if value.is_integer() else value
    if isinstance(value, list):
        if len(value) > 1000:
            _invalid()
        return [_wire_selector(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 128 or not all(_key(key) for key in value):
            _invalid()
        return {key: _wire_selector(value[key], depth + 1) for key in sorted(value)}
    _invalid()


def validate_citations(citations: Any) -> list[dict[str, Any]]:
    """Return a bounded deterministic recipe, or refuse structural invalidity.

    Absent citations normalize to an empty list. Order and exact duplicate
    entries do not change the recipe. Quotes remain byte-for-byte text; no
    Unicode normalization or whitespace trimming changes their meaning.
    """
    if citations is None:
        return []
    if not isinstance(citations, list) or len(citations) > MAX_CITATIONS:
        _invalid()
    unique: dict[bytes, dict[str, Any]] = {}
    size = 2
    for citation in citations:
        if (
            not isinstance(citation, dict)
            or set(citation) - _FIELDS
            or not _REQUIRED <= set(citation)
        ):
            _invalid()
        selector = citation["match"]
        if (
            not isinstance(selector, dict)
            or not 1 <= len(selector) <= 8
            or not all(_key(key) for key in selector)
            or not _key(citation["column_key"])
            or not isinstance(citation["source_version_id"], str)
            or _ID.fullmatch(citation["source_version_id"]) is None
            or not isinstance(citation["quote"], str)
            or not citation["quote"].strip()
            or len(citation["quote"]) > MAX_QUOTE_CHARACTERS
            or ("start" in citation) != ("end" in citation)
        ):
            _invalid()
        normalized = {
            "match": {key: _wire_selector(selector[key]) for key in sorted(selector)},
            "column_key": citation["column_key"],
            "source_version_id": citation["source_version_id"],
            "quote": citation["quote"],
        }
        if "start" in citation:
            start, end = citation["start"], citation["end"]
            if type(start) is not int or type(end) is not int or not 0 <= start < end:
                _invalid()
            normalized.update(start=start, end=end)
        try:
            encoded = canonical(normalized)
        except (ValueError, TypeError, UnicodeError):
            _invalid()
        size += len(encoded) + 1
        if size > MAX_CITATION_BYTES:
            _invalid()
        unique[encoded] = normalized
    return [unique[encoded] for encoded in sorted(unique)]


def _same_wire(left: Any, right: Any) -> bool:
    """Boolean, numeric, string and NULL identities never coerce into each other."""
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_wire(a, b) for a, b in zip(left, right))
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            _same_wire(left[key], right[key]) for key in left
        )
    return left == right


def bind_curated_citations(
    table: Table,
    row_ids: list[str],
    sources: dict[str, dict[str, Any]],
    citations: list[dict[str, Any]],
    *,
    wire_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    """Bind a previously validated recipe without changing rows or lineage.

    ``wire_rows`` must be the table's public values converted by the caller's
    authoritative type-aware wire converter. Matching raw BIGINT/DECIMAL Python
    values would lose the public string identity. ``sources`` is the caller's
    already authorized retained-source closure, never caller-supplied URLs.

    A malformed recipe is rejected by validate_citations before dispatch.
    Individual unsupported claims here yield advisory counts and, when a real
    output cell can be identified, an explicitly advisory diagnostic. This
    describes a rejected attribution recipe, not the cell's processing state;
    it neither discards rows nor turns a present required value into a gap.
    """
    if (
        len(table.rows) != len(row_ids)
        or len(wire_rows) != len(row_ids)
        or not all(isinstance(row_id, str) for row_id in row_ids)
        or len(set(row_ids)) != len(row_ids)
    ):
        raise SourcesQLError("invalid_request", "Invalid curated citation row mapping", "publish")
    columns = {column.key for column in table.columns}
    evidence: dict[str, dict[str, Any]] = {}
    diagnostics: dict[str, dict[str, Any]] = {}
    selectors: dict[bytes, list[int]] = {}
    cells: set[tuple[str, str]] = set()
    support_context = SupportValidationContext()
    counts = {
        "submitted_citations": len(citations),
        "attached_citations": 0,
        "unattached_citations": 0,
        "bound_cells": 0,
    }

    def reject(citation, reason, index=None, status="evidence_invalid"):
        counts["unattached_citations"] += 1
        counts[reason] = counts.get(reason, 0) + 1
        if index is None or citation["column_key"] not in columns:
            return
        row_id, key = row_ids[index], citation["column_key"]
        diagnostic_id = "d_" + digest([CURATED_CITATION_CONTRACT, row_id, citation, reason])[:32]
        diagnostics[diagnostic_id] = {
            "diagnostic_id": diagnostic_id,
            "operator": "CURATED_CITATION",
            "advisory": True,
            "status": status,
            "reason": reason,
            "row_id": row_id,
            "column_key": key,
            "value_path": [],
            "source_version_id": citation["source_version_id"],
        }

    for citation in citations:
        selector = citation["match"]
        selector_key = canonical(selector)
        if selector_key not in selectors:
            selectors[selector_key] = [
                index
                for index, row in enumerate(wire_rows)
                if all(
                    key in row and _same_wire(row[key], value) for key, value in selector.items()
                )
            ]
        matches = selectors[selector_key]
        if len(matches) != 1:
            reject(citation, "row_not_found" if not matches else "row_ambiguous")
            continue
        index = matches[0]
        key = citation["column_key"]
        if key not in columns:
            reject(citation, "unknown_column")
            continue
        if wire_rows[index].get(key) is None:
            reject(citation, "null_target", index, "unknown")
            continue
        source_id = citation["source_version_id"]
        source = sources.get(source_id)
        if source is None:
            reject(citation, "source_not_retained", index)
            continue
        text = source.get("content")
        if not isinstance(text, str):
            reject(citation, "source_text_unavailable", index)
            continue
        content_hash = support_context.source_hash(source, expected_id=source_id)
        if content_hash is None:
            reject(citation, "source_identity_invalid", index)
            continue
        quote = citation["quote"]
        if "start" in citation:
            start, end = citation["start"], citation["end"]
        else:
            start = text.find(quote)
            if start < 0:
                reject(citation, "quote_not_found", index)
                continue
            if text.find(quote, start + 1) >= 0:
                reject(citation, "quote_ambiguous", index)
                continue
            end = start + len(quote)
        span = {
            "quote": quote,
            "start": start,
            "end": end,
            "source_version_id": source_id,
            "content_sha256": content_hash,
        }
        row_id = row_ids[index]
        record = {
            "operator": "CURATED_CITATION",
            "status": "supported_text",
            "attribution_basis": "agent_selected_quote",
            "row_id": row_id,
            "column_key": key,
            "value_path": [],
            "source_version_id": source_id,
            "support": [span],
        }
        # Canonical source identity/hash and span validity share the same
        # validator used when citations are retained through later SQL reuse.
        support = checked_support(record, sources, context=support_context)
        if not support:
            reject(citation, "quote_range_mismatch", index)
            continue
        evidence_id = (
            "e_" + digest([CURATED_CITATION_CONTRACT, row_id, key, source_id, support[0]])[:32]
        )
        evidence[evidence_id] = {**record, "evidence_id": evidence_id, "support": support}
        counts["attached_citations"] += 1
        cells.add((row_id, key))
    counts["bound_cells"] = len(cells)
    return list(evidence.values()), list(diagnostics.values()), counts
