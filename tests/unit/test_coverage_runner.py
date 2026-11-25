import importlib.util
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "coverage_python", ROOT / "scripts" / "coverage_python.py"
)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def collected_files():
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", *runner.DEFAULT_SUITE],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return {line.split("::")[0] for line in result.stdout.splitlines() if "::" in line}


def test_shards_cover_every_file_pytest_collects():
    sharded = {name for bucket in runner.shards(2) for name in bucket}
    assert collected_files() <= sharded, "A file pytest collects is missing from the shards."


def test_shards_include_files_named_with_a_test_suffix(tmp_path, monkeypatch):
    suite = tmp_path / "tests"
    suite.mkdir()
    for name in ("test_prefix.py", "suffix_test.py", "helper.py"):
        (suite / name).write_text("")
    monkeypatch.setattr(runner, "ROOT", tmp_path)
    monkeypatch.setattr(runner, "DEFAULT_SUITE", ["tests"])
    names = {Path(name).name for bucket in runner.shards(2) for name in bucket}
    assert names == {"test_prefix.py", "suffix_test.py"}


def test_junit_option_is_split_out_in_both_spellings():
    assert runner.take_junit_path(["-k", "x", "--junitxml", "a.xml"]) == (["-k", "x"], "a.xml")
    assert runner.take_junit_path(["--junitxml=b.xml", "-x"]) == (["-x"], "b.xml")
    assert runner.take_junit_path(["-x"]) == (["-x"], None)


def test_merged_junit_report_keeps_every_shards_test_cases(tmp_path):
    parts = []
    for index, name in enumerate(("one", "two")):
        part = tmp_path / f"{index}.xml"
        part.write_text(
            '<testsuites><testsuite name="pytest" tests="1" failures="0" errors="0" '
            f'skipped="0" time="1.5"><testcase name="{name}"/></testsuite></testsuites>'
        )
        parts.append(part)
    parts.append(tmp_path / "missing.xml")
    target = tmp_path / "merged.xml"
    runner.merge_junit(parts, str(target))
    suite = ET.parse(target).getroot().find("testsuite")
    assert [case.get("name") for case in suite.iter("testcase")] == ["one", "two"]
    assert suite.get("tests") == "2" and suite.get("time") == "3.000"
