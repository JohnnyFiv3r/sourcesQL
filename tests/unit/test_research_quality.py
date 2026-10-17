"""Research obligations do not inherit SQL completion or assert factual truth."""

from copy import deepcopy
import json

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.research_quality import assess_requirements, validate_requirements


COLUMNS = [Column("entity"), Column("value", "DOUBLE"), Column("active", "BOOLEAN")]
REQUIREMENTS = {"key_columns": ["entity"], "fields": ["value"]}


def table(rows):
    return Table(COLUMNS, rows)


def test_validation_returns_an_independent_descriptor_with_an_explicit_row_default():
    raw = {"fields": ["value", "entity"], "key_columns": ["entity"]}
    normalized = validate_requirements(raw, [column.to_dict() for column in COLUMNS])
    assert normalized == {
        "key_columns": ["entity"],
        "fields": ["value", "entity"],
        "minimum_rows": 0,
    }
    normalized["fields"].append("active")
    assert raw["fields"] == ["value", "entity"]
    assert validate_requirements(None, []) is None


@pytest.mark.parametrize(
    "raw",
    [
        {},
        [],
        "all fields",
        {"key_columns": ["entity"]},
        {**REQUIREMENTS, "fields": []},
        {**REQUIREMENTS, "key_columns": []},
        {**REQUIREMENTS, "fields": ["value", "value"]},
        {**REQUIREMENTS, "key_columns": ["entity", "entity"]},
        {**REQUIREMENTS, "fields": ["missing"]},
        {**REQUIREMENTS, "fields": [["value"]]},
        {**REQUIREMENTS, "minimum_rows": -1},
        {**REQUIREMENTS, "minimum_rows": 1001},
        {**REQUIREMENTS, "minimum_rows": True},
        {**REQUIREMENTS, "minimum_rows": 1.0},
        {**REQUIREMENTS, "instructions": "PRIVATE-RAW-REQUEST"},
    ],
)
def test_invalid_obligations_refuse_with_a_safe_fixed_error(raw):
    with pytest.raises(SourcesQLError) as error:
        validate_requirements(raw, COLUMNS)
    assert error.value.code == "invalid_request"
    assert "PRIVATE" not in error.value.safe_message


def test_validation_enforces_column_and_field_bounds():
    columns = [Column("field_" + str(index)) for index in range(33)]
    validate_requirements(
        {
            "key_columns": [c.key for c in columns[:4]],
            "fields": [c.key for c in columns[:32]],
            "minimum_rows": 1000,
        },
        columns,
    )
    for raw in [
        {"key_columns": [c.key for c in columns[:5]], "fields": [columns[0].key]},
        {"key_columns": [columns[0].key], "fields": [c.key for c in columns]},
    ]:
        with pytest.raises(SourcesQLError):
            validate_requirements(raw, columns)


@pytest.mark.parametrize("kind", ["VARCHAR[]", "STRUCT(name VARCHAR)", "JSON"])
def test_complex_fields_are_supported_but_cannot_act_as_scalar_key_columns(kind):
    columns = [Column("entity"), Column("details", kind)]
    assert validate_requirements({"key_columns": ["entity"], "fields": ["details"]}, columns)
    with pytest.raises(SourcesQLError) as error:
        validate_requirements({"key_columns": ["details"], "fields": ["entity"]}, columns)
    assert error.value.code == "invalid_request"


def test_undeclared_quality_stays_not_evaluated_for_nonempty_and_empty_results():
    for result, identities in [(table([]), []), (table([{"entity": "A", "value": 5}]), ["row_a"])]:
        assessment = assess_requirements(result, identities, [], None)
        assert assessment["goal_status"] == "not_evaluated"
        assert assessment["complete"] is False
        assert assessment["required_cells"] == 0
        assert assessment["factual_truth_verified"] is False


def test_present_cells_only_satisfy_declared_obligations_without_a_truth_claim():
    result = table([{"entity": "A", "value": 0, "active": False}])
    assessment = assess_requirements(
        result, ["row_a"], [], {"key_columns": ["entity"], "fields": ["value", "active", "entity"]}
    )
    assert assessment["goal_status"] == "requirements_satisfied"
    assert assessment["complete"] is True
    assert assessment["required_cells"] == 3
    assert assessment["unresolved_cells"] == 0 and assessment["gaps"] == []
    assert assessment["scope"] == "declared_cells_and_minimum_rows"
    assert assessment["factual_truth_verified"] is False


def test_missing_values_keep_uninspected_unknown_and_failed_states_distinct():
    statuses = [
        "not_stated",
        "unknown",
        "not_inspected",
        "failed",
        "invalid_output",
        "evidence_invalid",
    ]
    rows = [{"entity": str(index), "value": None} for index in range(len(statuses) + 1)]
    identities = ["row_" + str(index) for index in range(len(rows))]
    diagnostics = [
        {
            "row_id": row_id,
            "column_key": "value",
            "status": status,
            "diagnostic_id": "d_" + str(index),
            "source_version_id": "src_" + str(index),
            "value_path": [],
        }
        for index, (row_id, status) in enumerate(zip(identities, statuses))
    ]
    assessment = assess_requirements(table(rows), identities, diagnostics, REQUIREMENTS)
    assert assessment["goal_status"] == "partial" and assessment["complete"] is False
    assert assessment["unresolved_cells"] == len(rows)
    assert [gap["status"] for gap in assessment["gaps"]] == [*statuses, "uninspected"]
    assert assessment["gaps"][0]["diagnostic_id"] == "d_0"
    assert assessment["gaps"][0]["source_version_id"] == "src_0"
    assert assessment["gaps"][0]["value_path"] == []


