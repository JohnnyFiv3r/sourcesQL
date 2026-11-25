"""The shipped live profile template: off as shipped, fetch-only without a key, clear refusals."""

from __future__ import annotations

import copy
import json
import pathlib
import socket

import httpx
import pytest

from sourcesql.contracts import Budget, Column, SourcesQLError, Table
from sourcesql.engine import Engine
from sourcesql.providers import FixtureProvider, ProviderRegistry, SafeFetcher
from sourcesql.execution.worker_process import evaluate
from sourcesql.providers.fixture import DOCUMENTS
from urllib.parse import urlsplit

AURORA = "https://aurora.example/project"


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


def urls(*values):
    return {f"u{i}": value for i, value in enumerate(values, 1)}


def serve_fixture_text(requests):
    texts = {
        urlsplit(d["url"]).hostname: d["text"] for d in DOCUMENTS if d["version"] in {"t1", "both"}
    }

    def reply(request):
        requests.append(request.headers["host"])
        return httpx.Response(
            200, headers={"content-type": "text/plain"}, text=texts[request.headers["host"]]
        )

    return reply


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEMPLATE = json.loads((ROOT / "examples" / "profiles.live.example.json").read_text())
FETCH = "SELECT url AS source_url, fetch_status, source_version_id FROM WEB_FETCH($u1)"
BUDGET = {"max_cost_microusd": 1}


def enabled(name, **changes):
    profile = copy.deepcopy(TEMPLATE[name])
    profile.update(
        {
            "allow_live": True,
            "approved_cost_microusd": 1000,
            "allowed_source_hosts": ["aurora.example"],
        }
    )
    profile.update(changes)
    return profile


