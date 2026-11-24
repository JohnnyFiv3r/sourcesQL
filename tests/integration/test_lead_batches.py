"""Recording what a lead-set batch fetched: only the engine's own fetch outcomes count."""

from __future__ import annotations

import threading

import pytest

from sourcesql import error_codes
from sourcesql.contracts import SourcesQLError
from sourcesql.engine import Engine
from sourcesql.providers import fixture

from test_engine_lineage import make, reference_worker
from test_lead_sets import AURORA, BIRCH, VENDOR, lead_view, refused, request_id, rows, stored_leads

MISSING = "https://nowhere.example/x"
BATCH = "SELECT lead_id, WEB_FETCH(url) AS page FROM input.l"


def leads_of(*urls):
    return [
        {"url": url, "title": f"Lead {i}", "query": "q", "rank": i + 1}
        for i, url in enumerate(urls)
    ]


def statuses(engine, reply):
    return {
        row["url"]: (row["lead_status"], row["fetch_failure"])
        for row in stored_leads(engine, reply)
    }


def every_lead(engine, reply):
    found, offset = [], 0
    while offset is not None:
        page = engine.read_result(reply["result_id"], offset=offset)
        found += page["rows"]
        offset = page["next_offset"]
    return found


def run_batch(engine, reply, query=BATCH, parameters=None):
    return engine.query(query=query, parameters=parameters or {}, inputs={"l": lead_view(reply)})


def test_fetch_outcomes_are_recorded_per_requested_url(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, BIRCH, MISSING))
    batch = run_batch(engine, reply)
    outcomes = {o["url"]: o for o in batch["fetch_outcomes"]}
    assert set(outcomes) == {AURORA, BIRCH, MISSING}
    assert [outcomes[u]["status"] for u in (AURORA, BIRCH, MISSING)] == ["ok", "ok", "failed"]
    assert outcomes[MISSING]["failure"] == "http_error"
    assert outcomes[MISSING]["source_version_id"] is None
    assert outcomes[AURORA]["source_version_id"].startswith("src_")
    assert "fetch_outcomes" not in {c["key"] for c in batch["columns"]}


def test_a_query_that_fetches_nothing_has_no_fetch_outcomes(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA))
    batch = run_batch(engine, reply, "SELECT lead_id FROM input.l")
    assert "fetch_outcomes" not in batch


def test_record_marks_fetched_and_failed_from_engine_outcomes(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, BIRCH, MISSING, VENDOR))
    batch = run_batch(
        engine,
        reply,
        "SELECT lead_id, WEB_FETCH(url) AS page FROM input.l WHERE url <> '" + VENDOR + "'",
    )
    record = engine.record_lead_batch(request_id(2), reply["lead_set_id"], batch["result_id"])
    assert record["revision"] == 2
    assert (record["fetched"], record["failed"], record["not_fetched"], record["ignored"]) == (
        2,
        1,
        0,
        0,
    )
    assert record["failure_counts"] == {"http_error": 1}
    assert record["totals"] == {"leads": 4, "fetched": 2, "failed": 1, "pending": 1}
    state = statuses(engine, record)
    assert state[AURORA] == ("fetched", None) and state[BIRCH] == ("fetched", None)
    assert state[MISSING] == ("failed", "http_error") and state[VENDOR] == ("pending", None)
    saved = engine.read_result(record["result_id"])
    assert {r["batch_result_id"] for r in saved["rows"] if r["lead_status"] != "pending"} == {
        batch["result_id"]
    }
    hits = engine.store.lead_set_head(reply["lead_set_id"])["hits_result_id"]
    assert [p["result_id"] for p in saved["parents"]] == [
        hits,
        reply["result_id"],
        batch["result_id"],
    ]
    assert saved["data_classification"] == "host_reported"


def test_forged_status_columns_record_nothing(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, BIRCH))
    forged = run_batch(
        engine, reply, "SELECT lead_id, 'ok' AS fetch_status, NULL AS fetch_failure FROM input.l"
    )
    error = refused(
        lambda: engine.record_lead_batch(request_id(2), reply["lead_set_id"], forged["result_id"])
    )
    assert error.safe_message == error_codes.refusal("lead_batch_nothing_fetched")
    assert engine.store.lead_set_head(reply["lead_set_id"])["revision"] == 1
    # A batch that fetches one page and claims all of them fetched changes only that page.
    partial = run_batch(
        engine,
        reply,
        "SELECT lead_id, 'ok' AS fetch_status, WEB_FETCH('"
        + AURORA
        + "') AS page FROM input.l LIMIT 1",
    )
    record = engine.record_lead_batch(request_id(3), reply["lead_set_id"], partial["result_id"])
    assert statuses(engine, record) == {AURORA: ("fetched", None), BIRCH: ("pending", None)}


