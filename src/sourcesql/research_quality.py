"""Declared research obligations, assessed independently of SQL execution status.

This is a shape and processing-state assessment. It neither verifies factual
truth nor establishes that discovery covered the relevant corpus. All follow-up
work remains an explicitly authored query with its own budgets and dependencies.
"""

from __future__ import annotations

import re
from typing import Any, NoReturn

from .contracts import Column, SourcesQLError, Table, canonical
from .sql.admission import validate_type


MAX_GAPS = 256
_COLUMN_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
_REFERENCE = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
_PATH_PART = re.compile(r"[A-Za-z0-9_]{1,64}\Z")
_RESOLVED = {"processed", "supported_text", "no_match"}
_UNRESOLVED = {
    "not_stated",
    "unknown",
    "uninspected",
    "not_inspected",
    "ambiguous",
    "conflicting",
    "evidence_invalid",
    "invalid_output",
    "failed",
    "unprocessed",
    "not_processed",
    "budget_exhausted",
    "cancelled",
    "provider_unavailable",
    "provider_timeout",
    "provider_connection_error",
    "provider_http_error",
    "provider_error",
}


def _invalid_requirements() -> NoReturn:
    raise SourcesQLError(
        "invalid_request", "Research requirements must name bounded existing columns and row count"
    )


