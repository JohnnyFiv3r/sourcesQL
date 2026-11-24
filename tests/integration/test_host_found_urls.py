"""Research over URLs the host agent found itself: fetch rows, failures, caps, no evidence leaks."""

from __future__ import annotations

import json
import pathlib
import re
import socket
from urllib.parse import urlsplit

import httpx

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers import FixtureProvider, ProviderRegistry, SafeFetcher
from sourcesql.providers.fixture import DOCUMENTS
from sourcesql.sql.admission import PUBLIC_REASON, SOURCE_COLUMNS, public_refusal_reason


def reference_worker(sql, tables, parameters=None, timeout=30):
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


def make(tmp_path):
    return Engine(tmp_path / "engine", worker=reference_worker)


def pin(result, view="original"):
    return {"result_id": result["result_id"], "view": view, "amendment_revision": None}


def latest_run(engine):
    with engine.store.db() as db:
        row = db.execute("SELECT receipt FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
    return engine.run_status(json.loads(row[0])["run_id"])


AURORA = "https://aurora.example/project"
BIRCH = "https://birch.example/campus"
VENDOR = "https://vendor.example/platform"
MISSING = "https://nowhere.example/x"

EXTRACT = """SELECT url AS source_url, fetch_status, fetch_failure,
  SEM_EXTRACT(content, 'project facts', evidence := true, project := 'project name') AS fact
FROM WEB_FETCH($u1, $u2, $u3)"""


def urls(*values):
    return {f"u{i}": value for i, value in enumerate(values, 1)}


def test_three_fetched_urls_give_ok_rows_citations_and_three_source_versions(tmp_path):
    engine = make(tmp_path)
    result = engine.query(query=EXTRACT, parameters=urls(AURORA, BIRCH, VENDOR))
    assert [r["fetch_status"] for r in result["rows"]] == ["ok"] * 3
    assert [r["fetch_failure"] for r in result["rows"]] == [None] * 3
    assert [e for e in result["evidence"] if e.get("row_id")]
    sources = engine.query(query="SELECT url FROM input.s", inputs={"s": pin(result, "sources")})
    assert sorted(r["url"] for r in sources["rows"]) == sorted([AURORA, BIRCH, VENDOR])
    texts = {s["source_version_id"]: s["content"] for s in result["source_versions"]}
    for item in result["evidence"]:
        for quote in item.get("support") or []:
            assert quote["quote"] in texts[quote["source_version_id"]]


def test_duplicate_url_is_fetched_once_and_listed_once_in_sources(tmp_path):
    engine = make(tmp_path)
    result = engine.query(
        query="SELECT url, fetch_status FROM WEB_FETCH($u1, $u2)", parameters=urls(AURORA, AURORA)
    )
    assert result["receipt"]["counts"]["fetches"] == 1
    sources = engine.query(query="SELECT url FROM input.s", inputs={"s": pin(result, "sources")})
    assert [r["url"] for r in sources["rows"]] == [AURORA]


def test_failed_url_stays_as_failed_row_with_reason_and_no_citation(tmp_path):
    engine = make(tmp_path)
    result = engine.query(query=EXTRACT, parameters=urls(AURORA, MISSING, BIRCH))
    assert [r["source_url"] for r in result["rows"]] == [AURORA, MISSING, BIRCH]
    failed = result["rows"][1]
    assert (failed["fetch_status"], failed["fetch_failure"], failed["fact"]) == (
        "failed",
        "http_error",
        None,
    )
    assert result["rows"][0]["fetch_status"] == "ok"
    failed_row_id = result["row_ids"][1]
    assert not [e for e in result["evidence"] if e.get("row_id") == failed_row_id]
    assert [e for e in result["evidence"] if e.get("row_id") == result["row_ids"][0]]
    assert result["receipt"]["status"] == "partial"
    assert result["receipt"]["fetch_failed"] == 1
    assert result["receipt"]["fetch_cap_hit"] is False
    assert result["receipt"]["not_fetched_urls"] == []


def test_all_urls_failing_completes_with_failed_rows_and_no_sources(tmp_path):
    engine = make(tmp_path)
    result = engine.query(
        query="SELECT url, fetch_status, fetch_failure FROM WEB_FETCH($u1)",
        parameters=urls(MISSING),
    )
    assert result["rows"] == [
        {"url": MISSING, "fetch_status": "failed", "fetch_failure": "http_error"}
    ]
    assert result["receipt"]["fetch_failed"] == 1
    sources = engine.query(query="SELECT url FROM input.s", inputs={"s": pin(result, "sources")})
    assert sources["rows"] == []


def test_strict_policy_still_refuses_when_a_fetch_fails(tmp_path):
    engine = make(tmp_path)
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT url FROM WEB_FETCH($u1)",
            parameters=urls(MISSING),
            partial_policy="strict",
        )
    assert (refused.value.code, refused.value.stage) == ("provider_unavailable", "fetch")
    assert latest_run(engine)["fetch_failed"] == 1


