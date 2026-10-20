"""Materialization indexes canonical evidence without caching authorization."""

from __future__ import annotations

from copy import deepcopy
import hashlib

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.execution import evidence as evidence_module
from sourcesql.execution.evidence import SupportValidationContext, checked_support
from sourcesql.execution.materialized_evidence import preserve_cell_evidence


class CountingRecords(list):
    def __init__(self, records):
        super().__init__(records)
        self.iterations = 0

    def __iter__(self):
        self.iterations += 1
        return super().__iter__()


class CanonicalStore:
    def __init__(self, results):
        self.results = results
        self.reads = []
        self.authorizations = []
        self.revoked = set()

    def authorize(self, result_id):
        self.authorizations.append(result_id)
        if result_id in self.revoked:
            raise SourcesQLError("unauthorized", "Parent unavailable")
        return self.results[result_id][0]

    def read(self, result_id):
        self.reads.append(result_id)
        return self.authorize(result_id), self.results[result_id][1]


def fixture(rows=1, columns=1, *, parent_id="wq_parent", source=None):
    text = "Canonical retained source: verified passage 🌍."
    source = source or {
        "source_version_id": "src_retained",
        "content": text,
        "content_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "url": "https://synthetic.example/source",
    }
    table = Table(
        [Column(f"claim_{column}", "VARCHAR", False) for column in range(columns)],
        [
            {f"claim_{column}": f"Finding {row}/{column}" for column in range(columns)}
            for row in range(rows)
        ],
    )
    row_ids = [f"row_{row}" for row in range(rows)]
    records = CountingRecords(
        [
            {
                "evidence_id": f"e_{row}_{column}",
                "row_id": row_id,
                "column_key": column,
                "source_version_id": source["source_version_id"],
                "status": "supported_text",
                "support": [
                    {
                        "quote": source["content"],
                        "start": 0,
                        "end": len(source["content"]),
                        "source_version_id": source["source_version_id"],
                        "content_sha256": source["content_sha256"],
                    }
                ],
            }
            for row, row_id in enumerate(row_ids)
            for column in table.rows[row]
        ]
    )
    metadata = {
        "row_ids": row_ids,
        "evidence": records,
        "source_versions": [source],
        "parents": [],
    }
    origins = [
        {
            "row_id": row_id,
            "column_key": column.key,
            "result_id": parent_id,
            "source_row_id": row_id,
            "source_column_key": column.key,
        }
        for row_id in row_ids
        for column in table.columns
    ]
    return metadata, table, row_ids, origins


def count_source_hashes(monkeypatch, text):
    original = hashlib.sha256
    calls = []

    def counted(value=b"", **kwargs):
        if value == text.encode():
            calls.append(value)
        return original(value, **kwargs)

    monkeypatch.setattr(evidence_module.hashlib, "sha256", counted)
    return calls


def preserve(store, table, row_ids, origins, parents=None):
    return preserve_cell_evidence(
        store,
        table,
        row_ids,
        origins,
        parents or [{"result_id": "wq_parent"}],
        lambda value, _logical_type: value,
    )


def test_materialization_indexes_parent_once_and_hashes_one_source_once(monkeypatch):
    metadata, table, row_ids, origins = fixture(rows=205, columns=4)
    source = metadata["source_versions"][0]
    store = CanonicalStore({"wq_parent": (metadata, table)})
    hash_calls = count_source_hashes(monkeypatch, source["content"])

    copied, sources = preserve(store, table, row_ids, origins)

    assert len(copied) == 205 * 4
    assert metadata["evidence"].iterations == 1
    assert store.reads == ["wq_parent"]
    assert len(hash_calls) == 1
    assert sources == [source]
    assert {(record["row_id"], record["column_key"]) for record in copied} == {
        (origin["row_id"], origin["column_key"]) for origin in origins
    }
    assert all(record["support"][0]["quote"] == source["content"] for record in copied)

    # A separate operation revalidates the source and parent. Nothing persists
    # across calls that could turn the optimization into a revocation bypass.
    preserve(store, table, row_ids, origins)
    assert len(hash_calls) == 2
    store.revoked.add("wq_parent")
    with pytest.raises(SourcesQLError, match="Parent unavailable"):
        preserve(store, table, row_ids, origins)


