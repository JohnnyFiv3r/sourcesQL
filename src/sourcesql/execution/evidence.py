"""Coordinator-owned evidence handles; never infer attribution from equal values or URLs."""

from __future__ import annotations

from collections import defaultdict
import hashlib
import uuid
from typing import Any

from sourcesql.contracts import Table, SourcesQLError, digest


def retained_sources(store, result_id: str) -> dict[str, dict]:
    found: dict[str, dict] = {}
    visited: set[str] = set()

    def include(identifier):
        if identifier in visited:
            return
        visited.add(identifier)
        metadata = store.authorize(identifier)
        for parent in metadata.get("parents", []):
            include(parent["result_id"])
        for source in metadata.get("source_versions", []):
            sid = source.get("source_version_id")
            if isinstance(sid, str) and isinstance(source.get("content"), str):
                previous = found.get(sid)
                if previous is not None and (previous.get("url"), previous["content"]) != (
                    source.get("url"),
                    source["content"],
                ):
                    from sourcesql.contracts import SourcesQLError

                    raise SourcesQLError(
                        "evidence_invalid", "Conflicting retained source identity", "read"
                    )
                found[sid] = source

    include(result_id)
    return found


def path_value(row: dict, path: tuple[str, ...]):
    value: Any = row
    for part in path:
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit() and 1 <= int(part) <= len(value):
            value = value[int(part) - 1]
        else:
            return None
    return value


def path_present(row: dict, path: tuple[str, ...]) -> bool:
    """NULL is a present cell, unlike an absent struct/item path."""
    value: Any = row
    for part in path:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and 1 <= int(part) <= len(value):
            value = value[int(part) - 1]
        else:
            return False
    return True


class SupportValidationContext:
    """Reuse only computed source hashes within one evidence operation.

    The cache key contains the actual immutable text, not a caller-provided hash
    or validity assertion. A changed source therefore cannot inherit validation
    from an earlier version, even when it reuses a source-version identifier.
    """

    def __init__(self) -> None:
        self._content_hashes: dict[tuple[str, str], str] = {}

    def content_hash(self, source: dict) -> str:
        text = source["content"]
        key = (str(source.get("source_version_id")), text)
        if key not in self._content_hashes:
            self._content_hashes[key] = hashlib.sha256(text.encode()).hexdigest()
        return self._content_hashes[key]

    def source_hash(self, source: dict, *, expected_id: str) -> str | None:
        """Check current source metadata against its computed text hash.

        Only digest computation is cached. Identity and declared-hash checks run
        again on every call, so mutated metadata cannot inherit an earlier pass.
        Authorization remains the caller's separate, per-operation obligation.
        """
        if source.get("source_version_id") != expected_id or not isinstance(
            source.get("content"), str
        ):
            return None
        content_hash = self.content_hash(source)
        if source.get("content_sha256", content_hash) != content_hash:
            return None
        return content_hash


def checked_support(
    record: dict, sources: dict, *, context: SupportValidationContext | None = None
) -> list[dict]:
    source = sources.get(str(record.get("source_version_id")))
    if not source or record.get("status") not in ("supported_text", "processed", "no_match"):
        return []
    content_hash = (context or SupportValidationContext()).source_hash(
        source, expected_id=str(record.get("source_version_id"))
    )
    if content_hash is None:
        return []
    text = source["content"]
    support = []
    for span in record.get("support", []):
        start, end = span.get("start"), span.get("end")
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start < end <= len(text)
            or text[start:end] != span.get("quote")
            or span.get("source_version_id", record.get("source_version_id"))
            != record.get("source_version_id")
            or span.get("content_sha256", content_hash) != content_hash
        ):
            continue
        window = span.get("inspected_window")
        if window and not (
            type(window.get("start")) is int
            and type(window.get("end")) is int
            and 0 <= window["start"] <= start < end <= window["end"] <= len(text)
        ):
            continue
        support.append(span)
    return support


