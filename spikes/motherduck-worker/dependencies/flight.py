"""Fixed dependency/SQL compatibility probe; does not execute the sourcesQL engine.

Use setup.py to embed the current repository lock manifest in a single-file Flight.
--local-only imports packages and evaluates the fixed fixture without cloud access.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import json
import os
import re
import sys
import threading
from uuid import UUID

# setup.py replaces this one assignment with a manifest read from pyproject.toml/uv.lock.
LOCK_MANIFEST = None

DIRECT_PINS = {
    "sqlglot": "30.19.0",
    "duckdb": "1.5.0",
    "pyarrow": "23.0.1",
    "pydantic": "2.13.3",
    "httpx": "0.28.1",
    "pydantic-ai-slim": "2.27.0",
}
IMPORTS = {
    "sqlglot": ["sqlglot"],
    "duckdb": ["duckdb"],
    "pyarrow": ["pyarrow"],
    "pydantic": ["pydantic"],
    "httpx": ["httpx"],
    "pydantic-ai-slim": [
        "pydantic_ai",
        "pydantic_ai.models.openai",
        "pydantic_ai.providers.openai",
        "pydantic_ai.models.wrapper",
        "pydantic_ai.usage",
        "openai",
    ],
}
API_SYMBOLS = {
    "pyarrow": ["Table"],
    "pydantic": ["BaseModel", "ConfigDict", "Field", "create_model"],
    "httpx": ["AsyncClient"],
    "pydantic_ai": ["Agent"],
    "pydantic_ai.models.openai": ["OpenAIChatModel"],
    "pydantic_ai.providers.openai": ["OpenAIProvider"],
    "pydantic_ai.models.wrapper": ["WrapperModel"],
    "pydantic_ai.usage": ["UsageLimits"],
    "openai": ["AsyncOpenAI", "DefaultAsyncHttpxClient"],
}
SQL = """SELECT row_id, project, planned_mw FROM fixture_input
WHERE planned_mw >= 0 OR planned_mw IS NULL ORDER BY row_id LIMIT 2"""
DUCKDB_CONFIG = {
    "enable_external_access": "false",
    "autoload_known_extensions": "false",
    "autoinstall_known_extensions": "false",
    "threads": "1",
    "memory_limit": "256MB",
    "max_temp_directory_size": "0B",
}
COLUMNS = [
    {"name": "project", "label": "Project", "type": "string"},
    {"name": "planned_mw", "label": "Planned Capacity (MW)", "type": "number"},
]


def compatibility_report():
    expected = (LOCK_MANIFEST or {}).get("versions", DIRECT_PINS)
    packages = {}
    for name, pinned in expected.items():
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            actual = None
        packages[name] = {"expected": pinned, "actual": actual, "matches": actual == pinned}
    imported = {}
    for modules in IMPORTS.values():
        for module in modules:
            try:
                loaded = importlib.import_module(module)
                for symbol in API_SYMBOLS.get(module, []):
                    getattr(loaded, symbol)
                imported[module] = {"ok": True}
            except Exception as error:
                imported[module] = {"ok": False, "error_type": type(error).__name__}
    python_ok = (3, 12) <= sys.version_info[:2] < (3, 15)
    flight_context = {}
    for name in ["MOTHERDUCK_FLIGHT_ID", "MOTHERDUCK_FLIGHT_RUN_ID"]:
        value = os.environ.get(name)
        try:
            flight_context[name] = str(UUID(value)) if value is not None else None
        except ValueError:
            flight_context[name] = "present_but_not_uuid"
    return {
        "probe": "sourcesql_dependencies",
        "fixture": True,
        "flight_context": flight_context,
        "python": {
            "actual": sys.version.split()[0],
            "required": ">=3.12,<3.15",
            "matches": python_ok,
            "platform": sys.platform,
        },
        "packages": packages,
        "imports": imported,
        "manifest": LOCK_MANIFEST,
        "pin_scope": "locked_runtime" if LOCK_MANIFEST else "direct_dependencies_only",
        "packages_ok": all(package["matches"] for package in packages.values())
        and all(module["ok"] for module in imported.values()),
        "dependencies_ok": python_ok
        and all(package["matches"] for package in packages.values())
        and all(module["ok"] for module in imported.values()),
        "sql": {"status": "not_run", "timeout_sec": 10},
        "engine": {
            "status": "not_tested",
            "reason": "This fixed dependency probe does not invoke or qualify the engine's "
            "OS worker, SQL admission, or provider execution.",
        },
        "provider_calls": 0,
        "motherduck_connection": "not_attempted",
        "persisted": False,
    }


def synthetic_sql(report):
    import duckdb
    import pyarrow as pa
    import sqlglot

    # Only this source-owned SQL is accepted. No caller SQL or provider operators.
    tree = sqlglot.parse_one(SQL, read="duckdb")
    if not isinstance(tree, sqlglot.exp.Select):
        raise RuntimeError("Fixed SQL did not parse as SELECT")
    arrow = pa.Table.from_pylist(
        [
            {"row_id": "fictional-a", "project": "Fictional Alpha", "planned_mw": 500},
            {"row_id": "fictional-b", "project": "Fictional Beta", "planned_mw": None},
        ]
    )
    con = duckdb.connect(":memory:", config=DUCKDB_CONFIG)
    timer = threading.Timer(10, con.interrupt)
    try:
        con.execute("SET lock_configuration=true")
        settings = {
            key: con.execute("SELECT current_setting(?)", [key]).fetchone()[0]
            for key in [*DUCKDB_CONFIG, "lock_configuration"]
        }
        con.register("fixture_input", arrow)
        timer.start()
        values = con.execute(tree.sql(dialect="duckdb")).fetchall()
        if values != [
            ("fictional-a", "Fictional Alpha", 500),
            ("fictional-b", "Fictional Beta", None),
        ]:
            raise RuntimeError("Unexpected synthetic SQL result")
        report["sql"] = {
            "status": "passed",
            "rows": len(values),
            "timeout_sec": 10,
            "settings": settings,
            "uses_pyarrow_registration": True,
            "sqlglot_parse": "passed",
            "os_isolation": "not_tested",
        }
        return [
            (
                row_id,
                {
                    "project": project,
                    "planned_mw": planned_mw,
                    "evidence": (
                        [{"source_id": "synthetic-source-a", "quote": "planned 500 MW"}]
                        if row_id == "fictional-a"
                        else []
                    ),
                },
            )
            for row_id, project, planned_mw in values
        ]
    finally:
        timer.cancel()
        if timer.ident is not None:
            timer.join()
        con.close()


def persist(con, request_id, rows, report):
    # Preserve the original gateway probe's schemas and column metadata.
    con.execute("""CREATE TABLE IF NOT EXISTS sourcesql_gateway_probe_jobs (
        request_id UUID PRIMARY KEY, title VARCHAR, columns_json VARCHAR,
        created_at TIMESTAMPTZ DEFAULT current_timestamp)""")
    con.execute("""CREATE TABLE IF NOT EXISTS sourcesql_gateway_probe_rows (
        request_id UUID, row_id VARCHAR, payload_json VARCHAR,
        PRIMARY KEY (request_id, row_id))""")
    con.execute("""CREATE TABLE IF NOT EXISTS sourcesql_gateway_probe_corrections (
        revision_id UUID PRIMARY KEY, request_id UUID, row_id VARCHAR,
        column_name VARCHAR, value DOUBLE,
        created_at TIMESTAMPTZ DEFAULT current_timestamp)""")
    con.execute("BEGIN TRANSACTION")
    try:
        con.execute(
            """INSERT INTO sourcesql_gateway_probe_jobs
            (request_id, title, columns_json) VALUES (?, ?, ?)""",
            [request_id, "Synthetic dependency compatibility probe", json.dumps(COLUMNS)],
        )
        for row_id, payload in rows:
            con.execute(
                "INSERT INTO sourcesql_gateway_probe_rows VALUES (?, ?, ?)",
                [
                    request_id,
                    row_id,
                    json.dumps({**payload, "compatibility": {**report, "persisted": True}}),
                ],
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def main(local_only=False):
    request_id = None if local_only else str(UUID(os.environ["REQUEST_ID"]))
    database = None if local_only else os.environ["DATABASE"]
    if database is not None and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", database):
        raise ValueError("DATABASE must be a simple probe database identifier")
    report = compatibility_report()
    phase = "dependency_checks"
    try:
        if not local_only and LOCK_MANIFEST is None:
            raise RuntimeError("Generate the single-file Flight with setup.py before cloud use")
        if not report["packages_ok"]:
            raise RuntimeError("Pinned dependencies did not match")
        # This is source-owned diagnostic SQL, never the engine. Continue this
        # narrow probe on an available interpreter while retaining the failing
        # engine runtime contract in python.matches and dependencies_ok.
        phase = "synthetic_sql"
        rows = synthetic_sql(report)
        if not local_only:
            phase = "motherduck_persistence"
            import duckdb

            report["motherduck_connection"] = "attempting"
            con = duckdb.connect("md:" + database)
            report["motherduck_connection"] = "connected"
            try:
                persist(con, request_id, rows, report)
                report["persisted"] = True
            finally:
                con.close()
        print(json.dumps({"request_id": request_id, "rows": len(rows), "compatibility": report}))
        return report, rows
    except Exception as error:
        report["failed_phase"] = phase
        if phase == "synthetic_sql":
            report["sql"]["status"] = "failed"
        if report["motherduck_connection"] == "attempting":
            report["motherduck_connection"] = "failed"
        report["error_type"] = type(error).__name__
        # Classify an explicit version rejection without returning raw connection errors.
        message = str(error).lower()
        report["unsupported_duckdb_client_reported"] = (
            "duckdb" in message
            and "version" in message
            and any(word in message for word in ["unsupported", "not supported", "not compatible"])
        )
        print(json.dumps({"request_id": request_id, "compatibility": report}))
        # Do not expose connection errors, environments or credential-containing URLs.
        raise RuntimeError("Dependency probe failed at " + phase) from None


if __name__ == "__main__":
    main(local_only="--local-only" in sys.argv[1:])
