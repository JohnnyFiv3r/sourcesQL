"""Synthetic gateway compatibility probe, independent of the sourcesQL engine."""
import json
import os
from uuid import UUID

import duckdb


def main():
    request_id = str(UUID(os.environ["REQUEST_ID"]))
    columns = [
        {"name": "project", "label": "Project", "type": "string"},
        {"name": "planned_mw", "label": "Planned Capacity (MW)", "type": "number"},
    ]
    rows = [
        ("fictional-a", {"project": "Fictional Alpha", "planned_mw": 500,
                         "evidence": [{"source_id": "synthetic-source-a", "quote": "planned 500 MW"}]}),
        ("fictional-b", {"project": "Fictional Beta", "planned_mw": None, "evidence": []}),
    ]
    con = duckdb.connect("md:" + os.environ["DATABASE"])
    try:
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
        con.execute("INSERT INTO sourcesql_gateway_probe_jobs (request_id, title, columns_json) VALUES (?, ?, ?)",
                    [request_id, "Synthetic gateway probe", json.dumps(columns)])
        for row_id, values in rows:
            con.execute("INSERT INTO sourcesql_gateway_probe_rows VALUES (?, ?, ?)",
                        [request_id, row_id, json.dumps(values)])
        con.execute("COMMIT")
        print(json.dumps({"request_id": request_id, "rows": len(rows), "fixture": True}))
    finally:
        con.close()


if __name__ == "__main__":
    main()
