"""The shared error-code table is the only list; every consumer is held to it."""

from __future__ import annotations

import ast
from pathlib import Path
import re

from sourcesql import error_codes
from sourcesql.storage import stages

ROOT = Path(__file__).resolve().parents[2]

# Each call site that passes a code held in a variable or expression, keyed by
# file, enclosing function and the code expression. A new site must be listed
# here with where its code was already checked or read from a stored failure.
DYNAMIC_SITES = {
    "src/sourcesql/engine.py::stage_begin::'execution_outcome_unknown' if state['status'] in {'intent', 'outcome_unknown'} else 'storage_unavailable' if state['status'] == 'completed_unretained' else state['error_code'] or 'execution_failed'": "stored stage state, error_code filtered by stages._ERROR_CODES",
    "src/sourcesql/engine.py::begin_score_batch::'execution_outcome_unknown' if state['status'] in {'intent', 'outcome_unknown'} else 'storage_conflict'": "stage journal state, both literals checked",
    "src/sourcesql/engine.py::dispatch_score_batch::'execution_outcome_unknown' if retained['status'] in {'intent', 'outcome_unknown'} else retained['error_code'] or 'execution_failed'": "stored stage state, error_code filtered by stages._ERROR_CODES",
    "src/sourcesql/engine.py::fail_score_batch::failure.get('code', 'execution_failed')": "stored failure code, filtered by stages._ERROR_CODES",
    "src/sourcesql/engine.py::dispatch::code": "stored failure code, filtered by stages._ERROR_CODES",
    "src/sourcesql/engine.py::dispatch::failure['code']": "stored failure code, filtered by stages._ERROR_CODES",
    "src/sourcesql/engine.py::dispatch::validation['code']": "stored failure code, filtered by stages._ERROR_CODES",
    "src/sourcesql/sql/admission.py::refuse::code": "refuse() forwards its caller's code; callers are scanned as literal sites",
    "src/sourcesql/storage/motherduck.py::db::code": "stored job error code, filtered by HOSTED_CODES",
    "hosted/flight/runner.py::execute_job::error.code": "fail_job forwards the code of a SourcesQLError, checked where it is raised",
}


def leaves(expression: ast.AST) -> list[str]:
    """The string literals an expression can evaluate to, not those it only compares."""
    if isinstance(expression, ast.Constant):
        return [expression.value] if isinstance(expression.value, str) else []
    if isinstance(expression, ast.IfExp):
        return leaves(expression.body) + leaves(expression.orelse)
    if isinstance(expression, ast.BoolOp):
        return [value for operand in expression.values for value in leaves(operand)]
    if isinstance(expression, ast.Call) and getattr(expression.func, "attr", "") == "get":
        return leaves(expression.args[1]) if len(expression.args) > 1 else []
    return []


def own_nodes(scope: ast.AST):
    """Nodes of one function body, not those of functions or classes nested in it."""
    pending = list(ast.iter_child_nodes(scope))
    while pending:
        node = pending.pop()
        yield node
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | ast.ClassDef):
            pending.extend(ast.iter_child_nodes(node))


def flowing_literals(candidate: ast.AST, scope: ast.AST) -> list[str]:
    """Literals a variable code can hold: its own branches, its assignments and its default."""
    names = {node.id for node in ast.walk(candidate) if isinstance(node, ast.Name)}
    found = leaves(candidate)
    for node in own_nodes(scope):
        if isinstance(node, ast.Assign | ast.AnnAssign | ast.AugAssign):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if node.value and any(isinstance(t, ast.Name) and t.id in names for t in targets):
                found += leaves(node.value)
        elif isinstance(node, ast.arguments):
            positional = node.posonlyargs + node.args
            pairs = list(zip(positional[len(positional) - len(node.defaults) :], node.defaults))
            pairs += [(a, d) for a, d in zip(node.kwonlyargs, node.kw_defaults) if d is not None]
            for argument, default in pairs:
                if argument.arg in names:
                    found += leaves(default)
    return found