def test_batch_must_read_this_lead_set(tmp_path):
    engine = make(tmp_path)
    mine = engine.add_leads(request_id(1), leads_of(AURORA))
    other = engine.add_leads(request_id(2), leads_of(AURORA))
    unrelated = engine.query(query="SELECT url FROM WEB_FETCH('" + AURORA + "')")
    for batch in (unrelated, run_batch(engine, other)):
        error = refused(
            lambda: engine.record_lead_batch(request_id(9), mine["lead_set_id"], batch["result_id"])
        )
        assert error.safe_message == error_codes.refusal("lead_batch_other_set")
    # Any earlier revision of this set counts: the agent may have forgotten to record.
    older = run_batch(engine, mine)
    newer = engine.add_leads(request_id(3), leads_of(BIRCH), lead_set_id=mine["lead_set_id"])
    record = engine.record_lead_batch(request_id(4), mine["lead_set_id"], older["result_id"])
    assert record["revision"] == newer["revision"] + 1
    assert statuses(engine, record)[AURORA] == ("fetched", None)


def test_unmatched_fetches_are_ignored_and_counted(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA))
    batch = run_batch(
        engine,
        reply,
        "SELECT lead_id, WEB_FETCH(url) AS page, WEB_FETCH('" + VENDOR + "') AS extra FROM input.l",
    )
    record = engine.record_lead_batch(request_id(2), reply["lead_set_id"], batch["result_id"])
    assert (record["fetched"], record["ignored"]) == (1, 1)
    elsewhere = engine.query(
        query="SELECT lead_id, WEB_FETCH('" + VENDOR + "') AS page FROM input.l",
        inputs={"l": lead_view(reply)},
    )
    error = refused(
        lambda: engine.record_lead_batch(
            request_id(3), reply["lead_set_id"], elsewhere["result_id"]
        )
    )
    assert error.safe_message == error_codes.refusal("lead_batch_no_match")


def test_fetched_is_never_downgraded_and_failed_can_recover(tmp_path, monkeypatch):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, BIRCH))
    first = run_batch(engine, reply)
    one = engine.record_lead_batch(request_id(2), reply["lead_set_id"], first["result_id"])
    assert statuses(engine, one) == {AURORA: ("fetched", None), BIRCH: ("fetched", None)}
    documents = [d for d in fixture.DOCUMENTS if d["url"] not in {AURORA, BIRCH}]
    monkeypatch.setattr(fixture, "DOCUMENTS", documents)
    failing = run_batch(engine, one)
    two = engine.record_lead_batch(request_id(3), reply["lead_set_id"], failing["result_id"])
    assert (two["fetched"], two["failed"]) == (0, 0)
    assert statuses(engine, two) == {AURORA: ("fetched", None), BIRCH: ("fetched", None)}
    # A lead that failed and later succeeds becomes fetched.
    fresh = engine.add_leads(request_id(4), leads_of(AURORA), title="Recover")
    failed = run_batch(engine, fresh)
    bad = engine.record_lead_batch(request_id(5), fresh["lead_set_id"], failed["result_id"])
    assert statuses(engine, bad) == {AURORA: ("failed", "http_error")}
    monkeypatch.undo()
    again = run_batch(engine, bad)
    good = engine.record_lead_batch(request_id(6), fresh["lead_set_id"], again["result_id"])
    assert statuses(engine, good) == {AURORA: ("fetched", None)}


def test_record_is_idempotent_per_request_and_per_batch(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, BIRCH))
    one = run_batch(engine, reply, BATCH + " LIMIT 1")
    other = run_batch(engine, reply, BATCH + " ORDER BY url DESC LIMIT 1")
    first = engine.record_lead_batch(request_id(2), reply["lead_set_id"], one["result_id"])
    assert engine.record_lead_batch(request_id(2), reply["lead_set_id"], one["result_id"]) == first
    assert engine.record_lead_batch(request_id(3), reply["lead_set_id"], one["result_id"]) == first
    assert engine.store.lead_set_head(reply["lead_set_id"])["revision"] == 2
    error = refused(
        lambda: engine.record_lead_batch(request_id(2), reply["lead_set_id"], other["result_id"])
    )
    assert error.safe_message == error_codes.refusal("lead_record_reused")


