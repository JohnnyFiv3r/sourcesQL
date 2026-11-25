"""Host-found lead sets: intake, views, classification and the trust boundary."""

from __future__ import annotations

import threading
import time

import pytest

from sourcesql import error_codes
from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.engine import Engine

from test_engine_lineage import make, pin, reference_worker

AURORA = "https://aurora.example/project"
BIRCH = "https://birch.example/campus"
VENDOR = "https://vendor.example/platform"
REQUEST = "11111111-1111-4111-8111-{:012d}"


def request_id(n):
    return REQUEST.format(n)


def rows(count, start=0, query="q", rank_offset=1):
    return [
        {
            "url": f"https://site{start + i}.example/page",
            "title": f"Page {start + i}",
            "query": query,
            "rank": rank_offset + i,
        }
        for i in range(count)
    ]


def lead_view(reply, view="leads"):
    return {"result_id": reply["result_id"], "view": view, "amendment_revision": None}


def refused(call) -> SourcesQLError:
    with pytest.raises(SourcesQLError) as caught:
        call()
    return caught.value


def stored_leads(engine, reply):
    return engine.read_result(reply["result_id"])["rows"]


def test_intake_stores_up_to_150_leads_as_host_reported(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), rows(150), title="Wide search")
    assert reply["stored"] == 150 and reply["new"] == 150 and reply["revision"] == 1
    assert reply["totals"] == {"leads": 150, "fetched": 0, "failed": 0, "pending": 150}
    result = engine.read_result(reply["result_id"])
    assert result["data_classification"] == "host_reported"
    assert result["provenance"]["assertion"] == "host"
    assert {row["lead_status"] for row in result["rows"]} == {"pending"}
    assert {row["fetch_failure"] for row in result["rows"]} == {None}
    assert {row["batch_result_id"] for row in result["rows"]} == {None}


def test_too_many_or_no_leads_refuse_the_whole_call_and_store_nothing(tmp_path):
    engine = make(tmp_path)
    too_many = refused(lambda: engine.add_leads(request_id(1), rows(151)))
    assert too_many.code == "invalid_request"
    assert too_many.safe_message == error_codes.refusal("lead_batch_too_large", count=151)
    empty = refused(lambda: engine.add_leads(request_id(2), []))
    assert empty.safe_message == error_codes.refusal("lead_batch_empty")
    assert engine.store.lead_request(request_id(1)) is None
    with engine.store.db() as db:
        assert db.execute("SELECT count(*) FROM lead_sets").fetchone()[0] == 0


def test_append_dedupes_by_normalized_url_and_keeps_every_query(tmp_path):
    engine = make(tmp_path)
    first = engine.add_leads(
        request_id(1),
        [
            {
                "url": "HTTPS://A.example/x/#f",
                "title": "First title",
                "query": "one",
                "rank": 4,
                "date": "2026-01-02",
            },
            {"url": "https://b.example/?p=1", "title": "P1", "query": "one", "rank": 1},
            {"url": "https://b.example/?p=2", "title": "P2", "query": "one", "rank": 2},
        ],
    )
    second = engine.add_leads(
        request_id(2),
        [
            {
                "url": "https://a.example/x",
                "title": "Other title",
                "query": "two",
                "rank": 2,
                "date": "2026-05-05",
            },
            {"url": "https://c.example/new", "title": "New", "query": "two", "rank": 9},
        ],
        lead_set_id=first["lead_set_id"],
    )
    assert second["revision"] == 2 and second["lead_set_id"] == first["lead_set_id"]
    assert (second["new"], second["already_present"]) == (1, 1)
    by_url = {row["url"]: row for row in stored_leads(engine, second)}
    assert sorted(by_url) == [
        "https://a.example/x",
        "https://b.example/?p=1",
        "https://b.example/?p=2",
        "https://c.example/new",
    ]
    lead = by_url["https://a.example/x"]
    assert (lead["title"], lead["host_query"], lead["host_rank"], lead["host_date"]) == (
        "First title",
        "one",
        "2",
        "2026-01-02",
    )
    assert lead["times_found"] == "2"
    hits = engine.query(
        query="SELECT host_query, host_rank FROM input.h WHERE url = 'https://a.example/x' ORDER BY host_rank",
        inputs={"h": lead_view(second, "hits")},
    )
    assert hits["rows"] == [
        {"host_query": "two", "host_rank": "2"},
        {"host_query": "one", "host_rank": "4"},
    ]
    assert len(stored_leads(engine, first)) == 3, "revision 1 stays as it was"


def test_resend_same_request_id_is_idempotent(tmp_path):
    engine = make(tmp_path)
    leads = rows(5)
    first = engine.add_leads(request_id(1), leads)
    assert engine.add_leads(request_id(1), leads) == first
    with engine.store.db() as db:
        assert db.execute("SELECT count(*) FROM lead_sets").fetchone()[0] == 1
    changed = refused(lambda: engine.add_leads(request_id(1), rows(5, start=50)))
    assert changed.code == "invalid_request"
    assert changed.safe_message == error_codes.refusal("lead_request_reused")


