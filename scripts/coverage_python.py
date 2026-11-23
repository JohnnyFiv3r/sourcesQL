"""Run the Python and Flight suites under coverage and print per-module figures.

Run from the repository root: uv run --frozen python scripts/coverage_python.py
Extra arguments are added to the pytest command line. The exit status is pytest's; a low figure never
fails the run (docs/coverage.md).
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "coverage" / "python" / "coverage.json"
DEFAULT_SUITE = ["tests", "hosted/flight/tests"]
NOT_MEASURED_FOOTER = (
    "These files show 0% or are missing in the table above. That means not measured, not untested."
)


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
    status = subprocess.run(
        [*run, "run", "-m", "pytest", "-q", *DEFAULT_SUITE, *sys.argv[1:]], cwd=ROOT
    ).returncode
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
