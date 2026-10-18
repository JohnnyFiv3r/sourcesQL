"""SQL feedback describes actual execution without judging or blocking answers."""

from __future__ import annotations

import uuid

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table, canonical, digest
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate


def worker(sql, tables, parameters=None, timeout=30):
    result = evaluate(
        {
            "sql": sql,
            "tables": {key: value.to_dict() for key, value in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
    )
    return Table(
        [
            Column(column["key"], column["logical_type"], column["nullable"])
            for column in result["columns"]
        ],
        result["rows"],
    )


INTENT = {
    "question": "Which tracks were purchased in the greatest total quantities?",
    "row_unit": "One track, ranked by purchased units",
    "fields": [
        {"key": "track", "meaning": "Track identifier"},
        {"key": "quantity", "meaning": "Total units purchased, SUM of line quantities"},
    ],
}


def lines(engine):
    saved = engine.import_table(
        columns=[
            {"key": "track", "logical_type": "VARCHAR", "nullable": False},
            {"key": "quantity", "logical_type": "BIGINT", "nullable": False},
        ],
        rows=[{"track": "A", "quantity": 10}, *[{"track": "B", "quantity": 1} for _ in range(3)]],
    )
    return {
        "lines": {"result_id": saved["result_id"], "view": "original", "amendment_revision": None}
    }


def test_count_and_sum_same_shape_have_different_winners_and_truthful_feedback(tmp_path):
    engine = Engine(tmp_path, worker=worker)
    inputs = lines(engine)
    outputs = []
    for operation in ("COUNT", "SUM"):
        query = f"SELECT track, {operation}(quantity) AS quantity FROM input.lines GROUP BY track ORDER BY quantity DESC, track LIMIT 1"
        result = engine.query(query=query, inputs=inputs, answer_intent=INTENT)
        feedback = result["query_feedback"]
        assert result["receipt"]["status"] == "completed"
        assert feedback["advisory"] is True
        assert feedback["missing_intended_fields"] == []
        assert feedback["query_sha256"] == digest(query)
        assert feedback["parameters_sha256"] == digest({})
        assert feedback["description_status"] == "available"
        assert operation in canonical(feedback["description"]).decode()
        assert feedback["answer_intent"] == INTENT
        assert feedback["result_observations"]["row_count"] == 1
        assert engine.read_result(result["result_id"])["query_feedback"] == feedback
        outputs.append(result["rows"][0])
    assert [row["track"] for row in outputs] == ["B", "A"]
    assert [int(row["quantity"]) for row in outputs] == [3, 10]


def test_requested_fields_absent_from_valid_source_catalog_are_feedback_not_errors(tmp_path):
    engine = Engine(tmp_path, worker=worker)
    query = "SELECT title AS source_title, url AS source_url FROM WEB_SEARCH('synthetic catalog') LIMIT 2"
    result = engine.query(query=query, answer_intent=INTENT)
    assert result["receipt"]["status"] == "completed"
    assert result["rows"]
    feedback = result["query_feedback"]
    assert feedback["output_columns"] == ["source_title", "source_url"]
    assert feedback["missing_intended_fields"] == ["track", "quantity"]
    assert feedback["intent_status"] == "provided"
    assert "SEM_EXTRACT" not in canonical(feedback["description"]).decode()
    assert result["receipt"]["counts"].get("model_requests", 0) == 0


def test_null_cells_count_full_result_not_just_read_page_and_never_drop_rows(tmp_path):
    engine = Engine(tmp_path, worker=worker)
    saved = engine.import_table(
        columns=[{"key": "entity", "logical_type": "VARCHAR", "nullable": True}],
        rows=[{"entity": None}, {"entity": "Known"}, {"entity": None}],
    )
    result = engine.query(
        query="SELECT entity FROM input.saved",
        inputs={
            "saved": {
                "result_id": saved["result_id"],
                "view": "original",
                "amendment_revision": None,
            }
        },
        answer_intent={"row_unit": "One entity", "fields": [{"key": "entity", "meaning": "Name"}]},
    )
    page = engine.read_result(result["result_id"], offset=1, limit=1)
    assert page["rows"] == [{"entity": "Known"}]
    assert page["query_feedback"]["result_observations"] == {
        "row_count": 3,
        "null_cells": [{"key": "entity", "count": 2}],
    }
    assert result["row_count"] == 3


def test_unavailable_explainer_and_invalid_advisory_intent_do_not_fail_valid_query(
    tmp_path, monkeypatch
):
    from sourcesql.sql import query_description

    def unavailable(plan):
        raise RuntimeError("PRIVATE-DESCRIPTION-ERROR")

    monkeypatch.setattr(query_description, "describe_query", unavailable)
    engine = Engine(tmp_path, worker=worker)
    result = engine.query(
        query="SELECT title FROM WEB_SEARCH('fixture') LIMIT 1", answer_intent={"fields": "bad"}
    )
    feedback = result["query_feedback"]
    assert result["receipt"]["status"] == "completed"
    assert feedback["description_status"] == "unavailable"
    assert feedback["intent_status"] == "invalid"
    assert "PRIVATE" not in canonical(feedback).decode()
    assert "answer_intent" not in feedback and "description" not in feedback


def test_explain_reports_query_and_independent_intent_without_provider_calls(tmp_path):
    engine = Engine(tmp_path, worker=worker)
    result = engine.explain(
        query="SELECT title FROM WEB_SEARCH('fixture') LIMIT 1", answer_intent=INTENT
    )
    assert result["external_calls"] == 0
    assert result["query_feedback"]["missing_intended_fields"] == ["track", "quantity"]
    assert "result_observations" not in result["query_feedback"]


def test_idempotent_request_preserves_feedback_and_changed_intent_is_not_silent(tmp_path):
    engine = Engine(tmp_path, worker=worker)
    request = {
        "query": "SELECT title FROM WEB_SEARCH('fixture') LIMIT 1",
        "answer_intent": INTENT,
        "request_id": str(uuid.uuid4()),
    }
    result = engine.query(**request)
    replay = engine.query(**request)
    assert result["result_id"] == replay["result_id"]
    assert result["query_feedback"] == replay["query_feedback"]
    with pytest.raises(SourcesQLError) as error:
        engine.query(**{**request, "answer_intent": {**INTENT, "row_unit": "A different question"}})
    assert error.value.code == "idempotency_conflict"