def test_bad_rows_are_refused_by_index_and_the_others_are_stored(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(
        request_id(1),
        [
            {"url": "https://ok.example/a", "title": "ok", "rank": 1},
            {"url": "ftp://files.example/a", "title": "ftp"},
            {"url": "https://x.example/" + "a" * 2049, "title": "long"},
            {"title": "no url"},
            {"url": "https://rank.example/", "title": "rank", "rank": 0},
            {"url": "https://query.example/", "title": "q", "query": "q" * 301},
            {"url": "https://title.example/", "title": "t" * 301},
            {"url": "https://date.example/", "title": "date", "date": "01/02/2026"},
        ],
    )
    assert reply["refused"] == [
        {"index": 1, "reason": "not an http or https URL"},
        {"index": 2, "reason": "URL is longer than 2048 characters"},
        {"index": 3, "reason": "missing URL"},
        {"index": 4, "reason": "rank must be a whole number from 1 to 1000"},
        {"index": 5, "reason": "query is longer than 300 characters"},
        {"index": 6, "reason": "title is longer than 300 characters"},
    ]
    assert reply["stored"] == 2 and reply["dates_left_out"] == 1
    dated = {row["url"]: row for row in stored_leads(engine, reply)}["https://date.example/"]
    assert dated["host_date"] is None


def test_a_row_with_no_title_is_refused_by_index_and_the_others_are_stored(tmp_path):
    reply = make(tmp_path).add_leads(
        request_id(1),
        [
            {"url": "https://ok.example/a", "title": "ok"},
            {"url": "https://notitle.example/"},
            {"url": "https://blank.example/", "title": "   "},
        ],
    )
    assert reply["refused"] == [
        {"index": 1, "reason": "missing title"},
        {"index": 2, "reason": "missing title"},
    ]
    assert reply["stored"] == 1


def test_duplicate_submissions_are_all_kept_as_hits_below_the_lead_cap(tmp_path):
    engine = make(tmp_path)
    reply = None
    for call in range(41):
        reply = engine.add_leads(
            request_id(call + 1),
            [{"url": "https://repeat.example/page", "title": "repeat", "query": "q", "rank": 1}]
            * 150,
            lead_set_id=reply["lead_set_id"] if reply else None,
        )
    assert reply["totals"]["leads"] == 1
    counted = engine.query(
        query="SELECT count(*) AS n FROM input.h", inputs={"h": lead_view(reply, "hits")}
    )
    assert counted["rows"] == [{"n": "6150"}]


def test_no_hit_count_limit_of_its_own_beyond_the_storage_quota(tmp_path):
    engine = make(tmp_path)
    # Every revision rewrites the set, so a long history needs room; the quota is the limit.
    engine.store.quota = 10**10
    reply = None
    for call in range(135):
        reply = engine.add_leads(
            request_id(call + 1),
            [{"url": "https://repeat.example/page", "title": "r", "query": "q", "rank": 1}] * 150,
            lead_set_id=reply["lead_set_id"] if reply else None,
        )
    counted = engine.query(
        query="SELECT count(*) AS n FROM input.h", inputs={"h": lead_view(reply, "hits")}
    )
    assert counted["rows"] == [{"n": "20250"}]


def test_unknown_lead_field_refuses_the_call(tmp_path):
    error = refused(
        lambda: make(tmp_path).add_leads(
            request_id(1), [{"url": "https://a.example/", "title": "t", "snippet": "text"}]
        )
    )
    assert (error.code, error.safe_message) == ("invalid_request", "Unknown lead field")


def test_unknown_lead_set_looks_like_a_missing_result(tmp_path):
    error = refused(
        lambda: make(tmp_path).add_leads(
            request_id(1), rows(1), lead_set_id="22222222-2222-4222-8222-222222222222"
        )
    )
    assert (error.code, error.safe_message) == ("unauthorized", "Result or dependency unavailable")


def test_set_cap_refuses_the_whole_call_and_keeps_the_head(tmp_path):
    engine = make(tmp_path)
    reply = None
    for call in range(14):
        count = 150 if call < 13 else 50
        reply = engine.add_leads(
            request_id(call + 1),
            rows(count, start=call * 150),
            lead_set_id=reply["lead_set_id"] if reply else None,
        )
    assert reply["totals"]["leads"] == 2000
    error = refused(
        lambda: engine.add_leads(
            request_id(99), rows(1, start=5000), lead_set_id=reply["lead_set_id"]
        )
    )
    assert error.code == "budget_exhausted"
    assert error.safe_message == error_codes.refusal("lead_set_full")
    assert engine.store.lead_set_head(reply["lead_set_id"])["revision"] == 14


def test_a_thousand_lead_set_filters_fast(tmp_path):
    engine = make(tmp_path)
    reply = None
    for call in range(7):
        reply = engine.add_leads(
            request_id(call + 1),
            rows(150 if call < 6 else 100, start=call * 150, query=f"q{call % 3}"),
            lead_set_id=reply["lead_set_id"] if reply else None,
        )
    assert reply["totals"]["leads"] == 1000
    queries = {
        "rank filter": "SELECT url FROM input.l WHERE host_rank <= 3 ORDER BY times_found DESC",
        "row_number": "SELECT url FROM (SELECT url, ROW_NUMBER() OVER (PARTITION BY host_query ORDER BY host_rank) AS n FROM input.l) AS ranked WHERE n = 1",
    }
    # Best of 5 per query: a slow filter path is slow every time, a paused process is slow once.
    ceiling, attempts = 2.0, 5
    for name, sql in queries.items():
        best = None
        for _ in range(attempts):
            started = time.perf_counter()
            engine.query(query=sql, inputs={"l": lead_view(reply)})
            elapsed = time.perf_counter() - started
            best = elapsed if best is None else min(best, elapsed)
            if elapsed < ceiling:
                break
        assert best < ceiling, (
            f"{name} query: best of {attempts} took {best:.3f}s, ceiling {ceiling}s"
        )
    counted = engine.query(
        query="SELECT count(*) AS n FROM input.h", inputs={"h": lead_view(reply, "hits")}
    )
    assert counted["rows"] == [{"n": "1000"}]


def test_lead_set_has_no_sources(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), rows(3))
    sources = engine.query(query="SELECT url FROM input.s", inputs={"s": pin(reply, "sources")})
    assert sources["rows"] == []
    assert engine.read_result(reply["result_id"])["source_versions"] == []
    assert engine.read_result(reply["result_id"])["evidence"] == []


