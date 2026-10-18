"""Advisory SQL descriptions and observable result facts, never quality gates.

The intended answer is retained independently of projected columns. Descriptions
are generated only from the admitted AST and bound values, not from that intent.
Neither a mismatch nor an unavailable description changes execution or results.
"""

from __future__ import annotations

import re
from typing import Any

from .contracts import Table, canonical, digest

_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")


def normalize_answer_intent(raw: Any) -> dict[str, Any] | None:
    """Accept bounded descriptive metadata without requiring its fields to exist."""
    if (
        not isinstance(raw, dict)
        or set(raw) - {"question", "row_unit", "fields"}
        or not {"row_unit", "fields"} <= set(raw)
        or not isinstance(raw.get("row_unit"), str)
        or not 1 <= len(raw["row_unit"]) <= 200
        or not isinstance(raw.get("fields"), list)
        or not 1 <= len(raw["fields"]) <= 32
    ):
        return None
    if "question" in raw and (
        not isinstance(raw["question"], str) or not 1 <= len(raw["question"]) <= 2000
    ):
        return None
    fields: list[dict[str, str]] = []
    seen: set[str] = set()
    for field in raw["fields"]:
        if (
            not isinstance(field, dict)
            or set(field) != {"key", "meaning"}
            or not isinstance(field.get("key"), str)
            or not _KEY.fullmatch(field["key"])
            or field["key"] in {"constructor", "prototype", "__proto__"}
            or field["key"] in seen
            or not isinstance(field.get("meaning"), str)
            or not 1 <= len(field["meaning"]) <= 500
        ):
            return None
        seen.add(field["key"])
        fields.append({"key": field["key"], "meaning": field["meaning"]})
    normalized = {
        **({"question": raw["question"]} if "question" in raw else {}),
        "row_unit": raw["row_unit"],
        "fields": fields,
    }
    try:
        return normalized if len(canonical(normalized)) <= 24576 else None
    except (UnicodeError, ValueError, TypeError):
        return None


def build_query_feedback(plan, request: dict, parents: list[dict]) -> dict[str, Any]:
    """Build bounded feedback. An explainer failure is informational, not fatal."""
    intent = normalize_answer_intent(request.get("answer_intent"))
    feedback: dict[str, Any] = {
        "schema_version": 1,
        "advisory": True,
        "query_sha256": digest(request["query"]),
        "parameters_sha256": digest(request.get("parameters", {})),
        "input_pins_sha256": digest(parents),
        "description_status": "unavailable",
        "intent_status": (
            "provided"
            if intent is not None
            else "not_provided"
            if request.get("answer_intent") is None
            else "invalid"
        ),
        "output_columns": [column.key for column in plan.columns],
        "missing_intended_fields": [],
    }
    if intent is not None:
        feedback["answer_intent"] = intent
        feedback["missing_intended_fields"] = [
            field["key"]
            for field in intent["fields"]
            if field["key"] not in feedback["output_columns"]
        ]
    try:
        from .sql.query_description import describe_query

        description = describe_query(plan)
        if len(canonical(description)) <= 24576:
            feedback["description"] = description
            feedback["description_status"] = "available"
    except Exception:
        # Do not expose raw SQL/provider exceptions or suppress valid research
        # because a descriptive, non-authoritative component could not run.
        pass
    return feedback


def observe_result(feedback: dict[str, Any], table: Table) -> dict[str, Any]:
    """Count full-result rows and NULLs without filtering, scoring or inference."""
    fields = [column.key for column in table.columns]
    intent = feedback.get("answer_intent")
    return {
        **feedback,
        "output_columns": fields,
        "missing_intended_fields": [
            field["key"] for field in (intent or {}).get("fields", []) if field["key"] not in fields
        ],
        "result_observations": {
            "row_count": len(table.rows),
            "null_cells": [
                {"key": field, "count": sum(row.get(field) is None for row in table.rows)}
                for field in fields
            ],
        },
    }
