"""Coordinator-owned evidence handles; never infer attribution from equal values or URLs."""

from __future__ import annotations

from collections import defaultdict
import hashlib
import uuid
from typing import Any

from sourcesql.contracts import Table, digest


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


def checked_support(record: dict, sources: dict) -> list[dict]:
    source = sources.get(str(record.get("source_version_id")))
    if not source or record.get("status") not in ("supported_text", "processed", "no_match"):
        return []
    text = source["content"]
    content_hash = hashlib.sha256(text.encode()).hexdigest()
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

    def source_handle(self, source: dict) -> str:
        sid = source["source_version_id"]
        self.add_source(source)
        handle = "s_" + uuid.uuid4().hex
        self.source_handles[handle] = sid
        return handle

    def source_for(self, handles: list[str], text: Any) -> dict | None:
        matches = {self.source_handles[h] for h in handles if h in self.source_handles}
        if len(matches) != 1:
            return None
        source = self.sources[next(iter(matches))]
        return source if source.get("content") == text else None

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
                    support = checked_support(record, sources)
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
                    if path_value(table.rows[index], full_path) == source["content"]:
                        lineage[index].setdefault(full_path, []).append(self.source_handle(source))
            table.lineage = lineage

    def record(self, base: dict, fields: dict, target: dict) -> list[dict]:
        """Mint field-specific handles after validated semantic support is returned."""
        support = checked_support(base, self.sources)
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
                path = ()
            grouped[path].append(span)
        records = []
        for path, spans in grouped.items():
            identifier = "e_" + uuid.uuid4().hex
            record = {**base, "evidence_id": identifier, "support": spans}
            self.records[identifier] = record
            target[path] = [identifier]
            records.append(record)
        if fields and grouped:
            target[()] = [record["evidence_id"] for record in records]
        return records

    def bind(self, table: Table, row_ids: list[str], unbound: list[dict]):
        bound, source_bindings, referenced = [], [], set()
        for index, (row, row_id) in enumerate(zip(table.rows, row_ids)):
            tags = table.lineage[index] if index < len(table.lineage) else {}
            for path, handles in tags.items():
                if not path or path_value(row, path) is None:
                    continue
                if any(other[: len(path)] == path and len(other) > len(path) for other in tags):
                    continue
                for handle in dict.fromkeys(handles):
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
                        if path_value(row, path) == self.sources[sid]["content"]:
                            source_bindings.append(
                                {
                                    "row_id": row_id,
                                    "column_key": path[0],
                                    "value_path": list(path[1:]),
                                    "source_version_id": sid,
                                }
                            )
        retained = [record for record in unbound if record.get("evidence_id") not in referenced]
        cells = {(r["row_id"], r["column_key"]) for r in bound}
        return bound + retained, source_bindings, len(cells)
