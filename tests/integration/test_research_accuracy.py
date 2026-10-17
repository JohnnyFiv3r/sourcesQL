"""Synthetic compositional research regressions, never live accuracy measurements."""

from __future__ import annotations

import json

import pytest
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

from sourcesql.contracts import Budget, Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.evidence import EvidenceContext
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.common import source_record, text_hash
from sourcesql.providers.fixture import FixtureProvider
from sourcesql.providers.semantic import PydanticSemanticProvider, validate_outcome


def worker(sql, tables, parameters=None, timeout=30):
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


def install_catalog(monkeypatch, catalog, outputs):
    calls = []

    def fetch(self, urls, options, budget):
        rows = []
        for url in urls:
            budget.reserve("fetches", limit="max_fetches")
            rows.append(
                source_record(
                    url,
                    catalog[url],
                    provider="fixture",
                    basis="synthetic_fixture",
                    published_at="2026-02-01T00:00:00Z",
                )
            )
        return rows

    def answer(messages, info):
        prompt = json.loads(messages[-1].parts[-1].content)
        text = prompt["data"]["text"]
        calls.append(prompt)
        output = outputs(text, prompt) if callable(outputs) else outputs[text]
        return ModelResponse(
            [ToolCallPart(info.output_tools[0].name, output)],
            usage=RequestUsage(input_tokens=20, output_tokens=30),
        )

    leaf = PydanticSemanticProvider(FunctionModel(answer))

    def semantic(self, *args):
        return leaf.semantic(*args)

    monkeypatch.setattr(FixtureProvider, "fetch", fetch)
    monkeypatch.setattr(FixtureProvider, "semantic", semantic)
    return calls


def supported(value, quotes, statuses=()):
    return {
        "value": value,
        "status": "supported_text",
        "support": quotes,
        "field_outcomes": list(statuses),
    }


def test_source_window_reaches_later_fact_with_original_coordinates_and_saved_reuse(
    tmp_path, monkeypatch
):
    url = "https://catalog.example/later"
    prefix = "Unrelated introductory material. " * 800
    quote = "Phase One is planned for up to 500 MW, not operating capacity."
    text = prefix + quote + " Tail."
    calls = install_catalog(
        monkeypatch,
        {url: text},
        lambda text, prompt: supported(
            "up to 500 MW planned", [{"quote": quote, "field": "value"}]
        ),
    )
    engine = Engine(tmp_path / "engine", worker=worker)
    saved = engine.query(
        query="SELECT SOURCE_WINDOW(content, $start, $length) AS passage FROM WEB_FETCH($url)",
        parameters={"start": len(prefix), "length": len(quote), "url": url},
    )
    assert saved["receipt"]["counts"].get("semantic_documents", 0) == 0
    binding = saved["source_bindings"][0]
    assert binding["source_window"] == {"start": len(prefix), "end": len(prefix) + len(quote)}
    result = engine.query(
        query="SELECT SEM_EXTRACT(passage,'planned capacity preserving qualifier and scope') AS capacity FROM input.saved",
        inputs={"saved": pin(saved)},
    )
    assert result["rows"] == [{"capacity": "up to 500 MW planned"}]
    span = next(e for e in result["evidence"] if e.get("column_key") == "capacity")["support"][0]
    assert span["start"] == len(prefix) and span["end"] == len(prefix) + len(quote)
    assert text[span["start"] : span["end"]] == span["quote"]
    assert span["content_sha256"] == text_hash(text)
    assert calls[0]["data"]["text"] == quote
    assert "metadata_context" not in calls[0]["data"]
    assert result["receipt"]["counts"].get("fetches", 0) == 0
    restored = Engine(tmp_path / "restored", worker=worker)
    imported = restored.import_bundle(engine.export(saved["result_id"]))
    reopened = restored.query(
        query="SELECT passage FROM input.saved", inputs={"saved": pin(imported)}
    )
    assert reopened["source_bindings"][0]["source_window"] == binding["source_window"]


