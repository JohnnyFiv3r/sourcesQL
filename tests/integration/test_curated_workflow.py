"""Quote-backed curation, corrected-input reuse and authorization at the engine boundary."""

from __future__ import annotations

from uuid import uuid4

import pytest
import duckdb

from sourcesql.contracts import Column, Table, SourcesQLError
from sourcesql.engine import Engine
from sourcesql.storage.motherduck import MotherDuckStore
from sourcesql.execution.worker_process import evaluate


def worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {key: table.to_dict() for key, table in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [Column(c["key"], c["logical_type"], c["nullable"]) for c in result["columns"]],
        result["rows"],
    )


@pytest.fixture(params=["local", "motherduck-local"])
def engine(request, tmp_path):
    store = None
    if request.param == "motherduck-local":
        store = MotherDuckStore(
            database="synthetic_citation_test",
            namespace="b" * 64,
            connector=lambda: duckdb.connect(str(tmp_path / "durable.duckdb")),
        )
    return Engine(tmp_path / "engine", worker=worker, store=store)


def pin(result, view="original", revision=None):
    return {"result_id": result["result_id"], "view": view, "amendment_revision": revision}


def acquired(engine):
    return engine.query(query="SELECT content FROM WEB_FETCH('https://aurora.example/project')")


def curate(engine, source, **kwargs):
    retained = source["source_versions"][0]
    citation = {
        "match": {"product": "Aurora"},
        "column_key": "claim",
        "source_version_id": retained["source_version_id"],
        "quote": retained["content"],
    }
    return engine.query(
        query="SELECT $product AS product, $claim AS claim, 'Unreviewed' AS status FROM input.saved LIMIT 1",
        parameters={"product": "Aurora", "claim": "Agent-interpreted finding"},
        inputs={"saved": pin(source)},
        citations=kwargs.pop("citations", [citation]),
        **kwargs,
    )


def test_curation_is_quote_backed_advisory_and_reuses_without_provider_effects(engine):
    source = acquired(engine)
    request_id = str(uuid4())
    result = curate(engine, source, request_id=request_id)
    assert result["rows"][0]["claim"] == "Agent-interpreted finding"
    assert result["receipt"]["counts"] == {}
    assert result["citation_feedback"]["attached_citations"] == 1
    assert result["bound_evidence_cells"] == 1
    entry = next(e for e in result["evidence"] if e.get("row_id"))
    assert entry["column_key"] == "claim" and entry["attribution_basis"] == "agent_selected_quote"
    assert entry["support"][0]["quote"] == source["source_versions"][0]["content"]
    assert curate(engine, source, request_id=request_id)["result_id"] == result["result_id"]
    with pytest.raises(SourcesQLError) as conflict:
        curate(
            engine,
            source,
            request_id=request_id,
            citations=[
                {
                    "match": {"product": "Aurora"},
                    "column_key": "claim",
                    "source_version_id": source["source_versions"][0]["source_version_id"],
                    "quote": "changed quote",
                }
            ],
        )
    assert conflict.value.code == "idempotency_conflict"
    invalid = curate(
        engine,
        source,
        citations=[
            {
                "match": {"product": "Aurora"},
                "column_key": "claim",
                "source_version_id": source["source_versions"][0]["source_version_id"],
                "quote": "not in this source",
            }
        ],
    )
    assert invalid["rows"] == result["rows"]
    assert invalid["citation_feedback"]["unattached_citations"] == 1
    assert invalid["receipt"]["counts"] == {}
    assert not any(e.get("row_id") for e in invalid["evidence"])


def test_materialized_unchanged_claim_keeps_citation_but_user_decision_does_not(engine):
    source = acquired(engine)
    original = curate(engine, source)
    row_id = original["row_ids"][0]
    origins = [
        {
            "row_id": row_id,
            "column_key": key,
            "result_id": original["result_id"],
            "source_row_id": row_id,
            "source_column_key": key,
        }
        for key in ("claim", "status")
    ]
    imported = engine.import_table(
        original["columns"],
        [{**original["rows"][0], "status": "Shortlist"}],
        row_ids=[row_id],
        data_classification="synthetic_fixture",
        parents=[pin(original)],
        provenance={
            "materialization_contract": "sourcesql.app-effective.v2",
            "amendment_revision": 1,
        },
        cell_origins=origins,
    )
    derived = engine.query(
        query="SELECT product, claim, status FROM input.saved WHERE status='Shortlist'",
        inputs={"saved": pin(imported, "effective", 1)},
    )
    assert original["rows"][0]["status"] == "Unreviewed"
    assert derived["rows"][0]["status"] == "Shortlist"
    assert {e["column_key"] for e in derived["evidence"] if e.get("row_id")} == {"claim"}
    assert derived["receipt"]["counts"] == {}
    assert (
        engine.import_table(
            original["columns"],
            [{**original["rows"][0], "status": "Shortlist"}],
            row_ids=[row_id],
            data_classification="synthetic_fixture",
            parents=[pin(original)],
            provenance={
                "materialization_contract": "sourcesql.app-effective.v2",
                "amendment_revision": 1,
            },
            cell_origins=list(reversed(origins)),
        )["result_id"]
        == imported["result_id"]
    )
    with engine.store.db() as db:
        db.execute("UPDATE results SET revoked=1 WHERE id=?", [source["result_id"]])
    with pytest.raises(SourcesQLError):
        engine.read_result(derived["result_id"])
    with pytest.raises(SourcesQLError):
        engine.export(imported["result_id"])


def test_changed_value_or_unrelated_parent_cannot_borrow_a_citation(engine):
    original = curate(engine, acquired(engine))
    row_id = original["row_ids"][0]
    origin = {
        "row_id": row_id,
        "column_key": "claim",
        "result_id": original["result_id"],
        "source_row_id": row_id,
        "source_column_key": "claim",
    }
    changed = engine.import_table(
        original["columns"],
        [{**original["rows"][0], "claim": "Manual replacement"}],
        row_ids=[row_id],
        data_classification="synthetic_fixture",
        parents=[pin(original)],
        cell_origins=[origin],
    )
    assert not any(e.get("row_id") for e in changed["evidence"])
    with pytest.raises(SourcesQLError) as error:
        engine.import_table(
            original["columns"],
            original["rows"],
            row_ids=[row_id],
            data_classification="synthetic_fixture",
            cell_origins=[origin],
        )
    assert error.value.code == "unauthorized"


def test_origin_recipe_supports_the_full_existing_table_envelope():
    from sourcesql.execution.materialized_evidence import validate_cell_origins

    # A 205-row table with twelve cited fields exceeds a query's citation-batch
    # bound, but every existing supported cell must survive materialization.
    origins = [
        {
            "row_id": f"row_{row}",
            "column_key": f"field_{column}",
            "result_id": "wq_parent",
            "source_row_id": f"row_{row}",
            "source_column_key": f"field_{column}",
        }
        for row in range(205)
        for column in range(12)
    ]
    assert len(validate_cell_origins(origins)) == 2460
