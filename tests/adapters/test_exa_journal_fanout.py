"""Durable Exa fanout over mock HTTP; no credentials leave the test process."""

import json
import threading
import time
from uuid import uuid4

import httpx
import pytest

from sourcesql.contracts import Budget, Column, SourcesQLError, Table, digest
from sourcesql.engine import Engine
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.search import ExaProvider
from sourcesql.storage.store import Store


class Journal:
    def __init__(self, store, budget):
        self.store, self.budget = store, budget
        self.owner = threading.get_ident()
        self.operations = []

    def record(self, operation):
        assert threading.get_ident() == self.owner
        self.operations.append(operation)

    def begin(self, operator, arguments, options):
        self.record("begin")
        key = digest([operator, arguments, options])
        state, created = self.store.stage_begin("journal", key)
        if created:
            return key, None, False
        if state["status"] == "completed":
            self.budget.reserve("checkpoint_hits", limit="unbounded_counter")
            return key, state["value"]["data"], True
        raise SourcesQLError(
            "execution_outcome_unknown", "Saved effect cannot be replayed", "dispatch"
        )

    def finish(self, key, operator, data):
        self.record("finish")
        self.store.stage_finish("journal", key, {"operator": operator, "data": data})

    def fail(self, key, error):
        self.record("fail")
        self.store.stage_fail(
            "journal", key, error.code, bool(getattr(error, "remote_outcome_unknown", False))
        )

    def callbacks(self):
        return {"begin": self.begin, "finish": self.finish, "fail": self.fail}


def provider_with_journal(tmp_path, handler, budget, options=None):
    provider = ExaProvider(
        "synthetic", httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)
    )
    journal = Journal(Store(tmp_path), budget)
    provider.stage_journal = journal.callbacks()
    provider.stage_options = {
        "per_query_limit": 2,
        "source_mode": "allow_excerpt",
        **(options or {}),
    }
    return provider, journal


def response(query, count):
    return httpx.Response(
        200,
        json={
            "requestId": f"request-{query}",
            "results": [
                {
                    "url": f"https://fixture.example/{query}/{index}",
                    "highlights": [f"Source {query} {index}."],
                }
                for index in range(count)
            ],
        },
    )


def test_journaled_requests_remain_parallel_and_every_observer_stays_on_owner_thread(
    tmp_path, monkeypatch
):
    owner, reservations = threading.get_ident(), []
    budget = Budget(
        {"max_candidates": 8, "max_concurrency": 2},
        on_reserve=lambda counter, amount: reservations.append((counter, threading.get_ident())),
    )
    barrier, lock = threading.Barrier(2), threading.Lock()
    active, peak = 0, 0
    bodies = []

    def respond(request):
        nonlocal active, peak
        body = json.loads(request.content)
        with lock:
            active += 1
            peak = max(active, peak)
            bodies.append(body)
        try:
            barrier.wait(timeout=2)
            return response(body["query"], body.get("numResults", 10))
        finally:
            with lock:
                active -= 1

    provider, journal = provider_with_journal(tmp_path, respond, budget)
    parse = provider._rows
    monkeypatch.setattr(
        provider,
        "_rows",
        lambda body: (
            (threading.get_ident() == owner or pytest.fail("response parsing left owner thread"))
            and parse(body)
        ),
    )
    rows = provider.search(["one", "two", "three", "four"], {"per_query_limit": 2}, budget)
    assert peak == 2 and active == 0
    assert len(rows) == budget.counts["candidates"] == 8
    assert budget.counts["search_requests"] == budget.counts["search_queries"] == 4
    assert all(thread_id == owner for _, thread_id in reservations)
    assert [row["hits"][0]["query_index"] for row in rows] == [0, 0, 1, 1, 2, 2, 3, 3]
    assert len(journal.operations) == 8
    assert journal.store.stage_summaries("journal")["total"] == 4