def validate_requirements(
    raw: Any, columns: list[Column] | list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Return an independent canonical descriptor, or None when undeclared.

    Keys must use scalar columns; required fields may use any admitted column
    type. Lists retain their authored order. Key columns are presence obligations,
    not an inferred uniqueness or entity-resolution assertion. Row count defaults
    to zero: requiring a nonempty result must be explicit.
    """
    if raw is None:
        return None
    if (
        not isinstance(raw, dict)
        or set(raw) - {"key_columns", "fields", "minimum_rows"}
        or not {"key_columns", "fields"} <= set(raw)
        or not isinstance(columns, list)
        or not 1 <= len(columns) <= 128
    ):
        _invalid_requirements()
    declared: dict[str, str] = {}
    key: Any
    logical_type: Any
    for column in columns:
        if isinstance(column, Column):
            key, logical_type = column.key, column.logical_type
        elif isinstance(column, dict):
            key = column.get("key")
            logical_type = column.get("logical_type", column.get("logicalType", "VARCHAR"))
        else:
            _invalid_requirements()
        if not isinstance(key, str) or not _COLUMN_KEY.fullmatch(key) or key in declared:
            _invalid_requirements()
        declared[key] = logical_type
    for name, maximum in (("key_columns", 4), ("fields", 32)):
        selected = raw.get(name)
        if (
            not isinstance(selected, list)
            or not 1 <= len(selected) <= maximum
            or any(not isinstance(key, str) or key not in declared for key in selected)
            or len(set(selected)) != len(selected)
        ):
            _invalid_requirements()
    for key in raw["key_columns"]:
        try:
            kind = validate_type(declared[key])
        except SourcesQLError:
            _invalid_requirements()
        if kind.startswith("STRUCT(") or "[" in kind or kind == "JSON":
            _invalid_requirements()
    minimum = raw.get("minimum_rows", 0)
    if type(minimum) is not int or not 0 <= minimum <= 1000:
        _invalid_requirements()
    return {
        "key_columns": list(raw["key_columns"]),
        "fields": list(raw["fields"]),
        "minimum_rows": minimum,
    }


def _diagnostic_gap(diagnostic: dict, row_id: str, column_key: str, null: bool) -> dict | None:
    status = diagnostic.get("status")
    gap: dict[str, Any]
    if isinstance(status, str) and status in _RESOLVED:
        if not null:
            return None
        gap = {
            "row_id": row_id,
            "column_key": column_key,
            "status": "unknown",
            "diagnostic_status": status,
        }
    else:
        gap = {
            "row_id": row_id,
            "column_key": column_key,
            "status": status if isinstance(status, str) and status in _UNRESOLVED else "unknown",
        }
    for name in ("diagnostic_id", "source_version_id"):
        value = diagnostic.get(name)
        if isinstance(value, str) and _REFERENCE.fullmatch(value):
            gap[name] = value
    path = diagnostic.get("value_path")
    if (
        isinstance(path, list)
        and len(path) <= 8
        and all(isinstance(part, str) and _PATH_PART.fullmatch(part) for part in path)
    ):
        gap["value_path"] = list(path)
    return gap


def assess_requirements(
    table: Table,
    row_ids: list[str],
    cell_diagnostics: list[dict[str, Any]] | None,
    requirements: dict[str, Any] | None,
) -> dict[str, Any]:
    """Assess declared cells and row count with at most 256 diagnostic gap entries.

    An unresolved diagnostic is conservative even if its cell is non-NULL.
    Undiagnosed NULL is uninspected; a present value without diagnostics satisfies
    only its declared presence obligation. Counts refer to unique required cells,
    while gap totals count distinct retained processing diagnostics for those cells.
    Results contain safe reference IDs, never source text or provider messages.
    """
    descriptor = validate_requirements(requirements, table.columns)
    output: dict[str, Any] = {
        "goal_status": "not_evaluated",
        "required_cells": 0,
        "unresolved_cells": 0,
        "row_shortfall": 0,
        "gaps": [],
        "gaps_total": 0,
        "gaps_omitted": 0,
        "complete": False,
        "scope": "declared_cells_and_minimum_rows",
        "factual_truth_verified": False,
    }
    if descriptor is None:
        return output
    if (
        not isinstance(table.rows, list)
        or len(table.rows) > 1000
        or any(not isinstance(row, dict) for row in table.rows)
        or not isinstance(row_ids, list)
        or len(row_ids) != len(table.rows)
        or any(
            not isinstance(row_id, str) or not _REFERENCE.fullmatch(row_id) for row_id in row_ids
        )
        or len(set(row_ids)) != len(row_ids)
        or (cell_diagnostics is not None and not isinstance(cell_diagnostics, list))
    ):
        raise SourcesQLError(
            "invalid_output", "Research assessment requires valid result identities"
        )
    required = list(dict.fromkeys([*descriptor["key_columns"], *descriptor["fields"]]))
    required_set, row_set = set(required), set(row_ids)
    by_cell: dict[tuple[str, str], list[dict]] = {}
    for diagnostic in cell_diagnostics or []:
        if not isinstance(diagnostic, dict):
            continue
        # A rejected optional attribution is feedback about that quotation, not
        # an extraction failure or a missing value. NULL still gets a gap below.
        if diagnostic.get("operator") == "CURATED_CITATION" and diagnostic.get("advisory") is True:
            continue
        row_id, key = diagnostic.get("row_id"), diagnostic.get("column_key")
        if (
            isinstance(row_id, str)
            and isinstance(key, str)
            and row_id in row_set
            and key in required_set
        ):
            by_cell.setdefault((row_id, key), []).append(diagnostic)

    def record(gap: dict) -> None:
        output["gaps_total"] += 1
        if len(output["gaps"]) < MAX_GAPS:
            output["gaps"].append(gap)

    for row_id, row in zip(row_ids, table.rows, strict=True):
        for key in required:
            null = row.get(key) is None
            diagnostics = by_cell.get((row_id, key), [])
            seen: set[bytes] = set()
            unresolved = False
            for diagnostic in diagnostics:
                gap = _diagnostic_gap(diagnostic, row_id, key, null)
                if gap is None:
                    continue
                signature = canonical(gap)
                if signature not in seen:
                    record(gap)
                    seen.add(signature)
                unresolved = True
            if null and not diagnostics:
                record({"row_id": row_id, "column_key": key, "status": "uninspected"})
                unresolved = True
            output["unresolved_cells"] += int(unresolved)
    output["required_cells"] = len(table.rows) * len(required)
    output["row_shortfall"] = max(0, descriptor["minimum_rows"] - len(table.rows))
    output["gaps_omitted"] = output["gaps_total"] - len(output["gaps"])
    output["complete"] = not output["unresolved_cells"] and not output["row_shortfall"]
    output["goal_status"] = "requirements_satisfied" if output["complete"] else "partial"
    return output
