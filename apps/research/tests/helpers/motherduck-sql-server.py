"""Credential-free local DuckDB SQL for native gateway tests.

One process owns the file, with an independent connection per gateway client.
Only external MotherDuck control functions are simulated by the TypeScript test.
"""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
from uuid import uuid4

import duckdb


ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))


def execute_failing_job(values):
    """Run a real strict engine job with synthetic embedding transport failure."""
    import httpx

    from sourcesql.contracts import Column, Table
    from sourcesql.engine import Engine
    from sourcesql.execution.worker_process import evaluate
    from sourcesql.providers import ProviderRegistry
    from sourcesql.providers.semantic import OpenAIEmbeddingProvider
    from sourcesql.storage.motherduck import MotherDuckStore

    namespace, job_id, failure_kind = values
    if failure_kind not in {"timeout", "connection_error", "http_429", "invalid_output"}:
        raise ValueError("Unreviewed synthetic provider failure")
    requests = []

    def reply(request):
        requests.append(request)
        if failure_kind == "timeout":
            raise httpx.ReadTimeout("PRIVATE-PROVIDER-TIMEOUT", request=request)
        if failure_kind == "connection_error":
            raise httpx.ConnectError("PRIVATE-PROVIDER-CONNECTION", request=request)
        if failure_kind == "http_429":
            return httpx.Response(429, json={"error": "PRIVATE-PROVIDER-BODY"})
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": []}]})

    def reference_worker(sql, tables, parameters=None, timeout=30):
        result = evaluate(
            {
                "sql": sql,
                "tables": {name: table.to_dict() for name, table in tables.items()},
                "parameters": parameters or {},
                "max_rows": 1001,
            }
        )
        return Table(
            [Column(c["key"], c["logical_type"], c["nullable"]) for c in result["columns"]],
            result["rows"],
        )

    store = MotherDuckStore(
        database="synthetic_test", namespace=namespace, connector=lambda: duckdb.connect(path)
    )
    with store.db() as db:
        saved = store._job(db, job_id)
    saved_request = json.loads(saved["request_json"])
    if (
        saved_request.get("profile", "fixture") != "fixture"
        or saved_request.get("partial_policy") != "strict"
    ):
        raise ValueError("Synthetic execution requires a strict fixture job")
    context = {
        "flight_id": str(saved["flight_id"]),
        "run_id": str(saved["flight_run_id"] or uuid4()),
        "flight_version": saved["flight_version"],
    }
    runner_spec = importlib.util.spec_from_file_location(
        "sourcesql_gateway_test_runner", ROOT / "hosted/flight/runner.py"
    )
    runner = importlib.util.module_from_spec(runner_spec)
    runner_spec.loader.exec_module(runner)
    policy_spec = importlib.util.spec_from_file_location(
        "sourcesql_gateway_test_profile", ROOT / "hosted/flight/exa_profile.py"
    )
    helper = importlib.util.module_from_spec(policy_spec)
    policy_spec.loader.exec_module(helper)
    original_registry = ProviderRegistry.__init__

    with httpx.Client(transport=httpx.MockTransport(reply), trust_env=False) as client:

        def configure_registry(self, profile=None):
            original_registry(self, profile)
            self.embedding_provider = OpenAIEmbeddingProvider(
                "text-embedding-3-small", "synthetic-not-a-key", client=client
            )

        def score_many(self, texts, criterion, options, budget):
            return self.embedding_provider.score_many(texts, criterion, options, budget)

        def configured_engine(*args, **kwargs):
            return Engine(*args, **kwargs, worker=reference_worker)

        with tempfile.TemporaryDirectory(prefix="sourcesql-gateway-runner-") as directory:
            report = {}
            with (
                patch.object(ProviderRegistry, "__init__", configure_registry),
                patch.object(ProviderRegistry, "score_many", score_many),
                patch("sourcesql.engine.Engine", configured_engine),
                patch.object(runner, "flight_context", lambda: context),
            ):
                runner.execute_job(
                    store,
                    {"job_id": job_id},
                    report,
                    Path(directory),
                    helper,
                    helper.load_configuration({}),
                )
    with store.db() as db:
        saved = store._job(db, job_id)
    return [
        {
            "status": saved["status"],
            "error_code": saved["error_code"],
            "result_id": saved["result_id"],
            "provider_requests": len(requests),
        }
    ]


def wire(value):
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2**53 - 1:
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (tuple, list)):
        return [wire(item) for item in value]
    if isinstance(value, dict):
        return {key: wire(item) for key, item in value.items()}
    return str(value)


connections = {}
path = sys.argv[1]
print(json.dumps({"ready": True}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            key = request["connection_id"]
            if request["operation"] == "connect":
                connections[key] = duckdb.connect(path)
                rows = []
            elif request["operation"] == "end":
                connections.pop(key).close()
                rows = []
            elif request["operation"] == "execute_failing_job":
                rows = execute_failing_job(request["values"])
            else:
                cursor = connections[key].execute(request["sql"], request.get("values", []))
                names = [column[0] for column in cursor.description] if cursor.description else []
                rows = [dict(zip(names, map(wire, row))) for row in cursor.fetchall()]
            response = {"id": request["id"], "rows": rows}
        except Exception as error:
            response = {
                "id": request["id"],
                "error": {
                    "code": "40001" if isinstance(error, duckdb.TransactionException) else "XX000",
                    "type": type(error).__name__,
                    "message": "Local synthetic SQL failed",
                },
            }
        print(json.dumps(response), flush=True)
finally:
    for connection in connections.values():
        connection.close()
