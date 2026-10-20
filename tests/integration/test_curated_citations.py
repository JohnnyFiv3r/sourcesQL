"""Canonical, provider-free host curation with advisory unsupported citations."""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
import hashlib

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.curation import bind_curated_citations, validate_citations
from sourcesql.engine import Engine, wire_value
from sourcesql.execution.evidence import checked_support
from sourcesql.execution.worker_process import evaluate
from sourcesql.research_quality import assess_requirements

QUOTE = "Airtop requires explicit approval for sensitive browser actions."
SOURCE = {
    "source_version_id": "src_approval",
    "url": "https://official.example/approvals",
    "content": "Product documentation. " + QUOTE + " More documentation.",
}
SOURCE["content_sha256"] = hashlib.sha256(SOURCE["content"].encode()).hexdigest()
CITATION = {
    "match": {"product": "Airtop"},
    "column_key": "approval_controls",
    "source_version_id": SOURCE["source_version_id"],
    "quote": QUOTE,
}


def bind(citations, rows=None, sources=None, columns=None):
    rows = (
        rows
        if rows is not None
        else [{"product": "Airtop", "approval_controls": "Explicit approval"}]
    )
    columns = columns or [Column(key) for key in rows[0]]
    table = Table(columns, rows)
    wire_rows = [
        {column.key: wire_value(row[column.key], column.logical_type) for column in columns}
        for row in rows
    ]
    row_ids = [f"saved_row_{index}" for index in range(len(rows))]
    retained = {SOURCE["source_version_id"]: deepcopy(SOURCE)} if sources is None else sources
    before = deepcopy((table, retained, citations, wire_rows))
    result = bind_curated_citations(
        table, row_ids, retained, validate_citations(citations), wire_rows=wire_rows
    )
    assert (table, retained, citations, wire_rows) == before
    return result


def test_explicit_citation_preserves_value_and_names_the_canonical_support():
    evidence, diagnostics, counts = bind([CITATION])
    assert not diagnostics
    assert counts == {
        "submitted_citations": 1,
        "attached_citations": 1,
        "unattached_citations": 0,
        "bound_cells": 1,
    }
    record = evidence[0]
    assert record["row_id"] == "saved_row_0"
    assert record["column_key"] == "approval_controls"
    assert record["status"] == "supported_text"
    assert record["operator"] == "CURATED_CITATION"
    assert record["attribution_basis"] == "agent_selected_quote"
    assert checked_support(record, {SOURCE["source_version_id"]: SOURCE}) == record["support"]
    span = record["support"][0]
    assert SOURCE["content"][span["start"] : span["end"]] == QUOTE
    assert span["content_sha256"] == SOURCE["content_sha256"]
    assert bind([CITATION])[0] == evidence


def test_normalization_is_deterministic_and_does_not_change_quote_or_selectors():
    alternate = {**CITATION, "source_version_id": "src_alternate"}
    original = [alternate, CITATION, deepcopy(CITATION)]
    before = deepcopy(original)
    assert validate_citations(original) == validate_citations([CITATION, alternate])
    assert original == before
    assert validate_citations(None) == validate_citations([]) == []
    assert validate_citations([{**CITATION, "match": {"weight": 1.0}}]) == validate_citations(
        [{**CITATION, "match": {"weight": 1}}]
    )


@pytest.mark.parametrize(
    "citation",
    [
        None,
        {**CITATION, "match": {}},
        {**CITATION, "match": {"constructor": "Airtop"}},
        {**CITATION, "match": {"product": object()}},
        {**CITATION, "match": {"product": float("nan")}},
        {**CITATION, "column_key": "missing.key"},
        {**CITATION, "source_version_id": "https://official.example/approvals"},
        {**CITATION, "quote": "  "},
        {**CITATION, "start": 0},
        {**CITATION, "start": True, "end": 10},
        {**CITATION, "start": 10, "end": 9},
        {**CITATION, "url": "https://unverified.example/"},
    ],
)
def test_structurally_invalid_citations_refuse_without_binding(citation):
    with pytest.raises(SourcesQLError) as error:
        validate_citations([citation])
    assert error.value.code == "invalid_request"
    assert error.value.stage == "admission"


def test_recipe_count_and_byte_bounds_are_checked_before_binding():
    with pytest.raises(SourcesQLError):
        validate_citations([CITATION] * 2049)
    with pytest.raises(SourcesQLError):
        validate_citations(
            [{**CITATION, "quote": "a" * 11000, "match": {"product": str(i)}} for i in range(200)]
        )


