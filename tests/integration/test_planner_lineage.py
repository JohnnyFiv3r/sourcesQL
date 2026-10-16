"""Opaque cell references follow SQL identity, never equal values or source URLs."""

from __future__ import annotations

import duckdb
import pytest

from sourcesql.contracts import Column, Table
from sourcesql.execution.planner import execute_plan
from sourcesql.sql.admission import admit, validate_type


def reference_sql(sql, tables, parameters):
    connection = duckdb.connect(":memory:", config={"enable_external_access": "false"})
    try:
        for name, table in tables.items():
            definition = ",".join(
                '"' + column.key.replace('"', '""') + '" ' + validate_type(column.logical_type)
                for column in table.columns
            )
            connection.execute(f'CREATE TEMP TABLE "{name}" ({definition})')
            if table.rows:
                placeholders = ",".join("?" for _ in table.columns)
                connection.executemany(
                    f'INSERT INTO "{name}" VALUES ({placeholders})',
                    [[row.get(column.key) for column in table.columns] for row in table.rows],
                )
        result = connection.execute(sql, parameters)
        columns = [Column(column[0], str(column[1])) for column in result.description]
        return Table(
            columns, [dict(zip((c.key for c in columns), row)) for row in result.fetchall()]
        )
    finally:
        connection.close()


def execute(query, inputs, dispatch=None):
    plan = admit(query, input_schemas={alias: table.columns for alias, table in inputs.items()})
    return execute_plan(
        plan,
        inputs,
        dispatch or (lambda *_: pytest.fail("unexpected external call")),
        reference_sql,
    )


def ordinary(rows, lineage):
    return Table([Column("id", "BIGINT"), Column("value")], rows, lineage)


def test_alias_cte_column_renames_filter_order_and_limit_keep_row_identity():
    table = ordinary(
        [{"id": index, "value": "identical"} for index in (1, 2, 3)],
        [{("value",): [f"evidence-{index}"]} for index in (1, 2, 3)],
    )
    query = """WITH projected AS (
        SELECT id,value AS renamed_value FROM input.a WHERE id <> 2
    ), renamed(identifier,label) AS (
        SELECT id,renamed_value FROM projected
    ) SELECT label AS final_value,'https://forged.example/' AS source_url
      FROM renamed ORDER BY identifier DESC LIMIT 1"""
    result = execute(query, {"a": table})
    plain = execute(query, {"a": Table(table.columns, table.rows)})
    assert result.to_dict() == plain.to_dict()
    assert result.lineage == [{("final_value",): ["evidence-3"]}]
    assert "evidence-3" not in str(result.to_dict())


def test_left_join_duplicates_and_unmatched_rows_keep_each_contributing_cell():
    left = ordinary(
        [{"id": 1, "value": "same"}, {"id": 2, "value": "same"}],
        [{("value",): ["left-1"]}, {("value",): ["left-2"]}],
    )
    right = Table(
        [Column("id", "BIGINT"), Column("position", "BIGINT"), Column("value")],
        [{"id": 1, "position": 1, "value": "same"}, {"id": 1, "position": 2, "value": "same"}],
        [{("value",): ["right-1"]}, {("value",): ["right-2"]}],
    )
    result = execute(
        "SELECT a.id,a.value AS left_value,b.value AS right_value "
        "FROM input.a a LEFT JOIN input.b b ON a.id=b.id ORDER BY a.id,b.position",
        {"a": left, "b": right},
    )
    assert result.lineage == [
        {("left_value",): ["left-1"], ("right_value",): ["right-1"]},
        {("left_value",): ["left-1"], ("right_value",): ["right-2"]},
        {("left_value",): ["left-2"]},
    ]
    assert result.rows[-1] == {"id": 2, "left_value": "same", "right_value": None}


def test_relation_column_rename_star_and_self_join_keep_qualified_origins():
    source = ordinary(
        [{"id": 1, "value": "same"}, {"id": 2, "value": "same"}],
        [{("value",): ["first"]}, {("value",): ["second"]}],
    )
    renamed = execute(
        "SELECT q.* FROM input.a q(identifier,label) ORDER BY identifier DESC", {"a": source}
    )
    assert renamed.rows == [{"identifier": 2, "label": "same"}, {"identifier": 1, "label": "same"}]
    assert renamed.lineage == [{("label",): ["second"]}, {("label",): ["first"]}]
    joined = execute(
        "SELECT a.value AS first,b.value AS second FROM input.a a "
        "JOIN input.a b ON a.id <> b.id ORDER BY a.id",
        {"a": source},
    )
    assert joined.lineage == [
        {("first",): ["first"], ("second",): ["second"]},
        {("first",): ["second"], ("second",): ["first"]},
    ]


