"""Carry existing cell evidence across an explicitly identified, unchanged app cell."""

from __future__ import annotations

from collections import defaultdict
import copy
import re

from sourcesql.contracts import SourcesQLError, canonical, digest
from sourcesql.feature_contracts import CELL_ORIGINS_ENCODING
from sourcesql.execution.evidence import (
    SupportValidationContext,
    checked_support,
    retained_sources,
)


def validate_cell_origins(value, *, columns=None, row_ids=None, parents=None):
    if value is None:
        return []
    if isinstance(value, dict):
        if (
            set(value) != {"encoding", "cells"}
            or value.get("encoding") != CELL_ORIGINS_ENCODING
            or not isinstance(value.get("cells"), list)
            or len(value["cells"]) > 1000 * 128
            or not isinstance(columns, list)
            or not isinstance(row_ids, list)
            or not isinstance(parents, list)
        ):
            raise SourcesQLError("invalid_request", "Invalid indexed materialized cell origins")
        expanded = []
        for cell in value["cells"]:
            if (
                not isinstance(cell, list)
                or len(cell) != 3
                or any(type(index) is not int or index < 0 for index in cell)
                or cell[0] >= len(row_ids)
                or cell[1] >= len(columns)
                or cell[2] >= len(parents)
            ):
                raise SourcesQLError("invalid_request", "Invalid indexed materialized cell origin")
            row_id, column, parent = row_ids[cell[0]], columns[cell[1]], parents[cell[2]]
            if not isinstance(column, dict) or not isinstance(parent, dict):
                raise SourcesQLError("invalid_request", "Invalid indexed origin context")
            expanded.append(
                {
                    "row_id": row_id,
                    "column_key": column.get("key"),
                    "result_id": parent.get("result_id"),
                    "source_row_id": row_id,
                    "source_column_key": column.get("key"),
                }
            )
        value = expanded
    fields = {"row_id", "column_key", "result_id", "source_row_id", "source_column_key"}
    # One origin per cell across the existing import-table envelope (1000 x 128).
    # A separate 2048-entry cap would reject otherwise valid cited tables.
    if not isinstance(value, list) or len(value) > 1000 * 128:
        raise SourcesQLError("invalid_request", "Invalid materialized cell origins")
    origins = []
    for item in value:
        if (
            not isinstance(item, dict)
            or set(item) != fields
            or any(
                not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", v)
                for v in item.values()
            )
        ):
            raise SourcesQLError("invalid_request", "Invalid materialized cell origin")
        origins.append(dict(item))
    return sorted({canonical(item): item for item in origins}.values(), key=canonical)


def preserve_cell_evidence(store, table, row_ids, origins, parents, wire_value):
    """Identity chooses the source cell; exact type/value checks fence stale mappings.

    An origin is not permission to infer evidence from an equal value elsewhere.
    Only already validated canonical parent evidence can be carried forward.
    """
    allowed = {parent["result_id"] for parent in parents}
    outputs = {row_id: row for row_id, row in zip(row_ids, table.rows)}
    columns = {column.key: column for column in table.columns}
    loaded = {}
    validation = SupportValidationContext()
    evidence, sources, seen = [], {}, set()
    for origin in origins:
        rid = origin["result_id"]
        if rid not in allowed:
            raise SourcesQLError("unauthorized", "Cell origin must be an authorized import parent")
        if rid not in loaded:
            meta, parent_table = store.read(rid)
            indexed_evidence = defaultdict(list)
            for record in meta.get("evidence", []):
                indexed_evidence[(record.get("row_id"), record.get("column_key"))].append(record)
            loaded[rid] = (
                indexed_evidence,
                {row_id: row for row_id, row in zip(meta["row_ids"], parent_table.rows)},
                {column.key: column for column in parent_table.columns},
                retained_sources(store, rid),
            )
        indexed_evidence, parent_rows, parent_columns, retained = loaded[rid]
        row, source_row = outputs.get(origin["row_id"]), parent_rows.get(origin["source_row_id"])
        key, source_key = origin["column_key"], origin["source_column_key"]
        if (
            row is None
            or source_row is None
            or key not in columns
            or source_key not in parent_columns
            or columns[key].logical_type != parent_columns[source_key].logical_type
            or row[key] is None
            or canonical(wire_value(row[key], columns[key].logical_type))
            != canonical(
                wire_value(source_row[source_key], parent_columns[source_key].logical_type)
            )
        ):
            continue
        for record in indexed_evidence.get((origin["source_row_id"], source_key), []):
            support = checked_support(record, retained, context=validation)
            if not support:
                continue
            copied = {
                **copy.deepcopy(record),
                "row_id": origin["row_id"],
                "column_key": key,
                "support": copy.deepcopy(support),
            }
            copied["evidence_id"] = (
                "e_" + digest([rid, origin, record.get("evidence_id"), support])[:32]
            )
            if copied["evidence_id"] in seen:
                continue
            seen.add(copied["evidence_id"])
            evidence.append(copied)
            sid = copied.get("source_version_id")
            if sid in retained:
                sources[sid] = retained[sid]
    return evidence, list(sources.values())
