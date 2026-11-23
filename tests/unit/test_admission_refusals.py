"""Each security-relevant admission refusal fires for the SQL that should trigger it.

Existing admission tests only check that some SourcesQLError is raised, so a refusal can be
replaced by a different one, or removed behind an earlier check, without any test noticing. Every
case here names the refusal's code and the start of its sentence. Messages are matched by prefix
so detail appended to a sentence does not break them.

UNREACHABLE: refusal sites that no input fires, each shadowed by an earlier check that
refuses the same input first. Coverage confirms none of them runs under the whole suite.
- "DISTINCT ON is not installed" (admission.py _closed_tree): the Distinct node's `on` clause is
  refused first as "Unsupported clause in Distinct".
- "A query parameter has no binding" inside _Binder.infer: admit() refuses unbound parameters
  with the same sentence before the binder runs.
- "Unknown external operator" (validate_call): it is only called for names custom_name() has
  already accepted.
- "Only SELECT query blocks are installed" (_Binder._query): _closed_tree and the statement-type
  check in admit() leave only Select and SetOperation nodes.
Deleting one of these refusals does not change behaviour today. They are defence in depth.
"""

from __future__ import annotations

import pytest

from sourcesql.contracts import Column, SourcesQLError
from sourcesql.sql.admission import admit, validate_type

SCHEMAS = {
    "a": [Column("id", "BIGINT"), Column("content"), Column("label"), Column("items", "VARCHAR[]")],
    "b": [Column("id", "BIGINT"), Column("value", "BIGINT")],
}


def ctes(count):
    chain = ", ".join(f"c{i} AS (SELECT 1 AS x)" for i in range(count))
    return f"WITH {chain} SELECT x FROM c0"