JOIN = """WITH b AS (SELECT lead_id, url FROM input.l LIMIT 3),
f AS (SELECT lead_id, WEB_FETCH(url)[1].content AS content FROM b),
e AS (SELECT lead_id, SEM_EXTRACT(content, 'the campus name', evidence := true) AS campus FROM f)
SELECT l.title, l.host_query, l.host_rank, e.campus
FROM e JOIN input.l AS l ON l.lead_id = e.lead_id"""


def joined(engine, tmp_path=None):
    reply = engine.add_leads(
        request_id(1),
        [
            {"url": AURORA, "title": "Host says Aurora", "query": "campus plans", "rank": 1},
            {"url": BIRCH, "title": "Host says Birch", "query": "campus plans", "rank": 2},
            {"url": VENDOR, "title": "Host says Vendor", "query": "platform", "rank": 3},
        ],
    )
    return reply, engine.query(query=JOIN, inputs={"l": lead_view(reply)})


def test_host_fields_never_carry_citations_after_join(tmp_path):
    engine = make(tmp_path)
    _, result = joined(engine)
    assert len(result["rows"]) == 3
    cited = {e["column_key"] for e in result["evidence"] if e.get("row_id")}
    assert cited and cited <= {"campus"}
    origins = [
        e for e in result["evidence"] if e.get("column_key") in {"title", "host_query", "host_rank"}
    ]
    assert origins == []


def test_host_query_never_becomes_search_provenance(tmp_path):
    engine = make(tmp_path)
    _, result = joined(engine)
    haystack = repr(engine.run_status(result["run_id"])) + repr(result["source_versions"])
    assert "campus plans" not in haystack
    assert "Host says" not in haystack


def test_derived_result_is_host_reported_and_export_keeps_it(tmp_path):
    engine = make(tmp_path)
    reply, result = joined(engine)
    assert result["data_classification"] == "host_reported"
    bundle = engine.export(result["result_id"])
    classes = {
        r["metadata"]["result_id"]: r["metadata"]["data_classification"]
        for r in bundle["results"].values()
    }
    assert classes[reply["result_id"]] == "host_reported"
    assert classes[reply["hits_result_id"]] == "host_reported"
    fresh = Engine(tmp_path / "fresh", worker=reference_worker)
    mapping = fresh.import_bundle(bundle)["result_mapping"]
    local = {**reply, "result_id": mapping[reply["result_id"]]}
    imported = fresh.read_result(local["result_id"])
    assert imported["data_classification"] == "host_reported"
    assert (
        fresh.read_result(mapping[reply["hits_result_id"]])["data_classification"]
        == "host_reported"
    )
    assert fresh.query(query="SELECT url FROM input.l", inputs={"l": lead_view(local)})["rows"]
    assert fresh.query(query="SELECT url FROM input.h", inputs={"h": lead_view(local, "hits")})[
        "rows"
    ]


