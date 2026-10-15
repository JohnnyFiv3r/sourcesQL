"""Credential-free local DuckDB SQL for native gateway tests.

One process owns the file, with an independent connection per gateway client.
Only external MotherDuck control functions are simulated by the TypeScript test.
"""
import json
import sys

import duckdb


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
