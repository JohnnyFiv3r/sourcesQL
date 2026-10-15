"""Setup routing must not instantiate the research engine or load its profiles."""

import pytest

from sourcesql import cli, onboarding


def test_global_options_before_setup_still_delegate_without_loading_profiles(monkeypatch):
    monkeypatch.setenv("SOURCESQL_PROFILES_FILE", "/nonexistent/profiles.json")
    received = []
    monkeypatch.setattr(
        onboarding, "run_personal_cloud", lambda arguments: received.append(arguments) or 7
    )
    assert (
        cli.main(
            [
                "--store",
                "/unused/store",
                "setup",
                "personal-cloud",
                "plan",
                "--workspace",
                "/unused/cloud",
            ]
        )
        == 7
    )
    assert received == [["plan", "--workspace", "/unused/cloud"]]


def test_version_does_not_require_research_configuration(monkeypatch, capsys):
    monkeypatch.setenv("SOURCESQL_PROFILES_FILE", "/nonexistent/profiles.json")
    with pytest.raises(SystemExit) as outcome:
        cli.main(["--version"])
    assert outcome.value.code == 0
    assert capsys.readouterr().out.strip().startswith("sourcesQL ")