def test_a_long_history_exports_and_re_imports(tmp_path):
    engine = make(tmp_path)
    reply = None
    for call in range(33):
        reply = engine.add_leads(
            request_id(call + 1),
            [{"url": "https://same.example/page", "title": "Same", "query": f"Search {call}"}],
            lead_set_id=reply["lead_set_id"] if reply else None,
        )
    bundle = engine.export(reply["result_id"])
    assert len(bundle["results"]) == 2, "only the newest revision and its hits travel"
    fresh = Engine(tmp_path / "fresh", worker=reference_worker)
    mapping = fresh.import_bundle(bundle)["result_mapping"]
    local = {**reply, "result_id": mapping[reply["result_id"]]}
    assert fresh.query(query="SELECT url FROM input.l", inputs={"l": lead_view(local)})["rows"]


def test_revoking_any_revision_revokes_the_whole_set(tmp_path):
    engine = make(tmp_path)
    first = engine.add_leads(request_id(1), rows(2))
    second = engine.add_leads(request_id(2), rows(2, start=10), lead_set_id=first["lead_set_id"])
    engine.store.revoke(first["result_id"])
    for result_id in (second["result_id"], second["hits_result_id"]):
        error = refused(lambda: engine.read_result(result_id))
        assert (error.code, error.safe_message) == (
            "unauthorized",
            "Result or dependency unavailable",
        )
        assert refused(lambda: engine.export(result_id)).code == "unauthorized"


def test_a_private_input_keeps_a_derived_result_private(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), rows(2))
    private = engine.import_table([{"key": "label"}], [{"label": "private example"}])
    result = engine.query(
        query="SELECT l.title, p.label FROM input.l AS l CROSS JOIN input.p AS p",
        inputs={"l": lead_view(reply), "p": pin(private)},
    )
    assert result["data_classification"] == "private_derived"


def test_import_table_cannot_claim_host_reported(tmp_path):
    error = refused(
        lambda: make(tmp_path).import_table(
            [{"key": "a"}], [{"a": "x"}], data_classification="host_reported"
        )
    )
    assert error.code == "invalid_request"


def test_import_with_a_host_reported_parent_stays_host_reported(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), rows(2))
    derived = engine.import_table(
        [{"key": "a"}],
        [{"a": "x"}],
        data_classification="public_web",
        parents=[{"result_id": reply["result_id"]}],
    )
    assert derived["data_classification"] == "host_reported"


def test_forged_bundle_cannot_claim_host_reported_without_a_lead_set_or_parent(tmp_path):
    engine = make(tmp_path)
    plain = engine.import_table([{"key": "a"}], [{"a": "x"}], data_classification="public_web")
    bundle = engine.export(plain["result_id"])
    record = bundle["results"][plain["result_id"]]
    record["metadata"]["data_classification"] = "host_reported"
    body = {k: v for k, v in bundle.items() if k != "content_sha256"}
    from sourcesql.contracts import digest

    bundle["content_sha256"] = digest(body)
    error = refused(
        lambda: Engine(tmp_path / "other", worker=reference_worker).import_bundle(bundle)
    )
    assert error.code in {"invalid_request", "evidence_invalid"}


def test_views_refuse_ordinary_results(tmp_path):
    engine = make(tmp_path)
    plain = engine.import_table([{"key": "a"}], [{"a": "x"}], data_classification="public_web")
    for view in ("leads", "hits"):
        error = refused(
            lambda: engine.query(
                query="SELECT a FROM input.t", inputs={"t": {**pin(plain), "view": view}}
            )
        )
        assert (error.code, error.safe_message) == (
            "invalid_request",
            "Bind a lead-set result with view leads or hits",
        )


def test_caps_are_unchanged():
    limits = Budget().limits
    assert (
        limits["max_fetches"],
        limits["max_semantic_documents"],
        limits["max_model_requests"],
    ) == (
        40,
        40,
        96,
    )


def test_concurrent_appends_from_two_engines_both_land(tmp_path):
    first = Engine(tmp_path / "shared", worker=reference_worker)
    second = Engine(tmp_path / "shared", worker=reference_worker)
    base = first.add_leads(request_id(1), rows(2))
    barrier = threading.Barrier(2)
    replies = []

    def append(engine, n, start):
        barrier.wait()
        replies.append(
            engine.add_leads(request_id(n), rows(3, start=start), lead_set_id=base["lead_set_id"])
        )

    threads = [
        threading.Thread(target=append, args=(first, 2, 100)),
        threading.Thread(target=append, args=(second, 3, 200)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(r["revision"] for r in replies) == [2, 3]
    head = first.store.lead_set_head(base["lead_set_id"])
    assert head["revision"] == 3
    assert len(first.read_result(head["leads_result_id"])["rows"]) == 8