def test_unresolved_diagnostics_override_nonnull_cells_without_rewriting_values():
    result = table([{"entity": "A", "value": 10}])
    diagnostics = [
        {"row_id": "row_a", "column_key": "value", "status": status, "diagnostic_id": "d_" + status}
        for status in ["evidence_invalid", "ambiguous"]
    ]
    original_result, original_diagnostics = deepcopy(result), deepcopy(diagnostics)
    assessment = assess_requirements(result, ["row_a"], diagnostics, REQUIREMENTS)
    assert assessment["unresolved_cells"] == 1
    assert assessment["gaps_total"] == 2
    assert result == original_result and diagnostics == original_diagnostics
    assert [gap["status"] for gap in assessment["gaps"]] == ["evidence_invalid", "ambiguous"]


def test_resolved_diagnostic_cannot_make_a_null_cell_complete():
    assessment = assess_requirements(
        table([{"entity": "A", "value": None}]),
        ["row_a"],
        [{"row_id": "row_a", "column_key": "value", "status": "processed", "diagnostic_id": "d_a"}],
        REQUIREMENTS,
    )
    assert assessment["unresolved_cells"] == 1
    assert assessment["gaps"][0]["status"] == "unknown"
    assert assessment["gaps"][0]["diagnostic_status"] == "processed"


def test_minimum_rows_is_independent_of_cell_fill_and_allows_explicit_zero():
    missing = assess_requirements(table([]), [], [], {**REQUIREMENTS, "minimum_rows": 2})
    assert missing["row_shortfall"] == 2 and missing["goal_status"] == "partial"
    assert missing["required_cells"] == 0 and missing["gaps"] == []
    empty = assess_requirements(table([]), [], [], {**REQUIREMENTS, "minimum_rows": 0})
    assert empty["goal_status"] == "requirements_satisfied"
    assert empty["factual_truth_verified"] is False


def test_gap_payload_is_bounded_while_total_cell_and_gap_counts_stay_exact():
    rows = [{"entity": str(index), "value": None} for index in range(400)]
    identities = ["row_" + str(index) for index in range(400)]
    assessment = assess_requirements(table(rows), identities, [], REQUIREMENTS)
    assert len(assessment["gaps"]) == 256
    assert assessment["gaps_total"] == 400 and assessment["gaps_omitted"] == 144
    assert assessment["required_cells"] == 800 and assessment["unresolved_cells"] == 400
    assert assessment["gaps"][0]["row_id"] == "row_0"
    assert assessment["gaps"][-1]["row_id"] == "row_255"


def test_diagnostic_text_and_unsafe_references_never_enter_gap_metadata():
    diagnostics = [
        {
            "row_id": "row_a",
            "column_key": "value",
            "status": "PRIVATE-STATUS",
            "diagnostic_id": "PRIVATE RAW DIAGNOSTIC",
            "source_version_id": "https://private.example/key",
            "reason": "PRIVATE-REASON",
            "message": "PRIVATE-PROVIDER-MESSAGE",
            "value_path": ["PRIVATE PATH"],
        }
    ]
    assessment = assess_requirements(
        table([{"entity": "A", "value": None}]), ["row_a"], diagnostics, REQUIREMENTS
    )
    assert assessment["gaps"] == [{"row_id": "row_a", "column_key": "value", "status": "unknown"}]
    assert "PRIVATE" not in json.dumps(assessment)


def test_nested_diagnostic_paths_survive_safely_and_duplicate_records_do_not_inflate_counts():
    result = Table(
        [Column("entity"), Column("details", "STRUCT(value DOUBLE)")],
        [{"entity": "A", "details": {"value": None}}],
    )
    diagnostic = {
        "row_id": "row_a",
        "column_key": "details",
        "value_path": ["value"],
        "status": "not_stated",
        "diagnostic_id": "d_a",
    }
    assessment = assess_requirements(
        result,
        ["row_a"],
        [diagnostic, diagnostic],
        {"key_columns": ["entity"], "fields": ["details"]},
    )
    assert assessment["unresolved_cells"] == assessment["gaps_total"] == 1
    assert assessment["gaps"][0]["value_path"] == ["value"]
    assessment["gaps"][0]["value_path"].append("changed")
    assert diagnostic["value_path"] == ["value"]


@pytest.mark.parametrize("identities", [[], ["row_a", "row_a"], ["private id"], [None]])
def test_invalid_result_identities_are_refused(identities):
    with pytest.raises(SourcesQLError) as error:
        assess_requirements(table([{"entity": "A", "value": None}]), identities, [], REQUIREMENTS)
    assert error.value.code == "invalid_output"


def test_unrelated_diagnostics_do_not_change_the_requested_cells():
    result = table([{"entity": "A", "value": 10}])
    diagnostics = [
        {"row_id": "other_row", "column_key": "value", "status": "failed"},
        {"row_id": "row_a", "column_key": "active", "status": "failed"},
    ]
    assert assess_requirements(result, ["row_a"], diagnostics, REQUIREMENTS)["complete"] is True
