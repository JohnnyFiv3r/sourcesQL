"""Admit a closed relational language before any external work.

The class-and-argument closure and bound-value invariants were independently
adapted from the public memoriesQL admission kernel. See provenance/sql-reuse.json.
This module does not execute SQL, authorize inputs, or invoke providers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
import math
import re
from typing import Any, NoReturn

import sqlglot
from sqlglot import exp
from sqlglot.dialects.duckdb import DuckDB
from sqlglot.errors import SqlglotError
from sqlglot.parsers.duckdb import DuckDBParser

from sourcesql.contracts import Column, SourcesQLError

PARSER_VERSION = "30.19.0"
EXTERNAL = frozenset(
    {
        "WEB_SEARCH",
        "WEB_FETCH",
        "SEM_MATCH",
        "SEM_EXTRACT",
        "SEM_EXTRACT_ALL",
        "SEM_SCORE",
        "SEM_NORM",
        "SOURCE_WINDOW",
    }
)
SOURCE_COLUMNS = [
    Column(key)
    for key in (
        "document_id",
        "url",
        "title",
        "snippet",
        "content",
        "content_basis",
        "published_at",
        "provider_acquired_at",
        "retrieved_at",
        "source_version_id",
    )
]
SOURCE_COLUMNS.extend(
    [
        Column(
            "search_hits",
            "STRUCT(provider VARCHAR, search_id VARCHAR, query VARCHAR, query_index BIGINT, rank BIGINT, request_id VARCHAR)[]",
        ),
        Column("search_hit_count", "BIGINT"),
        Column("search_query_count", "BIGINT"),
        Column("best_search_rank", "BIGINT"),
    ]
)
SCALAR_TYPES = frozenset(
    {
        "VARCHAR",
        "BOOLEAN",
        "BIGINT",
        "DOUBLE",
        "DECIMAL(18,2)",
        "DATE",
        "TIMESTAMPTZ",
    }
)
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


class _ClosedDuckDB(DuckDB):
    class Parser(DuckDBParser):
        def _parse_as_command(self, start: Any) -> exp.Command:
            # SQLGlot's fallback otherwise logs original, potentially private SQL.
            raise SourcesQLError("unsupported_query", "Only read-only SELECT queries are supported")

        def _parse_command(self) -> exp.Command:
            raise SourcesQLError("unsupported_query", "Only read-only SELECT queries are supported")


@dataclass
class ParsedQuery:
    tree: exp.Expr
    parameters: dict[str, Any]
    input_aliases: tuple[str, ...]
    custom_operators: tuple[str, ...]
    columns: list[Column]
    explain: dict[str, Any]
    schemas: dict[str, list[Column]] = field(default_factory=dict)

    @property
    def sql(self) -> str:
        return self.tree.sql(dialect="duckdb")

    @property
    def operators(self) -> tuple[str, ...]:
        return self.custom_operators


# Exact node classes AND populated argument keys. Function-specific semantic
# checks below narrow values (join kinds, cast types, custom keyword names, etc.).
_ARGS: dict[str, set[str]] = {
    "Select": {
        "expressions",
        "from_",
        "joins",
        "where",
        "group",
        "having",
        "distinct",
        "order",
        "limit",
        "offset",
        "with_",
        "windows",
    },
    "Union": {"this", "expression", "distinct", "order", "limit", "offset", "with_", "by_name"},
    "Intersect": {"this", "expression", "distinct", "order", "limit", "offset", "with_", "by_name"},
    "Except": {"this", "expression", "distinct", "order", "limit", "offset", "with_", "by_name"},
    "Subquery": {"this", "alias"},
    "With": {"expressions", "recursive"},
    "CTE": {"this", "alias", "materialized"},
    "From": {"this"},
    "Join": {"this", "side", "kind", "on", "using"},
    "Table": {"this", "db", "alias"},
    "TableAlias": {"this", "columns"},
    "Identifier": {"this", "quoted"},
    "Column": {"this", "table", "db"},
    "Alias": {"this", "alias"},
    "Where": {"this"},
    "Having": {"this"},
    "Group": {"expressions"},
    "Distinct": {"expressions"},
    "Order": {"expressions"},
    "Ordered": {"this", "desc", "nulls_first"},
    "Limit": {"expression"},
    "Offset": {"expression"},
    "Window": {"this", "partition_by", "order", "spec", "over", "alias", "first"},
    "WindowSpec": {"kind", "start", "start_side", "end", "end_side", "exclude"},
    "Parameter": {"this"},
    "Placeholder": {"this"},
    "Literal": {"this", "is_string"},
    "Boolean": {"this"},
    "Null": set(),
    "Star": set(),
    "Paren": {"this"},
    "And": {"this", "expression"},
    "Or": {"this", "expression"},
    "Not": {"this"},
    "EQ": {"this", "expression"},
    "NEQ": {"this", "expression"},
    "LT": {"this", "expression"},
    "LTE": {"this", "expression"},
    "GT": {"this", "expression"},
    "GTE": {"this", "expression"},
    "Is": {"this", "expression", "negate"},
    "NullSafeEQ": {"this", "expression"},
    "NullSafeNEQ": {"this", "expression"},
    "Between": {"this", "low", "high", "symmetric"},
    "In": {"this", "expressions", "query"},
    "Exists": {"this"},
    "Like": {"this", "expression"},
    "ILike": {"this", "expression"},
    "Escape": {"this", "expression"},
    "Add": {"this", "expression"},
    "Sub": {"this", "expression"},
    "Mul": {"this", "expression"},
    "Div": {"this", "expression", "typed", "safe"},
    "Mod": {"this", "expression"},
    "Neg": {"this"},
    "DPipe": {"this", "expression", "safe"},
    "Case": {"this", "ifs", "default"},
    "If": {"this", "true", "false"},
    "Cast": {"this", "to"},
    "TryCast": {"this", "to", "safe"},
    "DataType": {"this", "expressions", "nested"},
    "DataTypeParam": {"this", "expression"},
    "Lower": {"this"},
    "Upper": {"this"},
    "Length": {"this", "binary"},
    "Trim": {"this", "expression", "position", "collation"},
    "Substring": {"this", "start", "length"},
    "SplitPart": {"this", "delimiter", "part_index"},
    "RegexpLike": {"this", "expression"},
    "Replace": {"this", "expression", "replacement"},
    "Concat": {"expressions", "safe", "coalesce"},
    "ConcatWs": {"expressions", "safe", "coalesce"},
    "Coalesce": {"this", "expressions", "is_nvl", "is_null"},
    "Nullif": {"this", "expression"},
    "Abs": {"this"},
    "Round": {"this", "decimals", "truncate"},
    "Ceil": {"this", "decimals", "to"},
    "Floor": {"this", "decimals", "to"},
    "Count": {"this", "expressions", "big_int"},
    "Sum": {"this"},
    "Avg": {"this"},
    "Min": {"this", "expressions"},
    "Max": {"this", "expressions"},
    "ArrayAgg": {"this", "nulls_excluded"},
    "Filter": {"this", "expression"},
    "RowNumber": set(),
    "Rank": {"expressions"},
    "DenseRank": {"expressions"},
    "Lag": {"this", "offset", "default", "nulls_excluded"},
    "Lead": {"this", "offset", "default", "nulls_excluded"},
    "Array": {"expressions", "bracket_notation"},
    "Struct": {"expressions"},
    "Unnest": {"expressions", "alias", "offset", "explode_array"},
    "Explode": {"this", "expressions"},
    "Bracket": {"this", "expressions", "offset", "safe", "returns_list"},
    "Dot": {"this", "expression"},
    "Kwarg": {"this", "expression"},
    "Var": {"this"},
    "PropertyEQ": {"this", "expression"},
    "Anonymous": {"this", "expressions"},
    "JSONExtract": {"this", "expression", "only_json_types", "expressions", "variant_extract"},
    "JSONExtractScalar": {"this", "expression", "only_json_types", "expressions", "scalar_only"},
    "JSONPath": {"expressions"},
    "JSONPathRoot": set(),
    "JSONPathKey": {"this"},
    "JSONPathSubscript": {"this"},
}


def refuse(message: str, code: str = "unsupported_query") -> NoReturn:
    raise SourcesQLError(code, message)


def custom_name(node: exp.Expr) -> str | None:
    return (
        node.name.upper()
        if isinstance(node, exp.Anonymous) and node.name.upper() in EXTERNAL
        else None
    )


def call_parts(node: exp.Anonymous) -> tuple[list[exp.Expr], dict[str, exp.Expr]]:
    args, keywords = [], {}
    for value in node.expressions:
        if isinstance(value, (exp.Kwarg, exp.PropertyEQ)):
            key = value.this.name.lower()
            if key in keywords:
                refuse("Duplicate operator option", "invalid_query")
            keywords[key] = value.expression
        else:
            if keywords:
                refuse("Positional arguments must precede named options", "invalid_query")
            args.append(value)
    return args, keywords


def _parameter_name(node: exp.Expr) -> str:
    return str(node.this.name if isinstance(node.this, exp.Expr) else node.this)


def literal_value(node: exp.Expr, parameters: dict[str, Any]) -> Any:
    if isinstance(node, exp.Literal):
        return (
            node.this
            if node.is_string
            else float(node.this)
            if not re.fullmatch(r"[0-9]+", node.this)
            else int(node.this)
        )
    if isinstance(node, exp.Boolean):
        return node.this
    if isinstance(node, exp.Null):
        return None
    if isinstance(node, (exp.Placeholder, exp.Parameter)):
        return parameters[_parameter_name(node)]
    refuse("Operator option must be a literal or bound scalar value")


def _closed_tree(tree: exp.Expr) -> None:
    nodes = list(tree.walk())
    if len(nodes) > 4096:
        refuse("Query exceeds the AST size limit", "invalid_query")
    if len(list(tree.find_all(exp.CTE))) > 16 or len(list(tree.find_all(exp.Table))) > 32:
        refuse("Query exceeds the installed composition limit", "invalid_query")
    for node in nodes:
        name = type(node).__name__
        if name not in _ARGS:
            refuse(f"Unsupported SQL construct: {name}")
        if any(v is not None and v != [] and k not in _ARGS[name] for k, v in node.args.items()):
            refuse(f"Unsupported clause in {name}")
        if isinstance(node, exp.Anonymous) and not custom_name(node):
            refuse("Function is outside the installed SQL allowlist")
        if isinstance(node, exp.Identifier) and node.name.lower().startswith("__wql"):
            refuse("Identifier uses a reserved planner namespace", "invalid_query")
        if isinstance(node, exp.With) and node.args.get("recursive"):
            refuse("Recursive CTEs are not installed")
        if isinstance(node, exp.SetOperation) and node.args.get("by_name"):
            refuse("Set operations by name are not installed")
        if (
            isinstance(node, exp.Distinct)
            and isinstance(node.parent, exp.Select)
            and node.expressions
        ):
            refuse("DISTINCT ON is not installed")
        if isinstance(node, exp.Join):
            side, kind = node.side.upper(), node.kind.upper()
            if side not in ("", "LEFT") or kind not in ("", "INNER", "CROSS"):
                refuse("Only INNER, LEFT, and CROSS joins are installed")
            if side == "LEFT" and not (node.args.get("on") or node.args.get("using")):
                refuse("LEFT joins require ON or USING", "invalid_query")
        if isinstance(node, exp.DataType):
            value = node.sql(dialect="duckdb").upper().replace(" ", "")
            if value not in SCALAR_TYPES | {
                "INT",
                "INTEGER",
                "SMALLINT",
                "TINYINT",
                "FLOAT",
                "REAL",
                "TEXT",
                "TIMESTAMP",
            }:
                refuse("Cast type is outside the installed allowlist")
        if isinstance(node, (exp.Limit, exp.Offset)):
            value = node.expression
            if (
                not isinstance(value, exp.Literal)
                or value.is_string
                or not value.this.isdigit()
                or int(value.this) > 1000000
            ):
                refuse("LIMIT and OFFSET require a nonnegative bounded integer literal")
        depth, parent = 0, node.parent
        while parent:
            depth, parent = depth + 1, parent.parent
            if depth > 40:
                refuse("Query exceeds the AST depth limit", "invalid_query")


def _direct_nodes(tree: exp.Expr):
    yield tree
    for child in tree.iter_expressions():
        if isinstance(child, (exp.Subquery, exp.CTE, exp.Select, exp.SetOperation)):
            continue
        yield from _direct_nodes(child)


def _fields(logical_type: str) -> list[Column]:
    """Read only validated struct type trees, including nested fields."""
    try:
        tree = exp.DataType.build(validate_type(logical_type), dialect="duckdb")
    except SourcesQLError:
        return []
    if tree.this != exp.DataType.Type.STRUCT:
        return []
    return [
        Column(field.name, validate_type(field.args["kind"].sql(dialect="duckdb")))
        for field in tree.expressions
    ]


def validate_type(logical_type: str) -> str:
    """Validate a declared type as an AST before it enters trusted worker SQL."""
    if type(logical_type) is not str or len(logical_type) > 4096:
        refuse("Invalid logical type", "invalid_output")
    try:
        statements = sqlglot.parse(f"SELECT CAST(NULL AS {logical_type})", read=_ClosedDuckDB)
        if (
            len(statements) != 1
            or not isinstance(statements[0], exp.Select)
            or len(statements[0].expressions) != 1
        ):
            refuse("Invalid logical type", "invalid_output")
        expression = statements[0].expressions[0]
        if (
            not isinstance(expression, exp.Cast)
            or not isinstance(expression.this, exp.Null)
            or any(
                v is not None and v != [] and k != "expressions"
                for k, v in statements[0].args.items()
            )
            or any(
                v is not None and v != [] and k not in {"this", "to"}
                for k, v in expression.args.items()
            )
        ):
            refuse("Invalid logical type", "invalid_output")
        tree = expression.args["to"]
    except SqlglotError:
        refuse("Invalid logical type", "invalid_output")

    scalar = {
        "TEXT": "VARCHAR",
        "VARCHAR": "VARCHAR",
        "BOOLEAN": "BOOLEAN",
        "TINYINT": "TINYINT",
        "SMALLINT": "SMALLINT",
        "INT": "INTEGER",
        "BIGINT": "BIGINT",
        "UBIGINT": "UBIGINT",
        "UINT": "UINTEGER",
        "FLOAT": "FLOAT",
        "DOUBLE": "DOUBLE",
        "DATE": "DATE",
        "TIMESTAMP": "TIMESTAMP",
        "TIMESTAMPTZ": "TIMESTAMPTZ",
        "JSON": "JSON",
        "INT128": "HUGEINT",
        "UINT128": "UHUGEINT",
    }

    def walk(node: exp.DataType, depth: int = 0) -> str:
        if depth > 8 or not isinstance(node, exp.DataType):
            refuse("Logical type exceeds the supported nesting", "invalid_output")
        if any(
            v is not None and v != [] and k not in {"this", "expressions", "nested"}
            for k, v in node.args.items()
        ):
            refuse("Unsupported logical type options", "invalid_output")
        kind = node.this.value if isinstance(node.this, exp.DataType.Type) else str(node.this)
        if kind in scalar and not node.expressions:
            return scalar[kind]
        if kind == "ARRAY" and len(node.expressions) == 1:
            return walk(node.expressions[0], depth + 1) + "[]"
        if kind == "STRUCT" and 1 <= len(node.expressions) <= 128:
            fields, names = [], set()
            for field in node.expressions:
                if (
                    not isinstance(field, exp.ColumnDef)
                    or not isinstance(field.this, exp.Identifier)
                    or any(
                        v is not None and v != [] and k not in {"this", "kind"}
                        for k, v in field.args.items()
                    )
                ):
                    refuse("Invalid struct field type", "invalid_output")
                name = field.name
                if (
                    name.lower() in names
                    or len(name) > 128
                    or not name
                    or any(ord(c) < 32 for c in name)
                ):
                    refuse("Duplicate or invalid struct fields", "invalid_output")
                names.add(name.lower())
                fields.append(
                    '"' + name.replace('"', '""') + '" ' + walk(field.args["kind"], depth + 1)
                )
            return "STRUCT(" + ", ".join(fields) + ")"
        if kind == "DECIMAL" and len(node.expressions) in (1, 2):
            values = []
            for parameter in node.expressions:
                if (
                    not isinstance(parameter, exp.DataTypeParam)
                    or not isinstance(parameter.this, exp.Literal)
                    or parameter.this.is_string
                    or not parameter.this.this.isdigit()
                ):
                    refuse("Invalid decimal precision", "invalid_output")
                values.append(int(parameter.this.this))
            precision, scale = values[0], values[1] if len(values) == 2 else 0
            if 1 <= precision <= 38 and 0 <= scale <= precision:
                return f"DECIMAL({precision},{scale})"
        refuse("Logical type is outside the installed allowlist", "invalid_output")

    return walk(tree)


def operator_type(node: exp.Anonymous, parameters: dict[str, Any]) -> str:
    name = custom_name(node)
    _, kwargs = call_parts(node)
    if name in ("WEB_SEARCH", "WEB_FETCH"):
        return "STRUCT(" + ", ".join(c.key + " " + c.logical_type for c in SOURCE_COLUMNS) + ")[]"
    if name == "SEM_MATCH":
        return "BOOLEAN"
    if name == "SEM_SCORE":
        return "DOUBLE"
    if name in ("SEM_NORM", "SOURCE_WINDOW"):
        return "VARCHAR"
    fields = [k for k in kwargs if k not in ("type", "evidence")]
    result = (
        "STRUCT(" + ", ".join(k + " VARCHAR" for k in fields) + ")"
        if fields
        else str(literal_value(kwargs["type"], parameters)).upper()
        if "type" in kwargs
        else "VARCHAR"
    )
    return result + "[]" if name == "SEM_EXTRACT_ALL" else result


class _Binder:
    def __init__(self, parameters: dict[str, Any], inputs: dict[str, list[Column]]):
        self.parameters, self.inputs = parameters, inputs
        self.used_inputs: set[str] = set()
        self.used_parameters: set[str] = set()
        self.operators: list[str] = []
        self.cte_schemas: dict[str, list[Column]] = {}
        self.cte_stack: list[dict[str, list[Column]]] = []

    def resolve(
        self, node: exp.Column, sources: dict[str, list[Column]], outer: dict[str, list[Column]]
    ) -> str:
        if node.args.get("db"):
            # SQLGlot represents qualified struct access q.value.field as a
            # three-part Column. It never grants another database/schema.
            if node.db in sources:
                columns = [c for c in sources[node.db] if c.key.lower() == node.table.lower()]
                fields = _fields(columns[0].logical_type) if len(columns) == 1 else []
                matches = [c for c in fields if c.key.lower() == node.name.lower()]
                if len(matches) == 1:
                    return matches[0].logical_type
            refuse("Unknown relation or struct field", "invalid_query")
        candidates = (
            sources
            if not node.table
            else {node.table: sources[node.table]}
            if node.table in sources
            else {}
        )
        found = [
            c for cols in candidates.values() for c in cols if c.key.lower() == node.name.lower()
        ]
        if not found and node.table and node.table not in sources:
            structs = [
                c for cols in sources.values() for c in cols if c.key.lower() == node.table.lower()
            ]
            fields = _fields(structs[0].logical_type) if len(structs) == 1 else []
            found = [c for c in fields if c.key.lower() == node.name.lower()]
        if not found and outer:
            return self.resolve(node, outer, {})
        if len(found) != 1:
            refuse(
                "Column is unknown or ambiguous; use an explicit relation alias", "invalid_query"
            )
        return found[0].logical_type

    def infer(
        self,
        node: exp.Expr,
        sources: dict[str, list[Column]],
        outer: dict[str, list[Column]] | None = None,
    ) -> str:
        outer = outer or {}
        if isinstance(node, (exp.Alias, exp.Paren)):
            return self.infer(node.this, sources, outer)
        if isinstance(node, exp.Column):
            if isinstance(node.this, exp.Star):
                return "VARCHAR"
            return self.resolve(node, sources, outer)
        if isinstance(node, (exp.Parameter, exp.Placeholder)):
            key = _parameter_name(node)
            if key not in self.parameters:
                refuse("A query parameter has no binding", "invalid_query")
            self.used_parameters.add(key)
            value = self.parameters[key]
            return (
                "BOOLEAN"
                if type(value) is bool
                else "BIGINT"
                if type(value) is int
                else "DOUBLE"
                if type(value) is float
                else "VARCHAR"
            )
        if custom_name(node):
            assert isinstance(node, exp.Anonymous)
            return operator_type(node, self.parameters)
        if isinstance(node, exp.Literal):
            return "VARCHAR" if node.is_string else "DOUBLE" if "." in node.this else "BIGINT"
        if isinstance(node, exp.Boolean):
            return "BOOLEAN"
        if isinstance(node, exp.SplitPart):
            if any(node.args.get(key) is None for key in ("this", "delimiter", "part_index")):
                refuse(
                    "SPLIT_PART requires a string, delimiter, and integer index", "invalid_query"
                )
            if any(
                self.infer(node.args[key], sources, outer) != "VARCHAR"
                for key in ("this", "delimiter")
            ) or self.infer(node.args["part_index"], sources, outer) not in {
                "TINYINT",
                "SMALLINT",
                "INTEGER",
                "BIGINT",
                "HUGEINT",
                "UBIGINT",
                "UHUGEINT",
                "UINTEGER",
            }:
                refuse("SPLIT_PART requires string operands and an integer index", "invalid_query")
            return "VARCHAR"
        if isinstance(node, exp.RegexpLike):
            if any(
                self.infer(node.args[key], sources, outer) != "VARCHAR"
                for key in ("this", "expression")
            ):
                refuse("REGEXP_MATCHES requires string operands", "invalid_query")
            return "BOOLEAN"
        if isinstance(node, exp.Case):
            if node.this:
                self.infer(node.this, sources, outer)
            types = [self.infer(value, sources, outer) for value in node.args.get("ifs", [])]
            if node.args.get("default"):
                types.append(self.infer(node.args["default"], sources, outer))
            return types[0] if types else "VARCHAR"
        if isinstance(node, exp.If):
            self.infer(node.this, sources, outer)
            result = self.infer(node.args["true"], sources, outer)
            if node.args.get("false"):
                self.infer(node.args["false"], sources, outer)
            return result
        if isinstance(node, (exp.Cast, exp.TryCast)):
            self.infer(node.this, sources, outer)
            return validate_type(node.args["to"].sql(dialect="duckdb"))
        if isinstance(node, exp.Subquery):
            cols = self.query(node.this, self.cte_stack[-1], {**outer, **sources})
            if len(cols) != 1:
                refuse("A scalar subquery requires one column", "invalid_query")
            return cols[0].logical_type
        if isinstance(node, exp.Exists):
            self.query(node.this, self.cte_stack[-1], {**outer, **sources})
            return "BOOLEAN"
        if isinstance(node, exp.Dot):
            typ = self.infer(node.this, sources, outer)
            fields = _fields(typ)
            selected = [c for c in fields if c.key.lower() == node.expression.name.lower()]
            if not selected:
                refuse("Unknown struct field", "invalid_query")
            return selected[0].logical_type
        if isinstance(node, exp.Bracket):
            typ = self.infer(node.this, sources, outer)
            for value in node.expressions:
                self.infer(value, sources, outer)
            return typ[:-2] if typ.endswith("[]") else "VARCHAR"
        if isinstance(node, (exp.Unnest, exp.Explode)):
            if isinstance(node, exp.Explode):
                typ = self.infer(node.this, sources, outer)
                return typ[:-2] if typ.endswith("[]") else typ
            values = [v for v in node.expressions if not isinstance(v, exp.Kwarg)]
            typ = self.infer(values[0], sources, outer)
            return typ[:-2] if typ.endswith("[]") else typ
        if isinstance(node, exp.Array):
            types = [self.infer(v, sources, outer) for v in node.expressions]
            return (types[0] if types and len(set(types)) == 1 else "VARCHAR") + "[]"
        if isinstance(node, exp.Struct):
            struct_fields = []
            for value in node.expressions:
                if not isinstance(value, exp.PropertyEQ) or not _IDENTIFIER.fullmatch(
                    value.this.name
                ):
                    refuse("Struct fields require ordinary named keys")
                struct_fields.append(
                    value.this.name + " " + self.infer(value.expression, sources, outer)
                )
            return validate_type("STRUCT(" + ", ".join(struct_fields) + ")")
        # Traverse deterministic children to validate every column and parameter.
        child_types = [
            self.infer(child, sources, outer)
            for child in node.iter_expressions()
            if not isinstance(child, (exp.Identifier, exp.Var, exp.DataType, exp.Kwarg))
        ]
        if isinstance(node, (exp.Predicate, exp.And, exp.Or, exp.Not)):
            return "BOOLEAN"
        if isinstance(node, (exp.Count, exp.RowNumber, exp.Rank, exp.DenseRank, exp.Length)):
            return "BIGINT"
        if isinstance(node, exp.Avg):
            return "DOUBLE"
        if isinstance(node, exp.ArrayAgg):
            return (child_types[0] if child_types else "VARCHAR") + "[]"
        if isinstance(
            node,
            (
                exp.Lower,
                exp.Upper,
                exp.Concat,
                exp.ConcatWs,
                exp.DPipe,
                exp.Substring,
                exp.Trim,
                exp.Replace,
            ),
        ):
            return "VARCHAR"
        if isinstance(node, exp.Div):
            return "DOUBLE"
        return child_types[0] if child_types else "VARCHAR"

    def source(
        self, node: exp.Expr, ctes: dict[str, list[Column]], outer: dict[str, list[Column]]
    ) -> tuple[str, list[Column]]:
        if isinstance(node, exp.Subquery):
            if not node.alias:
                refuse("Derived relations require a local alias", "invalid_query")
            cols = self.query(node.this, ctes, outer)
        elif isinstance(node, exp.Table):
            if isinstance(node.this, exp.Anonymous):
                if custom_name(node.this) not in ("WEB_SEARCH", "WEB_FETCH"):
                    refuse("Only WEB_SEARCH and WEB_FETCH are source operators")
                self.validate_call(node.this, {}, source=True)
                cols = list(SOURCE_COLUMNS)
            elif node.db:
                if node.db.lower() != "input" or node.name not in self.inputs:
                    refuse("Unknown or unbound input relation", "invalid_query")
                self.used_inputs.add(node.name)
                cols = self.inputs[node.name]
            elif node.name in ctes:
                cols = ctes[node.name]
            else:
                refuse("Physical relations are not exposed; bind input.<alias>")
        else:
            refuse("Unsupported relation expression")
        alias = node.alias_or_name or "__source"
        renames = node.args.get("alias")
        if renames and renames.args.get("columns"):
            names = [n.name for n in renames.args["columns"]]
            if len(names) != len(cols):
                refuse("Relation alias column count does not match its schema", "invalid_query")
            cols = [Column(n, c.logical_type, c.nullable) for n, c in zip(names, cols)]
        return alias, cols

    def validate_call(
        self, node: exp.Anonymous, sources: dict[str, list[Column]], source: bool = False
    ) -> None:
        name = custom_name(node)
        if not name:
            refuse("Unknown external operator")
        self.operators.append(name)
        args, kwargs = call_parts(node)
        if any(custom_name(child) for arg in args for child in arg.walk()):
            refuse("Stage nested external calls in separate CTEs")
        if any(
            isinstance(
                child,
                (
                    exp.Subquery,
                    exp.Select,
                    exp.SetOperation,
                    exp.Explode,
                    exp.Unnest,
                    exp.AggFunc,
                    exp.Window,
                ),
            )
            for arg in args
            for child in arg.walk()
        ):
            refuse(
                "Operator arguments must be deterministic scalar expressions from the source row"
            )
        if name in ("WEB_SEARCH", "WEB_FETCH"):
            if not 1 <= len(args) <= 32:
                refuse("Web source operators require one to 32 strings", "invalid_query")
            allowed = (
                {
                    "published_after",
                    "published_before",
                    "per_query_limit",
                    "undated_policy",
                    "allow_post_filter",
                }
                if name == "WEB_SEARCH"
                else {"mode"}
            )
            if set(kwargs) - allowed:
                refuse("Unsupported web source option")
            for arg in args:
                if source:
                    value = literal_value(arg, self.parameters)
                    if (
                        type(value) is not str
                        or not value.strip()
                        or name == "WEB_SEARCH"
                        and len(value) > 2000
                    ):
                        message = "Web source arguments require nonempty strings"
                        if name == "WEB_SEARCH":
                            message += "; use per_query_limit := N for a result limit"
                        refuse(message, "invalid_query")
                elif self.infer(arg, sources) != "VARCHAR":
                    refuse("Row-dependent web arguments must have VARCHAR type", "invalid_query")
            for key, value in kwargs.items():
                raw = literal_value(value, self.parameters)
                if key == "per_query_limit" and (type(raw) is not int or not 1 <= raw <= 100):
                    refuse("per_query_limit must be an integer from 1 to 100", "invalid_query")
                if key == "mode" and raw not in ("cache_preferred", "live"):
                    refuse("Unsupported fetch mode", "invalid_query")
                if key.startswith("published_"):
                    try:
                        if type(raw) is not str:
                            raise ValueError
                        if len(raw) == 10:
                            date.fromisoformat(raw)
                        elif datetime.fromisoformat(raw.replace("Z", "+00:00")).utcoffset() is None:
                            raise ValueError
                    except ValueError:
                        refuse(
                            "Publication bounds require a real ISO date or offset-bearing instant",
                            "invalid_query",
                        )
                if key == "undated_policy" and raw not in {"include", "exclude", "error"}:
                    refuse("undated_policy must be include, exclude, or error", "invalid_query")
                if key == "allow_post_filter" and type(raw) is not bool:
                    refuse("allow_post_filter must be Boolean", "invalid_query")
            if (
                name == "WEB_SEARCH"
                and any(k in kwargs for k in ("published_after", "published_before"))
                and "undated_policy" not in kwargs
            ):
                refuse("Publication filters require an explicit undated_policy", "invalid_query")
        elif name == "SOURCE_WINDOW":
            if len(args) != 3 or kwargs or self.infer(args[0], sources) != "VARCHAR":
                refuse(
                    "SOURCE_WINDOW requires content, zero-based start and length", "invalid_query"
                )
            for argument in args[1:]:
                if self.infer(argument, sources) not in {"BIGINT", "INT"}:
                    refuse("SOURCE_WINDOW offsets must be integers", "invalid_query")
                if isinstance(argument, (exp.Literal, exp.Neg, exp.Parameter, exp.Placeholder)):
                    value = literal_value(argument, self.parameters)
                    if type(value) is not int or value < 0:
                        refuse("SOURCE_WINDOW offsets must be nonnegative", "invalid_query")
        else:
            if len(args) != 2:
                refuse(
                    "Semantic operators require a value and literal instruction", "invalid_query"
                )
            if self.infer(args[0], sources) != "VARCHAR":
                refuse("Semantic inputs must have VARCHAR type", "invalid_query")
            instruction = literal_value(args[1], self.parameters)
            if type(instruction) is not str or not instruction.strip() or len(instruction) > 4000:
                refuse("Semantic instructions require a nonempty string", "invalid_query")
            if name in ("SEM_MATCH", "SEM_SCORE", "SEM_NORM") and kwargs:
                refuse("This semantic operator has no installed options")
            fields = [key for key in kwargs if key not in ("type", "evidence")]
            if fields and "type" in kwargs:
                refuse(
                    "Scalar type and named extraction fields cannot be combined", "invalid_query"
                )
            if name == "SEM_EXTRACT_ALL" and "type" in kwargs:
                refuse("Typed scalar EXTRACT_ALL is not installed")
            if len(fields) > 32 or any(not _IDENTIFIER.fullmatch(key) for key in fields):
                refuse("Invalid extraction field schema", "invalid_query")
            for key, value in kwargs.items():
                raw = literal_value(value, self.parameters)
                if key == "type" and (type(raw) is not str or raw.upper() not in SCALAR_TYPES):
                    refuse("Unsupported semantic extraction type", "invalid_query")
                if key == "evidence" and raw not in (True, False, "per_field"):
                    refuse("Unsupported evidence option", "invalid_query")
                if key not in ("type", "evidence") and (
                    type(raw) is not str or not raw.strip() or len(raw) > 4000
                ):
                    refuse("Named extraction fields require nonempty definitions", "invalid_query")
        # Bind parameters in options/instructions as well as deterministic values.
        for value in node.walk():
            if isinstance(value, (exp.Parameter, exp.Placeholder)):
                self.infer(value, sources)

    def query(
        self,
        node: exp.Expr,
        ctes: dict[str, list[Column]],
        outer: dict[str, list[Column]] | None = None,
    ) -> list[Column]:
        local = dict(ctes)
        self.cte_stack.append(local)
        try:
            return self._query(node, local, outer)
        finally:
            self.cte_stack.pop()

    def _query(
        self,
        node: exp.Expr,
        local: dict[str, list[Column]],
        outer: dict[str, list[Column]] | None = None,
    ) -> list[Column]:
        outer = outer or {}
        if outer and any(custom_name(n) for n in node.walk()):
            refuse("Correlated subqueries support pure SQL only; stage external work in a CTE")
        with_ = node.args.get("with_")
        if with_:
            for cte in with_.expressions:
                name = cte.alias
                if (
                    not name
                    or name in local
                    or name in self.inputs
                    or not _IDENTIFIER.fullmatch(name)
                ):
                    refuse("Duplicate or invalid CTE name", "invalid_query")
                cols = self.query(cte.this, local, outer)
                renames = cte.args["alias"].args.get("columns")
                if renames:
                    if len(renames) != len(cols):
                        refuse("CTE alias column count mismatch", "invalid_query")
                    cols = [Column(n.name, c.logical_type) for n, c in zip(renames, cols)]
                    self.unique(cols)
                local[name] = cols
                self.cte_schemas[name] = cols
        if isinstance(node, exp.SetOperation):
            left, right = (
                self.query(node.this, local, outer),
                self.query(node.expression, local, outer),
            )
            if len(left) != len(right):
                refuse("Set operands must have matching column counts", "invalid_query")
            for clause in (node.args.get("order"), node.args.get("limit"), node.args.get("offset")):
                if clause:
                    self.infer(clause, {"result": left}, outer)
            return left
        if not isinstance(node, exp.Select):
            refuse("Only SELECT query blocks are installed")
        sources: dict[str, list[Column]] = {}
        from_ = node.args.get("from_")
        relations = ([from_.this] if from_ else []) + [j.this for j in node.args.get("joins", [])]
        for relation in relations:
            alias, cols = self.source(relation, local, outer)
            if alias in sources:
                refuse("Duplicate relation alias", "invalid_query")
            sources[alias] = cols
        calls = [
            n for n in _direct_nodes(node) if custom_name(n) and not isinstance(n.parent, exp.Table)
        ]
        if calls:
            if len(sources) != 1 or outer:
                refuse(
                    "External expressions require one source-local materialized relation; stage joins in a CTE"
                )
            if any(node.args.get(k) for k in ("group", "having", "windows")) or any(
                isinstance(n, (exp.AggFunc, exp.Window)) for n in _direct_nodes(node)
            ):
                refuse("Stage aggregates and windows after semantic evaluation in a separate CTE")
            where = node.args.get("where")
            projections = list(node.expressions)
            for call in calls:
                ancestors = []
                parent = call.parent
                while parent is not node and parent is not None:
                    ancestors.append(parent)
                    parent = parent.parent
                in_where = where is not None and where in ancestors
                if in_where:
                    if custom_name(call) != "SEM_MATCH" or any(
                        not isinstance(a, (exp.And, exp.Paren, exp.Where)) for a in ancestors
                    ):
                        refuse(
                            "WHERE semantics support only top-level SEM_MATCH conjuncts; stage mixed OR/NOT"
                        )
                elif not any(p is call or p in ancestors for p in projections):
                    refuse(
                        "External functions are supported only in projections or source-local WHERE"
                    )
                self.validate_call(call, sources)
        output: list[Column] = []
        for projection in node.expressions:
            if (
                isinstance(projection, exp.Star)
                or isinstance(projection, exp.Column)
                and isinstance(projection.this, exp.Star)
            ):
                selected = (
                    sources
                    if not isinstance(projection, exp.Column) or not projection.table
                    else {projection.table: sources.get(projection.table, [])}
                )
                if not selected:
                    refuse("Star projection has no relation", "invalid_query")
                output.extend(c for cols in selected.values() for c in cols)
                continue
            value = projection.this if isinstance(projection, exp.Alias) else projection
            typ = self.infer(projection, sources, outer)
            if isinstance(value, (exp.Unnest, exp.Explode)):
                recursive = any(
                    isinstance(v, (exp.Kwarg, exp.PropertyEQ))
                    and v.this.name.lower() == "recursive"
                    and literal_value(v.expression, self.parameters) is True
                    for v in value.expressions
                )
                if recursive and _fields(typ):
                    output.extend(_fields(typ))
                    continue
            key = projection.alias_or_name or projection.sql(dialect="duckdb")
            output.append(Column(key, typ))
        self.unique(output)
        for key in ("where", "group", "having", "order"):
            clause = node.args.get(key)
            if clause:
                if key in ("where", "group") and any(
                    isinstance(n, (exp.AggFunc, exp.Window)) for n in _direct_nodes(clause)
                ):
                    refuse(
                        "Aggregates and windows are not valid in this query phase", "invalid_query"
                    )
                if key == "having" and any(
                    isinstance(n, exp.Window) for n in _direct_nodes(clause)
                ):
                    refuse("Windows are not valid in HAVING", "invalid_query")
                # GROUP/HAVING/ORDER may reference projection aliases.
                present = {c.key.lower() for cols in sources.values() for c in cols}
                aliases = (
                    [c for c in output if c.key.lower() not in present] if key != "where" else []
                )
                clause_scope = {**sources, "__output": aliases} if aliases else sources
                self.infer(clause, clause_scope, outer)
        for join in node.args.get("joins", []):
            if join.args.get("on"):
                if any(
                    custom_name(n) or isinstance(n, (exp.AggFunc, exp.Window))
                    for n in join.args["on"].walk()
                ):
                    refuse("JOIN ON requires pure scalar relational expressions")
                self.infer(join.args["on"], sources, outer)
        return output

    @staticmethod
    def unique(columns: list[Column]) -> None:
        names = [c.key.lower() for c in columns]
        if len(names) != len(set(names)):
            refuse("Duplicate output column names; assign explicit unique aliases", "invalid_query")
        if len(columns) > 128:
            refuse("Output exceeds the 128-column limit", "invalid_query")


def admit(
    query: str,
    parameters: dict[str, Any] | None = None,
    input_schemas: dict[str, list[Column]] | None = None,
) -> ParsedQuery:
    if sqlglot.__version__ != PARSER_VERSION:
        refuse(
            "Installed parser version differs from the qualified language version",
            "unsupported_capability",
        )
    try:
        length = len(query.encode("utf-8")) if type(query) is str else 0
    except UnicodeError:
        refuse("Query must be valid UTF-8 text", "invalid_query")
    if type(query) is not str or not query.strip() or length > 65536:
        refuse("Query must be nonempty UTF-8 text within 64 KiB", "invalid_query")
    params, schemas = dict(parameters or {}), dict(input_schemas or {})
    for key, value in params.items():
        if type(key) is not str or not _IDENTIFIER.fullmatch(key):
            refuse("Parameter names must be ordinary SQL identifiers", "invalid_query")
        if value is not None and type(value) not in (str, int, float, bool):
            refuse("Parameters must be bound JSON scalars", "invalid_query")
        if (
            type(value) is float
            and not math.isfinite(value)
            or type(value) is int
            and abs(value) > 9007199254740991
        ):
            refuse(
                "Numeric parameters must be finite and integral values JavaScript-safe; use a cast string",
                "invalid_query",
            )
    for key, cols in schemas.items():
        if not _IDENTIFIER.fullmatch(key):
            refuse("Input aliases must be ordinary SQL identifiers", "invalid_query")
        _Binder.unique(cols)
        schemas[key] = [Column(c.key, validate_type(c.logical_type), c.nullable) for c in cols]
    try:
        statements = sqlglot.parse(query, read=_ClosedDuckDB)
    except SqlglotError:
        refuse("SQL could not be parsed in the installed dialect", "invalid_query")
    if len(statements) != 1 or not isinstance(statements[0], (exp.Select, exp.SetOperation)):
        refuse("Exactly one read-only SELECT statement is required")
    tree = statements[0]
    _closed_tree(tree)
    # Validate every binding before extracting literal options from custom calls.
    for node in tree.walk():
        if (
            isinstance(node, (exp.Parameter, exp.Placeholder))
            and _parameter_name(node) not in params
        ):
            refuse("A query parameter has no binding", "invalid_query")
    binder = _Binder(params, schemas)
    columns = binder.query(tree, {})
    if set(params) != binder.used_parameters:
        refuse("Parameter bindings must exactly match the query", "invalid_query")
    stages: list[dict[str, Any]] = [
        {"stage": "materialize_cte", "relation": name} for name in binder.cte_schemas
    ]
    stages.extend(
        {"stage": "external", "operator": name, "estimated_calls": None}
        for name in binder.operators
    )
    stages.append({"stage": "relational", "estimated_rows": None})
    return ParsedQuery(
        tree,
        params,
        tuple(sorted(binder.used_inputs)),
        tuple(binder.operators),
        columns,
        {
            "dialect": "duckdb",
            "parser_version": PARSER_VERSION,
            "stages": stages,
            "output_columns": [c.to_dict() for c in columns],
            "limit_is_output_only": True,
            "filter_pushdown": "source-local exact conjuncts only",
            "external_dispatch_during_explain": False,
        },
        {**schemas, **binder.cte_schemas},
    )