def scan(source: str, relative: str, literal: dict[str, list[str]], dynamic: list[str]) -> None:
    tree = ast.parse(source)
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    for node in ast.walk(tree):
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
        keyword = [k.value for k in node.keywords if k.arg == "code"]
        if name in {"SourcesQLError", "AdmissionRefusal"}:
            candidates = node.args[:1] + keyword
        elif name == "refuse":
            candidates = node.args[1:2] + keyword
        elif name == "fail_job":
            candidates = node.args[2:3] + keyword
        enclosing: ast.AST = node
        while enclosing in parents and not isinstance(
            enclosing, ast.FunctionDef | ast.AsyncFunctionDef
        ):
            enclosing = parents[enclosing]
        scope = getattr(enclosing, "name", "<module>")
        for candidate in candidates:
            if isinstance(candidate, ast.Constant) and isinstance(candidate.value, str):
                literal.setdefault(candidate.value, []).append(f"{relative}:{node.lineno}")
            else:
                dynamic.append(f"{relative}::{scope}::{ast.unparse(candidate)}")
                for value in flowing_literals(candidate, enclosing):
                    literal.setdefault(value, []).append(f"{relative}:{node.lineno}")


def raised_codes() -> tuple[dict[str, list[str]], list[str]]:
    literal: dict[str, list[str]] = {}
    dynamic: list[str] = []
    for base in ("src/sourcesql", "hosted/flight"):
        for path in sorted((ROOT / base).rglob("*.py")):
            if "tests" in path.parts:
                continue
            scan(
                path.read_text(encoding="utf-8"),
                path.relative_to(ROOT).as_posix(),
                literal,
                dynamic,
            )
    return literal, dynamic


def test_scan_reads_positional_and_keyword_codes():
    literal: dict[str, list[str]] = {}
    dynamic: list[str] = []
    scan(
        "raise SourcesQLError('a_positional', 'm', 'admission')\n"
        "raise SourcesQLError(code='a_keyword', safe_message='m', stage='admission')\n"
        "raise AdmissionRefusal(code='an_admission', safe_message='m')\n"
        "store.fail_job(job, token, 'a_failed_job', 'm')\n"
        "store.fail_job(job, token, code='a_failed_keyword', safe_message='m')\n"
        "raise SourcesQLError(code=variable, safe_message='m')\n",
        "probe.py",
        literal,
        dynamic,
    )
    assert dynamic == ["probe.py::<module>::variable"]
    assert set(literal) == {
        "a_positional",
        "a_keyword",
        "an_admission",
        "a_failed_job",
        "a_failed_keyword",
    }


def test_scan_tracks_each_variable_site_by_function_even_in_known_files():
    dynamic: list[str] = []
    scan(
        "def known():\n    raise SourcesQLError(code, 'm', 'admission')\n"
        "def added():\n    refuse('m', code=code)\n    refuse('m', other)\n",
        "src/sourcesql/engine.py",
        {},
        dynamic,
    )
    assert dynamic == [
        "src/sourcesql/engine.py::known::code",
        "src/sourcesql/engine.py::added::code",
        "src/sourcesql/engine.py::added::other",
    ]


def test_scan_reads_defaults_and_assignments_behind_a_variable_code():
    literal: dict[str, list[str]] = {}
    scan(
        "def refuse(message, code='a_default'):\n    raise AdmissionRefusal(code, message)\n"
        "def limit(x):\n    code = 'an_assigned'\n"
        "    if x:\n        code = 'a_branch' if x > 1 else 'another_branch'\n"
        "    raise SourcesQLError(code, 'm', 'admission')\n"
        "def pick(failure):\n    raise SourcesQLError(failure.get('code', 'a_fallback'), 'm', 's')\n",
        "probe.py",
        literal,
        [],
    )
    assert set(literal) == {
        "a_default",
        "an_assigned",
        "a_branch",
        "another_branch",
        "a_fallback",
    }


def test_scan_ignores_a_nested_functions_unrelated_variable_of_the_same_name():
    literal: dict[str, list[str]] = {}
    scan(
        "def refuse(message, code='a_default'):\n"
        "    def metadata(code='nested_default'):\n"
        "        code = 'descriptive_metadata'\n"
        "        return code\n"
        "    raise AdmissionRefusal(code, message)\n",
        "probe.py",
        literal,
        [],
    )
    assert set(literal) == {"a_default"}


def test_every_raised_code_is_in_the_table():
    literal, dynamic = raised_codes()
    missing = {code: sites for code, sites in literal.items() if code not in error_codes.CODES}
    assert not missing, f"Add these codes to src/sourcesql/error_codes.json: {missing}"
    assert sorted(dynamic) == sorted(DYNAMIC_SITES), (
        "Call sites that pass a code held in a variable changed. List each new one in "
        f"DYNAMIC_SITES with where its code is checked, and drop stale entries: "
        f"new {sorted(set(dynamic) - set(DYNAMIC_SITES))}, "
        f"gone {sorted(set(DYNAMIC_SITES) - set(dynamic))}"
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
