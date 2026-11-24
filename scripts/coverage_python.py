"""Run the Python and Flight suites under coverage and print per-module figures.

Run from the repository root: uv run --frozen python scripts/coverage_python.py
Extra arguments are added to the pytest command line. The exit status is pytest's; a low figure never
fails the run (docs/coverage.md).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "coverage" / "python" / "coverage.json"
DEFAULT_SUITE = ["tests", "hosted/flight/tests"]
NOT_MEASURED_FOOTER = (
    "These files show 0% or are missing in the table above. That means not measured, not untested."
)


# Measured seconds of the slowest test files, used only to balance the shards. A file missing from
# the table counts as one second, and a stale figure only skews the balance, never the result.
SLOW_FILE_SECONDS = {
    "tests/security/test_stage_review_lifecycle.py": 81,
    "tests/integration/test_engine_plans.py": 33,
    "tests/security/test_stage_journal.py": 33,
    "tests/integration/test_lead_sets.py": 31,
    "tests/security/test_materialization_lineage.py": 30,
    "tests/security/test_motherduck_store.py": 16,
    "tests/security/test_request_lookup_index.py": 15,
    "hosted/flight/tests/test_search_profiles.py": 11,
    "tests/integration/test_scoring_cloud_transactions.py": 10,
    "tests/security/test_linux_worker_isolation.py": 10,
    "tests/integration/test_embedding_checkpoints.py": 9,
    "tests/unit/test_admission_nesting.py": 8,
    "tests/integration/test_result_inspection.py": 7,
}


def shard_count() -> int:
    """How many pytest processes share the run. COVERAGE_SHARDS=1 runs the suite in one process."""
    requested = os.environ.get("COVERAGE_SHARDS")
    if requested:
        return max(1, int(requested))
    return max(1, min(os.cpu_count() or 1, 2))


def shards(count: int) -> list[list[str]]:
    """Test files dealt to the shards, slowest first, each to the lightest shard so far."""
    files = sorted(
        str(path.relative_to(ROOT))
        for suite in DEFAULT_SUITE
        for path in (ROOT / suite).rglob("test_*.py")
    )
    weight = {name: SLOW_FILE_SECONDS.get(name, 1) for name in files}
    buckets: list[list[str]] = [[] for _ in range(count)]
    loads = [0] * count
    for name in sorted(files, key=lambda name: (-weight[name], name)):
        lightest = loads.index(min(loads))
        buckets[lightest].append(name)
        loads[lightest] += weight[name]
    return [bucket for bucket in buckets if bucket]


def run_suite(run: list[str], extra: list[str]) -> int:
    """Run the suite under coverage, in parallel shards, and leave one combined data file.

    Tracing slows a single process a lot, and the tests do not share state, so the files are
    split across processes whose coverage data is combined afterwards. One shard is the plain
    single-process run.
    """
    count = shard_count()
    subprocess.run([*run, "erase"], cwd=ROOT, check=True)
    if count == 1:
        return subprocess.run(
            [*run, "run", "-m", "pytest", "-q", *DEFAULT_SUITE, *extra], cwd=ROOT
        ).returncode
    with tempfile.TemporaryDirectory() as scratch:
        running = []
        for index, files in enumerate(shards(count)):
            log = open(Path(scratch) / f"shard{index}.log", "w+")
            command = [*run, "run", "-p", "-m", "pytest", "-q", *files, *extra]
            running.append((subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log), log))
        codes = []
        for index, (process, log) in enumerate(running):
            codes.append(process.wait())
            log.seek(0)
            print(f"--- shard {index + 1} of {len(running)} (exit {codes[-1]}) ---")
            print(log.read().rstrip())
            log.close()
    subprocess.run([*run, "combine", "-q"], cwd=ROOT, check=True)
    # Exit status 5 means a shard collected nothing, which `-k` can cause; it is not a failure.
    failed = [code for code in codes if code not in (0, 5)]
    return failed[0] if failed else (5 if all(code == 5 for code in codes) else 0)


def not_measured(doc: Path, prefix: str) -> list[tuple[str, str]]:
    """Entries of the `not-measured` block in docs/coverage.md whose path starts with prefix."""
    block = re.search(r"```not-measured\n(.*?)```", doc.read_text(), re.DOTALL)
    if block is None:
        raise SystemExit(f"{doc} has no not-measured block.")
    entries = []
    for line in block.group(1).splitlines():
        path, separator, checked_by = line.partition(" | ")
        if separator:
            entries.append((path.strip(), checked_by.strip()))
    return [entry for entry in entries if entry[0].startswith(prefix)]


def percent(covered: int, total: int) -> str:
    return f"{round(100 * covered / total)}%" if total else "n/a"


def table(report: dict) -> str:
    lines = [
        "sourcesQL Python coverage (lines, branches)",
        f"{'Module':<58}{'Lines':>7}{'Branches':>10}",
    ]
    for path, data in sorted(report["files"].items()):
        summary = data["summary"]
        lines.append(
            f"{path:<58}"
            f"{percent(summary['covered_lines'], summary['num_statements']):>7}"
            f"{percent(summary['covered_branches'], summary['num_branches']):>10}"
        )
    totals = report["totals"]
    lines.append(
        f"{'TOTAL':<58}"
        f"{percent(totals['covered_lines'], totals['num_statements']):>7}"
        f"{percent(totals['covered_branches'], totals['num_branches']):>10}"
    )
    return "\n".join(lines)


def main() -> int:
    try:
        import coverage  # noqa: F401
    except ImportError:
        print(
            "Coverage tool is not installed. Run uv sync --frozen (Python) or npm ci (app).",
            file=sys.stderr,
        )
        return 1
    run = [sys.executable, "-m", "coverage"]
    # Extra arguments (for example -x or -k) narrow or tune the default suite.
    status = run_suite(run, sys.argv[1:])
    # The report is wanted even when a test failed, so the figures cover what ran.
    for command in ("html", "json"):
        subprocess.run([*run, command, "-q"], cwd=ROOT, check=True)
    print()
    print(table(json.loads(REPORT.read_text())))
    print()
    print("Not measured (runs in Python child processes or is never loaded by a test):")
    for path, checked_by in not_measured(ROOT / "docs" / "coverage.md", ("src/", "hosted/")):
        print(f"  {path}  checked by: {checked_by}")
    print(NOT_MEASURED_FOOTER)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
