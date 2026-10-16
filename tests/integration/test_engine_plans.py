"""Engine fixture queries using the actual macOS sandboxed SQL worker.

These use only fictional local provider fixtures. They do not qualify live
semantic quality or a ChatGPT host surface.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sourcesql.contracts import SourcesQLError
from sourcesql.engine import Engine


EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def imported(engine, columns, rows, classification="synthetic_fixture"):
    return engine.import_table(
        [{"key": key, "logical_type": logical_type} for key, logical_type in columns],
        rows,
        data_classification=classification,
    )


def binding(result):
    return {"result_id": result["result_id"], "view": "original", "amendment_revision": None}


def completed(result):
    assert result["receipt"]["status"] == "completed"
    assert result["receipt"]["settlement_status"] == "settled"
    assert result["receipt"]["plan_complete"] is True
    assert result["result_id"]


def test_engine_six_reviewed_shapes_actual_worker(tmp_path):
    engine = Engine(tmp_path / "engine")
    discovery = engine.query(query=(EXAMPLES / "01_discovery.sql").read_text())
    completed(discovery)
    assert {r["project"] for r in discovery["rows"]} == {"Aurora Campus", "Birch Campus"}
    by_project = {r["project"]: r for r in discovery["rows"]}
    assert by_project["Aurora Campus"]["planned_mw"] == "500"
    assert by_project["Aurora Campus"]["grid_status"] == "proposed"
    assert by_project["Birch Campus"]["operating_mw"] is None
    assert discovery["receipt"]["counts"]["search_queries"] == 2
    assert all(s["content_basis"] == "synthetic_fixture" for s in discovery["source_versions"])
    project_evidence = [e for e in discovery["evidence"] if e.get("field") == "project"]
    assert project_evidence and all(e["support"] for e in project_evidence)

    many = engine.query(query=(EXAMPLES / "02_many_entities.sql").read_text())
    completed(many)
    assert many["rows"] == [
        {"url": "https://aurora.example/project", "project": "Aurora Campus", "planned_mw": "500"}
    ]

    refined = engine.query(
        query=(EXAMPLES / "03_refine_saved.sql").read_text(),
        inputs={"previous": binding(discovery)},
    )
    completed(refined)
    assert [r["project"] for r in refined["rows"]] == ["Birch Campus", "Aurora Campus"]
    assert [r["planned_mw"] for r in refined["rows"]] == ["750", "500"]
    assert not refined["receipt"]["provider_events"]
    assert refined["parents"][0]["result_id"] == discovery["result_id"]

    private = imported(
        engine,
        [
            ("private_entity_id", "VARCHAR"),
            ("entity_key", "VARCHAR"),
            ("expert_capacity_mw", "BIGINT"),
        ],
        [{"private_entity_id": "p1", "entity_key": "Aurora Campus", "expert_capacity_mw": "480"}],
        "private_local",
    )
    observations = imported(
        engine,
        [("entity_key", "VARCHAR"), ("planned_mw", "BIGINT"), ("url", "VARCHAR")],
        [
            {
                "entity_key": "Aurora Campus",
                "planned_mw": "500",
                "url": "https://aurora.example/project",
            }
        ],
    )
    joined = engine.query(
        query=(EXAMPLES / "04_private_join.sql").read_text(),
        inputs={"private_entities": binding(private), "public_observations": binding(observations)},
    )
    completed(joined)
    assert joined["data_classification"] == "private_derived"
    assert joined["rows"][0]["expert_capacity_mw"] == "480"
    assert joined["rows"][0]["public_planned_mw"] == "500"
    assert not joined["receipt"]["provider_events"]

    selected = imported(engine, [("project", "VARCHAR")], [{"project": "Aurora Campus"}])
    expanded = engine.query(
        query=(EXAMPLES / "05_expand_row.sql").read_text(), inputs={"selected": binding(selected)}
    )
    completed(expanded)
    assert expanded["rows"][0]["project"] == "Aurora Campus"
    assert expanded["rows"][0]["url"] == "https://aurora.example/project"
    assert expanded["receipt"]["counts"]["search_queries"] == 1

    old = imported(
        engine,
        [("entity_key", "VARCHAR"), ("grid_status", "VARCHAR")],
        [{"entity_key": "Aurora Campus", "grid_status": "not signed"}],
    )
    new = imported(
        engine,
        [("entity_key", "VARCHAR"), ("grid_status", "VARCHAR")],
        [{"entity_key": "Aurora Campus", "grid_status": "signed"}],
    )
    diff = engine.query(
        query=(EXAMPLES / "06_compare_snapshots.sql").read_text(),
        inputs={"old_snapshot": binding(old), "new_snapshot": binding(new)},
    )
    completed(diff)
    assert diff["rows"] == [
        {
            "entity_key": "Aurora Campus",
            "prior_observation": "not signed",
            "newer_observation": "signed",
        }
    ]
    assert not diff["receipt"]["provider_events"]


def test_engine_score_norm_and_typed_scalar_actual_worker(tmp_path):
    engine = Engine(tmp_path / "engine")
    scores = engine.query(
        query="SELECT url,SEM_SCORE(content,'specific campus') AS score FROM WEB_SEARCH('fictional campuses') ORDER BY score DESC LIMIT 1"
    )
    completed(scores)
    assert scores["rows"] == [{"url": "https://aurora.example/project", "score": 0.8}]
    assert scores["receipt"]["counts"]["model_requests"] == 4
    labels = imported(
        engine,
        [("label", "VARCHAR")],
        [{"label": "Aurora"}, {"label": "Aurora Campus"}, {"label": "Birch"}, {"label": None}],
    )
    normalized = engine.query(
        query="SELECT label,SEM_NORM(label,'resolve fixture names') AS normalized FROM input.names",
        inputs={"names": binding(labels)},
    )
    completed(normalized)
    assert [r["normalized"] for r in normalized["rows"]] == [
        "Aurora Campus",
        "Aurora Campus",
        "Birch Campus",
        None,
    ]
    assert normalized["receipt"]["counts"]["model_requests"] == 1
    typed = engine.query(
        query="SELECT SEM_EXTRACT(content,'planned capacity',type := 'BIGINT') AS capacity FROM WEB_FETCH('https://aurora.example/project',mode := 'live')",
        profile="fixture",
    )
    completed(typed)
    assert typed["rows"] == [{"capacity": "500"}]
    assert typed["columns"][0]["logical_type"] == "BIGINT"
    assert all(s["content_basis"] == "synthetic_fixture" for s in typed["source_versions"])
    assert typed["data_classification"] == "synthetic_fixture"
    assert typed["receipt"]["data_classification"] == typed["data_classification"]
    assert typed["latest_receipt"]["data_classification"] == typed["data_classification"]
    fresh = Engine(tmp_path / "engine")
    reopened = fresh.read_result(typed["result_id"])
    assert reopened["data_classification"] == "synthetic_fixture"
    assert reopened["receipt"]["data_classification"] == reopened["data_classification"]
    assert reopened["latest_receipt"]["data_classification"] == reopened["data_classification"]
    assert fresh.run_status(typed["run_id"])["data_classification"] == "synthetic_fixture"


def test_engine_aggregate_and_json_cte_types_survive_materialization(tmp_path):
    engine = Engine(tmp_path / "engine")
    numeric = imported(
        engine, [("amount", "BIGINT")], [{"amount": "9223372036854775807"}, {"amount": "1"}]
    )
    result = engine.query(
        query="WITH totals AS (SELECT sum(amount) AS total FROM input.a) SELECT total FROM totals",
        inputs={"a": binding(numeric)},
    )
    completed(result)
    assert result["rows"] == [{"total": "9223372036854775808"}]
    assert result["columns"][0]["logical_type"] == "HUGEINT"
    json_data = imported(
        engine, [("payload", "VARCHAR")], [{"payload": '{"name":"Aurora Campus"}'}]
    )
    result = engine.query(
        query="WITH decoded AS (SELECT JSON_EXTRACT(payload,'$.name') AS json_name FROM input.a) SELECT CAST(json_name AS VARCHAR) AS name FROM decoded",
        inputs={"a": binding(json_data)},
    )
    completed(result)
    assert result["rows"] == [{"name": '"Aurora Campus"'}]


def test_engine_invalid_grouping_has_no_provider_work_actual_worker(tmp_path):
    engine = Engine(tmp_path / "engine")
    with pytest.raises(SourcesQLError) as error:
        engine.query(query="SELECT title FROM WEB_SEARCH('fixture campuses') GROUP BY url")
    assert error.value.code == "invalid_query"
    with engine.store.db() as db:
        receipt_text = db.execute(
            "SELECT receipt FROM runs ORDER BY rowid DESC LIMIT 1"
        ).fetchone()[0]
    import json

    receipt = json.loads(receipt_text)
    assert receipt["status"] == "failed"
    assert not receipt["counts"]
    assert receipt.get("provider_events", []) == []


def test_engine_null_semantic_evidence_has_unprocessed_partial_receipt(tmp_path):
    engine = Engine(tmp_path / "engine")
    data = imported(engine, [("content", "VARCHAR")], [{"content": None}])
    query = "SELECT SEM_MATCH(content,'specific campus') AS matched FROM input.a"
    with pytest.raises(SourcesQLError) as error:
        engine.query(query=query, inputs={"a": binding(data)}, partial_policy="strict")
    assert error.value.code == "invalid_output"
    partial = engine.query(
        query=query, inputs={"a": binding(data)}, partial_policy="retain_partial"
    )
    assert partial["rows"] == [{"matched": None}]
    assert partial["receipt"]["status"] == "partial"
    assert partial["receipt"]["plan_complete"] is False
    assert partial["operator_outcomes"][0]["status"] == "unprocessed"
    assert partial["receipt"]["counts"].get("model_requests", 0) == 0


def test_engine_publication_filter_and_nested_declared_types(tmp_path):
    engine = Engine(tmp_path / "engine")
    dated = engine.query(
        query="SELECT title FROM WEB_SEARCH('fictional campuses',published_after := '2026-01-01',undated_policy := 'exclude',allow_post_filter := true)"
    )
    completed(dated)
    assert dated["rows"] == [{"title": "Aurora Campus planning"}]
    assert dated["receipt"]["counts"]["search_queries"] == 1
    payload = {"count": "42", "amount": "123.45", "seen": "2026-10-13", "labels": ["Aurora", None]}
    data = imported(
        engine,
        [
            ("payload", "STRUCT(count BIGINT,amount DECIMAL(18,2),seen DATE,labels VARCHAR[])"),
            ("all_null", "BIGINT"),
        ],
        [{"payload": payload, "all_null": None}],
    )
    result = engine.query(query="SELECT payload,all_null FROM input.a", inputs={"a": binding(data)})
    completed(result)
    assert result["rows"] == [{"payload": payload, "all_null": None}]
    assert result["columns"][1]["logical_type"] == "BIGINT"


def test_oversized_intermediate_fails_instead_of_publishing_clipped_count(tmp_path):
    engine = Engine(tmp_path / "engine")
    data = imported(engine, [("id", "BIGINT")], [{"id": str(i)} for i in range(40)])
    query = "WITH expanded AS (SELECT a.id AS a_id,b.id AS b_id FROM input.a a CROSS JOIN input.b b) SELECT count(*) AS n FROM expanded"
    with pytest.raises(SourcesQLError) as error:
        engine.query(query=query, inputs={"a": binding(data), "b": binding(data)})
    assert error.value.code == "budget_exhausted"
    assert error.value.stage == "worker"
    with engine.store.db() as db:
        import json

        receipt = json.loads(
            db.execute("SELECT receipt FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()[0]
        )
        published = db.execute("SELECT count(*) FROM results").fetchone()[0]
    assert receipt["status"] == "failed"
    assert receipt["result_id"] is None
    assert receipt["errors"][0]["code"] == "budget_exhausted"
    assert published == 1  # The original imported input only; no clipped count.


@pytest.mark.parametrize(
    "code",
    ["provider_timeout", "provider_connection_error", "provider_http_error", "provider_error"],
)
def test_model_failure_keeps_category_without_copying_provider_text(tmp_path, monkeypatch, code):
    from sourcesql.contracts import SemanticOutcome
    from sourcesql.providers import ProviderRegistry

    calls = []

    def failed(registry, operator, text, instruction, fields, options, budget):
        calls.append(operator)
        return SemanticOutcome(
            None,
            "failed",
            usage={
                "failure": {
                    "code": code,
                    "message": "PRIVATE_PROVIDER_BODY_MUST_NOT_ESCAPE",
                    "remote_outcome_unknown": True,
                    "retryable": False,
                }
            },
        )

    monkeypatch.setattr(ProviderRegistry, "semantic", failed)
    engine = Engine(tmp_path / "engine")
    source = imported(engine, [("content", "VARCHAR")], [{"content": "Retained source text"}])
    with pytest.raises(SourcesQLError) as error:
        engine.query(
            query="SELECT SEM_EXTRACT(content,'stated value') AS value FROM input.saved",
            inputs={"saved": binding(source)},
            partial_policy="strict",
        )
    assert error.value.code == code
    assert "PRIVATE_PROVIDER_BODY" not in error.value.safe_message
    assert len(calls) == 1
    assert engine.capabilities()["semantic_limits"]["extract_all_max_items_per_call"] == 8


def test_named_field_failure_defaults_to_partial_with_citations_and_strict_still_fails(
    tmp_path, monkeypatch
):
    from pydantic_ai.messages import ModelResponse, ToolCallPart
    from pydantic_ai.models.function import FunctionModel
    from sourcesql.providers import ProviderRegistry
    from sourcesql.providers.semantic import PydanticSemanticProvider

    calls = []

    def model(_messages, info):
        calls.append(1)
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": {"name": "Aurora Campus", "status": "invented"},
                        "status": "supported_text",
                        "support": [{"field": "name", "quote": "Aurora Campus"}],
                    },
                )
            ]
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    monkeypatch.setattr(ProviderRegistry, "semantic", lambda self, *args: provider.semantic(*args))
    engine = Engine(tmp_path / "engine")
    source = imported(engine, [("content", "VARCHAR")], [{"content": "Aurora Campus"}])
    arguments = {
        "query": "WITH extracted AS (SELECT SEM_EXTRACT(content,'facts',name := 'name',status := 'status') AS facts FROM input.saved) SELECT facts.name AS name,facts.status AS status FROM extracted",
        "inputs": {"saved": binding(source)},
    }
    result = engine.query(**arguments)
    assert result["rows"] == [{"name": "Aurora Campus", "status": None}]
    assert result["columns"] == [
        {"key": "name", "label": "name", "logical_type": "VARCHAR", "nullable": True},
        {"key": "status", "label": "status", "logical_type": "VARCHAR", "nullable": True},
    ]
    assert result["receipt"]["status"] == "partial" and result["receipt"]["plan_complete"] is False
    assert result["operator_outcomes"][0]["field_errors"][0]["field"] == "status"
    assert any(
        s["quote"] == "Aurora Campus" for e in result["evidence"] for s in e.get("support", [])
    )
    assert len(calls) == 1
    # Cached successful siblings must retain the unavailable-cell diagnostic.
    replay = engine.query(**arguments)
    assert replay["receipt"]["status"] == "partial" and len(calls) == 1
    with pytest.raises(SourcesQLError) as error:
        engine.query(**arguments, partial_policy="strict")
    assert error.value.code == "evidence_invalid"
    assert error.value.safe_message == "Required semantic field is unavailable"
    assert len(calls) == 1


@pytest.mark.parametrize("case", ["mixed", "all_invalid", "not_stated", "scalar"])
def test_all_keeps_original_entities_null_slots_and_partial_cache_contract(
    tmp_path, monkeypatch, case
):
    from pydantic_ai.messages import ModelResponse, ToolCallPart
    from pydantic_ai.models.function import FunctionModel
    from sourcesql.providers import ProviderRegistry
    from sourcesql.providers.semantic import PydanticSemanticProvider

    text = "Aurora Campus is proposed; Birch Campus is operating. proposed remains tentative."
    values = [
        {"name": "Aurora Campus", "status": "proposed"},
        {"name": "Birch Campus", "status": "operating"},
    ]
    support = [
        {"item": 0, "field": "name", "quote": "Aurora Campus"},
        {"item": 0, "field": "status", "quote": "proposed"},
        {"item": 1, "field": "name", "quote": "Birch Campus"},
        {"item": 1, "field": "status", "quote": "is operating"},
    ]
    status = "supported_text"
    expected = [
        {"name": "Aurora Campus", "status": None},
        {"name": "Birch Campus", "status": "operating"},
    ]
    query = "SELECT UNNEST(SEM_EXTRACT_ALL(content,'entities',name := 'name',status := 'status'),recursive := true) FROM input.saved"
    if case == "all_invalid":
        support = []
        expected = [{"name": None, "status": None}, {"name": None, "status": None}]
    elif case == "not_stated":
        values = [{"name": None, "status": None}, {"name": None, "status": None}]
        support = []
        status = "not_stated"
        expected = values
    elif case == "scalar":
        values = ["Aurora Campus", "Birch Campus"]
        support = [{"item": 1, "quote": "Birch Campus"}]
        expected = [{"name": None}, {"name": "Birch Campus"}]
        query = "SELECT UNNEST(SEM_EXTRACT_ALL(content,'names')) AS name FROM input.saved"
    calls = []

    def model(_messages, info):
        calls.append(1)
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": values,
                        "status": status,
                        "support": support,
                    },
                )
            ]
        )

    provider = PydanticSemanticProvider(FunctionModel(model))
    monkeypatch.setattr(ProviderRegistry, "semantic", lambda self, *args: provider.semantic(*args))
    engine = Engine(tmp_path / "engine")
    source = imported(engine, [("content", "VARCHAR")], [{"content": text}])
    arguments = {"query": query, "inputs": {"saved": binding(source)}}
    result = engine.query(**arguments)
    assert result["rows"] == expected
    assert all(column["logical_type"] == "VARCHAR" for column in result["columns"])
    assert result["receipt"]["status"] == ("completed" if case == "not_stated" else "partial")
    assert result["receipt"]["plan_complete"] is (case == "not_stated")
    outcome = result["operator_outcomes"][0]
    assert bool(outcome["field_errors"]) is (case != "not_stated")
    if case == "mixed":
        assert {s["item"] for s in outcome["support"]} == {0, 1}
        assert not any(s["item"] == 0 and s["field"] == "status" for s in outcome["support"])
    elif case == "scalar":
        assert [s["item"] for s in outcome["support"]] == [1]
    elif case == "all_invalid":
        assert outcome["status"] == "evidence_invalid" and outcome["support"] == []
    assert len(calls) == 1
    replay = engine.query(**arguments)
    assert replay["rows"] == expected and replay["receipt"]["status"] == result["receipt"]["status"]
    assert len(calls) == (2 if case == "all_invalid" else 1)
    if case != "not_stated":
        with pytest.raises(SourcesQLError) as error:
            engine.query(**arguments, partial_policy="strict")
        assert error.value.code == "evidence_invalid"
        assert len(calls) == (3 if case == "all_invalid" else 1)
    else:
        assert engine.query(**arguments, partial_policy="strict")["rows"] == expected
        assert len(calls) == 1