def test_duplicate_or_absent_rows_are_feedback_without_assigning_a_source_to_either():
    rows = [
        {"product": "Airtop", "approval_controls": "Explicit approval"},
        {"product": "Airtop", "approval_controls": "Different edition"},
    ]
    evidence, diagnostics, counts = bind(
        [CITATION, {**CITATION, "match": {"product": "Absent"}}], rows
    )
    assert evidence == diagnostics == []
    assert counts["row_ambiguous"] == counts["row_not_found"] == 1
    assert counts["unattached_citations"] == 2


def test_compound_selector_resolves_one_edition_without_guessing_an_entity():
    rows = [
        {"product": "Airtop", "edition": "Cloud", "approval_controls": "Explicit approval"},
        {"product": "Airtop", "edition": "Enterprise", "approval_controls": "Different"},
    ]
    evidence, diagnostics, _ = bind(
        [{**CITATION, "match": {"edition": "Cloud", "product": "Airtop"}}], rows
    )
    assert not diagnostics
    assert evidence[0]["row_id"] == "saved_row_0"


@pytest.mark.parametrize(
    ("citation", "reason", "status"),
    [
        ({**CITATION, "column_key": "missing"}, "unknown_column", None),
        (
            {**CITATION, "source_version_id": "src_forged"},
            "source_not_retained",
            "evidence_invalid",
        ),
        (
            {**CITATION, "quote": "The provider does not require approval."},
            "quote_not_found",
            "evidence_invalid",
        ),
        ({**CITATION, "start": 0, "end": len(QUOTE)}, "quote_range_mismatch", "evidence_invalid"),
    ],
)
def test_bad_individual_citations_keep_the_valid_table_and_report_safe_feedback(
    citation, reason, status
):
    evidence, diagnostics, counts = bind([citation])
    assert not evidence
    assert counts[reason] == counts["unattached_citations"] == 1
    if status:
        assert diagnostics[0]["row_id"] == "saved_row_0"
        assert diagnostics[0]["column_key"] == "approval_controls"
        assert diagnostics[0]["status"] == status
        assert diagnostics[0]["reason"] == reason
    else:
        assert not diagnostics


def test_a_bad_sibling_does_not_discard_valid_citations_or_rows():
    evidence, diagnostics, counts = bind(
        [CITATION, {**CITATION, "source_version_id": "src_forged"}]
    )
    assert len(evidence) == len(diagnostics) == 1
    assert counts["attached_citations"] == counts["unattached_citations"] == 1
    assert counts["bound_cells"] == 1


def test_null_target_is_not_promoted_to_supported_data_and_null_selector_is_exact():
    rows = [{"product": "Airtop", "edition": None, "approval_controls": None}]
    evidence, diagnostics, counts = bind(
        [{**CITATION, "match": {"product": "Airtop", "edition": None}}], rows
    )
    assert not evidence
    assert counts["null_target"] == 1
    assert diagnostics[0]["status"] == "unknown"
    assert diagnostics[0]["row_id"] == "saved_row_0"


def test_multiple_explicit_source_versions_can_support_the_same_cell():
    other = {**SOURCE, "source_version_id": "src_other", "url": "https://other.example/approval"}
    evidence, diagnostics, counts = bind(
        [CITATION, {**CITATION, "source_version_id": "src_other"}],
        sources={SOURCE["source_version_id"]: SOURCE, "src_other": other},
    )
    assert not diagnostics
    assert {item["source_version_id"] for item in evidence} == {"src_approval", "src_other"}
    assert counts["attached_citations"] == 2 and counts["bound_cells"] == 1


@pytest.mark.parametrize(
    ("source", "reason"),
    [
        ({**SOURCE, "content": None}, "source_text_unavailable"),
        ({**SOURCE, "source_version_id": "src_other"}, "source_identity_invalid"),
        ({**SOURCE, "content_sha256": "0" * 64}, "source_identity_invalid"),
    ],
)
def test_only_available_canonical_source_text_is_eligible(source, reason):
    evidence, diagnostics, counts = bind([CITATION], sources={"src_approval": source})
    assert not evidence
    assert diagnostics[0]["reason"] == reason
    assert counts[reason] == 1