def test_source_window_never_borrows_equal_literal_or_composed_text_identity():
    context = EvidenceContext()
    source = source_record(
        "https://catalog.example/repeated", "α fact. α fact.", provider="fixture"
    )
    handle = context.source_handle(source)
    value, window_handle = context.window(source["content"], [handle], 8, 7)
    assert value == "α fact."
    assert context.source_for([window_handle], value)["_input_window"] == {"start": 8, "end": 15}
    assert context.window(value, [], 0, len(value)) == (value, None)
    assert context.source_for([handle], value) is None
    with pytest.raises(SourcesQLError):
        context.window(source["content"], [handle], -1, 5)
    with pytest.raises(SourcesQLError):
        context.window(source["content"], [handle], 0, True)


def test_uninspected_or_ambiguous_window_support_cannot_be_promoted():
    source = "repeat earlier. " + "selected unique fact."
    selected = "selected unique fact."
    provider = PydanticSemanticProvider(
        FunctionModel(
            lambda messages, info: ModelResponse(
                [
                    ToolCallPart(
                        info.output_tools[0].name,
                        supported("earlier", [{"quote": "repeat earlier."}]),
                    )
                ]
            )
        )
    )
    outcome = provider.semantic(
        "SEM_EXTRACT",
        selected,
        "fact",
        {},
        {
            "source_window_start": 16,
            "source_characters": len(source),
            "source_content_sha256": text_hash(source),
        },
        Budget(),
    )
    assert outcome.value is None and outcome.status == "evidence_invalid"


def test_unnest_keeps_item_field_evidence_and_null_diagnostics_after_sort_join_reuse(
    tmp_path, monkeypatch
):
    url = "https://catalog.example/items"
    first = "Orion at 10 Dock Road is planned for up to 500 MW; its operating capacity is unstated."
    second = "Orion at 80 Hill Road is operating at 50 MW."
    text = first + " " + second
    values = [
        {
            "name": "Orion",
            "address": "10 Dock Road",
            "capacity": "up to 500 MW planned",
            "operating": None,
        },
        {
            "name": "Orion",
            "address": "80 Hill Road",
            "capacity": "50 MW operating",
            "operating": "50 MW",
        },
    ]
    quotes = [
        {"quote": quote, "field": field, "item": index}
        for index, (item, quote) in enumerate(zip(values, (first, second)))
        for field, value in item.items()
        if value is not None
    ]
    calls = install_catalog(
        monkeypatch,
        {url: text},
        {
            text: supported(
                values, quotes, [{"field": "operating", "item": 0, "status": "not_stated"}]
            )
        },
    )
    engine = Engine(tmp_path / "engine", worker=worker)
    result = engine.query(
        query="""WITH local AS (
      SELECT SEM_EXTRACT_ALL(content,'individual sites with identity, scope and qualifiers',
        name := 'site name', address := 'street address', capacity := 'capacity preserving unit qualifier and planned or operating basis', operating := 'operating capacity only') AS facts
      FROM WEB_FETCH($url)
    ), expanded AS (SELECT UNNEST(facts) AS item FROM local)
    SELECT item.name AS name,item.address AS address,item.capacity AS capacity,item.operating AS operating
    FROM expanded ORDER BY address DESC""",
        parameters={"url": url},
    )
    assert len(result["rows"]) == 2
    by_row = {row_id: row for row_id, row in zip(result["row_ids"], result["rows"])}
    direct = [e for e in result["evidence"] if e.get("row_id")]
    assert len(direct) == 7
    for record in direct:
        row = by_row[record["row_id"]]
        assert row["address"] in record["support"][0]["quote"]
    null_diagnostic = next(
        d
        for d in result["cell_diagnostics"]
        if d["column_key"] == "operating" and d["status"] == "not_stated"
    )
    assert by_row[null_diagnostic["row_id"]]["address"] == "10 Dock Road"
    assert null_diagnostic["reason"] == "not_stated_in_inspected_evidence"
    assert not any(
        e.get("row_id") == null_diagnostic["row_id"] and e.get("column_key") == "operating"
        for e in direct
    )
    cached = engine.query(
        query="""WITH local AS (
          SELECT SEM_EXTRACT_ALL(content,'individual sites with identity, scope and qualifiers',
            name := 'site name', address := 'street address', capacity := 'capacity preserving unit qualifier and planned or operating basis', operating := 'operating capacity only') AS facts
          FROM input.docs
        ), expanded AS (SELECT UNNEST(facts) AS item FROM local)
        SELECT item.address AS address,item.operating AS operating FROM expanded""",
        inputs={"docs": pin(result, "sources")},
    )
    assert len(calls) == 1
    assert cached["receipt"]["counts"]["cache_hits"] == 1
    cached_null = next(d for d in cached["cell_diagnostics"] if d["status"] == "not_stated")
    assert cached_null["reason"] == "not_stated_in_inspected_evidence"
    assert cached_null["inspected_windows"] == [{"start": 0, "end": len(text)}]
    reused = engine.query(
        query="SELECT a.address,a.operating,b.capacity FROM input.saved a JOIN input.saved b ON a.address=b.address ORDER BY a.address",
        inputs={"saved": pin(result)},
    )
    assert len([d for d in reused["cell_diagnostics"] if d["status"] == "not_stated"]) == 1
    assert len([e for e in reused["evidence"] if e.get("row_id")]) == 5
    restored = Engine(tmp_path / "restored", worker=worker)
    imported = restored.import_bundle(engine.export(reused["result_id"]))
    assert any(
        d["status"] == "not_stated"
        for d in restored.read_result(imported["result_id"])["cell_diagnostics"]
    )


