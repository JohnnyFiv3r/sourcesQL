"""The shared error-code table is the only list; every consumer is held to it."""

from __future__ import annotations

import ast
from pathlib import Path
import re

from sourcesql import error_codes
from sourcesql.storage import stages

ROOT = Path(__file__).resolve().parents[2]

# Raised with a code held in a variable. Each forwards a code that was already
# filtered through the table or read from a stored failure.
DYNAMIC_SITES = {
    "src/sourcesql/engine.py": "stored or bridged failure codes, filtered by stages._ERROR_CODES",
    "src/sourcesql/storage/motherduck.py": "stored job error code, filtered by HOSTED_CODES",
    "src/sourcesql/sql/admission.py": "refuse() default and callers pass literals checked below",
}


def raised_codes() -> tuple[dict[str, list[str]], list[str]]:
    literal: dict[str, list[str]] = {}
    dynamic: list[str] = []
    for base in ("src/sourcesql", "hosted/flight"):
        for path in sorted((ROOT / base).rglob("*.py")):
            if "tests" in path.parts:
                continue
            relative = path.relative_to(ROOT).as_posix()
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if not isinstance(node, ast.Call):
                    continue
                function = node.func
                name = (
                    function.id
                    if isinstance(function, ast.Name)
                    else function.attr
                    if isinstance(function, ast.Attribute)
                    else None
                )
                candidates = []
                if name in {"SourcesQLError", "AdmissionRefusal"} and node.args:
                    candidates = [node.args[0]]
                elif name == "refuse":
                    candidates = [k.value for k in node.keywords if k.arg == "code"]
                    candidates += node.args[1:2]
                for candidate in candidates:
                    if isinstance(candidate, ast.Constant) and isinstance(candidate.value, str):
                        literal.setdefault(candidate.value, []).append(f"{relative}:{node.lineno}")
                    elif name != "refuse":
                        dynamic.append(relative)
    return literal, dynamic


def test_every_raised_code_is_in_the_table():
    literal, dynamic = raised_codes()
    missing = {code: sites for code, sites in literal.items() if code not in error_codes.CODES}
    assert not missing, f"Add these codes to src/sourcesql/error_codes.json: {missing}"
    assert set(dynamic) <= set(DYNAMIC_SITES), (
        "A new site raises a code held in a variable; list its source in DYNAMIC_SITES: "
        f"{sorted(set(dynamic) - set(DYNAMIC_SITES))}"
    )


def test_python_stage_journal_allowlist_is_the_table():
    assert stages._ERROR_CODES == error_codes.CODES


def test_shared_codes_the_app_could_lose_are_in_the_table():
    for code in ("not_found", "result_unavailable", "idempotency_conflict", "revision_conflict"):
        assert code in error_codes.HOSTED_CODES


def test_table_summaries_pass_the_stored_reason_gate():
    gate = re.compile(r"[A-Za-z0-9 ,.;:()_'-]{1,240}\Z")
    for code in error_codes.CODES:
        assert gate.match(error_codes.summary(code)), code


def test_table_ships_a_refusals_section_for_later_wording():
    assert error_codes.TABLE["refusals"] == {}
