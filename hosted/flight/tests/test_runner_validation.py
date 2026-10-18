"""Hosted queries bind once in their execution sandbox before trusted setup/effects."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest

from sourcesql.contracts import Column, SourcesQLError, Table
import sourcesql.engine as engine_module
from sourcesql.execution import planner
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers import ProviderRegistry
from sourcesql.providers.fixture import FixtureProvider
from sourcesql.storage.store import Store


def load(name):
    specification = importlib.util.spec_from_file_location(
        "sourcesql_runner_validation_" + name,
        Path(__file__).resolve().parents[1] / (name + ".py"),
    )
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


runner, policy = load("runner"), load("exa_profile")


class JobStore(Store):
    def __init__(self, root, request, operation="query", fingerprint=None):
        super().__init__(root)
        self.request, self.operation, self.fingerprint = request, operation, fingerprint
        self.failures, self.finished, self.explanations = [], [], []

    def claim_job(self, *args, **kwargs):
        return {
            "request": self.request,
            "operation": self.operation,
            "provider_policy_sha256": self.fingerprint,
        }

    def bind_job(self, *args):
        pass

    def finish_job(self, *args):
        self.finished.append(args)

    def finish_preflight(self, job_id, token, explanation):
        self.explanations.append(explanation)

    def fail_job(self, identity, token, code, message, stage="admission"):
        self.failures.append(code)


def tracked_execution(monkeypatch):
    sessions, events = [], []
    validate = planner.validate_plan
    preflight = ProviderRegistry.preflight

    class Session:
        def __enter__(self):
            self.closed = False
            sessions.append(self)
            return self

        def run_sql(self, sql, tables, parameters=None, timeout=30):
            result = evaluate(
                {
                    "sql": sql,
                    "tables": {name: table.to_dict() for name, table in tables.items()},
                    "parameters": parameters or {},
                    "max_rows": 1001,
                }
            )
            if "error" in result:
                raise SourcesQLError("invalid_query", "Synthetic SQL binding failed", "worker")
            return Table(
                [
                    Column(item["key"], item["logical_type"], item["nullable"])
                    for item in result["columns"]
                ],
                result["rows"],
            )

        def __exit__(self, *args):
            self.closed = True

    def validate_once(*args):
        events.append("binding_started")
        result = validate(*args)
        events.append("binding_validated")
        return result

    def capability_check(*args):
        events.append("provider_preflight")
        return preflight(*args)

    monkeypatch.setattr(engine_module, "WorkerSession", Session)
    monkeypatch.setattr(planner, "validate_plan", validate_once)
    monkeypatch.setattr(ProviderRegistry, "preflight", capability_check)
    return sessions, events


def test_hosted_query_owns_one_binding_pass_and_sandbox_without_explain(tmp_path, monkeypatch):
    sessions, events = tracked_execution(monkeypatch)
    search = FixtureProvider.search

    def search_after_validation(*args):
        events.append("provider_effect")
        return search(*args)

    def unexpected_explain(*args, **kwargs):
        raise AssertionError("Ordinary hosted query must not run an independent explain")

    monkeypatch.setattr(FixtureProvider, "search", search_after_validation)
    monkeypatch.setattr(engine_module.Engine, "explain", unexpected_explain)
    store = JobStore(tmp_path / "store", {"query": "SELECT url FROM WEB_SEARCH('campuses')"})
    report = {}
    runner.execute_job(
        store, {"job_id": str(uuid4())}, report, tmp_path, policy, policy.load_configuration({})
    )
    assert report["status"] == "completed" and store.failures == []
    assert len(store.finished) == len(sessions) == 1 and sessions[0].closed
    assert events == [
        "binding_started",
        "binding_validated",
        "provider_preflight",
        "provider_effect",
    ]


def test_binding_failure_precedes_hosted_hydration_and_provider_effects(tmp_path, monkeypatch):
    sessions, events = tracked_execution(monkeypatch)
    environment = {
        "SOURCESQL_ALLOW_LIVE_EXA": "1",
        "SOURCESQL_EXA_POLICY_VERSION": "exa-research.v3",
        "SOURCESQL_EXA_SECRET_NAME": "sourcesql_exa",
        "sourcesql_exa_EXA_API_KEY": "SYNTHETIC-EXA-KEY",
        "SOURCESQL_OPENAI_EMBEDDING_MODEL": "text-embedding-3-small",
        "SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME": "sourcesql_openai",
        "sourcesql_openai_OPENAI_API_KEY": "SYNTHETIC-MODEL-KEY",
    }
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    settings = policy.load_configuration(environment)
    request = {
        "query": "WITH candidate AS (SELECT 'not_a_number' AS content), "
        "scored AS (SELECT content,SEM_SCORE(content,'criterion') AS score FROM candidate) "
        "SELECT CAST(content AS BIGINT) AS count,score FROM scored",
        "profile": "exa",
        "source_mode": "allow_excerpt",
        "budgets": {**settings["descriptor"]["limits"], "max_cost_microusd": 50_000},
    }

    def forbidden(*args, **kwargs):
        raise AssertionError("Invalid SQL cannot hydrate or dispatch")

    monkeypatch.setattr(runner, "hydrate_embedding_tokenizer", forbidden)
    monkeypatch.setattr(ProviderRegistry, "search", forbidden)
    monkeypatch.setattr(ProviderRegistry, "score_many", forbidden)
    store = JobStore(tmp_path / "store", request, fingerprint=settings["provider_policy_sha256"])
    report = {}
    runner.execute_job(store, {"job_id": str(uuid4())}, report, tmp_path, policy, settings)
    assert store.failures == ["invalid_query"] and store.finished == []
    assert report["status"] == "failed" and report["error_code"] == "invalid_query"
    assert events == ["binding_started"]
    assert len(sessions) == 1 and sessions[0].closed


def test_explicit_hosted_explain_still_explains_without_provider_setup(tmp_path, monkeypatch):
    sessions, events = tracked_execution(monkeypatch)

    def forbidden(*args, **kwargs):
        raise AssertionError("Explain cannot execute query or provider setup")

    monkeypatch.setattr(engine_module.Engine, "query", forbidden)
    monkeypatch.setattr(runner, "hydrate_embedding_tokenizer", forbidden)
    store = JobStore(tmp_path / "store", {"query": "SELECT 7 AS value"}, operation="explain")
    report = {}
    runner.execute_job(
        store, {"job_id": str(uuid4())}, report, tmp_path, policy, policy.load_configuration({})
    )
    assert report["status"] == "completed" and report["operation"] == "explain"
    assert report["external_calls"] == 0
    assert len(store.explanations) == len(sessions) == 1 and sessions[0].closed
    assert events == ["binding_started", "binding_validated"]


@pytest.mark.parametrize("field", ["before_dispatch", "on_validated"])
def test_query_cannot_supply_a_validation_override(tmp_path, field):
    with pytest.raises(SourcesQLError, match="Unknown request field"):
        engine_module.Engine(tmp_path).query(query="SELECT 1 AS value", **{field: True})
