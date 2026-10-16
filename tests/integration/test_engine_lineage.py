"""Canonical cell evidence and retained-source reuse, with synthetic providers only."""

from __future__ import annotations

import pytest

from sourcesql.contracts import Column, Table, SourcesQLError
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate


def reference_worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {k: v.to_dict() for k, v in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [Column(c["key"], c["logical_type"], c["nullable"]) for c in result["columns"]],
        result["rows"],
    )


def pin(result, view="original"):
    return {"result_id": result["result_id"], "view": view, "amendment_revision": None}


def make(tmp_path):
    return Engine(tmp_path / "engine", worker=reference_worker)


def test_struct_projection_saved_reuse_and_join_keep_source_specific_cells(tmp_path):
    engine = make(tmp_path)
    extracted = engine.query(
        query="""WITH fetched AS (
      SELECT url, WEB_FETCH(url) AS docs FROM WEB_SEARCH('aurora', per_query_limit := 1)
    ), facts AS (
      SELECT url, SEM_EXTRACT(docs[1].content, 'project facts',
        project := 'project name', planned := 'planned capacity', absent := 'utility') AS fact
      FROM fetched
    ) SELECT fact.project AS project, fact.planned AS capacity, fact.absent AS utility,
      'https://unrelated.example/not-proof' AS source_url FROM facts"""
    )
    assert extracted["rows"] == [
        {
            "project": "Aurora Campus",
            "capacity": "500",
            "utility": None,
            "source_url": "https://unrelated.example/not-proof",
        }
    ]
    direct = [e for e in extracted["evidence"] if e.get("row_id")]
    assert {e["column_key"] for e in direct} == {"project", "capacity"}
    assert all(e["row_id"] == extracted["row_ids"][0] for e in direct)
    assert all(e["support"] and e["source_version_id"] for e in direct)
    assert extracted["bound_evidence_cells"] == 2
    reused = engine.query(
        query="""WITH preferred AS (
      SELECT project AS name, capacity AS amount FROM input.saved
    ) SELECT a.name AS entity, b.amount AS planned_capacity
      FROM preferred a LEFT JOIN preferred b ON a.name=b.name ORDER BY entity""",
        inputs={"saved": pin(extracted)},
    )
    assert reused["rows"] == [{"entity": "Aurora Campus", "planned_capacity": "500"}]
    assert reused["receipt"]["counts"] == {}
    direct = [e for e in reused["evidence"] if e.get("row_id")]
    assert {e["column_key"] for e in direct} == {"entity", "planned_capacity"}
    assert all(e["row_id"] == reused["row_ids"][0] for e in direct)
    bundle = engine.export(reused["result_id"])
    restored = Engine(tmp_path / "restored", worker=reference_worker)
    saved = restored.import_bundle(bundle)
    reopened = restored.query(
        query="SELECT planned_capacity AS mw FROM input.saved", inputs={"saved": pin(saved)}
    )
    assert reopened["rows"] == [{"mw": "500"}]
    assert {e["column_key"] for e in reopened["evidence"] if e.get("row_id")} == {"mw"}


def test_retained_sources_view_reuses_canonical_text_with_no_fetch(tmp_path):
    engine = make(tmp_path)
    original = engine.query(query="SELECT title FROM WEB_FETCH('https://aurora.example/project')")
    result = engine.query(
        query="SELECT SEM_EXTRACT(content,'planned capacity') AS mw FROM input.docs",
        inputs={"docs": pin(original, "sources")},
    )
    assert result["rows"] == [{"mw": "500"}]
    counts = result["receipt"]["counts"]
    assert counts.get("fetches", 0) == counts.get("search_requests", 0) == 0
    assert {e["column_key"] for e in result["evidence"] if e.get("row_id")} == {"mw"}
    assert result["parents"][0]["view"] == "sources"
    with pytest.raises(SourcesQLError) as error:
        engine.query(
            query="SELECT content FROM input.docs",
            inputs={"docs": {**pin(original, "sources"), "amendment_revision": 1}},
        )
    assert error.value.code == "invalid_request"


