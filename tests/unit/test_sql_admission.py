"""Closed-language and zero-dispatch admission invariants."""

from __future__ import annotations

import logging

import pytest

from open_webql.contracts import Column, WebQLError
from open_webql.sql.admission import admit, validate_type


SCHEMAS = {
    "a": [Column("id", "BIGINT"), Column("content"), Column("label"), Column("items", "VARCHAR[]")],
    "b": [Column("id", "BIGINT"), Column("value", "BIGINT")],
}


@pytest.mark.parametrize(
    "query",
    [
        "CREATE TABLE x(id INT)",
        "DELETE FROM input.a",
        "ATTACH 'secret.db'",
        "COPY input.a TO 'secret.csv'",
        "INSTALL httpfs",
        "LOAD httpfs",
        "PRAGMA version",
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM read_parquet('https://example.test/x')",
        "SELECT * FROM duckdb_tables()",
        "SELECT * FROM information_schema.tables",
        "SELECT current_setting('threads')",
        "SELECT getenv('TOKEN')",
        "SELECT * FROM secrets",
        "SELECT 1; SELECT 2",
        "CREATE RESEARCH x AS SELECT 1",
        "SELECT random()",
        "SELECT uuid()",
        "SELECT * FROM input.missing",
        "SELECT 1 AS x, 2 AS x",
        "SELECT a.id,b.id FROM input.a a JOIN input.b b ON a.id=b.id",
        "SELECT * FROM input.a a RIGHT JOIN input.b b ON a.id=b.id",
        "WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x",
        "SELECT count(*) FROM input.a WHERE count(*)>0",
        "SELECT id FROM input.a WHERE row_number() OVER ()=1",
        "SELECT CAST(id AS BLOB) FROM input.a",
        "SELECT * FROM input.a LIMIT -1",
        "SELECT * FROM input.a ORDER BY id LIMIT $n",
        "SELECT __wql1 FROM input.a",
        "SELECT * EXCLUDE(content) FROM input.a",
        "SELECT * FROM input.a USING SAMPLE 1",
    ],
)
def test_closed_queries_are_refused(query):
    with pytest.raises(WebQLError):
        admit(query, input_schemas=SCHEMAS)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT id FROM WEB_SEARCH('x') WHERE SEM_MATCH(content,'x') OR id=1",
        "SELECT id FROM WEB_SEARCH('x') WHERE NOT SEM_MATCH(content,'x')",
        "SELECT SEM_MATCH(a.content,'x') AS m FROM input.a a JOIN input.b b ON a.id=b.id",
        "SELECT a.id FROM input.a a JOIN input.b b ON SEM_MATCH(a.content,'x')",
        "SELECT SEM_EXTRACT(content,'x') AS n,count(*) FROM input.a GROUP BY n",
        "SELECT SEM_EXTRACT(content,'x') AS n,row_number() OVER () AS r FROM input.a",
        "SELECT SEM_EXTRACT(SEM_EXTRACT(content,'x'),'y') AS n FROM input.a",
        "SELECT SEM_EXTRACT(UNNEST(items),'x') AS n FROM input.a",
        "SELECT id FROM input.a ORDER BY SEM_MATCH(content,'x')",
        "SELECT * FROM WEB_SEARCH(content)",
        "SELECT SEM_EXTRACT(content,'x',type := 'VARCHAR',name := 'x') FROM input.a",
        "SELECT SEM_EXTRACT(content,'x',type := 'BLOB') FROM input.a",
        "SELECT SEM_MATCH(id,'x') FROM input.a",
        "SELECT SEM_MATCH(content,'x',evidence := true) FROM input.a",
    ],
)
def test_unsupported_custom_shapes_refuse_before_planning(query):
    with pytest.raises(WebQLError):
        admit(query, input_schemas=SCHEMAS)


def test_parser_fallback_does_not_log_private_query(caplog):
    caplog.set_level(logging.DEBUG)
    private = "private-marker-89c2"
    with pytest.raises(WebQLError):
        admit(f"CREATE RESEARCH {private} AS SELECT 1")
    assert private not in caplog.text


