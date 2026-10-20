"""Read-only, bounded SQL projections over retained metadata.

The database still parses legacy JSON blobs. No record index or storage migration
is claimed; source/evidence bodies are not loaded into Python for every page.
"""

from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path

from sourcesql.contracts import SourcesQLError, canonical, digest
from sourcesql.feature_contracts import RESULT_INSPECTION_CONTRACT

_META = (
    "result_id",
    "run_id",
    "content_sha256",
    "data_classification",
    "row_count",
    "columns",
    "row_ids",
    "parents",
    "provenance",
    "research_requirements",
    "source_bindings",
    "cell_diagnostics",
    "created_at",
    "profile_revision",
    "query_sha256",
    "query",
    "parameters",
    "research_quality",
    "query_feedback",
    "citation_feedback",
    "lineage_precision",
    "replay_level",
    "bound_evidence_cells",
    "receipt",
    "foreign_receipt",
    "receipt_id",
    "receipt_revision",
)
_REQUIRED = (
    "result_id",
    "content_sha256",
    "data_classification",
    "row_count",
    "columns",
    "row_ids",
    "parents",
    "run_id",
)
_COLLECTIONS = {"evidence", "source_versions", "cell_diagnostics"}
_STRUCTURED = {
    "columns",
    "row_ids",
    "parents",
    "provenance",
    "research_requirements",
    "source_bindings",
    "cell_diagnostics",
    "parameters",
    "research_quality",
    "query_feedback",
    "citation_feedback",
    "receipt",
    "foreign_receipt",
}