def test_identical_literal_and_composed_text_do_not_borrow_source_citations(tmp_path):
    engine = make(tmp_path)
    original = engine.query(query="SELECT content FROM WEB_FETCH('https://aurora.example/project')")
    text = original["rows"][0]["content"]
    result = engine.query(
        query="SELECT SEM_EXTRACT($literal,'planned capacity') AS mw FROM input.docs",
        parameters={"literal": text},
        inputs={"docs": pin(original, "sources")},
    )
    assert result["rows"] == [{"mw": "500"}]
    assert not any(e.get("row_id") for e in result["evidence"])
    assert result["lineage_precision"] == "input_set"
    derived = engine.query(
        query="SELECT content || '' AS same_text FROM input.saved", inputs={"saved": pin(original)}
    )
    assert derived.get("source_bindings") == []


def test_aggregated_values_never_claim_direct_source_support(tmp_path):
    engine = make(tmp_path)
    result = engine.query(
        query="SELECT SEM_EXTRACT(content,'planned capacity') AS mw FROM WEB_SEARCH('aurora')"
    )
    aggregated = engine.query(
        query="SELECT max(mw) AS biggest FROM input.saved", inputs={"saved": pin(result)}
    )
    assert aggregated["rows"] and aggregated["bound_evidence_cells"] == 0
    assert not any(e.get("row_id") for e in aggregated["evidence"])
    assert aggregated["parents"][0]["result_id"] == result["result_id"]


def test_retained_sources_private_authorization_precedes_dispatch(tmp_path):
    owner = make(tmp_path)
    private = owner.import_table([{"key": "secret"}], [{"secret": "private"}])
    calls = []
    restricted = Engine(
        tmp_path / "engine", worker=lambda *args, **kwargs: calls.append(args), allow_private=False
    )
    with pytest.raises(SourcesQLError) as error:
        restricted.query(
            query="SELECT content FROM input.docs", inputs={"docs": pin(private, "sources")}
        )
    assert error.value.code == "unauthorized" and calls == []


def test_reopened_excerpt_cannot_bypass_document_requirement(tmp_path, monkeypatch):
    from sourcesql.providers.fixture import FixtureProvider

    original_record = FixtureProvider._record

    def excerpt(self, document):
        row = original_record(self, document)
        row["content_basis"] = "excerpt"
        row["coverage"]["complete"] = False
        return row

    monkeypatch.setattr(FixtureProvider, "_record", excerpt)
    engine = make(tmp_path)
    original = engine.query(
        query="SELECT title FROM WEB_SEARCH('aurora', per_query_limit := 1)",
        source_mode="allow_excerpt",
    )
    with pytest.raises(SourcesQLError) as error:
        engine.query(
            query="SELECT SEM_EXTRACT(content,'planned capacity') AS mw FROM input.docs",
            inputs={"docs": pin(original, "sources")},
        )
    assert error.value.code == "unsupported_capability"
    allowed = engine.query(
        query="SELECT SEM_EXTRACT(content,'planned capacity') AS mw FROM input.docs",
        inputs={"docs": pin(original, "sources")},
        source_mode="allow_excerpt",
    )
    assert allowed["rows"] == [{"mw": "500"}]


def test_lineage_seed_failure_settles_run_without_dispatch(tmp_path, monkeypatch):
    from sourcesql.execution.evidence import EvidenceContext

    engine = make(tmp_path)

    def refuse(*args):
        raise SourcesQLError("evidence_invalid", "Conflicting retained source identity", "read")

    monkeypatch.setattr(EvidenceContext, "seed", refuse)
    with pytest.raises(SourcesQLError):
        engine.query(query="SELECT title FROM WEB_SEARCH('aurora')")
    with engine.store.db() as db:
        receipts = db.execute("SELECT receipt FROM runs").fetchall()
    import json

    receipt = json.loads(receipts[0][0])
    assert receipt["status"] == "failed"
    assert receipt["counts"] == {}
    assert not engine.active


def test_processed_outcome_with_valid_quotes_retains_cell_evidence(tmp_path, monkeypatch):
    from sourcesql.providers.fixture import FixtureProvider

    original_semantic = FixtureProvider.semantic

    def processed(self, *args, **kwargs):
        outcome = original_semantic(self, *args, **kwargs)
        outcome.status = "processed"
        return outcome

    monkeypatch.setattr(FixtureProvider, "semantic", processed)
    result = make(tmp_path).query(
        query="SELECT SEM_EXTRACT(content,'planned capacity') AS mw FROM WEB_FETCH('https://aurora.example/project')"
    )
    assert result["rows"] == [{"mw": "500"}]
    assert result["bound_evidence_cells"] == 1
    assert any(
        e.get("column_key") == "mw" and e["status"] == "processed" for e in result["evidence"]
    )
