"""Concrete final-state privacy and coordinator failure-path regressions."""

from __future__ import annotations

import uuid

import pytest

from open_webql.contracts import Column, Table, WebQLError, canonical, digest
from open_webql.engine import Engine
from open_webql.storage.store import Store
from test_engine_boundaries import reference_worker


def test_imported_public_label_cannot_declassify_private_parent_closure(tmp_path):
    original = Engine(tmp_path / "original", worker=reference_worker)
    private = original.import_table([{"key": "value"}], [{"value": "SYNTHETIC-PRIVATE-FIXTURE"}])
    child = original.query(
        query="SELECT value FROM input.p", inputs={"p": {"result_id": private["result_id"]}}
    )
    bundle = original.export(child["result_id"])
    bundle["results"][bundle["root_result_id"]]["metadata"]["data_classification"] = (
        "synthetic_fixture"
    )
    bundle["content_sha256"] = digest({k: v for k, v in bundle.items() if k != "content_sha256"})
    restored = Engine(tmp_path / "restored", worker=reference_worker).import_bundle(bundle)
    restricted = Engine(tmp_path / "restored", worker=reference_worker, allow_private=False)
    with pytest.raises(WebQLError) as error:
        restricted.read_result(restored["result_id"])
    assert error.value.code == "unauthorized"


def test_stale_cancellation_does_not_replace_atomic_publication_receipt(tmp_path):
    engine = Engine(tmp_path, worker=reference_worker)
    result = engine.query(query="SELECT 7 AS value", request_id=str(uuid.uuid4()))
    receipt = result["receipt"]
    stale = {**receipt, "status": "cancelled", "result_id": None, "receipt_revision": 0}
    returned = Engine(tmp_path, worker=reference_worker).store.update_run(stale)
    assert returned == receipt
    assert engine.read_result(result["result_id"])["rows"] == [{"value": 7}]


def test_bundle_quote_must_match_retained_source_text(tmp_path):
    original = Engine(tmp_path / "original", worker=reference_worker)
    result = original.query(
        query="SELECT url,SEM_EXTRACT(content,'project name') AS project FROM WEB_SEARCH('Aurora campus')"
    )
    bundle = original.export(result["result_id"])
    record = bundle["results"][bundle["root_result_id"]]
    record["metadata"]["evidence"][0]["support"][0]["quote"] = "FORGED-QUOTE"
    bundle["content_sha256"] = digest({k: v for k, v in bundle.items() if k != "content_sha256"})
    restored = Engine(tmp_path / "restored", worker=reference_worker)
    with pytest.raises(WebQLError) as error:
        restored.import_bundle(bundle)
    assert error.value.code == "evidence_invalid"


def test_retained_source_metadata_consumes_result_quota_even_for_tiny_table(tmp_path):
    store = Store(tmp_path, quota=4096)
    table = Table([Column("value")], [{"value": "fixture"}])
    metadata = {
        "result_id": "oversized_metadata",
        "data_classification": "synthetic_fixture",
        "source_versions": [
            {"source_version_id": "fixture_source", "content": "SYNTHETIC-SOURCE-TEXT " * 500}
        ],
        "evidence": [],
    }
    assert len(canonical(table.to_dict())) < store.quota
    assert len(canonical(metadata)) > store.quota
    with pytest.raises(WebQLError) as error:
        store.commit(table, metadata)
    assert error.value.code == "budget_exhausted"
    with store.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 0