def profile_engine(tmp_path, monkeypatch, name, profile, reply):
    """An engine on a template profile, with the network replaced by a recording transport."""

    def resolve(host, port, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    original = ProviderRegistry.__init__

    def configured(self, profile=None):
        original(self, profile)
        self.profile["resolver"] = resolve
        self.fetch_provider = SafeFetcher(
            client=httpx.Client(transport=httpx.MockTransport(reply), trust_env=False),
            resolver=resolve,
        )
        self.semantic_provider = FixtureProvider("t1")

    monkeypatch.setattr(ProviderRegistry, "__init__", configured)
    return Engine(tmp_path / "live", profiles={name: profile}, worker=reference_worker)


def template_engine(tmp_path, monkeypatch, name, reply, **changes):
    return profile_engine(tmp_path, monkeypatch, name, enabled(name, **changes), reply)


def test_shipped_live_template_cannot_go_live_unedited(tmp_path, monkeypatch):
    live = [name for name, profile in TEMPLATE.items() if profile["mode"] == "live"]
    assert live == ["live-search", "live-fetch"]
    for name in live:
        profile = TEMPLATE[name]
        assert profile["allow_live"] is False
        assert profile["approved_cost_microusd"] == 0
        assert profile["allowed_source_hosts"] == []
        assert "api_key" not in profile
    monkeypatch.setattr(ProviderRegistry, "_authorize", ProviderRegistry._authorize, raising=True)
    engine = Engine(tmp_path / "e", profiles=TEMPLATE, worker=reference_worker)
    with pytest.raises(SourcesQLError) as refused:
        engine.query(query=FETCH, parameters=urls(AURORA), profile="live-fetch", budgets=BUDGET)
    assert refused.value.code == "unauthorized"
    assert refused.value.safe_message.startswith(
        "Live dispatch requires a trusted finite spending grant"
    )


def test_fetch_only_template_fetches_with_no_search_key(tmp_path, monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    seen = []
    engine = template_engine(tmp_path, monkeypatch, "live-fetch", serve_fixture_text(seen))
    result = engine.query(
        query=FETCH, parameters=urls(AURORA), profile="live-fetch", budgets=BUDGET
    )
    assert seen == ["aurora.example"]
    assert [r["fetch_status"] for r in result["rows"]] == ["ok"]
    assert result["rows"][0]["source_version_id"]
    assert len(result["source_versions"]) == 1


def test_fetch_only_template_rows_match_the_host_route_shape(tmp_path, monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    monkeypatch.delenv("BRAVE_API_KEY", raising=False)
    seen = []
    template = template_engine(tmp_path, monkeypatch, "live-fetch", serve_fixture_text(seen))
    shipped = template.query(
        query="SELECT * FROM WEB_FETCH($u1)",
        parameters=urls(AURORA),
        profile="live-fetch",
        budgets=BUDGET,
    )
    brave = {
        "mode": "live",
        "provider": "brave",
        "allow_live": True,
        "approved_cost_microusd": 1000,
        "metering_policy": "estimated",
        "allow_public_source_hosts": True,
    }
    host_route = profile_engine(
        tmp_path / "host", monkeypatch, "hostfetch", brave, serve_fixture_text(seen)
    ).query(
        query="SELECT * FROM WEB_FETCH($u1)",
        parameters=urls(AURORA),
        profile="hostfetch",
        budgets=BUDGET,
    )
    assert [(c["key"], c["logical_type"]) for c in shipped["columns"]] == [
        (c["key"], c["logical_type"]) for c in host_route["columns"]
    ]


def test_template_without_per_query_budget_names_the_budget(tmp_path, monkeypatch):
    engine = template_engine(tmp_path, monkeypatch, "live-fetch", serve_fixture_text([]))
    with pytest.raises(SourcesQLError) as refused:
        engine.query(query=FETCH, parameters=urls(AURORA), profile="live-fetch")
    assert refused.value.code == "unauthorized"
    assert "budgets.max_cost_microusd" in refused.value.safe_message


def test_unconfigured_engine_lists_fixture_for_live_search(tmp_path):
    with pytest.raises(SourcesQLError) as refused:
        Engine(tmp_path / "e", worker=reference_worker).query(
            query="SELECT 1 AS n", profile="live-search"
        )
    assert refused.value.code == "unsupported_capability"
    assert "Available profiles: fixture." in refused.value.safe_message


@pytest.mark.parametrize("value", [None, ""])
def test_search_without_key_names_the_variable_not_the_value(tmp_path, monkeypatch, value):
    seen = []
    engine = template_engine(tmp_path, monkeypatch, "live-search", serve_fixture_text(seen))
    if value is None:
        monkeypatch.delenv("EXA_API_KEY", raising=False)
    else:
        monkeypatch.setenv("EXA_API_KEY", value)
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT url FROM WEB_SEARCH($q)",
            parameters={"q": "aurora"},
            profile="live-search",
            budgets=BUDGET,
        )
    assert refused.value.code == "provider_unavailable"
    assert refused.value.safe_message == (
        "Search credentials are not configured. Set the environment variable EXA_API_KEY "
        "for this profile. Or use WEB_FETCH with URLs you already have."
    )
    assert seen == []
    result = engine.query(
        query=FETCH, parameters=urls(AURORA), profile="live-search", budgets=BUDGET
    )
    assert [r["fetch_status"] for r in result["rows"]] == ["ok"]


@pytest.mark.parametrize("name", ["X" * 70, "BAD$NAME"])
def test_search_key_name_outside_the_gate_is_omitted(tmp_path, monkeypatch, name):
    engine = template_engine(
        tmp_path, monkeypatch, "live-search", serve_fixture_text([]), api_key_env=name
    )
    monkeypatch.delenv(name, raising=False)
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT url FROM WEB_SEARCH($q)",
            parameters={"q": "aurora"},
            profile="live-search",
            budgets=BUDGET,
        )
    assert "(name omitted)" in refused.value.safe_message
    assert name not in refused.value.safe_message


def test_fetch_only_profile_search_refusal_keeps_host_route_text(tmp_path, monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    engine = template_engine(tmp_path, monkeypatch, "live-fetch", serve_fixture_text([]))
    with pytest.raises(SourcesQLError) as refused:
        engine.query(
            query="SELECT url FROM WEB_SEARCH($q)",
            parameters={"q": "aurora"},
            profile="live-fetch",
            budgets=BUDGET,
        )
    assert refused.value.safe_message.startswith("No search provider is configured")


def test_host_refusal_says_where_to_add_hosts(tmp_path, monkeypatch):
    expected = (
        "Live fetch requires permitted source hosts. "
        "Add the sites to allowed_source_hosts in the profile."
    )
    engine = template_engine(
        tmp_path, monkeypatch, "live-fetch", serve_fixture_text([]), allowed_source_hosts=[]
    )
    with pytest.raises(SourcesQLError) as refused:
        engine.query(query=FETCH, parameters=urls(AURORA), profile="live-fetch", budgets=BUDGET)
    assert refused.value.safe_message == expected
    registry = ProviderRegistry(enabled("live-fetch", allowed_source_hosts=[]))
    with pytest.raises(SourcesQLError) as fetched:
        registry.fetch([AURORA], {}, Budget(BUDGET))
    assert fetched.value.safe_message == expected


def test_capabilities_show_live_permission_and_approved_amount(tmp_path):
    shipped = {
        p["name"]: p for p in Engine(tmp_path / "a", profiles=TEMPLATE).capabilities()["profiles"]
    }
    assert (
        shipped["live-search"]["allow_live"],
        shipped["live-search"]["approved_cost_microusd"],
    ) == (False, 0)
    assert (shipped["fixture"]["allow_live"], shipped["fixture"]["approved_cost_microusd"]) == (
        False,
        0,
    )
    profiles = {"live-search": enabled("live-search")}
    edited = Engine(tmp_path / "b", profiles=profiles).capabilities()["profiles"]
    live = next(p for p in edited if p["name"] == "live-search")
    assert (live["allow_live"], live["approved_cost_microusd"]) == (True, 1000)
    assert "EXA_API_KEY" not in json.dumps(edited)