def test_public_numeric_wire_identity_is_lossless_and_never_coerces_strings():
    rows = [
        {
            "count": 9007199254740993,
            "amount": Decimal("12345678901234567890.123456"),
            "approval_controls": "Explicit approval",
        }
    ]
    columns = [
        Column("count", "BIGINT"),
        Column("amount", "DECIMAL(38,6)"),
        Column("approval_controls"),
    ]
    evidence, diagnostics, counts = bind(
        [
            {
                **CITATION,
                "match": {"count": "9007199254740993", "amount": "12345678901234567890.123456"},
            },
            {**CITATION, "match": {"count": 9007199254740993}},
            {**CITATION, "match": {"amount": "12345678901234567890.123457"}},
        ],
        rows,
        columns=columns,
    )
    assert len(evidence) == 1 and not diagnostics
    assert counts["row_not_found"] == 2
    assert counts["attached_citations"] == 1


def test_boolean_and_numeric_zero_do_not_match_each_other():
    rows = [
        {"flag": False, "approval_controls": "Explicit approval"},
        {"flag": 0, "approval_controls": "Explicit approval"},
        {"flag": "0", "approval_controls": "Explicit approval"},
    ]
    table = Table([Column("flag"), Column("approval_controls")], rows)
    evidence, diagnostics, counts = bind_curated_citations(
        table,
        ["boolean", "number", "string"],
        {"src_approval": SOURCE},
        validate_citations([{**CITATION, "match": {"flag": False}}]),
        wire_rows=rows,
    )
    assert not diagnostics
    assert evidence[0]["row_id"] == "boolean"
    assert counts["bound_cells"] == 1


def test_unicode_offsets_use_canonical_character_coordinates_without_normalization():
    prefix, quote = "😀 e\u0301 café — ", "利用者が承認します"
    text = prefix + quote + "。"
    source = {"source_version_id": "src_unicode", "content": text}
    valid = {
        **CITATION,
        "source_version_id": "src_unicode",
        "quote": quote,
        "start": len(prefix),
        "end": len(prefix) + len(quote),
    }
    wrong_start = len(prefix.encode("utf-16-le")) // 2
    evidence, diagnostics, counts = bind(
        [valid, {**valid, "start": wrong_start, "end": wrong_start + len(quote)}],
        sources={"src_unicode": source},
    )
    assert len(evidence) == len(diagnostics) == 1
    assert evidence[0]["support"][0]["start"] == len(prefix)
    assert counts["quote_range_mismatch"] == 1


def test_repeated_quotes_require_explicit_occurrence_coordinates():
    text = QUOTE + " Earlier edition. " + QUOTE
    source = {"source_version_id": "src_repeat", "content": text}
    citation = {**CITATION, "source_version_id": "src_repeat"}
    second = text.rfind(QUOTE)
    evidence, diagnostics, counts = bind(
        [citation, {**citation, "start": second, "end": second + len(QUOTE)}],
        sources={"src_repeat": source},
    )
    assert len(evidence) == len(diagnostics) == 1
    assert evidence[0]["support"][0]["start"] == second
    assert counts["quote_ambiguous"] == 1


def test_nested_wire_selectors_keep_types_and_do_not_resolve_by_url_labels():
    citation = {**CITATION, "match": {"details": {"editions": ["Cloud", None], "active": False}}}
    rows = [
        {
            "details": {"editions": ["Cloud", None], "active": False},
            "source_url": SOURCE["url"],
            "approval_controls": "Explicit approval",
        }
    ]
    evidence, diagnostics, counts = bind([citation], rows)
    assert len(evidence) == 1 and not diagnostics and counts["bound_cells"] == 1
    # A matching display URL is only an explicit row selector. It never selects
    # a different source version or grants a source identity.
    evidence, diagnostics, counts = bind(
        [{**CITATION, "match": {"source_url": SOURCE["url"]}, "source_version_id": "src_forged"}],
        rows,
    )
    assert not evidence and diagnostics[0]["reason"] == "source_not_retained"


def _quality_for_citations(citations, *, value="Explicit approval", extra_diagnostics=()):
    rows = [{"product": "Airtop", "approval_controls": value}]
    _, diagnostics, counts = bind(citations, rows)
    table = Table([Column("product"), Column("approval_controls")], rows)
    quality = assess_requirements(
        table,
        ["saved_row_0"],
        [*diagnostics, *extra_diagnostics],
        {"key_columns": ["product"], "fields": ["approval_controls"], "minimum_rows": 1},
    )
    return quality, diagnostics, counts