CASES = [
    # (id, sql, parameters, code, message start)
    (
        "duplicate_option",
        "SELECT url FROM WEB_SEARCH('x', per_query_limit := 1, per_query_limit := 2)",
        None,
        "invalid_query",
        "Duplicate operator option",
    ),
    (
        "positional_after_named",
        "SELECT url FROM WEB_SEARCH('x', per_query_limit := 1, 'y')",
        None,
        "invalid_query",
        "Positional arguments must precede named options",
    ),
    (
        "ast_size",
        "SELECT " + "+".join(["1"] * 2100) + " AS x",
        None,
        "invalid_query",
        "Query exceeds the AST size limit",
    ),
    (
        "too_many_ctes",
        ctes(17),
        None,
        "invalid_query",
        "Query exceeds the installed composition limit",
    ),
    (
        "too_many_tables",
        "SELECT 1 AS x FROM " + " CROSS JOIN ".join(f"input.b t{i}" for i in range(33)),
        None,
        "invalid_query",
        "Query exceeds the installed composition limit",
    ),
    (
        "ast_depth",
        "SELECT " + "+".join(["1"] * 45) + " AS x",
        None,
        "invalid_query",
        "Query exceeds the AST depth limit",
    ),
    (
        "set_by_name",
        "SELECT 1 AS a UNION BY NAME SELECT 2 AS a",
        None,
        "unsupported_query",
        "Set operations by name are not installed",
    ),
    (
        "full_join",
        "SELECT a.id FROM input.a a FULL JOIN input.b b ON a.id=b.id",
        None,
        "unsupported_query",
        "Only INNER, LEFT, and CROSS joins are installed",
    ),
    (
        "left_join_without_condition",
        "SELECT a.id FROM input.a a LEFT JOIN input.b b",
        None,
        "invalid_query",
        "LEFT joins require ON or USING",
    ),
    (
        "struct_field",
        "SELECT {'a b': 1} AS s",
        None,
        "unsupported_query",
        "Struct fields require ordinary named keys",
    ),
    (
        "unknown_qualified_struct_field",
        "SELECT q.s.zzz AS v FROM (SELECT {'a': 1} AS s) q",
        None,
        "invalid_query",
        "Unknown relation or struct field",
    ),
    (
        "unknown_struct_field",
        "SELECT (q.s).zzz AS v FROM (SELECT {'a': 1} AS s) q",
        None,
        "invalid_query",
        "Unknown struct field",
    ),
    (
        "unsupported_relation_expression",
        "SELECT * FROM UNNEST([1])",
        None,
        "unsupported_query",
        "Unsupported relation expression",
    ),
    (
        "join_on_aggregate",
        "SELECT a.id FROM input.a a JOIN input.b b ON count(*) > 0",
        None,
        "unsupported_query",
        "JOIN ON requires pure scalar relational expressions",
    ),
    (
        "unused_parameter",
        "SELECT 1 AS x",
        {"unused": 1},
        "invalid_query",
        "Parameter bindings must exactly match the query",
    ),
    (
        "unbound_parameter",
        "SELECT $missing AS v",
        None,
        "invalid_query",
        "A query parameter has no binding",
    ),
    (
        "scalar_subquery_columns",
        "SELECT (SELECT id, value FROM input.b) AS v",
        None,
        "invalid_query",
        "A scalar subquery requires one column",
    ),
    (
        "derived_relation_alias",
        "SELECT id FROM (SELECT id FROM input.b)",
        None,
        "invalid_query",
        "Derived relations require a local alias",
    ),
    (
        "non_search_source_operator",
        "SELECT * FROM SEM_MATCH('x')",
        None,
        "unsupported_query",
        "Only WEB_SEARCH and WEB_FETCH are source operators",
    ),
    (
        "physical_relation",
        "SELECT * FROM secrets_table",
        None,
        "unsupported_query",
        "Physical relations are not exposed",
    ),
    (
        "alias_column_count",
        "SELECT x FROM input.b AS t(x)",
        None,
        "invalid_query",
        "Relation alias column count does not match its schema",
    ),
    (
        "unsupported_web_option",
        "SELECT url FROM WEB_SEARCH('x', mode := 'live')",
        None,
        "unsupported_query",
        "Unsupported web source option",
    ),
    (
        "row_dependent_web_argument_type",
        "SELECT WEB_FETCH(id) AS d FROM input.b",
        None,
        "invalid_query",
        "Row-dependent web arguments must have VARCHAR type",
    ),
    (
        "per_query_limit_range",
        "SELECT url FROM WEB_SEARCH('x', per_query_limit := 101)",
        None,
        "invalid_query",
        "per_query_limit must be an integer from 1 to 100",
    ),
    (
        "unsupported_fetch_mode",
        "SELECT WEB_FETCH(label, mode := 'stale') AS d FROM input.a",
        None,
        "invalid_query",
        "Unsupported fetch mode",
    ),
    (
        "publication_filter_needs_policy",
        "SELECT url FROM WEB_SEARCH('x', published_after := '2025-01-01')",
        None,
        "invalid_query",
        "Publication filters require an explicit undated_policy",
    ),
    (
        "source_window_arity",
        "SELECT SOURCE_WINDOW(content, 0) AS w FROM input.a",
        None,
        "invalid_query",
        "SOURCE_WINDOW requires content, zero-based start and length",
    ),
    (
        "source_window_offset_type",
        "SELECT SOURCE_WINDOW(content, 'a', 5) AS w FROM input.a",
        None,
        "invalid_query",
        "SOURCE_WINDOW offsets must be integers",
    ),
    (
        "source_window_negative_offset",
        "SELECT SOURCE_WINDOW(content, $start, 5) AS w FROM input.a",
        {"start": -1},
        "invalid_query",
        "SOURCE_WINDOW offsets must be nonnegative",
    ),
    (
        "semantic_arity",
        "SELECT SEM_EXTRACT(content) AS v FROM input.a",
        None,
        "invalid_query",
        "Semantic operators require a value and literal instruction",
    ),
    (
        "semantic_input_type",
        "SELECT SEM_EXTRACT(id, 'x') AS v FROM input.a",
        None,
        "invalid_query",
        "Semantic inputs must have VARCHAR type",
    ),
    (
        "semantic_empty_instruction",
        "SELECT SEM_EXTRACT(content, ' ') AS v FROM input.a",
        None,
        "invalid_query",
        "Semantic instructions require a nonempty string",
    ),
    (
        "typed_extract_all",
        "SELECT SEM_EXTRACT_ALL(content, 'x', type := 'VARCHAR') AS v FROM input.a",
        None,
        "unsupported_query",
        "Typed scalar EXTRACT_ALL is not installed",
    ),
    (
        "extraction_field_schema",
        "SELECT SEM_EXTRACT(content, 'x', \"bad name\" := 'y') AS v FROM input.a",
        None,
        "invalid_query",
        "Invalid extraction field schema",
    ),
    (
        "extraction_type",
        "SELECT SEM_EXTRACT(content, 'x', type := 'GEOMETRY') AS v FROM input.a",
        None,
        "invalid_query",
        "Unsupported semantic extraction type",
    ),
    (
        "extraction_evidence_option",
        "SELECT SEM_EXTRACT(content, 'x', evidence := 'sometimes') AS v FROM input.a",
        None,
        "invalid_query",
        "Unsupported evidence option",
    ),
    (
        "extraction_field_definition",
        "SELECT SEM_EXTRACT(content, 'x', field := ' ') AS v FROM input.a",
        None,
        "invalid_query",
        "Named extraction fields require nonempty definitions",
    ),
    (
        "correlated_external_call",
        "SELECT (SELECT SEM_EXTRACT(a.content, 'x') FROM input.b b) AS v FROM input.a a",
        None,
        "unsupported_query",
        "Correlated subqueries support pure SQL only",
    ),
    (
        "duplicate_cte_name",
        "WITH c AS (SELECT 1 AS x), c AS (SELECT 2 AS x) SELECT x FROM c",
        None,
        "invalid_query",
        "Duplicate or invalid CTE name",
    ),
    (
        "cte_alias_count",
        "WITH c(a, b) AS (SELECT 1 AS x) SELECT a FROM c",
        None,
        "invalid_query",
        "CTE alias column count mismatch",
    ),
    (
        "set_operand_counts",
        "SELECT id FROM input.b UNION ALL SELECT id, value FROM input.b",
        None,
        "invalid_query",
        "Set operands must have matching column counts",
    ),
    (
        "duplicate_relation_alias",
        "SELECT t.id FROM input.a t JOIN input.b t ON t.id = t.id",
        None,
        "invalid_query",
        "Duplicate relation alias",
    ),
    ("star_without_relation", "SELECT *", None, "invalid_query", "Star projection has no relation"),
    (
        "window_in_having",
        "SELECT id FROM input.b GROUP BY id HAVING row_number() OVER () > 0",
        None,
        "invalid_query",
        "Windows are not valid in HAVING",
    ),
    (
        "duplicate_output_columns",
        "SELECT 1 AS x, 2 AS X",
        None,
        "invalid_query",
        "Duplicate output column names",
    ),
    (
        "too_many_output_columns",
        "SELECT " + ", ".join(f"1 AS c{i}" for i in range(129)),
        None,
        "invalid_query",
        "Output exceeds the 128-column limit",
    ),
    (
        "empty_query",
        "   ",
        None,
        "invalid_query",
        "Query must be nonempty UTF-8 text within 64 KiB",
    ),
    (
        "oversized_query",
        "SELECT 1 AS x -- " + "x" * 70000,
        None,
        "invalid_query",
        "Query must be nonempty UTF-8 text within 64 KiB",
    ),
    (
        "invalid_utf8",
        "SELECT '\ud800' AS x",
        None,
        "invalid_query",
        "Query must be valid UTF-8 text",
    ),
]

