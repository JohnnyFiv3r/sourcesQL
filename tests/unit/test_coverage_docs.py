from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def not_measured_entries():
    text = (ROOT / "docs" / "coverage.md").read_text()
    block = re.search(r"```not-measured\n(.*?)```", text, re.DOTALL)
    assert block, "docs/coverage.md has no not-measured block."
    entries = []
    for line in block.group(1).splitlines():
        path, separator, checked_by = line.partition(" | ")
        assert separator, f"Malformed not-measured line: {line!r}"
        entries.append((path.strip(), checked_by.strip()))
    return entries


def test_not_measured_files_and_their_checks_exist():
    entries = not_measured_entries()
    assert entries, "The not-measured list is empty."
    for path, checked_by in entries:
        assert (ROOT / path).is_file(), f"Not-measured file is missing: {path}"
        for check in re.findall(r"[\w./-]+\.(?:py|ts|tsx|mjs)\b", checked_by):
            assert (ROOT / check).is_file(), f"{path} names a missing check: {check}"


def test_every_unmeasured_area_named_by_the_spec_is_listed():
    listed = {path for path, _ in not_measured_entries()}
    assert {
        "src/sourcesql/execution/linux_sandbox.py",
        "src/sourcesql/execution/linux_syscalls.py",
        "src/sourcesql/bridge.py",
        "src/sourcesql/execution/worker_process.py",
        "hosted/flight/runner.py",
        "apps/research/src/app.tsx",
    } <= listed