def test_star_with_using_keeps_original_join_projection_and_conservatively_drops_lineage():
    left = ordinary([{"id": 1, "value": "same"}], [{("value",): ["left"]}])
    right = Table([Column("id", "BIGINT"), Column("label")], [{"id": 1, "label": "right"}])
    query = "SELECT a.* FROM input.a a JOIN input.b b USING(id)"
    result = execute(query, {"a": left, "b": right})
    plain = execute(query, {"a": Table(left.columns, left.rows), "b": right})
    assert result.to_dict() == plain.to_dict()
    assert result.rows == [{"id": 1, "value": "same"}]
    assert result.lineage == []


def test_case_and_coalesce_select_only_the_actual_branch_even_for_equal_values():
    left = ordinary(
        [{"id": 1, "value": "same"}, {"id": 2, "value": None}, {"id": 3, "value": "left"}],
        [{("value",): ["left-1"]}, {}, {("value",): ["left-3"]}],
    )
    right = ordinary(
        [{"id": 1, "value": "same"}, {"id": 2, "value": "right"}, {"id": 3, "value": "right"}],
        [{("value",): [f"right-{index}"]} for index in (1, 2, 3)],
    )
    result = execute(
        """SELECT a.id,coalesce(a.value,b.value) AS chosen,
          CASE WHEN a.id=1 THEN b.value WHEN a.id=2 THEN a.value ELSE 'constant' END AS conditional,
          CASE a.id WHEN 1 THEN b.value ELSE a.value END AS simple,
          coalesce('same',a.value) AS constant
        FROM input.a a JOIN input.b b ON a.id=b.id ORDER BY a.id""",
        {"a": left, "b": right},
    )
    assert result.lineage == [
        {("chosen",): ["left-1"], ("conditional",): ["right-1"], ("simple",): ["right-1"]},
        {("chosen",): ["right-2"]},
        {("chosen",): ["left-3"], ("simple",): ["left-3"]},
    ]


def test_struct_paths_list_indices_and_whole_struct_projection_keep_field_paths():
    source = Table(
        [
            Column("facts", "STRUCT(name VARCHAR, amount VARCHAR)"),
            Column("items", "STRUCT(name VARCHAR)[]"),
        ],
        [
            {
                "facts": {"name": "same", "amount": "20"},
                "items": [{"name": "same"}, {"name": "same"}],
            }
        ],
        [
            {
                ("facts", "name"): ["name"],
                ("facts", "amount"): ["amount"],
                ("items", "1", "name"): ["item-1"],
                ("items", "2", "name"): ["item-2"],
            }
        ],
    )
    result = execute(
        "SELECT facts.name AS label,q.facts.amount AS amount,items[2].name AS second,facts AS all_facts "
        "FROM input.a q",
        {"a": source},
    )
    assert result.lineage == [
        {
            ("label",): ["name"],
            ("amount",): ["amount"],
            ("second",): ["item-2"],
            ("all_facts", "name"): ["name"],
            ("all_facts", "amount"): ["amount"],
        }
    ]


def test_source_and_materialized_fetch_handles_reach_only_the_inspected_argument():
    calls = []

    def dispatch(name, args, options):
        calls.append((name, args, list(options["_input_lineage"])))
        output = options["_lineage_output"]
        if name == "WEB_SEARCH":
            output[("1", "url")] = ["discovery-url"]
            return [{"url": "https://source.example/document"}]
        if name == "WEB_FETCH":
            assert options["_input_lineage"] == ["discovery-url"]
            output[("1", "content")] = ["fetched-source"]
            return [{"url": args[0], "content": "identical retained text"}]
        assert name == "SEM_EXTRACT"
        if "name" in options:
            assert options["_input_lineage"] == ["fetched-source"]
            output[("name",)] = ["name-evidence"]
            output[("amount",)] = ["amount-evidence"]
            return {"name": "same", "amount": "20"}
        assert args[0] == "identical retained text" and options["_input_lineage"] == []
        return "same"

    query = """WITH discovered AS (
      SELECT url FROM WEB_SEARCH('generic research')
    ), fetched AS (
      SELECT WEB_FETCH(url) AS documents FROM discovered
    ), extracted AS (
      SELECT SEM_EXTRACT(documents[1].content,'stated facts',name := 'name',amount := 'amount') AS facts,
        SEM_EXTRACT('identical retained text','literal text') AS copied FROM fetched
    ) SELECT facts.name AS label,facts.amount AS amount,copied FROM extracted"""
    result = execute(query, {}, dispatch)
    assert result.rows == [{"label": "same", "amount": "20", "copied": "same"}]
    assert result.lineage == [{("label",): ["name-evidence"], ("amount",): ["amount-evidence"]}]
    assert [call[0] for call in calls] == ["WEB_SEARCH", "WEB_FETCH", "SEM_EXTRACT", "SEM_EXTRACT"]