def test_strict_refusal_counts_every_failed_url_of_the_call(tmp_path):
    engine = make(tmp_path)
    misses = [f"https://nowhere.example/{n}" for n in range(3)]
    with pytest.raises(SourcesQLError):
        engine.query(
            query="SELECT url FROM WEB_FETCH($u1, $u2, $u3)",
            parameters=urls(*misses),
            partial_policy="strict",
        )
    assert latest_run(engine)["fetch_failed"] == 3


def test_web_fetch_without_urls_says_what_to_pass_in_a_hosted_safe_sentence(tmp_path):
    with pytest.raises(SourcesQLError) as refused:
        make(tmp_path).query(query="SELECT url FROM WEB_FETCH()")
    assert refused.value.code == "invalid_query"
    assert refused.value.safe_message.startswith("WEB_FETCH needs at least one URL")
    assert PUBLIC_REASON.fullmatch(refused.value.safe_message)
    assert public_refusal_reason(refused.value) == refused.value.safe_message


def test_scalar_web_fetch_list_carries_the_status_fields(tmp_path):
    engine = make(tmp_path)
    result = engine.query(
        query="""SELECT url, WEB_FETCH(url)[1].fetch_status AS s, WEB_FETCH(url)[1].fetch_failure AS f
        FROM WEB_SEARCH('aurora', per_query_limit := 1)"""
    )
    assert [(r["s"], r["f"]) for r in result["rows"]] == [("ok", None)]


def test_over_cap_fetch_is_refused_and_receipt_names_unfetched_urls(tmp_path):
    engine = make(tmp_path)
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT url FROM WEB_FETCH($u1, $u2, $u3)",
            parameters=urls(AURORA, BIRCH, VENDOR),
            budgets={"max_fetches": 2},
        )
    assert refused.value.code == "budget_exhausted"
    receipt = latest_run(engine)
    run_id = receipt["run_id"]
    assert receipt["fetch_cap_hit"] is True
    assert receipt["not_fetched_urls"] == [VENDOR]
    assert receipt["not_fetched_count"] == 1
    recovered = engine.recover_run(run_id)
    assert sorted(r["url"] for r in recovered["rows"]) == [AURORA, BIRCH]


def test_refused_over_cap_job_counts_every_failed_fetch_it_attempted(tmp_path):
    engine = make(tmp_path)
    unknown = [f"https://nowhere.example/{n}" for n in range(41)]
    first, second = unknown[:32], unknown[32:]
    parameters = {f"u{i}": url for i, url in enumerate(unknown, 1)}
    query = (
        "SELECT url FROM WEB_FETCH("
        + ", ".join(f"$u{i}" for i in range(1, 33))
        + ") UNION ALL SELECT url FROM WEB_FETCH("
        + ", ".join(f"$u{i}" for i in range(33, 42))
        + ")"
    )
    with pytest.raises(SourcesQLError) as refused:
        engine.query(query=query, parameters=parameters)
    assert refused.value.code == "budget_exhausted"
    receipt = latest_run(engine)
    assert len(first) + len(second) == 41
    assert receipt["fetch_failed"] == 40
    assert receipt["not_fetched_urls"] == [unknown[40]]


def test_web_search_rows_keep_their_columns(tmp_path):
    result = make(tmp_path).query(query="SELECT * FROM WEB_SEARCH('aurora', per_query_limit := 1)")
    assert [c["key"] for c in result["columns"]] == [c.key for c in SOURCE_COLUMNS]


def test_imported_host_hits_still_have_no_evidence_or_sources(tmp_path):
    engine = make(tmp_path)
    imported = engine.import_table(
        [{"key": k} for k in ("title", "url", "content")],
        [
            {
                "title": "Aurora",
                "url": AURORA,
                "content": "Aurora Campus. Planned capacity is 500 MW.",
            }
        ],
        data_classification="synthetic_fixture",
    )
    result = engine.query(
        query="SELECT SEM_EXTRACT(content, 'facts', evidence := true, mw := 'planned capacity') AS f"
        " FROM input.h",
        inputs={"h": pin(imported)},
    )
    assert not [e for e in result["evidence"] if e.get("row_id")]
    assert result["replay_level"] == "values_only"
    sources = engine.query(query="SELECT url FROM input.s", inputs={"s": pin(result, "sources")})
    assert sources["rows"] == []


LIVE = {"mode": "live", "provider": "brave", "allow_live": True, "approved_cost_microusd": 50_000}