def test_rejected_citation_is_advisory_with_or_without_a_valid_sibling():
    typo = {**CITATION, "quote": QUOTE.replace("approval", "apprvoal")}
    for citations in ([CITATION, typo], [typo]):
        quality, diagnostics, counts = _quality_for_citations(citations)
        assert counts["unattached_citations"] == counts["quote_not_found"] == 1
        assert diagnostics[0]["status"] == "evidence_invalid"
        assert diagnostics[0]["reason"] == "quote_not_found"
        assert diagnostics[0]["advisory"] is True
        assert quality["complete"] is True
        assert quality["goal_status"] == "requirements_satisfied"
        assert quality["unresolved_cells"] == quality["gaps_total"] == 0


def test_advisory_citation_does_not_hide_a_missing_required_value():
    quality, diagnostics, counts = _quality_for_citations([CITATION], value=None)
    assert counts["null_target"] == 1
    assert diagnostics[0]["advisory"] is True
    assert diagnostics[0]["status"] == "unknown"
    assert quality["complete"] is False
    assert quality["unresolved_cells"] == quality["gaps_total"] == 1
    assert quality["gaps"][0]["status"] == "uninspected"


@pytest.mark.parametrize("advisory", [False, True])
def test_valid_citation_does_not_hide_a_real_extraction_gap_on_a_populated_cell(advisory):
    extraction_gap = {
        "operator": "SEM_EXTRACT",
        "row_id": "saved_row_0",
        "column_key": "approval_controls",
        "status": "not_inspected",
        "reason": "not_inspected",
        "advisory": advisory,
    }
    quality, diagnostics, counts = _quality_for_citations(
        [CITATION, {**CITATION, "quote": "A quote typo"}],
        extra_diagnostics=[extraction_gap],
    )
    assert counts["attached_citations"] == 1
    assert diagnostics[0]["advisory"] is True
    assert quality["complete"] is False
    assert quality["unresolved_cells"] == quality["gaps_total"] == 1
    assert quality["gaps"][0]["status"] == "not_inspected"


def test_published_and_reused_research_keeps_rejected_attribution_advisory(tmp_path):
    def worker(sql, tables, parameters=None, timeout=30):
        result = evaluate(
            {
                "sql": sql,
                "tables": {alias: table.to_dict() for alias, table in tables.items()},
                "parameters": parameters or {},
                "max_rows": 1001,
            }
        )
        return Table(
            [Column(c["key"], c["logical_type"], c["nullable"]) for c in result["columns"]],
            result["rows"],
        )

    engine = Engine(tmp_path, worker=worker)
    source = engine.query(query="SELECT content FROM WEB_FETCH('https://aurora.example/project')")
    retained = source["source_versions"][0]
    valid = {
        "match": {"product": "Aurora"},
        "column_key": "claim",
        "source_version_id": retained["source_version_id"],
        "quote": retained["content"],
    }
    requirements = {"key_columns": ["product"], "fields": ["claim"], "minimum_rows": 1}

    def pin(result):
        return {"result_id": result["result_id"], "view": "original", "amendment_revision": None}

    published = engine.query(
        query="SELECT 'Aurora' AS product, 'Agent-interpreted finding' AS claim FROM input.saved LIMIT 1",
        inputs={"saved": pin(source)},
        citations=[valid, {**valid, "quote": "A quote typo not present in the source"}],
        research_requirements=requirements,
    )
    reused = engine.query(
        query="SELECT product, claim FROM input.saved",
        inputs={"saved": pin(published)},
        research_requirements=requirements,
    )
    for result in (published, reused):
        assert result["research_quality"]["complete"] is True
        assert result["research_quality"]["gaps_total"] == 0
        assert result["receipt"]["goal_status"] == "requirements_satisfied"
        diagnostics = result["cell_diagnostics"]
        assert len(diagnostics) == 1
        assert diagnostics[0]["operator"] == "CURATED_CITATION"
        assert diagnostics[0]["status"] == "evidence_invalid"
        assert diagnostics[0]["advisory"] is True
        assert result["bound_evidence_cells"] == 1
    assert published["citation_feedback"]["attached_citations"] == 1
    assert published["citation_feedback"]["unattached_citations"] == 1
    assert published["receipt"]["counts"] == reused["receipt"]["counts"] == {}