def test_shared_source_hash_is_reused_across_authorized_parents(monkeypatch):
    left, table, row_ids, origins = fixture()
    right, _, _, right_origins = fixture(
        parent_id="wq_other", source=deepcopy(left["source_versions"][0])
    )
    store = CanonicalStore({"wq_parent": (left, table), "wq_other": (right, table)})
    hash_calls = count_source_hashes(monkeypatch, left["source_versions"][0]["content"])
    copied, sources = preserve(
        store,
        table,
        row_ids,
        origins + right_origins,
        [{"result_id": "wq_parent"}, {"result_id": "wq_other"}],
    )
    assert len(copied) == 2
    assert len(sources) == 1
    assert left["evidence"].iterations == right["evidence"].iterations == 1
    assert store.reads == ["wq_parent", "wq_other"]
    assert len(hash_calls) == 1


def test_cached_hash_never_skips_current_source_identity_or_hash_checks(monkeypatch):
    metadata, _, _, _ = fixture()
    source = metadata["source_versions"][0]
    record = metadata["evidence"][0]
    sources = {source["source_version_id"]: source}
    context = SupportValidationContext()
    hash_calls = count_source_hashes(monkeypatch, source["content"])
    assert checked_support(record, sources, context=context) == record["support"]
    assert len(hash_calls) == 1

    content_hash = source["content_sha256"]
    source["content_sha256"] = "0" * 64
    assert checked_support(record, sources, context=context) == []
    source["content_sha256"] = content_hash
    source["source_version_id"] = "src_wrong"
    assert checked_support(record, sources, context=context) == []
    source["source_version_id"] = "src_retained"
    # The old quote still occurs exactly at the same offsets after this edit.
    # Reusing the previous hash would therefore incorrectly accept the span.
    source["content"] += " Appended canonical text."
    assert checked_support(record, sources, context=context) == []
    source["content_sha256"] = hashlib.sha256(source["content"].encode()).hexdigest()
    assert checked_support(record, sources, context=context) == []
    record["support"][0]["content_sha256"] = source["content_sha256"]
    assert checked_support(record, sources, context=context) == record["support"]
    assert len(hash_calls) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"start": True},
        {"end": 9999},
        {"quote": "A different passage"},
        {"source_version_id": "src_unrelated"},
        {"content_sha256": "0" * 64},
        {"inspected_window": {"start": 1, "end": 2}},
    ],
)
def test_cached_source_still_checks_every_quote_and_inspected_window(change):
    metadata, _, _, _ = fixture()
    source = metadata["source_versions"][0]
    record = metadata["evidence"][0]
    sources = {source["source_version_id"]: source}
    context = SupportValidationContext()
    assert checked_support(record, sources, context=context) == record["support"]
    altered = deepcopy(record)
    altered["support"][0].update(change)
    assert checked_support(altered, sources, context=context) == []
    # The longstanding two-positional-argument API has the same validation.
    assert checked_support(altered, sources) == []


@pytest.mark.parametrize("replacement", [None, "Changed manual value"])
def test_index_does_not_copy_a_changed_or_null_cell(replacement):
    metadata, table, row_ids, origins = fixture()
    output = Table(table.columns, [{"claim_0": replacement}])
    store = CanonicalStore({"wq_parent": (metadata, table)})
    assert preserve(store, output, row_ids, origins) == ([], [])


def test_index_does_not_copy_evidence_across_a_logical_type_change():
    metadata, table, row_ids, origins = fixture()
    output = Table([Column("claim_0", "JSON", False)], table.rows)
    store = CanonicalStore({"wq_parent": (metadata, table)})
    assert preserve(store, output, row_ids, origins) == ([], [])


def test_index_respects_exact_source_row_and_parent_membership():
    metadata, table, row_ids, origins = fixture(rows=2)
    store = CanonicalStore({"wq_parent": (metadata, table)})
    metadata["evidence"] = [
        record for record in metadata["evidence"] if record["row_id"] == row_ids[0]
    ]
    table.rows[1]["claim_0"] = table.rows[0]["claim_0"]
    assert preserve(store, table, row_ids, [origins[1]]) == ([], [])
    origins[0]["result_id"] = "wq_unrelated"
    with pytest.raises(SourcesQLError) as error:
        preserve(store, table, row_ids, origins)
    assert error.value.code == "unauthorized"
    assert store.reads == ["wq_parent"]