def profile_entry(tmp_path, **changes):
    engine = Engine(
        tmp_path / "caps",
        profiles={"p": {**LIVE, **changes}},
        worker=reference_worker,
    )
    return next(p for p in engine.capabilities()["profiles"] if p["name"] == "p")


def test_live_profile_without_search_key_reports_fetch_and_host_route(tmp_path, monkeypatch):
    monkeypatch.delenv("SYNTHETIC_SEARCH_KEY", raising=False)
    entry = profile_entry(
        tmp_path, allow_public_source_hosts=True, api_key_env="SYNTHETIC_SEARCH_KEY"
    )
    assert entry["search"] == {"configured": False}
    assert entry["fetch"]["configured"] is True
    assert entry["fetch"]["live_qualified"] is False
    assert entry["host_search_route"]["available"] is True
    assert "WEB_FETCH" in entry["host_search_route"]["operators"]
    assert "SYNTHETIC_SEARCH_KEY" not in json.dumps(entry)


def test_host_route_lists_semantic_operators_only_when_a_model_is_configured(tmp_path, monkeypatch):
    monkeypatch.delenv("SYNTHETIC_MODEL_KEY", raising=False)
    without = profile_entry(tmp_path, allow_public_source_hosts=True)
    assert without["host_search_route"]["operators"] == ["WEB_FETCH"]
    unkeyed = profile_entry(
        tmp_path,
        allow_public_source_hosts=True,
        model={"name": "synthetic", "api_key_env": "SYNTHETIC_MODEL_KEY"},
    )
    assert unkeyed["host_search_route"]["operators"] == ["WEB_FETCH"]
    keyed = profile_entry(
        tmp_path,
        allow_public_source_hosts=True,
        model={"name": "synthetic", "api_key": "SAFE-SYNTHETIC-KEY"},
    )
    assert keyed["host_search_route"]["operators"] == [
        "WEB_FETCH",
        "SEM_MATCH",
        "SEM_EXTRACT",
        "SEM_EXTRACT_ALL",
    ]
    assert "SAFE-SYNTHETIC-KEY" not in json.dumps(keyed)


@pytest.mark.parametrize(
    ("changes", "reason", "fetch_configured"),
    [
        (
            {"api_key": "SAFE-SYNTHETIC-KEY", "allow_public_source_hosts": True},
            "search_provider_configured",
            True,
        ),
        ({"allowed_source_hosts": []}, "fetch_not_configured", False),
        ({"allow_public_source_hosts": "true"}, "fetch_not_configured", False),
    ],
)
def test_host_route_is_unavailable_when_search_is_configured_or_fetch_is_not(
    tmp_path, changes, reason, fetch_configured
):
    entry = profile_entry(tmp_path, **changes)
    assert entry["host_search_route"] == {"available": False, "reason": reason}
    assert entry["fetch"]["configured"] is fetch_configured
    assert "SAFE-SYNTHETIC-KEY" not in json.dumps(entry)


def test_explicit_allowlist_counts_as_fetch_configured(tmp_path):
    entry = profile_entry(tmp_path, allowed_source_hosts=["source.example"])
    assert entry["host_search_route"]["available"] is True


def test_fixture_profile_advertises_the_host_route_so_it_runs_offline(tmp_path):
    entry = next(p for p in make(tmp_path).capabilities()["profiles"] if p["name"] == "fixture")
    assert entry["host_search_route"]["available"] is True
    assert entry["search"] == {"configured": True}
    assert entry["provider"] == "fixture"


GUIDANCE = pathlib.Path(__file__).parents[2] / "apps/research/server/agent-guidance.ts"


def test_documented_fetch_example_runs_in_fixture_mode(tmp_path):
    match = re.search(r"SOURCESQL_FETCH_EXAMPLE = `(.*?)`;", GUIDANCE.read_text(), re.DOTALL)
    assert match, "SOURCESQL_FETCH_EXAMPLE not found in agent-guidance.ts"
    result = make(tmp_path).query(query=match.group(1), parameters=urls(AURORA, BIRCH, VENDOR))
    assert [r["fetch_status"] for r in result["rows"]] == ["ok"] * 3
    assert [r["source_url"] for r in result["rows"]] == [AURORA, BIRCH, VENDOR]
    # A copyable example must end in cited answers, not only fetched pages.
    assert [r["project_name"] for r in result["rows"]] == [
        "Aurora Campus",
        "Birch Campus",
        "Fictional Platform",
    ]
    cited = [e for e in result["evidence"] if e.get("row_id") and e.get("support")]
    assert len(cited) == 3