def _integer(value, minimum=0, maximum=1000000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise SourcesQLError("invalid_request", "Invalid inspection bounds", "read")
    return value


def _page(offset, returned, total):
    return {
        "offset": offset,
        "returned": returned,
        "total": total,
        "next_offset": offset + returned if offset + returned < total else None,
    }


class InspectionMixin:
    inspection_dialect = "sqlite"

    def _inspection_decode(self, key, value):
        if value is None:
            return None
        if self.inspection_dialect == "duckdb" or key in _STRUCTURED:
            return json.loads(value) if isinstance(value, str) else value
        return value

    def _inspection_authorize(self, db, result_id, seen=None, cache=None):
        seen = set() if seen is None else seen
        cache = {} if cache is None else cache
        if not isinstance(result_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", result_id):
            raise SourcesQLError("invalid_request", "Invalid result identity", "read")
        if result_id in seen or len(seen) >= 64:
            raise SourcesQLError("evidence_invalid", "Invalid result dependency graph", "read")
        if result_id in cache:
            return cache[result_id]
        if len(cache) >= 64:
            raise SourcesQLError("evidence_invalid", "Result dependency allowance exceeded", "read")
        seen = seen | {result_id}
        fields = ",".join(f"json_extract(metadata,'$.{key}')" for key in _REQUIRED)
        check = ",sha256(payload)=hash" if self.inspection_dialect == "duckdb" else ""
        row = db.execute(
            f"SELECT revoked,hash,{fields}{check} FROM results WHERE id=?", [result_id]
        ).fetchone()
        if not row or row[0]:
            raise SourcesQLError("unauthorized", "Result or dependency unavailable", "read")
        if self.inspection_dialect == "duckdb" and row[-1] is not True:
            raise SourcesQLError("evidence_invalid", "Retained result integrity failure", "read")
        meta = {key: self._inspection_decode(key, value) for key, value in zip(_REQUIRED, row[2:])}
        if (
            meta.get("result_id") != result_id
            or meta.get("content_sha256") != row[1]
            or not isinstance(meta.get("parents") or [], list)
        ):
            raise SourcesQLError("evidence_invalid", "Invalid inspection identity", "read")
        for parent in meta.get("parents") or []:
            if not isinstance(parent, dict) or not isinstance(parent.get("result_id"), str):
                raise SourcesQLError("evidence_invalid", "Invalid parent identity", "read")
            ancestor = self._inspection_authorize(db, parent["result_id"], seen, cache)
            if parent.get("content_sha256") not in (None, ancestor["content_sha256"]):
                raise SourcesQLError("evidence_invalid", "Parent content pin mismatch", "read")
            if ancestor.get("data_classification") in ("private_local", "private_derived"):
                meta["data_classification"] = "private_derived"
        cache[result_id] = meta
        return meta

    def _inspection_metadata(self, db, result_id, budget):
        # SQL removes private replay controls before the size or body is read.
        patch = "json_patch" if self.inspection_dialect == "sqlite" else "json_merge_patch"
        cleaned = f"CASE WHEN j.key IN ('receipt','foreign_receipt') THEN {patch}(j.value,'{{\"resume_request\":null}}') ELSE j.value END"
        length = (
            f"length(CAST({cleaned} AS BLOB))"
            if self.inspection_dialect == "sqlite"
            else f"octet_length(encode(CAST({cleaned} AS VARCHAR)))"
        )
        keys = ",".join("'" + key + "'" for key in _META if key not in _REQUIRED)
        descriptors = db.execute(
            f"SELECT j.key,{length} FROM results r,json_each(r.metadata) j WHERE r.id=? AND j.key IN ({keys})",
            [result_id],
        ).fetchall()
        lengths = {key: int(size or 0) for key, size in descriptors}
        selected, omitted, used = [], [], 0
        for key in _META:
            if key not in lengths:
                continue
            size = lengths[key] + len(key) + 8
            if used + size <= budget:
                selected.append(key)
                used += size
            else:
                omitted.append({"field": key, "bytes": lengths[key]})
        if not selected:
            return {}, omitted
        marks = ",".join("?" for _ in selected)
        rows = db.execute(
            f"SELECT j.key,{cleaned} FROM results r,json_each(r.metadata) j WHERE r.id=? AND j.key IN ({marks})",
            [result_id, *selected],
        ).fetchall()
        return {key: self._inspection_decode(key, value) for key, value in rows}, omitted

    def _inspection_records(self, db, result_id, collection, offset, limit, budget, row_ids):
        if collection not in _COLLECTIONS:
            raise SourcesQLError("invalid_request", "Invalid inspection collection", "read")
        scalar = "json_extract" if self.inspection_dialect == "sqlite" else "json_extract_string"
        scope, scope_values = "", []
        if collection in ("evidence", "cell_diagnostics"):
            marks = ",".join("?" for _ in row_ids) or "NULL"
            match = f"{scalar}(j.value,'$.row_id') IN ({marks})"
            scope = (
                f" AND ({scalar}(j.value,'$.row_id') IS NULL OR {match})"
                if collection == "evidence"
                else f" AND {match}"
            )
            scope_values = list(row_ids)
        value = "CAST(j.value AS VARCHAR)"
        length = (
            "length(CAST(j.value AS BLOB))"
            if self.inspection_dialect == "sqlite"
            else f"octet_length(encode({value}))"
        )
        records = f"FROM results r,json_each(json_extract(r.metadata,?)) j WHERE r.id=?{scope}"
        args = [f"$.{collection}", result_id, *scope_values]
        total = int(db.execute(f"SELECT count(*) {records}", args).fetchone()[0])
        descriptors = db.execute(
            f"SELECT CAST(j.key AS INTEGER),{length} {records} ORDER BY CAST(j.key AS INTEGER) LIMIT ? OFFSET ?",
            [*args, limit, offset],
        ).fetchall()
        indexes, used = [], 2
        for index, size in descriptors:
            if used + int(size) + 2 > budget - 512:
                break
            indexes.append(int(index))
            used += int(size) + 2
        page = _page(offset, len(indexes), total)
        if not indexes and descriptors:
            page.update(
                next_offset=None,
                complete=False,
                oversized_record_index=int(descriptors[0][0]),
                chunk_required={
                    "tool": "sourcesql_inspect_evidence",
                    "collection": collection,
                    "record_index": int(descriptors[0][0]),
                    "chunk_offset": 0,
                    "next_offset_after_chunk": offset + 1 if offset + 1 < total else None,
                },
            )
        values = []
        if indexes:
            marks = ",".join("?" for _ in indexes)
            rows = db.execute(
                f"SELECT {value} FROM results r,json_each(json_extract(r.metadata,?)) j WHERE r.id=? AND CAST(j.key AS INTEGER) IN ({marks}) ORDER BY CAST(j.key AS INTEGER)",
                [f"$.{collection}", result_id, *indexes],
            ).fetchall()
            values = [json.loads(row[0]) for row in rows]
            if len(values) != len(indexes):
                raise SourcesQLError(
                    "evidence_invalid", "Retained inspection records changed", "read"
                )
        return values, page

    def _inspection_chunk(self, db, result_id, params, budget):
        collection = params["collection"]
        if collection not in _COLLECTIONS:
            raise SourcesQLError("invalid_request", "Invalid inspection collection", "read")
        index = _integer(params.get("record_index"))
        start = _integer(params.get("chunk_offset", 0), maximum=100000000)
        limit = _integer(params.get("chunk_limit", 32768), 1, 131072)
        path = f"$.{collection}[{index}]"
        row = db.execute(
            "SELECT length(CAST(json_extract(metadata,?) AS VARCHAR)) FROM results WHERE id=?",
            [path, result_id],
        ).fetchone()
        if not row or row[0] is None:
            raise SourcesQLError("not_found", "Retained record unavailable", "read")
        total = int(row[0])
        if start > total:
            raise SourcesQLError("invalid_request", "Invalid inspection chunk boundary", "read")
        length = min(limit, max(1, (budget - 1024) // 6), total - start)
        chunk = db.execute(
            "SELECT substr(CAST(json_extract(metadata,?) AS VARCHAR),?,?) FROM results WHERE id=?",
            [path, start + 1, length, result_id],
        ).fetchone()[0]
        return {
            "result_id": result_id,
            "collection": collection,
            "record_index": index,
            "encoding": "json",
            "offset_unit": "unicode_code_points",
            "chunk_offset": start,
            "next_chunk_offset": start + len(chunk) if start + len(chunk) < total else None,
            "total_characters": total,
            "json_chunk": chunk,
        }

    def inspect_result(self, params, wire_value, allow_private):
        allowed = {
            "result_id",
            "mode",
            "offset",
            "limit",
            "columns",
            "evidence_offset",
            "evidence_limit",
            "source_offset",
            "source_limit",
            "collection",
            "record_index",
            "chunk_offset",
            "chunk_limit",
            "max_bytes",
        }
        if set(params) - allowed or params.get("mode", "evidence") not in ("rows", "evidence"):
            raise SourcesQLError("invalid_request", "Invalid inspection request", "read")
        result_id = params.get("result_id")
        collection = params.get("collection")
        if collection is not None and (
            collection not in _COLLECTIONS | {"rows"} or "record_index" not in params
        ):
            raise SourcesQLError(
                "invalid_request", "Invalid inspection collection or index", "read"
            )
        if collection is None and any(
            key in params for key in ("record_index", "chunk_offset", "chunk_limit")
        ):
            raise SourcesQLError(
                "invalid_request", "Collection is required for chunk inspection", "read"
            )
        offset = _integer(params.get("offset", 0))
        limit = _integer(params.get("limit", 20), 1, 100)
        budget = _integer(params.get("max_bytes", 512 * 1024), 4096, 512 * 1024)
        with self.db() as db:
            if self.inspection_dialect == "sqlite":
                db.execute("BEGIN")
            meta = self._inspection_authorize(db, result_id)
            if not allow_private and meta.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError("unauthorized", "Private result unavailable", "read")
            if collection is not None and collection != "rows":
                if self.inspection_dialect == "sqlite":
                    try:
                        with (Path(self.root) / (result_id + ".json")).open("rb") as handle:
                            content_hash = hashlib.file_digest(handle, "sha256").hexdigest()
                    except OSError as error:
                        raise SourcesQLError(
                            "result_unavailable", "Retained result bytes unavailable", "read"
                        ) from error
                    if content_hash != meta["content_sha256"]:
                        raise SourcesQLError(
                            "evidence_invalid", "Retained result integrity failure", "read"
                        )
                output = self._inspection_chunk(db, result_id, params, budget)
                return {**meta, **output, "inspection_contract": RESULT_INSPECTION_CONTRACT}
            if self.inspection_dialect == "sqlite":
                try:
                    payload = (Path(self.root) / (result_id + ".json")).read_bytes()
                except OSError as error:
                    raise SourcesQLError(
                        "result_unavailable", "Retained result bytes unavailable", "read"
                    ) from error
            else:
                payload = db.execute(
                    "SELECT payload FROM results WHERE id=?", [result_id]
                ).fetchone()[0]
            table = json.loads(payload)
            if digest(table) != meta["content_sha256"]:
                raise SourcesQLError(
                    "evidence_invalid", "Retained result integrity failure", "read"
                )
            if (
                not isinstance(meta.get("row_ids"), list)
                or len(meta["row_ids"]) != len(table.get("rows", []))
                or meta["row_count"] != len(table["rows"])
                or meta["columns"] != table["columns"]
            ):
                raise SourcesQLError("evidence_invalid", "Retained result shape mismatch", "read")
            if params.get("collection"):
                if params["collection"] == "rows":
                    index = _integer(params.get("record_index"))
                    if index >= len(table["rows"]):
                        raise SourcesQLError("not_found", "Retained row unavailable", "read")
                    row = {
                        c["key"]: wire_value(table["rows"][index][c["key"]], c["logical_type"])
                        for c in table["columns"]
                    }
                    text = canonical(row).decode()
                    start = _integer(params.get("chunk_offset", 0), maximum=100000000)
                    length = _integer(params.get("chunk_limit", 32768), 1, 131072)
                    if start > len(text):
                        raise SourcesQLError(
                            "invalid_request", "Invalid row chunk boundary", "read"
                        )
                    chunk = text[start : start + min(length, max(1, (budget - 1024) // 6))]
                    output = {
                        "result_id": result_id,
                        "collection": "rows",
                        "record_index": index,
                        "row_id": meta["row_ids"][index],
                        "encoding": "json",
                        "offset_unit": "unicode_code_points",
                        "chunk_offset": start,
                        "next_chunk_offset": start + len(chunk)
                        if start + len(chunk) < len(text)
                        else None,
                        "total_characters": len(text),
                        "json_chunk": chunk,
                    }
                else:
                    output = self._inspection_chunk(db, result_id, params, budget)
                return {**meta, **output, "inspection_contract": RESULT_INSPECTION_CONTRACT}
            extra, omitted = self._inspection_metadata(db, result_id, budget // 3)
            if meta.get("run_id"):
                patch = "json_patch" if self.inspection_dialect == "sqlite" else "json_merge_patch"
                expression = f"{patch}(receipt,'{{\"resume_request\":null}}')"
                size_expr = (
                    f"length(CAST({expression} AS BLOB))"
                    if self.inspection_dialect == "sqlite"
                    else f"octet_length(encode(CAST({expression} AS VARCHAR)))"
                )
                size = db.execute(
                    f"SELECT {size_expr} FROM runs WHERE id=?", [meta["run_id"]]
                ).fetchone()
                if not size:
                    raise SourcesQLError("evidence_invalid", "Retained receipt unavailable", "read")
                if int(size[0]) <= budget // 12:
                    extra["latest_receipt"] = json.loads(
                        db.execute(
                            f"SELECT CAST({expression} AS VARCHAR) FROM runs WHERE id=?",
                            [meta["run_id"]],
                        ).fetchone()[0]
                    )
                else:
                    omitted.append({"field": "latest_receipt", "bytes": int(size[0])})
            output = {
                **meta,
                **extra,
                "inspection_contract": RESULT_INSPECTION_CONTRACT,
                "row_ids": meta["row_ids"][offset : offset + limit],
                "offset": offset,
                "next_offset": offset + limit if offset + limit < meta["row_count"] else None,
                "evidence": [],
                "source_versions": [],
            }
            if omitted:
                output["metadata_omitted"] = omitted
            if params.get("mode") == "rows":
                selected = params.get("columns") or [c["key"] for c in table["columns"]]
                columns = [c for c in table["columns"] if c["key"] in selected]
                if len(columns) != len(selected):
                    raise SourcesQLError("invalid_request", "Unknown selected column", "read")
                output["columns"] = columns
                output["rows"] = [
                    {c["key"]: wire_value(row[c["key"]], c["logical_type"]) for c in columns}
                    for row in table["rows"][offset : offset + limit]
                ]
                rows = []
                row_ids = []
                remaining = budget // 2 - 512
                for row, row_id in zip(output["rows"], output["row_ids"]):
                    size = len(canonical(row)) + len(canonical(row_id)) + 2
                    if size > remaining:
                        break
                    rows.append(row)
                    row_ids.append(row_id)
                    remaining -= size
                page = _page(offset, len(rows), meta["row_count"])
                if not rows and output["rows"]:
                    page.update(
                        next_offset=None,
                        complete=False,
                        oversized_record_index=offset,
                        chunk_required={
                            "tool": "sourcesql_inspect_evidence",
                            "collection": "rows",
                            "record_index": offset,
                            "chunk_offset": 0,
                            "next_offset_after_chunk": offset + 1
                            if offset + 1 < meta["row_count"]
                            else None,
                        },
                    )
                output["rows"] = rows
                output["row_ids"] = row_ids
                output["row_page"] = page
                output["next_offset"] = page["next_offset"]
                for name, collection in (
                    ("evidence_page", "evidence"),
                    ("source_page", "source_versions"),
                ):
                    total = int(
                        db.execute(
                            "SELECT coalesce(json_array_length(json_extract(metadata,?)),0) FROM results WHERE id=?",
                            [f"$.{collection}", result_id],
                        ).fetchone()[0]
                    )
                    output[name] = _page(0, 0, total)
                return output
            for name, collection, record_offset, record_limit in (
                (
                    "evidence_page",
                    "evidence",
                    params.get("evidence_offset", 0),
                    params.get("evidence_limit", 100),
                ),
                (
                    "source_page",
                    "source_versions",
                    params.get("source_offset", 0),
                    params.get("source_limit", 100),
                ),
                ("diagnostic_page", "cell_diagnostics", 0, 256),
            ):
                values, page = self._inspection_records(
                    db,
                    result_id,
                    collection,
                    _integer(record_offset),
                    _integer(record_limit, maximum=1000),
                    max(4096, budget // 5),
                    output["row_ids"],
                )
                output[collection] = values
                output[name] = page
            output["cell_diagnostics_omitted"] = output["diagnostic_page"]["total"] - len(
                output["cell_diagnostics"]
            )
            return output
