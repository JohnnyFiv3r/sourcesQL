import importlib.util
from pathlib import Path
import subprocess
import sys

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


def test_default_run_is_sharded(monkeypatch):
    monkeypatch.delenv("PYTEST_ADDOPTS", raising=False)
    monkeypatch.setenv("COVERAGE_SHARDS", "2")
    assert runner.shard_count_for([]) == 2


def test_pytest_arguments_keep_the_run_in_one_process(monkeypatch):
    monkeypatch.delenv("PYTEST_ADDOPTS", raising=False)
    monkeypatch.setenv("COVERAGE_SHARDS", "2")
    for extra in (
        ["--junitxml=a/b/out.xml"],
        ["--junitxml"],
        ["-o", "python_files=qa_*.py"],
        ["-k", "x"],
    ):
        assert runner.shard_count_for(extra) == 1


def test_pytest_addopts_keep_the_run_in_one_process(monkeypatch):
    monkeypatch.setenv("COVERAGE_SHARDS", "2")
    monkeypatch.setenv("PYTEST_ADDOPTS", "--junitxml=out.xml")
    assert runner.shard_count_for([]) == 1