def live_engine(tmp_path, monkeypatch, reply, **changes):
    def resolve(host, port, **kwargs):
        address = "10.0.0.2" if host == "private.example" else "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    original = ProviderRegistry.__init__

    def configured(self, profile=None):
        original(self, profile)
        # MockTransport is the only HTTP path; the profile itself stays plain data.
        self.profile["resolver"] = resolve
        self.fetch_provider = SafeFetcher(
            client=httpx.Client(transport=httpx.MockTransport(reply), trust_env=False),
            resolver=resolve,
        )
        self.semantic_provider = FixtureProvider("t1")

    monkeypatch.setattr(ProviderRegistry, "__init__", configured)
    profile = {
        "mode": "live",
        "provider": "brave",
        "allow_live": True,
        "approved_cost_microusd": 50_000,
        "metering_policy": "estimated",
        "allow_public_source_hosts": True,
        **changes,
    }
    return Engine(tmp_path / "live", profiles={"hostfetch": profile}, worker=reference_worker)


def serve_fixture_text(requests):
    texts = {
        urlsplit(d["url"]).hostname: d["text"] for d in DOCUMENTS if d["version"] in {"t1", "both"}
    }

    def reply(request):
        requests.append(request.headers["host"])
        host = request.headers["host"]
        if host == "pdf.example":
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")
        if host == "big.example":
            return httpx.Response(
                200, headers={"content-type": "text/html"}, content=b"x" * 2_200_000
            )
        if host == "gone.example":
            return httpx.Response(404, headers={"content-type": "text/html"}, text="gone")
        return httpx.Response(200, headers={"content-type": "text/plain"}, text=texts[host])

    return reply


LIVE_BUDGET = {"max_cost_microusd": 1}


def test_live_fetch_only_profile_gives_cited_cells_and_three_source_versions(tmp_path, monkeypatch):
    monkeypatch.delenv("BRAVE_API_KEY", raising=False)
    seen = []
    engine = live_engine(tmp_path, monkeypatch, serve_fixture_text(seen))
    result = engine.query(
        query=EXTRACT,
        parameters=urls(AURORA, BIRCH, VENDOR),
        profile="hostfetch",
        budgets=LIVE_BUDGET,
    )
    assert seen == ["aurora.example", "birch.example", "vendor.example"]
    assert [r["fetch_status"] for r in result["rows"]] == ["ok"] * 3
    assert [e for e in result["evidence"] if e.get("row_id")]
    texts = {s["source_version_id"]: s["content"] for s in result["source_versions"]}
    assert len(texts) == 3
    for item in result["evidence"]:
        for quote in item.get("support") or []:
            assert quote["quote"] in texts[quote["source_version_id"]]


def test_web_search_without_provider_is_refused_before_any_dispatch(tmp_path, monkeypatch):
    monkeypatch.delenv("BRAVE_API_KEY", raising=False)
    seen = []
    engine = live_engine(tmp_path, monkeypatch, serve_fixture_text(seen))
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT url FROM WEB_SEARCH($q)",
            parameters={"q": "aurora"},
            profile="hostfetch",
            budgets=LIVE_BUDGET,
        )
    assert (refused.value.code, refused.value.stage) == ("provider_unavailable", "acquisition")
    assert refused.value.safe_message.startswith("No search provider is configured")
    assert "pass the URLs to WEB_FETCH" in refused.value.safe_message
    assert seen == []


@pytest.mark.parametrize(
    ("host", "reason"),
    [
        ("pdf.example", "unsupported_type"),
        ("big.example", "too_large"),
        ("private.example", "blocked_host"),
        ("gone.example", "http_error"),
    ],
)
def test_live_failures_stay_as_failed_rows_and_the_job_completes(
    tmp_path, monkeypatch, host, reason
):
    seen = []
    engine = live_engine(tmp_path, monkeypatch, serve_fixture_text(seen))
    result = engine.query(
        query="""SELECT url AS source_url, fetch_status, fetch_failure,
          SEM_EXTRACT(content, 'project facts', evidence := true, project := 'project name') AS fact
        FROM WEB_FETCH($u1, $u2)""",
        parameters=urls(AURORA, f"https://{host}/doc"),
        profile="hostfetch",
        budgets=LIVE_BUDGET,
    )
    good, bad = result["rows"]
    assert good["fetch_status"] == "ok"
    assert (bad["fetch_status"], bad["fetch_failure"], bad["fact"]) == ("failed", reason, None)
    assert not [e for e in result["evidence"] if e.get("row_id") == result["row_ids"][1]]
    assert [e for e in result["evidence"] if e.get("row_id") == result["row_ids"][0]]
    assert result["receipt"]["status"] == "partial"
    assert result["receipt"]["fetch_failed"] == 1
    if host == "private.example":
        assert "private.example" not in seen
