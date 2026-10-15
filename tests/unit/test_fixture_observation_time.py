"""Fixture acquisition time is real; fictional publication/version facts stay fixed."""

from datetime import datetime, timezone

from sourcesql.contracts import Budget
from sourcesql.providers.fixture import FixtureProvider


def parsed(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def test_fixture_fetch_records_actual_acquisition_without_changing_source_identity():
    provider = FixtureProvider("t2")
    before = datetime.now(timezone.utc)
    first = provider.fetch(["https://aurora.example/project"], {"mode": "live"}, Budget())[0]
    second = provider.fetch(["https://aurora.example/project"], {"mode": "live"}, Budget())[0]
    after = datetime.now(timezone.utc)

    assert before <= parsed(first["retrieved_at"]) <= after
    assert before <= parsed(second["retrieved_at"]) <= after
    assert first["published_at"] == "2026-09-01T00:00:00Z"
    assert first["provider_acquired_at"] == "2026-10-13T12:00:00Z"
    assert first["source_version_id"] == second["source_version_id"]
    assert first["content_sha256"] == second["content_sha256"]
    assert first["content"] == second["content"]
    assert first["content_basis"] == "synthetic_fixture"
    assert first["fixture_only"] is True


def test_fixture_search_also_observes_now_while_t1_t2_versions_remain_distinct():
    before = datetime.now(timezone.utc)
    old = FixtureProvider("t1").search(["Aurora"], {}, Budget())[0]
    new = FixtureProvider("t2").search(["Aurora"], {}, Budget())[0]
    after = datetime.now(timezone.utc)

    assert before <= parsed(old["retrieved_at"]) <= after
    assert before <= parsed(new["retrieved_at"]) <= after
    assert old["published_at"] == new["published_at"]
    assert old["source_version_id"] != new["source_version_id"]
    assert old["content_sha256"] != new["content_sha256"]
