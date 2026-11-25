"""The first-live-result recipe, its README links and its shipped MCP config."""

from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
RECIPE = (ROOT / "docs" / "first-live-result.md").read_text()


def test_readme_links_the_first_live_recipe_from_both_entry_points():
    assert (ROOT / "README.md").read_text().count("docs/first-live-result.md") >= 2


def test_recipe_has_at_most_nine_numbered_actions_and_names_the_settings():
    steps = re.findall(r"^\d+\. \*\*", RECIPE, re.MULTILINE)
    assert 1 <= len(steps) <= 9
    assert RECIPE.count("*Your choice.*") >= 5
    for setting in (
        "allow_live",
        "approved_cost_microusd",
        "allowed_source_hosts",
        "max_cost_microusd",
    ):
        assert setting in RECIPE


def test_recipe_states_the_ceiling_and_the_fixture_default():
    assert "not a billing cap" in RECIPE
    assert "Fixture mode remains the default" in RECIPE


def test_recipe_is_labelled_not_live_qualified():
    assert "documented, not live-qualified" in RECIPE


def test_live_mcp_config_has_no_key_entries_and_points_at_the_profiles_file():
    config = json.loads((ROOT / "apps" / "research" / "mcp-config.live.example.json").read_text())
    env = config["mcpServers"]["sourcesql-research"]["env"]
    assert not [name for name in env if name.endswith("_API_KEY")]
    assert env["SOURCESQL_PROFILES_FILE"] == "local/profiles.json"
    assert env["SOURCESQL_ALLOW_PRIVATE"] == "0"


def test_recipe_step_nine_names_fields_a_live_result_really_has():
    assert "Visit source" in RECIPE
    assert "data_classification" in RECIPE
    assert "receipt.mode" not in RECIPE
