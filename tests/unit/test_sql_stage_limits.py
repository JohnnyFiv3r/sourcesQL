"""Materialized relational populations are complete or explicitly fail."""

from __future__ import annotations

import pytest

from sourcesql.contracts import SourcesQLError
from sourcesql.execution.worker_process import StageLimitExceeded, evaluate


def request(rows, maximum):
    return {
        "sql": "SELECT id FROM staged ORDER BY id",
        "tables": {
            "staged": {
                "columns": [{"key": "id", "logical_type": "BIGINT"}],
                "rows": [{"id": value} for value in range(rows)],
            }
        },
        "max_rows": maximum,
    }


def test_exact_stage_ceiling_is_complete_but_one_more_row_is_budget_failure():
    complete = evaluate(request(1001, 1001))
    assert len(complete["rows"]) == 1001
    assert complete["rows"][-1] == {"id": 1000}
    with pytest.raises(SourcesQLError) as error:
        evaluate(request(1002, 1001))
    assert isinstance(error.value, StageLimitExceeded)
    assert error.value.code == "budget_exhausted"
    assert error.value.stage == "worker"


def test_zero_stage_ceiling_preserves_empty_schema_and_refuses_nonempty():
    empty = evaluate(request(0, 0))
    assert empty["rows"] == []
    assert empty["columns"][0]["logical_type"] == "BIGINT"
    with pytest.raises(StageLimitExceeded):
        evaluate(request(1, 0))