TYPE_CASES = [
    ("type_not_a_string", 5, "Invalid logical type"),
    ("type_too_long", "VARCHAR" + " " * 5000, "Invalid logical type"),
    ("type_two_statements", "VARCHAR); SELECT (1", "Invalid logical type"),
    ("type_nested_too_deep", "BIGINT" + "[]" * 10, "Logical type exceeds the supported nesting"),
    ("type_bad_decimal_precision", "DECIMAL('x')", "Invalid decimal precision"),
]


@pytest.mark.parametrize(
    ("sql", "parameters", "code", "message"), [c[1:] for c in CASES], ids=[c[0] for c in CASES]
)
def test_admission_refuses(sql, parameters, code, message):
    with pytest.raises(SourcesQLError) as refused:
        admit(sql, parameters, SCHEMAS)
    assert (refused.value.code, str(refused.value)[: len(message)]) == (code, message)


def test_admission_refuses_input_alias_that_is_not_an_identifier():
    with pytest.raises(SourcesQLError) as refused:
        admit("SELECT 1 AS x", None, {"bad name": [Column("id")]})
    assert (refused.value.code, str(refused.value)) == (
        "invalid_query",
        "Input aliases must be ordinary SQL identifiers",
    )


def test_admission_refuses_when_parser_version_differs_from_the_qualified_one(monkeypatch):
    monkeypatch.setattr("sourcesql.sql.admission.sqlglot.__version__", "0.0.0")
    with pytest.raises(SourcesQLError) as refused:
        admit("SELECT 1 AS x")
    assert refused.value.code == "unsupported_capability"


@pytest.mark.xfail(
    strict=True,
    raises=RecursionError,
    reason="Deeply nested parentheses raise RecursionError from the parser instead of an "
    "admission refusal; see the item filed from #135.",
)
def test_deeply_nested_parentheses_are_refused_not_crashed():
    sql = "SELECT " + "(" * 100 + "1" + ")" * 100 + " AS x"
    with pytest.raises(SourcesQLError):
        admit(sql)


@pytest.mark.parametrize(
    ("logical_type", "message"), [c[1:] for c in TYPE_CASES], ids=[c[0] for c in TYPE_CASES]
)
def test_validate_type_refuses(logical_type, message):
    with pytest.raises(SourcesQLError) as refused:
        validate_type(logical_type)
    assert (refused.value.code, str(refused.value)[: len(message)]) == ("invalid_output", message)