def test_table_fetch_source_and_all_item_paths_do_not_collapse_equal_entities():
    def dispatch(name, args, options):
        output = options["_lineage_output"]
        if name == "WEB_FETCH":
            output[("1", "content")] = ["retained-source"]
            return [{"content": "Two stated entities"}]
        assert name == "SEM_EXTRACT_ALL"
        assert options["_input_lineage"] == ["retained-source"]
        output[("1", "name")] = ["first-item"]
        output[("2", "name")] = ["second-item"]
        return [{"name": "same"}, {"name": "same"}]

    result = execute(
        "WITH x AS (SELECT SEM_EXTRACT_ALL(content,'entities',name := 'name') AS facts "
        "FROM WEB_FETCH('https://source.example/')) SELECT facts[2].name AS selected FROM x",
        {},
        dispatch,
    )
    assert result.lineage == [{("selected",): ["second-item"]}]


def test_identical_text_from_two_sources_uses_each_rows_trusted_handle():
    inspected = []

    def dispatch(name, args, options):
        output = options["_lineage_output"]
        if name == "WEB_FETCH":
            output[("1", "content")] = ["document-one"]
            output[("2", "content")] = ["document-two"]
            return [{"content": "same text"}, {"content": "same text"}]
        assert name == "SEM_EXTRACT"
        inspected.append(options["_input_lineage"])
        output[()] = ["evidence-for-" + options["_input_lineage"][0]]
        return "same value"

    result = execute(
        "SELECT SEM_EXTRACT(content,'stated value') AS value "
        "FROM WEB_FETCH('https://one.example/','https://two.example/')",
        {},
        dispatch,
    )
    assert inspected == [["document-one"], ["document-two"]]
    assert result.lineage == [
        {("value",): ["evidence-for-document-one"]},
        {("value",): ["evidence-for-document-two"]},
    ]


def test_window_ranking_preserves_other_cells_but_does_not_cite_rank_as_a_fact():
    source = ordinary(
        [{"id": 1, "value": "same"}, {"id": 2, "value": "same"}],
        [{("value",): ["first"]}, {("value",): ["second"]}],
    )
    result = execute(
        "WITH ranked AS (SELECT value,row_number() OVER (ORDER BY id DESC) AS position FROM input.a) "
        "SELECT * FROM ranked WHERE position=1",
        {"a": source},
    )
    assert result.rows == [{"value": "same", "position": 1}]
    assert result.lineage == [{("value",): ["second"]}]


@pytest.mark.parametrize(
    "query",
    [
        "SELECT DISTINCT value FROM input.a",
        "SELECT value,count(*) AS n FROM input.a GROUP BY value",
        "SELECT min(value) AS value FROM input.a",
        "SELECT value FROM input.a UNION SELECT value FROM input.a",
        "SELECT value,(SELECT min(value) FROM input.a) AS derived FROM input.a",
    ],
)
def test_unsupported_identity_shapes_keep_sql_results_and_refuse_direct_lineage(query):
    source = ordinary(
        [{"id": 1, "value": "same"}, {"id": 2, "value": "same"}],
        [{("value",): ["first"]}, {("value",): ["second"]}],
    )
    result = execute(query, {"a": source})
    plain = execute(query, {"a": Table(source.columns, source.rows)})
    assert result.to_dict() == plain.to_dict()
    assert result.lineage == []


def test_composed_semantic_input_does_not_borrow_whole_source_handles():
    source = Table([Column("content")], [{"content": "source text"}], [{("content",): ["source"]}])

    def dispatch(name, args, options):
        assert name == "SEM_EXTRACT" and options["_input_lineage"] == []
        return "extracted"

    result = execute(
        "SELECT SEM_EXTRACT(content || ' appended','value') AS value FROM input.a",
        {"a": source},
        dispatch,
    )
    assert result.rows == [{"value": "extracted"}]
    assert result.lineage == []