def test_next_batch_neither_refetches_nor_skips(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, BIRCH, MISSING))
    batch = run_batch(engine, reply, BATCH + " ORDER BY url LIMIT 2")
    record = engine.record_lead_batch(request_id(2), reply["lead_set_id"], batch["result_id"])
    pending = engine.query(
        query="SELECT url FROM input.l WHERE lead_status = 'pending'",
        inputs={"l": lead_view(record)},
    )
    attempted = {o["url"] for o in batch["fetch_outcomes"]}
    assert {r["url"] for r in pending["rows"]} == {AURORA, BIRCH, MISSING} - attempted


def test_intake_after_record_keeps_statuses_and_their_parent(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA))
    record = engine.record_lead_batch(
        request_id(2), reply["lead_set_id"], run_batch(engine, reply)["result_id"]
    )
    later = engine.add_leads(request_id(3), leads_of(BIRCH), lead_set_id=reply["lead_set_id"])
    assert later["totals"] == {"leads": 2, "fetched": 1, "failed": 0, "pending": 1}
    assert statuses(engine, later)[AURORA] == ("fetched", None)
    parents = [p["result_id"] for p in engine.read_result(later["result_id"])["parents"]]
    assert record["result_id"] in parents
    plain = engine.add_leads(request_id(4), leads_of(BIRCH))
    assert len(engine.read_result(plain["result_id"])["parents"]) == 1, (
        "intake-only exports stay small"
    )


def test_unknown_batch_or_set_looks_missing(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA))
    batch = run_batch(engine, reply)
    for set_id, batch_id in (
        (reply["lead_set_id"], "wq_does_not_exist"),
        (request_id(77).replace("1111", "2222"), batch["result_id"]),
    ):
        error = refused(lambda: engine.record_lead_batch(request_id(5), set_id, batch_id))
        assert (error.code, error.safe_message) == (
            "unauthorized",
            "Result or dependency unavailable",
        )


def test_malformed_ids_are_refused(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA))
    for args in (
        ("nope", reply["lead_set_id"], "wq_x"),
        (request_id(2), "nope", "wq_x"),
        (request_id(2), reply["lead_set_id"], ""),
    ):
        assert refused(lambda: engine.record_lead_batch(*args)).code == "invalid_request"


def test_record_revision_exports_with_its_batches_and_re_imports(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), leads_of(AURORA, MISSING))
    batch = run_batch(engine, reply)
    record = engine.record_lead_batch(request_id(2), reply["lead_set_id"], batch["result_id"])
    bundle = engine.export(record["result_id"])
    classes = {
        r["metadata"]["result_id"]: r["metadata"]["data_classification"]
        for r in bundle["results"].values()
    }
    assert {record["result_id"], reply["result_id"], batch["result_id"]} <= set(classes)
    assert classes[record["result_id"]] == classes[reply["result_id"]] == "host_reported"
    fresh = Engine(tmp_path / "fresh", worker=reference_worker)
    mapping = fresh.import_bundle(bundle)["result_mapping"]
    imported = fresh.read_result(mapping[record["result_id"]])
    assert imported["data_classification"] == "host_reported"
    assert {r["url"]: r["lead_status"] for r in imported["rows"]} == {
        AURORA: "fetched",
        MISSING: "failed",
    }