def test_complementary_claims_join_by_explicit_site_identity_before_eligibility(
    tmp_path, monkeypatch
):
    announcement = (
        "Aster site at 10 Dock Road was announced on 2025-03-01, planned for up to 500 MW."
    )
    progress = "Aster site at 10 Dock Road began construction on 2026-02-01."
    lookalike = "Aster site at 80 Hill Road began construction on 2024-02-01."
    catalog = {
        "https://catalog.example/announcement": announcement,
        "https://catalog.example/progress": progress,
        "https://catalog.example/lookalike": lookalike,
    }

    def outputs(text, prompt):
        if text == announcement:
            value = {
                "name": "Aster",
                "address": "10 Dock Road",
                "announced": "2025-03-01",
                "progress": None,
                "capacity": "up to 500 MW planned",
            }
        elif text == progress:
            value = {
                "name": "Aster",
                "address": "10 Dock Road",
                "announced": None,
                "progress": "2026-02-01",
                "capacity": None,
            }
        else:
            value = {
                "name": "Aster",
                "address": "80 Hill Road",
                "announced": None,
                "progress": "2024-02-01",
                "capacity": None,
            }
        return supported(
            value,
            [
                {"quote": text, "field": field}
                for field, value in value.items()
                if value is not None
            ],
        )

    install_catalog(monkeypatch, catalog, outputs)
    result = Engine(tmp_path / "engine", worker=worker).query(
        query="""WITH facts AS (
      SELECT SEM_EXTRACT(content,'source-local facts, no inferred facts from other sources',name := 'site name', address := 'street address', announced := 'original announcement date only', progress := 'construction start date only', capacity := 'capacity with unit qualifier and basis') AS fact
      FROM WEB_FETCH('https://catalog.example/announcement','https://catalog.example/progress','https://catalog.example/lookalike')
    ), announcements AS (SELECT fact.name AS name,fact.address AS address,fact.announced AS announced,fact.capacity AS capacity FROM facts WHERE fact.announced IS NOT NULL),
    progress AS (SELECT fact.address AS address,fact.progress AS progress FROM facts WHERE fact.progress IS NOT NULL)
    SELECT a.name,a.address,a.announced,p.progress,a.capacity FROM announcements a JOIN progress p ON a.address=p.address
      WHERE a.announced>='2025-01-01' AND p.progress>='2026-01-01'"""
    )
    assert result["rows"] == [
        {
            "name": "Aster",
            "address": "10 Dock Road",
            "announced": "2025-03-01",
            "progress": "2026-02-01",
            "capacity": "up to 500 MW planned",
        }
    ]
    direct = {e["column_key"]: e for e in result["evidence"] if e.get("row_id")}
    assert "announced on 2025-03-01" in direct["announced"]["support"][0]["quote"]
    assert "began construction on 2026-02-01" in direct["progress"]["support"][0]["quote"]
    assert direct["progress"]["source_version_id"] != direct["announced"]["source_version_id"]