class EvidenceContext:
    def __init__(self):
        self.sources: dict[str, dict] = {}
        self.records: dict[str, dict] = {}
        self.source_handles: dict[str, str] = {}
        self.source_windows: dict[str, tuple[int, int]] = {}
        self.diagnostics: dict[str, dict] = {}
        self._support_validation = SupportValidationContext()

    def add_source(self, source: dict) -> None:
        sid = source["source_version_id"]
        previous = self.sources.get(sid)
        if previous and (previous.get("url"), previous["content"]) != (
            source.get("url"),
            source["content"],
        ):
            from sourcesql.contracts import SourcesQLError

            raise SourcesQLError("evidence_invalid", "Conflicting source identity", "acquisition")
        self.sources[sid] = source

    def source_handle(self, source: dict, window: tuple[int, int] | None = None) -> str:
        sid = source["source_version_id"]
        self.add_source(source)
        handle = "s_" + uuid.uuid4().hex
        self.source_handles[handle] = sid
        if window is not None:
            self.source_windows[handle] = window
        return handle

    def source_for(self, handles: list[str], text: Any) -> dict | None:
        matches = {self.source_handles[h] for h in handles if h in self.source_handles}
        if len(matches) != 1:
            return None
        source = self.sources[next(iter(matches))]
        windows = {
            self.source_windows.get(handle, (0, len(source["content"])))
            for handle in handles
            if self.source_handles.get(handle) == source["source_version_id"]
        }
        if len(windows) != 1:
            return None
        start, end = next(iter(windows))
        if source["content"][start:end] != text:
            return None
        return {**source, "_input_window": {"start": start, "end": end}}

    def window(self, text: Any, handles: list[str], start: Any, length: Any):
        """Explicit slices retain their canonical source and original coordinates."""
        if text is None or start is None or length is None:
            return None, None
        if not isinstance(text, str) or type(start) is not int or type(length) is not int:
            raise SourcesQLError(
                "invalid_request", "Source windows require text and integer bounds"
            )
        if start < 0 or length < 0 or start > len(text):
            raise SourcesQLError("invalid_request", "Source window bounds are outside the input")
        end = min(len(text), start + length)
        value = text[start:end]
        source = self.source_for(handles, text)
        if source is None:
            return value, None
        origin = source["_input_window"]["start"]
        canonical_source = self.sources[source["source_version_id"]]
        return value, self.source_handle(canonical_source, (origin + start, origin + end))

    def seed(self, inputs: dict[str, Table], bindings: dict, store) -> None:
        for alias, table in inputs.items():
            binding = bindings[alias]
            rid = binding["result_id"]
            meta = store.authorize(rid)
            sources = retained_sources(store, rid)
            for retained_source in sources.values():
                self.add_source(retained_source)
            lineage: list[dict[tuple[str, ...], list[str]]] = [{} for _ in table.rows]
            if binding.get("view", "original") == "sources":
                for row, tags in zip(table.rows, lineage):
                    source = sources.get(str(row.get("source_version_id")))
                    if source and row.get("content") == source["content"]:
                        tags[("content",)] = [self.source_handle(source)]
            else:
                rows = {row_id: index for index, row_id in enumerate(meta.get("row_ids", []))}
                columns = {column.key for column in table.columns}
                for record in meta.get("evidence", []):
                    key, row_id = record.get("column_key"), record.get("row_id")
                    path = record.get("value_path", [])
                    if (
                        row_id not in rows
                        or key not in columns
                        or not isinstance(path, list)
                        or not all(isinstance(part, str) for part in path)
                    ):
                        continue
                    index = rows[row_id]
                    full_path = (key, *path)
                    support = checked_support(record, sources, context=self._support_validation)
                    if not support or path_value(table.rows[index], full_path) is None:
                        continue
                    token = "e_" + digest([rid, record.get("evidence_id"), full_path, support])[:32]
                    retained = {
                        k: v
                        for k, v in record.items()
                        if k not in ("row_id", "column_key", "value_path")
                    }
                    self.records[token] = {**retained, "evidence_id": token, "support": support}
                    lineage[index].setdefault(full_path, []).append(token)
                for record in meta.get("source_bindings", []):
                    key, row_id = record.get("column_key"), record.get("row_id")
                    path = record.get("value_path", [])
                    source = sources.get(str(record.get("source_version_id")))
                    if (
                        row_id not in rows
                        or key not in columns
                        or not source
                        or not isinstance(path, list)
                        or not all(isinstance(v, str) for v in path)
                    ):
                        continue
                    index, full_path = rows[row_id], (key, *path)
                    window = record.get("source_window")
                    if window is None:
                        start, end = 0, len(source["content"])
                    elif (
                        isinstance(window, dict)
                        and type(window.get("start")) is int
                        and type(window.get("end")) is int
                        and 0 <= window["start"] <= window["end"] <= len(source["content"])
                    ):
                        start, end = window["start"], window["end"]
                    else:
                        continue
                    if path_value(table.rows[index], full_path) == source["content"][start:end]:
                        lineage[index].setdefault(full_path, []).append(
                            self.source_handle(source, (start, end))
                        )
                for record in meta.get("cell_diagnostics", []):
                    key, row_id = record.get("column_key"), record.get("row_id")
                    path = record.get("value_path", [])
                    if (
                        row_id not in rows
                        or key not in columns
                        or not isinstance(path, list)
                        or not all(isinstance(part, str) for part in path)
                    ):
                        continue
                    index, full_path = rows[row_id], (key, *path)
                    if not path_present(table.rows[index], full_path):
                        continue
                    token = "d_" + digest([rid, record.get("diagnostic_id"), full_path])[:32]
                    self.diagnostics[token] = {
                        **{
                            k: v
                            for k, v in record.items()
                            if k not in ("row_id", "column_key", "value_path")
                        },
                        "diagnostic_id": token,
                    }
                    lineage[index].setdefault(full_path, []).append(token)
            table.lineage = lineage

    def record(self, base: dict, fields: dict, target: dict) -> list[dict]:
        """Mint field-specific handles after validated semantic support is returned."""
        support = checked_support(base, self.sources, context=self._support_validation)
        grouped: dict[tuple[str, ...], list[dict]] = defaultdict(list)
        path: tuple[str, ...]
        for span in support:
            if fields:
                name = span.get("field")
                if not isinstance(name, str) or name not in fields:
                    continue
                path = (name,)
                if base.get("operator") == "SEM_EXTRACT_ALL":
                    item = span.get("item")
                    if type(item) is not int or item < 0:
                        continue
                    path = (str(item + 1), name)
            else:
                item = span.get("item")
                path = (
                    (str(item + 1),)
                    if base.get("operator") == "SEM_EXTRACT_ALL" and type(item) is int and item >= 0
                    else ()
                )
            grouped[path].append(span)
        records = []
        for path, spans in grouped.items():
            identifier = "e_" + uuid.uuid4().hex
            record = {**base, "evidence_id": identifier, "support": spans}
            self.records[identifier] = record
            target.setdefault(path, []).append(identifier)
            records.append(record)
        if fields and grouped:
            target.setdefault((), []).extend(record["evidence_id"] for record in records)
        return records

    def record_outcome(self, base: dict, value: Any, fields: dict, target: dict) -> None:
        """Record per-cell processing state separately from quoted evidence."""
        operator = base.get("operator")
        if operator in {"SEM_NORM", "SEM_SCORE"}:
            return
        usage = base.get("usage") or {}
        errors = base.get("field_errors", usage.get("field_errors", [])) or []
        statuses = usage.get("field_outcomes", []) or []
        values = value if operator == "SEM_EXTRACT_ALL" and isinstance(value, list) else [value]
        for index, item in enumerate(values):
            cells = (
                ((field, item.get(field) if isinstance(item, dict) else None) for field in fields)
                if fields
                else [("value", item)]
            )
            for field, cell in cells:
                path = ((str(index + 1),) if operator == "SEM_EXTRACT_ALL" else ()) + (
                    (field,) if fields else ()
                )
                field_error = next(
                    (
                        error
                        for error in errors
                        if error.get("field", "value") == field
                        and (operator != "SEM_EXTRACT_ALL" or error.get("item") == index)
                    ),
                    None,
                )
                field_status = next(
                    (
                        status
                        for status in statuses
                        if status.get("field", "value") == field
                        and (operator != "SEM_EXTRACT_ALL" or status.get("item") == index)
                    ),
                    None,
                )
                status = (
                    field_error.get("code")
                    if field_error
                    else field_status.get("status")
                    if field_status
                    else base.get("status", "unknown")
                )
                if cell is None and status in {"processed", "supported_text", "no_match"}:
                    status = "unknown"
                reason = {
                    "not_stated": "not_stated_in_inspected_evidence",
                    "not_inspected": "not_inspected",
                    "ambiguous": "ambiguous",
                    "conflicting": "conflicting",
                    "evidence_invalid": "invalid_evidence",
                    "invalid_output": "invalid_output",
                    "failed": "provider_failure",
                    "unprocessed": "not_inspected"
                    if usage.get("reason") == "missing_text"
                    else "unprocessed",
                    "budget_exhausted": "capacity_limited",
                }.get(status, "resolved" if cell is not None else "unknown")
                identifier = "d_" + uuid.uuid4().hex
                self.diagnostics[identifier] = {
                    "diagnostic_id": identifier,
                    "operator": operator,
                    "status": status
                    if status
                    in {
                        "processed",
                        "supported_text",
                        "no_match",
                        "not_stated",
                        "unknown",
                        "not_inspected",
                        "ambiguous",
                        "conflicting",
                        "evidence_invalid",
                        "invalid_output",
                        "failed",
                        "unprocessed",
                        "budget_exhausted",
                    }
                    else "unknown",
                    "reason": reason,
                    "source_version_id": base.get("source_version_id"),
                    "inspected_windows": usage.get("inspected_windows", []),
                    "input_omitted_characters": usage.get("input_omitted_characters"),
                }
                target.setdefault(path, []).append(identifier)

    def bind(self, table: Table, row_ids: list[str], unbound: list[dict]):
        bound, source_bindings, cell_diagnostics, referenced = [], [], [], set()
        for index, (row, row_id) in enumerate(zip(table.rows, row_ids)):
            tags = table.lineage[index] if index < len(table.lineage) else {}
            for path, handles in tags.items():
                if not path or not path_present(row, path):
                    continue
                if any(other[: len(path)] == path and len(other) > len(path) for other in tags):
                    continue
                for handle in dict.fromkeys(handles):
                    diagnostic = self.diagnostics.get(handle)
                    if diagnostic:
                        cell_diagnostics.append(
                            {
                                **diagnostic,
                                "row_id": row_id,
                                "column_key": path[0],
                                "value_path": list(path[1:]),
                            }
                        )
                        continue
                    if path_value(row, path) is None:
                        continue
                    record = self.records.get(handle)
                    if record:
                        bound.append(
                            {
                                **record,
                                "row_id": row_id,
                                "column_key": path[0],
                                "value_path": list(path[1:]),
                            }
                        )
                        referenced.add(handle)
                    elif handle in self.source_handles:
                        sid = self.source_handles[handle]
                        start, end = self.source_windows.get(
                            handle, (0, len(self.sources[sid]["content"]))
                        )
                        if path_value(row, path) == self.sources[sid]["content"][start:end]:
                            source_bindings.append(
                                {
                                    "row_id": row_id,
                                    "column_key": path[0],
                                    "value_path": list(path[1:]),
                                    "source_version_id": sid,
                                    "source_window": {"start": start, "end": end},
                                }
                            )
        retained = [record for record in unbound if record.get("evidence_id") not in referenced]
        cells = {(r["row_id"], r["column_key"]) for r in bound}
        return bound + retained, source_bindings, len(cells), cell_diagnostics