def test_pending_candidate_slots_prevent_concurrent_oversubscription_and_clip_overreturns(tmp_path):
    budget = Budget({"max_candidates": 5, "max_concurrency": 3})
    barrier, bodies, lock = threading.Barrier(3), [], threading.Lock()

    def respond(request):
        body = json.loads(request.content)
        with lock:
            bodies.append(body)
        if body["query"] != "four":
            barrier.wait(timeout=2)
        return response(body["query"], 20)

    provider, _ = provider_with_journal(tmp_path, respond, budget, {"per_query_limit": 3})
    rows = provider.search(["one", "two", "three", "four"], {"per_query_limit": 3}, budget)
    assert len(rows) == budget.counts["candidates"] == 5
    counts = {body["query"]: body["numResults"] for body in bodies}
    assert counts == {"one": 1, "two": 1, "three": 1, "four": 2}
    coverage = provider.search_coverage[0]
    assert coverage["requested_per_query_limit"] == 3
    assert [query["effective_limit"] for query in coverage["queries"]] == [1, 1, 1, 2]
    assert [query["retained_hits"] for query in coverage["queries"]] == [1, 1, 1, 2]
    assert all(query["returned_hits"] == 20 for query in coverage["queries"])


def test_unused_pending_slots_are_available_to_later_queries(tmp_path):
    budget, bodies = Budget({"max_candidates": 6, "max_concurrency": 2}), []
    barrier = threading.Barrier(2)

    def respond(request):
        body = json.loads(request.content)
        bodies.append(body)
        if body["query"] in {"one", "two"}:
            barrier.wait(timeout=2)
        if body["query"] == "two":
            time.sleep(0.04)
        return response(body["query"], 0 if body["query"] == "one" else body["numResults"])

    provider, _ = provider_with_journal(tmp_path, respond, budget, {"per_query_limit": 4})
    rows = provider.search(["one", "two", "three"], {"per_query_limit": 4}, budget)
    assert {body["query"]: body["numResults"] for body in bodies} == {
        "one": 2,
        "two": 2,
        "three": 4,
    }
    assert len(rows) == budget.counts["candidates"] == 6


@pytest.mark.parametrize("unknown", [False, True])
def test_failed_sibling_stops_new_work_but_successful_started_sibling_is_durable(tmp_path, unknown):
    budget, calls = Budget({"max_candidates": 6, "max_concurrency": 2}), []
    barrier = threading.Barrier(2)

    def respond(request):
        query = json.loads(request.content)["query"]
        calls.append(query)
        barrier.wait(timeout=2)
        if query == "bad":
            if unknown:
                raise httpx.ReadTimeout("synthetic timeout")
            return httpx.Response(429)
        time.sleep(0.03)
        return response(query, 2)

    provider, journal = provider_with_journal(tmp_path, respond, budget)
    with pytest.raises(SourcesQLError):
        provider.search(["bad", "good", "never"], {"per_query_limit": 2}, budget)
    assert sorted(calls) == ["bad", "good"]
    states = journal.store.stage_summaries("journal")["stages"]
    assert {state["status"] for state in states} == {
        "completed",
        "outcome_unknown" if unknown else "rejected",
    }
    completed = next(state for state in states if state["status"] == "completed")
    assert (
        journal.store.stage_read("journal", completed["stage_key"])["value"]["data"][0]["hits"][0][
            "query"
        ]
        == "good"
    )
    assert budget.counts["candidates"] == 2


def test_cached_queries_reuse_requested_options_at_full_candidate_capacity(tmp_path):
    calls = []
    budget = Budget({"max_candidates": 1})
    provider, journal = provider_with_journal(
        tmp_path,
        lambda request: calls.append(request) or response("one", 1),
        budget,
        {"per_query_limit": 3},
    )
    first = provider.search(["one"], {"per_query_limit": 3}, budget)
    assert budget.counts["candidates"] == 1
    replay_budget = Budget({"max_candidates": 1})
    replay_budget.counts = dict(budget.counts)
    replay, _ = provider_with_journal(
        tmp_path,
        lambda request: pytest.fail("cached query dispatched"),
        replay_budget,
        {"per_query_limit": 3},
    )
    assert replay.search(["one"], {"per_query_limit": 3}, replay_budget) == first
    assert replay_budget.counts["candidates"] == replay_budget.counts["search_requests"] == 1
    assert replay_budget.counts["checkpoint_hits"] == 1
    assert len(calls) == 1 and journal.store.stage_summaries("journal")["total"] == 1


