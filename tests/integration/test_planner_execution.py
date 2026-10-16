"""Fixture staged execution with a direct DuckDB reference worker.

These tests establish language/planner mechanics, not actual worker isolation,
live provider quality, hosted integration, or production qualification.
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow as pa
import pytest

from sourcesql.contracts import Column, Table, SourcesQLError
from sourcesql.execution.planner import execute_plan
from sourcesql.sql.admission import SOURCE_COLUMNS, admit, validate_type


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def reference_sql(sql, tables, parameters):
    connection = duckdb.connect()
    try:
        for name, table in tables.items():
            arrow_name = name + "_arrow"
            arrow = pa.table(
                {c.key: pa.array([row.get(c.key) for row in table.rows]) for c in table.columns}
            )
            connection.register(arrow_name, arrow)
            projections = ", ".join(
                f"CAST({quote(c.key)} AS {validate_type(c.logical_type)}) AS {quote(c.key)}"
                for c in table.columns
            )
            connection.execute(
                f"CREATE TEMP TABLE {quote(name)} AS SELECT {projections} FROM {quote(arrow_name)}"
            )
        result = connection.execute(sql, parameters)
        columns = [Column(c[0], str(c[1])) for c in result.description]
        return Table(
            columns, [dict(zip([c.key for c in columns], row)) for row in result.fetchall()]
        )
    finally:
        connection.close()


SOURCES = [
    {
        "document_id": "d1",
        "url": "https://aurora.example/project",
        "title": "Aurora",
        "content": "Aurora campus planned 600 operating 0 grid pending",
        "source_version_id": "v1",
    },
    {
        "document_id": "d2",
        "url": "https://birch.example/project",
        "title": "Birch",
        "content": "Birch campus planned 300 operating 100 grid signed",
        "source_version_id": "v2",
    },
    {
        "document_id": "d3",
        "url": "https://other.example/",
        "title": "Other",
        "content": "Unrelated page",
        "source_version_id": "v3",
    },
]


class Fixture:
    def __init__(self):
        self.calls = []

    def __call__(self, name, args, kwargs):
        self.calls.append((name, args, kwargs))
        if name in ("WEB_SEARCH", "WEB_FETCH"):
            return [dict(s) for s in SOURCES]
        text, instruction = args
        if name == "SEM_MATCH":
            return "campus" in text
        if name == "SEM_SCORE":
            return 0.9 if "Aurora" in text else 0.3
        if name == "SEM_NORM":
            return [value.strip().upper() for value in text]
        if name == "SEM_EXTRACT_ALL":
            return (
                [
                    {"project": "Aurora", "planned_mw": "600"},
                    {"project": "Birch", "planned_mw": "300"},
                ]
                if "campus" in text
                else []
            )
        if "project name" in instruction:
            return text.split()[0]
        if "planned capacity" in instruction:
            return "600" if "Aurora" in text else "300"
        if "operating capacity" in instruction:
            return "0" if "Aurora" in text else "100"
        if "grid agreement" in instruction:
            return "pending" if "Aurora" in text else "signed"
        if "type" in kwargs:
            return 600 if kwargs["type"] == "BIGINT" else None
        fields = {
            k: "Aurora" if k == "project" else "600"
            for k in kwargs
            if not k.startswith("_") and k not in ("evidence", "type")
        }
        return fields or text.split()[0]


def execute(query, inputs=None, fixture=None, parameters=None, worker=reference_sql):
    inputs, fixture = inputs or {}, fixture or Fixture()
    plan = admit(query, parameters, {alias: table.columns for alias, table in inputs.items()})
    table = execute_plan(plan, inputs, fixture, worker)
    return table, fixture


def test_discovery_stages_match_before_extract_and_retains_context():
    query = """SELECT url,SEM_EXTRACT(content,'project name explicitly stated') AS project
    FROM WEB_SEARCH('campuses') WHERE SEM_MATCH(content,'specific campus') ORDER BY project"""
    table, fixture = execute(query)
    assert [r["project"] for r in table.rows] == ["Aurora", "Birch"]
    assert [c[0] for c in fixture.calls] == [
        "WEB_SEARCH",
        "SEM_MATCH",
        "SEM_MATCH",
        "SEM_MATCH",
        "SEM_EXTRACT",
        "SEM_EXTRACT",
    ]
    assert fixture.calls[-2][2]["_output_field"] == "project"
    assert fixture.calls[-2][2]["_source_version_id"] == "v1"
    assert fixture.calls[-2][2]["_source_url"] == "https://aurora.example/project"


def test_six_reviewed_examples_execute():
    directory = Path(__file__).resolve().parents[2] / "examples"
    inputs = {
        "previous": Table(
            [Column(k) for k in ("project", "planned_mw", "grid_status", "url")],
            [
                {
                    "project": "Aurora",
                    "planned_mw": "600",
                    "grid_status": "pending",
                    "url": "https://aurora.example/project",
                }
            ],
        ),
        "selected": Table([Column("project")], [{"project": "Aurora"}]),
        "private_entities": Table(
            [Column(k) for k in ("private_entity_id", "entity_key", "expert_capacity_mw")],
            [{"private_entity_id": "p1", "entity_key": "Aurora", "expert_capacity_mw": "550"}],
        ),
        "public_observations": Table(
            [Column(k) for k in ("entity_key", "planned_mw", "url")],
            [
                {
                    "entity_key": "Aurora",
                    "planned_mw": "600",
                    "url": "https://aurora.example/project",
                }
            ],
        ),
        "old_snapshot": Table(
            [Column(k) for k in ("entity_key", "grid_status")],
            [{"entity_key": "Aurora", "grid_status": "pending"}],
        ),
        "new_snapshot": Table(
            [Column(k) for k in ("entity_key", "grid_status")],
            [{"entity_key": "Aurora", "grid_status": "signed"}],
        ),
    }
    files = sorted(directory.glob("0[1-6]*.sql"))
    assert len(files) == 6
    for path in files:
        table, fixture = execute(path.read_text(), inputs)
        assert table.columns and table.rows, path.name
        if path.name.startswith(("03", "04", "06")):
            assert not fixture.calls


def test_ctes_materialize_semantic_values_then_join_group_and_window():
    query = """WITH found AS (
      SELECT url,SEM_EXTRACT(content,'project name explicitly stated') AS project
      FROM WEB_SEARCH('campuses') WHERE SEM_MATCH(content,'campus')
    ), totals AS (
      SELECT f.project,count(*) AS n FROM found f JOIN input.labels l ON f.project=l.project GROUP BY f.project
    ) SELECT project,n,row_number() OVER (ORDER BY project) AS rank FROM totals ORDER BY project"""
    labels = Table(
        [Column("project")], [{"project": "Aurora"}, {"project": "Aurora"}, {"project": "Birch"}]
    )
    table, _ = execute(query, {"labels": labels})
    assert table.rows == [
        {"project": "Aurora", "n": 2, "rank": 1},
        {"project": "Birch", "n": 1, "rank": 2},
    ]


@pytest.mark.parametrize(
    "operator,expected",
    [("UNION ALL", [1, 1, 2]), ("UNION", [1, 2]), ("INTERSECT", [1]), ("EXCEPT", [2])],
)
def test_set_operations_preserve_bag_and_set_semantics(operator, expected):
    left = Table([Column("id", "BIGINT")], [{"id": 1}, {"id": 2}])
    right = Table([Column("id", "BIGINT")], [{"id": 1}])
    table, fixture = execute(
        f"SELECT id FROM input.a {operator} SELECT id FROM input.b ORDER BY id",
        {"a": left, "b": right},
    )
    assert [r["id"] for r in table.rows] == expected
    assert not fixture.calls


def test_exact_filter_precedes_semantics_but_outer_limit_is_not_pushed_down():
    table, fixture = execute(
        "SELECT title,SEM_EXTRACT(content,'project name explicitly stated') AS p FROM WEB_SEARCH('campuses') WHERE title<>'Other' LIMIT 1"
    )
    assert len(table.rows) == 1
    assert len([c for c in fixture.calls if c[0] == "SEM_EXTRACT"]) == 2
    table, fixture = execute(
        "WITH first AS (SELECT * FROM WEB_SEARCH('campuses') ORDER BY title LIMIT 1) SELECT SEM_EXTRACT(content,'project name explicitly stated') AS p FROM first"
    )
    assert len([c for c in fixture.calls if c[0] == "SEM_EXTRACT"]) == 1


def test_ordinary_sql_filters_reduce_both_semantic_filter_and_extraction_calls():
    base = """SELECT title,SEM_EXTRACT(content,'project name explicitly stated') AS project
    FROM WEB_SEARCH('campuses') WHERE SEM_MATCH(content,'specific campus')"""
    baseline, baseline_provider = execute(base)
    filtered, filtered_provider = execute(base + " AND title='Aurora'")
    empty, empty_provider = execute(base + " AND title='No such campus'")
    assert len(baseline.rows) == 2
    assert filtered.rows == [{"title": "Aurora", "project": "Aurora"}]
    assert empty.rows == []
    # SQL predicate appears after SEM_MATCH in the text, but runs first.
    assert [call[0] for call in baseline_provider.calls].count("SEM_MATCH") == 3
    assert [call[0] for call in baseline_provider.calls].count("SEM_EXTRACT") == 2
    assert [call[0] for call in filtered_provider.calls] == [
        "WEB_SEARCH",
        "SEM_MATCH",
        "SEM_EXTRACT",
    ]
    assert [call[0] for call in empty_provider.calls] == ["WEB_SEARCH"]
    assert filtered_provider.calls[-1][2]["_source_version_id"] == "v1"


def test_empty_and_null_extraction_keep_schema_and_unknown_match_is_not_false():
    sources = Table(list(SOURCE_COLUMNS), [])
    table, fixture = execute(
        "SELECT SEM_EXTRACT(content,'x',type := 'BIGINT') AS n FROM input.a", {"a": sources}
    )
    assert table.columns == [Column("n", "BIGINT")]
    assert table.rows == [] and fixture.calls == []

    def unknown(name, args, kwargs):
        return None

    sources.rows = [SOURCES[0]]
    table, _ = execute(
        "SELECT url FROM input.a WHERE SEM_MATCH(content,'x')", {"a": sources}, fixture=unknown
    )
    assert table.rows == []


def test_list_struct_expansion_and_field_access():
    table, _ = execute(
        "WITH data AS (SELECT SEM_EXTRACT(content,'campus',project := 'name',mw := 'capacity') AS campus FROM WEB_FETCH('https://aurora.example/project')) SELECT campus.project AS project,TRY_CAST(campus.mw AS BIGINT) AS mw FROM data ORDER BY mw"
    )
    assert table.rows[0] == {"project": "Aurora", "mw": 600}
    table, _ = execute("SELECT UNNEST([1,2,3]) AS item")
    assert table.rows == [{"item": 1}, {"item": 2}, {"item": 3}]


def test_score_and_normalization_have_explicit_stage_shapes():
    table, fixture = execute(
        "SELECT title,SEM_SCORE(content,'specific project') AS score FROM WEB_SEARCH('campuses') ORDER BY score DESC LIMIT 1"
    )
    assert table.rows == [{"title": "Aurora", "score": 0.9}]
    labels = Table(
        [Column("label")],
        [{"label": " Acme "}, {"label": "acme"}, {"label": " Acme "}, {"label": None}],
    )
    table, fixture = execute(
        "SELECT label,SEM_NORM(label,'normalize casing') AS normalized FROM input.labels",
        {"labels": labels},
    )
    assert [r["normalized"] for r in table.rows] == ["ACME", "ACME", "ACME", None]
    assert fixture.calls[0][1][0] == [" Acme ", "acme"]
    assert len(fixture.calls) == 1


def test_unused_cte_does_not_dispatch():
    table, fixture = execute(
        "WITH unused AS (SELECT * FROM WEB_SEARCH('do not call')) SELECT 1 AS value"
    )
    assert table.rows == [{"value": 1}] and not fixture.calls


def test_parameter_binding_survives_each_staged_statement():
    query = (
        "SELECT SEM_EXTRACT(content,$field) AS project FROM WEB_SEARCH($search) WHERE title=$title"
    )
    table, fixture = execute(
        query, parameters={"field": "project name", "search": "campuses", "title": "Aurora"}
    )
    assert table.rows == [{"project": "Aurora"}]
    assert fixture.calls[0][1] == ["campuses"]


def test_argument_rows_are_joined_by_identity_even_if_worker_reorders_them():
    def reverse_worker(sql, tables, params):
        table = reference_sql(sql, tables, params)
        if "__arg0" in sql:
            table.rows.reverse()
        return table

    table, _ = execute(
        "SELECT title,SEM_EXTRACT(content,'project name') AS project FROM WEB_SEARCH('campuses') WHERE title<>'Other' ORDER BY title",
        worker=reverse_worker,
    )
    assert table.rows == [
        {"title": "Aurora", "project": "Aurora"},
        {"title": "Birch", "project": "Birch"},
    ]


def test_invalid_score_and_match_results_are_refused():
    for function, value in (("SEM_SCORE", float("nan")), ("SEM_MATCH", "false")):
        with pytest.raises(SourcesQLError) as error:
            execute(
                f"SELECT {function}(content,'x') AS value FROM input.a",
                {"a": Table([Column("content")], [{"content": "x"}])},
                fixture=lambda *_: value,
            )
        assert error.value.code == "invalid_output"


@pytest.mark.parametrize(
    "query",
    [
        "SELECT title FROM WEB_SEARCH('x') GROUP BY url",
        "SELECT sum(content) AS value FROM WEB_SEARCH('x')",
        "SELECT sum(count(*)) AS value FROM WEB_SEARCH('x')",
        "SELECT id FROM WEB_SEARCH('x') JOIN input.b b USING(missing)",
    ],
)
def test_relational_errors_have_zero_provider_dispatch(query):
    fixture = Fixture()
    with pytest.raises(SourcesQLError) as error:
        execute(query, {"b": Table([Column("id", "BIGINT")], [])}, fixture)
    assert error.value.code == "invalid_query"
    assert fixture.calls == []


def test_pure_correlated_exists_and_scalar_subqueries():
    a = Table([Column("id", "BIGINT")], [{"id": 1}, {"id": 2}, {"id": 3}])
    b = Table(
        [Column("id", "BIGINT"), Column("value", "BIGINT")],
        [{"id": 1, "value": 4}, {"id": 1, "value": 5}, {"id": 2, "value": 8}],
    )
    query = """WITH relevant AS (SELECT id,value FROM input.b WHERE value>4)
    SELECT a.id,(SELECT max(b.value) FROM relevant b WHERE b.id=a.id) AS biggest
    FROM input.a a WHERE EXISTS (SELECT 1 FROM relevant b WHERE b.id=a.id) ORDER BY a.id"""
    table, fixture = execute(query, {"a": a, "b": b})
    assert table.rows == [{"id": 1, "biggest": 5}, {"id": 2, "biggest": 8}]
    assert not fixture.calls


def test_case_string_arguments_evaluate_deterministically():
    a = Table(
        [Column("content"), Column("snippet")],
        [
            {"content": None, "snippet": "Aurora campus"},
            {"content": "Birch campus", "snippet": "wrong"},
        ],
    )
    table, fixture = execute(
        "SELECT SEM_EXTRACT(CASE WHEN content IS NULL THEN snippet ELSE content END,'project name') AS project FROM input.a",
        {"a": a},
    )
    assert [r["project"] for r in table.rows] == ["Aurora", "Birch"]
    assert [call[1][0] for call in fixture.calls] == ["Aurora campus", "Birch campus"]


def test_rank_dense_rank_lag_lead_and_distinct_aggregate():
    a = Table(
        [Column("id", "BIGINT"), Column("score", "BIGINT")],
        [{"id": 1, "score": 8}, {"id": 2, "score": 8}, {"id": 3, "score": 5}],
    )
    table, fixture = execute(
        "SELECT id,RANK() OVER (ORDER BY score DESC) AS rank,DENSE_RANK() OVER (ORDER BY score DESC) AS dense,LAG(score) OVER (ORDER BY id) AS prior,LEAD(score) OVER (ORDER BY id) AS next FROM input.a ORDER BY id",
        {"a": a},
    )
    assert table.rows == [
        {"id": 1, "rank": 1, "dense": 1, "prior": None, "next": 8},
        {"id": 2, "rank": 1, "dense": 1, "prior": 8, "next": 5},
        {"id": 3, "rank": 3, "dense": 2, "prior": 8, "next": None},
    ]
    counted, _ = execute("SELECT count(DISTINCT score) AS n FROM input.a", {"a": a})
    assert counted.rows == [{"n": 2}]
    assert not fixture.calls


def test_null_semantic_inputs_reach_coordinator_for_unprocessed_receipts():
    calls = []

    def dispatch(name, args, kwargs):
        calls.append((name, args, kwargs))
        return None

    table, _ = execute(
        "SELECT SEM_MATCH(content,'campus') AS matched FROM input.a",
        {"a": Table([Column("content")], [{"content": None}])},
        fixture=dispatch,
    )
    assert table.rows == [{"matched": None}]
    assert len(calls) == 1 and calls[0][1][0] is None


def test_deduplicated_sql_survivors_are_fetched_before_multifield_extraction():
    class Tracked:
        def __init__(self):
            self.calls = []

        def __call__(self, name, args, options):
            self.calls.append((name, args, options))
            if name == "WEB_SEARCH":
                return [dict(SOURCES[0]), dict(SOURCES[0]), dict(SOURCES[2])]
            if name == "WEB_FETCH":
                assert args == [SOURCES[0]["url"]]
                return [
                    {**SOURCES[0], "content": "Aurora planned 600 MW; operating capacity unstated"}
                ]
            assert name == "SEM_EXTRACT"
            assert args[0] == "Aurora planned 600 MW; operating capacity unstated"
            return {"project": "Aurora", "planned_mw": "600", "operating_mw": None}

    fixture = Tracked()
    table, _ = execute(
        """WITH discovered AS (
        SELECT url,title FROM WEB_SEARCH('campus development','power supply')
    ), candidates AS (
        SELECT url,min(title) AS title FROM discovered
        WHERE title <> 'Other' GROUP BY url
    ), fetched AS (
        SELECT url,WEB_FETCH(url) AS documents FROM candidates
    ), extracted AS (
        SELECT url,SEM_EXTRACT(documents[1].content,'Extract stated facts; keep unknown null',
          project := 'campus name',planned_mw := 'announced MW',
          operating_mw := 'operating MW') AS facts FROM fetched
    ) SELECT facts.project AS project,TRY_CAST(facts.planned_mw AS BIGINT) AS planned_mw,
        facts.operating_mw AS operating_mw,url FROM extracted ORDER BY project,url""",
        fixture=fixture,
    )
    assert table.rows == [
        {"project": "Aurora", "planned_mw": 600, "operating_mw": None, "url": SOURCES[0]["url"]}
    ]
    assert [call[0] for call in fixture.calls] == ["WEB_SEARCH", "WEB_FETCH", "SEM_EXTRACT"]
