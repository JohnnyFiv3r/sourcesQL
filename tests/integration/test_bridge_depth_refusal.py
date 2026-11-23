"""A query too deeply nested to parse gets the depth refusal over the real bridge process."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from uuid import uuid4

QUERY = "SELECT " + "(" * 100 + "1" + ")" * 100 + " AS x"


def test_bridge_refuses_too_deep_query_with_the_depth_sentence_and_stores_nothing(tmp_path):
    request_id = str(uuid4())
    lines = [
        {"id": "explain", "method": "explain", "params": {"query": QUERY}},
        {"id": "query", "method": "query", "params": {"query": QUERY, "request_id": request_id}},
        {"id": "lookup", "method": "lookup_request", "params": {"request_id": request_id}},
    ]
    # Lookup is sent to a second process, after the query has settled in the first.
    completed = subprocess.run(
        [sys.executable, "-m", "sourcesql.bridge"],
        input="".join(json.dumps(line) + "\n" for line in lines[:2]).encode(),
        env={**os.environ, "SOURCESQL_DATA_DIR": str(tmp_path)},
        capture_output=True,
        timeout=60,
    )
    responses = {r["id"]: r for r in map(json.loads, completed.stdout.decode().splitlines())}
    for name in ("explain", "query"):
        assert responses[name]["error"] == {
            "code": "invalid_query",
            "message": "Query exceeds the AST depth limit",
            "stage": "admission",
        }, responses[name]
    lookup = subprocess.run(
        [sys.executable, "-m", "sourcesql.bridge"],
        input=(json.dumps(lines[2]) + "\n").encode(),
        env={**os.environ, "SOURCESQL_DATA_DIR": str(tmp_path)},
        capture_output=True,
        timeout=60,
    )
    assert json.loads(lookup.stdout)["result"] == {"found": False}
