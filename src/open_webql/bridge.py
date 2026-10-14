"""Bounded JSON-lines interface for the existing research service; stdout is machine-only."""

from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import threading
from open_webql.contracts import WebQLError, canonical
from open_webql.contracts import digest
from open_webql.engine import Engine, strict_json


def main():
    profiles = {}
    path = os.environ.get("WEBQL_PROFILES_FILE")
    if path:
        profiles = strict_json(Path(path).read_bytes())
    principal = os.environ.get("WEBQL_PRINCIPAL", "local-owner")
    store_root = (
        Path(os.environ.get("WEBQL_DATA_DIR", "local/engine"))
        / "principals"
        / digest(principal)[:32]
    )
    engine = Engine(
        store_root,
        profiles=profiles,
        allow_private=os.environ.get("WEBQL_ALLOW_PRIVATE", "1") == "1",
    )
    methods = {
        "capabilities": engine.capabilities,
        "query": engine.query,
        "explain": engine.explain,
        "read_result": engine.read_result,
        "import_table": engine.import_table,
        "export": engine.export,
        "import": engine.import_bundle,
        "run_status": engine.run_status,
        "cancel": engine.cancel,
    }
    output_lock = threading.Lock()

    def respond(line):
        request_id = None
        try:
            if len(line) > 4 * 1024 * 1024:
                raise WebQLError("budget_exhausted", "Bridge input exceeds byte limit")
            request = strict_json(line)
            request_id = request.get("id")
            if (
                not isinstance(request, dict)
                or set(request) - {"id", "method", "params"}
                or request.get("method") not in methods
            ):
                raise WebQLError("invalid_request", "Invalid bridge request")
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise WebQLError("invalid_request", "Invalid method parameters")
            result = methods[request["method"]](**params)
            response = {"id": request_id, "result": result}
        except WebQLError as error:
            response = {
                "id": request_id,
                "error": {"code": error.code, "message": error.safe_message, "stage": error.stage},
            }
        except Exception:
            response = {
                "id": request_id,
                "error": {"code": "invalid_request", "message": "Request failed safely"},
            }
        with output_lock:
            sys.stdout.buffer.write(canonical(response) + b"\n")
            sys.stdout.buffer.flush()

    with ThreadPoolExecutor(max_workers=4) as executor:
        while line := sys.stdin.buffer.readline(4 * 1024 * 1024 + 1):
            if not line.endswith(b"\n"):
                while chunk := sys.stdin.buffer.readline(4 * 1024 * 1024 + 1):
                    if chunk.endswith(b"\n"):
                        break
                respond(b"{}")
            else:
                executor.submit(respond, line)


if __name__ == "__main__":
    main()
