"""Carry existing cell evidence across an explicitly identified, unchanged app cell."""

from __future__ import annotations

import copy
import re

from sourcesql.contracts import SourcesQLError, canonical, digest
from sourcesql.execution.evidence import checked_support, retained_sources


def validate_cell_origins(value):
    if value is None:
        return []
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
    evidence, sources, seen = [], {}, set()
    for origin in origins:
        rid = origin["result_id"]
        if rid not in allowed:
            raise SourcesQLError("unauthorized", "Cell origin must be an authorized import parent")
        if rid not in loaded:
            meta, parent_table = store.read(rid)
            loaded[rid] = (
                meta,
                {row_id: row for row_id, row in zip(meta["row_ids"], parent_table.rows)},
                {column.key: column for column in parent_table.columns},
                retained_sources(store, rid),
            )
        meta, parent_rows, parent_columns, retained = loaded[rid]
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
        for record in meta.get("evidence", []):
            if (
                record.get("row_id") != origin["source_row_id"]
                or record.get("column_key") != source_key
            ):
                continue
            support = checked_support(record, retained)
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
