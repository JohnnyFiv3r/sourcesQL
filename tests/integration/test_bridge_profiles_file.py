"""The bridge's start-up with a profiles file that is unset, missing, loaded or malformed."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
REQUEST = json.dumps({"id": "c", "method": "capabilities", "params": {}}) + "\n"


def bridge(tmp_path, profiles_file=None):
    env = {**os.environ, "SOURCESQL_DATA_DIR": str(tmp_path / "data")}
    env.pop("SOURCESQL_PROFILES_FILE", None)
    if profiles_file is not None:
        env["SOURCESQL_PROFILES_FILE"] = str(profiles_file)
    return subprocess.run(
        [sys.executable, "-m", "sourcesql.bridge"],
        input=REQUEST.encode(),
        env=env,
        capture_output=True,
        timeout=60,
    )


def capabilities(completed):
    return json.loads(completed.stdout.decode().splitlines()[0])["result"]


def test_bridge_without_profiles_file_reports_not_set(tmp_path):
    result = capabilities(bridge(tmp_path))
    assert result["profiles_file"] == "not_set"
    assert [p["name"] for p in result["profiles"]] == ["fixture"]


def test_bridge_with_missing_profiles_file_starts_in_fixture_without_the_path(tmp_path):
    completed = bridge(tmp_path, tmp_path / "none.json")
    result = capabilities(completed)
    assert result["profiles_file"] == "missing"
    assert [p["name"] for p in result["profiles"]] == ["fixture"]
    assert str(tmp_path) not in completed.stdout.decode()


def test_bridge_loads_the_shipped_live_template(tmp_path):
    result = capabilities(bridge(tmp_path, ROOT / "examples" / "profiles.live.example.json"))
    assert result["profiles_file"] == "loaded"
    assert [p["name"] for p in result["profiles"]] == ["fixture", "live-search", "live-fetch"]


def test_bridge_with_malformed_profiles_file_still_fails_to_start(tmp_path):
    broken = tmp_path / "broken.json"
    broken.write_text("{")
    completed = bridge(tmp_path, broken)
    assert completed.returncode != 0
    assert b'"result"' not in completed.stdout