def test_bound_values_are_never_interpolated_or_explained():
    private = "fixture'); INSTALL forbidden; --"
    plan = admit("SELECT $needle AS value FROM WEB_SEARCH($needle)", {"needle": private})
    assert private not in plan.sql
    assert private not in repr(plan.explain)
    assert plan.parameters == {"needle": private}


@pytest.mark.parametrize(
    "parameters",
    [
        {"n": float("nan")},
        {"n": float("inf")},
        {"n": 2**63},
        {"n": ["x"]},
        {"n": {"x": "x"}},
        {"bad-name": "x"},
        {},
        {"n": 1, "extra": 2},
    ],
)
def test_parameters_are_closed_json_scalar_bindings(parameters):
    with pytest.raises(WebQLError):
        admit("SELECT $n AS value", parameters)


def test_lossless_string_cast_and_named_struct_schema():
    plan = admit("SELECT CAST($n AS BIGINT) AS value", {"n": "9223372036854775807"})
    assert plan.columns == [Column("value", "BIGINT")]
    plan = admit(
        "WITH x AS (SELECT SEM_EXTRACT(content,'campus',project := 'name',mw := 'capacity') AS campus FROM input.a) SELECT campus.project AS project FROM x",
        input_schemas=SCHEMAS,
    )
    assert plan.columns == [Column("project")]


@pytest.mark.parametrize(
    "logical_type",
    [
        "VARCHAR",
        "BIGINT",
        "BOOLEAN",
        "UBIGINT",
        "HUGEINT",
        "UHUGEINT",
        "DOUBLE",
        "DECIMAL(18,2)",
        "TIMESTAMPTZ",
        "DATE",
        "VARCHAR[]",
        "STRUCT(name VARCHAR, flags BOOLEAN[])[]",
    ],
)
def test_declared_types_are_ast_validated(logical_type):
    assert validate_type(logical_type)


@pytest.mark.parametrize(
    "logical_type",
    [
        "VARCHAR); ATTACH 'secret'",
        "NOT_A_TYPE",
        "BLOB",
        "STRUCT(a VARCHAR,a BIGINT)",
        "DECIMAL(99,2)",
        "DECIMAL(2,9)",
        "VARCHAR DEFAULT 'x'",
        "STRUCT(x VARCHAR NOT NULL)",
    ],
)
def test_type_sql_cannot_escape_the_declared_type(logical_type):
    with pytest.raises(WebQLError):
        validate_type(logical_type)


def test_empty_source_has_static_extraction_schema():
    plan = admit(
        "SELECT url,UNNEST(SEM_EXTRACT_ALL(content,'campus',project := 'name',mw := 'capacity'),recursive := true) FROM WEB_FETCH('https://fiction.example/')"
    )
    assert [c.key for c in plan.columns] == ["url", "project", "mw"]
    assert plan.explain["external_dispatch_during_explain"] is False
    assert plan.explain["limit_is_output_only"] is True


def test_unknown_or_ambiguous_columns_are_refused_statically():
    for query in (
        "SELECT missing FROM WEB_SEARCH('x')",
        "SELECT id FROM input.a a JOIN input.b b ON a.id=b.id",
    ):
        with pytest.raises(WebQLError):
            admit(query, input_schemas=SCHEMAS)


def test_publication_options_validate_real_dates_and_explicit_policy():
    plan = admit(
        "SELECT url FROM WEB_SEARCH('campuses',published_after := $after,undated_policy := 'exclude',allow_post_filter := true,per_query_limit := 20)",
        {"after": "2026-01-01"},
    )
    assert plan.custom_operators == ("WEB_SEARCH",)
    for options in (
        "published_after := '2026-99-99',undated_policy := 'exclude'",
        "published_after := '2026-01-01'",
        "undated_policy := 'guess'",
        "allow_post_filter := 'true'",
        "per_query_limit := 21",
        "per_query_limit := 1e3",
    ):
        with pytest.raises(WebQLError):
            admit(f"SELECT url FROM WEB_SEARCH('campuses',{options})")