def test_identical_pending_query_is_coalesced_without_retry_or_more_candidate_charge(tmp_path):
    calls, budget = [], Budget({"max_candidates": 1, "max_concurrency": 2})
    provider, _ = provider_with_journal(
        tmp_path,
        lambda request: calls.append(request) or response("one", 1),
        budget,
        {"per_query_limit": 1},
    )
    rows = provider.search(["one", "one"], {"per_query_limit": 1}, budget)
    assert len(calls) == budget.counts["candidates"] == budget.counts["search_requests"] == 1
    assert len(rows) == 2 and rows[0] is not rows[1]
    assert provider.search_coverage[0]["queries"][1]["checkpoint_reused"] is True


def test_cancelled_reservation_prevents_http_and_leaves_no_replay_permission(tmp_path):
    budget = Budget({"max_concurrency": 1})

    def cancel(counter, amount):
        if counter == "search_requests":
            budget.cancelled = True

    budget.on_reserve = cancel
    provider, journal = provider_with_journal(
        tmp_path, lambda request: pytest.fail("cancelled query disclosed"), budget
    )
    with pytest.raises(SourcesQLError) as error:
        provider.search(["one", "never"], {"per_query_limit": 2}, budget)
    assert error.value.code == "cancelled"
    assert provider.events[0]["status"] == "not_dispatched"
    assert journal.store.stage_summaries("journal")["stages"][0]["status"] == "rejected"


def test_actual_engine_journal_preserves_parallelism_and_reuses_all_searches_on_resume(
    tmp_path, monkeypatch
):
    barrier, calls = threading.Barrier(2), []

    def respond(request):
        body = json.loads(request.content)
        calls.append(body)
        barrier.wait(timeout=2)
        return response(body["query"], body["numResults"])

    def worker(sql, tables, parameters=None, timeout=30):
        result = evaluate(
            {
                "sql": sql,
                "tables": {name: table.to_dict() for name, table in tables.items()},
                "parameters": parameters or {},
                "max_rows": 1001,
            }
        )
        return Table(
            [
                Column(column["key"], column["logical_type"], column["nullable"])
                for column in result["columns"]
            ],
            result["rows"],
        )

    profiles = {
        "bounded": {
            "mode": "live",
            "provider": "exa",
            "api_key": "synthetic",
            "http_client": httpx.Client(transport=httpx.MockTransport(respond), trust_env=False),
            "allow_live": True,
            "approved_cost_microusd": 10000,
            "metering_policy": "estimated",
        }
    }
    engine = Engine(tmp_path, profiles=profiles, worker=worker)

    def stop(*args, **kwargs):
        raise SourcesQLError("budget_exhausted", "Synthetic late publication stop", "publish")

    monkeypatch.setattr(engine.store, "commit", stop)
    with pytest.raises(SourcesQLError):
        engine.query(
            query="SELECT url FROM WEB_SEARCH('one','two',per_query_limit := 2)",
            profile="bounded",
            source_mode="allow_excerpt",
            budgets={"max_candidates": 4, "max_concurrency": 2, "max_cost_microusd": 10000},
        )
    with engine.store.db() as db:
        failed = json.loads(db.execute("SELECT receipt FROM runs").fetchone()[0])
    assert failed["counts"]["candidates"] == 4
    assert failed["settlement_status"] == "settled"
    assert {stage["status"] for stage in failed["checkpoints"]["stages"]} == {"completed"}
    result = Engine(tmp_path, profiles=profiles, worker=worker).resume_run(
        failed["run_id"], str(uuid4())
    )
    assert result["row_count"] == 4 and len(calls) == 2
    assert result["receipt"]["counts"]["candidates"] == 4
    assert result["receipt"]["counts"]["checkpoint_hits"] == 2