def test_concurrent_records_of_one_batch_make_one_revision(tmp_path):
    first = Engine(tmp_path / "shared", worker=reference_worker)
    second = Engine(tmp_path / "shared", worker=reference_worker)
    reply = first.add_leads(request_id(1), leads_of(AURORA, BIRCH))
    batch = run_batch(first, reply)
    barrier = threading.Barrier(2)
    replies = []

    def record(engine, n):
        barrier.wait()
        replies.append(
            engine.record_lead_batch(request_id(n), reply["lead_set_id"], batch["result_id"])
        )

    threads = [threading.Thread(target=record, args=(e, n)) for e, n in ((first, 2), (second, 3))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert replies[0] == replies[1]
    assert first.store.lead_set_head(reply["lead_set_id"])["revision"] == 2


def test_over_cap_batch_is_refused_and_records_nothing(tmp_path):
    engine = make(tmp_path)
    reply = engine.add_leads(request_id(1), rows(41))
    with pytest.raises(SourcesQLError) as refusal:
        run_batch(engine, reply)
    assert refusal.value.code == "budget_exhausted"
    assert engine.store.lead_set_head(reply["lead_set_id"])["revision"] == 1


def test_private_batch_makes_the_revision_private(tmp_path):
    engine = Engine(tmp_path / "engine", worker=reference_worker, allow_private=True)
    reply = engine.add_leads(request_id(1), leads_of(AURORA))
    secret = engine.import_table(
        columns=[{"key": "note", "logical_type": "VARCHAR", "nullable": False}],
        rows=[{"note": "private"}],
        data_classification="private_local",
    )
    both = [reply["result_id"], secret["result_id"]]
    engine.profiles["fixture"]["private_disclosure"] = {"search": both, "semantic": both}
    batch = engine.query(
        query="WITH j AS (SELECT l.lead_id, l.url, s.note FROM input.l l CROSS JOIN input.s s) "
        "SELECT lead_id, WEB_FETCH(url) AS page FROM j",
        inputs={
            "l": lead_view(reply),
            "s": {"result_id": secret["result_id"], "view": "original", "amendment_revision": None},
        },
    )
    record = engine.record_lead_batch(request_id(2), reply["lead_set_id"], batch["result_id"])
    assert engine.read_result(record["result_id"])["data_classification"] == "private_derived"
    later = engine.add_leads(request_id(3), leads_of(BIRCH), lead_set_id=reply["lead_set_id"])
    assert engine.read_result(later["result_id"])["data_classification"] == "private_derived"


def test_three_batches_over_300_leads_end_fetched_failed_or_pending(tmp_path):
    engine = make(tmp_path)
    known = [
        {"url": url, "title": "Known", "query": "q", "rank": rank}
        for rank, url in enumerate((AURORA, BIRCH, VENDOR), 1)
    ]
    first = engine.add_leads(request_id(1), known + rows(147, rank_offset=10))
    reply = engine.add_leads(
        request_id(2), rows(150, start=500, rank_offset=200), lead_set_id=first["lead_set_id"]
    )
    assert reply["totals"]["pending"] == 300
    pending = (
        "WITH batch AS (SELECT lead_id, url FROM input.l WHERE lead_status = 'pending' "
        "ORDER BY host_rank LIMIT 40) SELECT lead_id, WEB_FETCH(url) AS page FROM batch"
    )
    for call in range(3):
        batch = engine.query(query=pending, inputs={"l": lead_view(reply)})
        assert len(batch["fetch_outcomes"]) == 40
        record = engine.record_lead_batch(
            request_id(10 + call), reply["lead_set_id"], batch["result_id"]
        )
        reply = {**reply, "result_id": record["result_id"]}
        assert record["totals"]["pending"] == 300 - 40 * (call + 1)
    final = every_lead(engine, record)
    assert record["totals"] == {"leads": 300, "fetched": 3, "failed": 117, "pending": 180}
    assert {r["lead_status"] for r in final} == {"pending", "fetched", "failed"}
    assert all(r["fetch_failure"] for r in final if r["lead_status"] == "failed")
    assert all(r["fetch_failure"] is None for r in final if r["lead_status"] != "failed")
    assert sum(1 for r in final if r["lead_status"] == "pending") == 300 - 120
    fetched = {r["url"] for r in final if r["lead_status"] == "fetched"}
    assert fetched == {AURORA, BIRCH, VENDOR}
    # Fetched pages carry engine citations; leads never do.
    cited = engine.query(
        query=(
            "WITH f AS (SELECT lead_id, url, WEB_FETCH(url) AS page FROM input.l "
            "WHERE lead_status = 'fetched') "
            "SELECT url, SEM_EXTRACT(page[1].content, 'project facts', project := 'project name') "
            "AS fact FROM f"
        ),
        inputs={"l": lead_view(reply)},
    )
    assert cited["evidence"], "fetched text is cited"
    assert all(e["source_version_id"] for e in cited["evidence"])
    assert not engine.read_result(record["result_id"])["evidence"], "the lead set cites nothing"