def test_typed_extraction_preserves_bound_and_scope_as_nullable_output(monkeypatch):
    prompts = []

    def answer(messages, info):
        prompts.append(info.instructions or "")
        return ModelResponse(
            [
                ToolCallPart(
                    info.output_tools[0].name,
                    {
                        "value": None,
                        "status": "unknown",
                        "support": [],
                        "field_outcomes": [{"field": "value", "status": "ambiguous"}],
                    },
                )
            ]
        )

    outcome = PydanticSemanticProvider(FunctionModel(answer)).semantic(
        "SEM_EXTRACT",
        "Phase 1 is planned for up to 500 MW, not operating capacity.",
        "Exact operating capacity for the whole site, do not substitute phase maximum",
        {},
        {"type": "DOUBLE"},
        Budget(),
    )
    assert outcome.value is None
    assert outcome.usage["field_outcomes"] == [
        {"field": "value", "item": None, "status": "ambiguous"}
    ]
    instructions = " ".join(prompts)
    assert "Preserve bounds, approximation, and negation" in instructions
    assert "unit, measurement basis, and scope" in instructions


def test_null_inspection_coverage_and_diagnostics_do_not_create_quote_evidence():
    outcome = validate_outcome(
        "SEM_EXTRACT",
        "observed window",
        None,
        "not_stated",
        [],
        {},
        {"source_window_start": 100, "source_characters": 1000},
        {},
    )
    context, target = EvidenceContext(), {}
    context.record_outcome(
        {"operator": "SEM_EXTRACT", "status": outcome.status, "usage": outcome.usage},
        outcome.value,
        {},
        target,
    )
    table = Table([Column("fact")], [{"fact": None}], [{("fact",): target[()]}])
    evidence, _, count, diagnostics = context.bind(table, ["row-1"], [])
    assert evidence == [] and count == 0
    assert diagnostics[0]["inspected_windows"] == [{"start": 100, "end": 115}]
    assert diagnostics[0]["input_omitted_characters"] == 985


def test_unusable_optional_diagnostic_does_not_discard_supported_sibling_value():
    output = supported(
        {"name": "Aster", "date": None},
        [{"quote": "Aster", "field": "name"}],
        [
            {"field": "name", "status": "ambiguous"},
            {"field": "unrequested", "status": "unknown"},
            {"field": "date", "status": "invented_reason"},
            {"field": "date", "item": -1, "status": "unknown"},
            {"field": "date", "status": "not_stated"},
        ],
    )
    model = FunctionModel(
        lambda messages, info: ModelResponse([ToolCallPart(info.output_tools[0].name, output)])
    )
    outcome = PydanticSemanticProvider(model).semantic(
        "SEM_EXTRACT",
        "Aster",
        "name and announcement date",
        {"name": "name", "date": "original date"},
        {},
        Budget(),
    )
    assert outcome.value == {"name": "Aster", "date": None}
    assert outcome.usage["field_outcomes"] == [
        {"field": "date", "item": None, "status": "not_stated"}
    ]
