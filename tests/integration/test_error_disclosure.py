"""Errors reach an agent as fixed text: no provider body, driver message or path."""

from __future__ import annotations

import socket
import sqlite3

import httpx
import pytest

from sourcesql.contracts import Budget, SourcesQLError
from sourcesql.engine import Engine
from sourcesql.providers import ProviderRegistry

from test_engine_lineage import reference_worker

LEAKS = ("SECRET-BODY", "/home/u", "KEY=abc", "disk I/O")


def error_surface(error: SourcesQLError) -> str:
    return " ".join([error.code, error.safe_message, error.stage])


def resolve(host, port, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def test_missing_and_revoked_results_raise_the_same_code_and_text(tmp_path):
    engine = Engine(tmp_path / "engine", worker=reference_worker)
    saved = engine.query(query="SELECT 7 AS n")
    engine.store.revoke(saved["result_id"])
    seen = []
    for result_id in (saved["result_id"], "wq_does_not_exist"):
        with pytest.raises(SourcesQLError) as error:
            engine.read_result(result_id)
        seen.append((error.value.code, error.value.safe_message, error.value.stage))
    assert seen[0] == seen[1]
    assert seen[0][:2] == ("unauthorized", "Result or dependency unavailable")


def test_provider_error_body_never_reaches_the_raised_error():
    def reply(request):
        return httpx.Response(500, text="SECRET-BODY /home/u/x KEY=abc")

    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:
        registry = ProviderRegistry(
            {
                "mode": "live",
                "provider": "brave",
                "api_key": "SAFE-SYNTHETIC-KEY",
                "allow_live": True,
                "approved_cost_microusd": 50_000,
                "metering_policy": "estimated",
                "allow_public_source_hosts": True,
                "allowed_source_hosts": [],
                "fetch_client": client,
                "resolver": resolve,
            }
        )
        budget = Budget({"max_cost_microusd": 50_000, "max_fetches": 2})
        registry.preflight({"WEB_FETCH"}, budget)
        try:
            rows = registry.fetch(["https://source.example/start"], {}, budget)
            surface = repr(rows)
        except SourcesQLError as error:
            surface = error_surface(error)
    assert not any(leak in surface for leak in LEAKS), surface


def test_storage_failure_is_reported_with_the_fixed_execution_failed_text(tmp_path, monkeypatch):
    engine = Engine(tmp_path / "engine", worker=reference_worker)

    def fail(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error at /home/u/db")

    monkeypatch.setattr(engine.store, "commit", fail)
    with pytest.raises(SourcesQLError) as error:
        engine.query(query="SELECT 7 AS n")
    assert error.value.code == "execution_failed"
    assert error.value.safe_message == "Execution failed"
    assert not any(leak in error_surface(error.value) for leak in LEAKS)
