"""Credential-free JSON worker; launched under an OS sandbox by worker.py."""

from __future__ import annotations
import datetime
import decimal
import json
import math
import sys
from typing import TYPE_CHECKING
import duckdb
import pyarrow as pa  # type: ignore[import-untyped]
from sqlglot import exp


if TYPE_CHECKING or __package__:
    from open_webql.contracts import WebQLError
else:
    # The isolated script has only its execution directory on sys.path. Keep
    # the safe exception envelope local without loading the application/store.
    class WebQLError(Exception):
        def __init__(self, code: str, message: str, stage: str = "worker"):
            super().__init__(message)
            self.code, self.safe_message, self.stage = code, message, stage


class StageLimitExceeded(WebQLError):
    def __init__(self):
        super().__init__("budget_exhausted", "Relational stage row limit exceeded", "worker")


def encode(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("nonfinite result")
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, list):
        return [encode(x) for x in value]
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value


def checked_type(value):
    if len(value) > 2048:
        raise ValueError("type")
    dtype = exp.DataType.build(value, dialect="duckdb")
    allowed = {
        "VARCHAR",
        "TEXT",
        "BOOLEAN",
        "TINYINT",
        "SMALLINT",
        "INT",
        "UINT",
        "BIGINT",
        "UBIGINT",
        "HUGEINT",
        "UHUGEINT",
        "INT128",
        "UINT128",
        "FLOAT",
        "DOUBLE",
        "DECIMAL",
        "DATE",
        "TIMESTAMP",
        "TIMESTAMPTZ",
        "ARRAY",
        "STRUCT",
        "JSON",
        "NULL",
        "UNKNOWN",
    }
    for node in dtype.walk():
        if isinstance(node, exp.DataType) and node.this.name not in allowed:
            raise ValueError("type")
        if not isinstance(
            node, (exp.DataType, exp.DataTypeParam, exp.ColumnDef, exp.Identifier, exp.Literal)
        ):
            raise ValueError("type")
    return dtype.sql(dialect="duckdb")


def arrow_value(value, dtype):
    if value is None:
        return None
    kind = dtype.this.value
    if kind in {"BIGINT", "UBIGINT", "INT128", "UINT128", "DECIMAL"}:
        return str(value)
    if kind == "ARRAY":
        return [arrow_value(v, dtype.expressions[0]) for v in value]
    if kind == "STRUCT":
        return {
            field.name: arrow_value(value[field.name], field.args["kind"])
            for field in dtype.expressions
        }
    return value


def evaluate(request):
    db = duckdb.connect(
        ":memory:",
        config={
            "enable_external_access": "false",
            "autoload_known_extensions": "false",
            "autoinstall_known_extensions": "false",
            "threads": "1",
            "memory_limit": "256MB",
            "max_temp_directory_size": "0B",
        },
    )
    db.execute("SET lock_configuration=true")
    for name, table in request.get("tables", {}).items():
        if not name.replace("_", "").isalnum():
            raise ValueError("identifier")
        cols = table["columns"]
        rows = table["rows"]
        names = [c["key"] for c in cols]
        if len(set(names)) != len(names):
            raise ValueError("duplicate")
        types = [checked_type(c["logical_type"]) for c in cols]
        if rows:
            arrow = pa.Table.from_pylist(
                [
                    {
                        k: arrow_value(row[k], exp.DataType.build(t, dialect="duckdb"))
                        for k, t in zip(names, types)
                    }
                    for row in rows
                ]
            )
            db.register("_arrow_" + name, arrow)
            projection = ",".join(
                'CAST("'
                + k.replace('"', '""')
                + '" AS '
                + t
                + ') AS "'
                + k.replace('"', '""')
                + '"'
                for k, t in zip(names, types)
            )
            db.execute(
                'CREATE TEMP TABLE "'
                + name
                + '" AS SELECT '
                + projection
                + ' FROM "_arrow_'
                + name
                + '"'
            )
            db.unregister("_arrow_" + name)
        else:
            definition = ",".join(
                '"' + k.replace('"', '""') + '" ' + t for k, t in zip(names, types)
            )
            db.execute('CREATE TEMP TABLE "' + name + '" (' + definition + ")")
    cursor = db.execute(request["sql"], request.get("parameters", {}))
    description = cursor.description
    if description is None:
        raise ValueError("not a result")
    names = [x[0] for x in description]
    if len(names) != len(set(names)):
        raise ValueError("duplicate result columns")
    columns = [{"key": x[0], "logical_type": str(x[1]), "nullable": True} for x in description]
    maximum = request.get("max_rows", 1001)
    if type(maximum) is not int or not 0 <= maximum <= 1001:
        db.close()
        raise ValueError("stage row limit")
    rows = cursor.fetchmany(maximum + 1)
    if len(rows) > maximum:
        db.close()
        raise StageLimitExceeded()
    result = {"columns": columns, "rows": [dict(zip(names, map(encode, row))) for row in rows]}
    db.close()
    return result


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            result = evaluate(json.loads(line))
        except StageLimitExceeded as error:
            result = {"error": error.code, "stage": error.stage, "safe_message": error.safe_message}
        except Exception:
            result = {"error": "relational_execution_failed"}
        print(
            json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
            flush=True,
        )
