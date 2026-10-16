"""Materialize external operators outside DuckDB's optimizer.

The admitted SQL owns relational semantics; output LIMIT never caps provider
work. Only exact source-local conjuncts are applied before semantic stages.
"""

from __future__ import annotations

from typing import Any, Callable
import math

from sqlglot import exp

from sourcesql.contracts import Column, Table, SourcesQLError
from sourcesql.sql.admission import (
    ParsedQuery,
    SOURCE_COLUMNS,
    _direct_nodes,
    call_parts,
    custom_name,
    literal_value,
    operator_type,
    _parameter_name,
    validate_type,
)


def _conjuncts(node: exp.Expr | None) -> list[exp.Expr]:
    if node is None:
        return []
    if isinstance(node, exp.Paren):
        return _conjuncts(node.this)
    if isinstance(node, exp.And):
        return _conjuncts(node.this) + _conjuncts(node.expression)
    return [node]


def _and(values: list[exp.Expr]) -> exp.Expr | None:
    if not values:
        return None
    result = values[0].copy()
    for value in values[1:]:
        result = exp.and_(result, value.copy())
    return result


class _Executor:
    def __init__(
        self, plan: ParsedQuery, inputs: dict[str, Table], dispatch: Callable, run_sql: Callable
    ):
        self.plan, self.dispatch, self.run_sql = plan, dispatch, run_sql
        self.tables: dict[str, Table] = {}
        self.inputs: dict[str, str] = {}
        self.sequence = 0
        for alias in plan.input_aliases:
            if alias not in inputs:
                raise SourcesQLError("invalid_query", "An admitted input is not staged", "plan")
            expected = [(c.key, validate_type(c.logical_type)) for c in plan.schemas[alias]]
            actual = [(c.key, validate_type(c.logical_type)) for c in inputs[alias].columns]
            if expected != actual:
                raise SourcesQLError(
                    "invalid_query", "Staged input schema differs from its admitted binding", "plan"
                )
            self.inputs[alias] = self.store(inputs[alias])

    def name(self) -> str:
        self.sequence += 1
        return f"__wql{self.sequence}"

    def store(self, table: Table) -> str:
        if table.lineage and len(table.lineage) != len(table.rows):
            raise SourcesQLError("invalid_output", "Lineage cardinality differs from rows", "plan")
        name = self.name()
        self.tables[name] = table
        return name

    def sql(self, tree: exp.Expr) -> Table:
        # Each worker sees only relation names used by the current statement.
        used = {t.name for t in tree.find_all(exp.Table) if not t.db}
        tables = {name: table for name, table in self.tables.items() if name in used}
        keys = {
            _parameter_name(n)
            for n in tree.walk()
            if isinstance(n, (exp.Parameter, exp.Placeholder))
        }
        parameters = {k: self.plan.parameters[k] for k in keys}
        star_join_identity = any(
            isinstance(projection, exp.Star)
            or isinstance(projection, exp.Column)
            and isinstance(projection.this, exp.Star)
            for projection in tree.expressions
        ) and any(
            join.args.get("using") or join.args.get("method") == "NATURAL"
            for join in tree.args.get("joins", [])
        )
        if (
            not isinstance(tree, exp.Select)
            or any(tree.args.get(key) for key in ("distinct", "group", "having"))
            or star_join_identity
            or any(
                isinstance(node, (exp.Subquery, exp.Exists, exp.Unnest, exp.Explode))
                for node in tree.walk()
            )
            or any(
                isinstance(node, exp.AggFunc) and not node.find_ancestor(exp.Window)
                for node in _direct_nodes(tree)
            )
        ):
            result = self.run_sql(tree.sql(dialect="duckdb"), tables, parameters)
            return Table(result.columns, result.rows)
        return self.sql_lineage(tree, tables, parameters)

    @staticmethod
    def empty_refs() -> exp.Expr:
        return exp.Cast(
            this=exp.Array(expressions=[]),
            to=exp.DataType.build("VARCHAR[]", dialect="duckdb"),
        )

    def sql_lineage(self, tree: exp.Select, tables: dict[str, Table], parameters: dict) -> Table:
        """Carry opaque references in the same row-producing SQL statement.

        Carriers never participate in grouping, DISTINCT, set identity or public
        stars. Values and URLs are not used to rediscover an output row's origin.
        """
        if not any(table.lineage for table in tables.values()):
            result = self.run_sql(tree.sql(dialect="duckdb"), tables, parameters)
            return Table(result.columns, result.rows)
        query = tree.copy()
        names = {column.key for table in tables.values() for column in table.columns}

        def carrier_name() -> str:
            name = self.name()
            while name in names:
                name = self.name()
            names.add(name)
            return name

        staged = {}
        carriers: dict[str, dict[tuple[str, ...], str]] = {}
        for name, table in tables.items():
            columns = {column.key for column in table.columns}
            paths = sorted(
                {path for row in table.lineage for path in row if path and path[0] in columns}
            )
            mapping = {path: carrier_name() for path in paths}
            carriers[name] = mapping
            staged[name] = Table(
                table.columns + [Column(hidden, "VARCHAR[]") for hidden in mapping.values()],
                [
                    {
                        **row,
                        **{
                            hidden: table.lineage[index].get(path, []) if table.lineage else []
                            for path, hidden in mapping.items()
                        },
                    }
                    for index, row in enumerate(table.rows)
                ],
            )

        # Relation aliases and alias-column renames determine paths, not values.
        bindings: dict[str, tuple[list[str], dict[tuple[str, ...], str]]] = {}
        from_ = query.args.get("from_")
        relations = ([from_.this] if from_ else []) + [
            join.this for join in query.args.get("joins", [])
        ]
        for relation in relations:
            if not isinstance(relation, exp.Table) or relation.name not in tables:
                result = self.run_sql(tree.sql(dialect="duckdb"), tables, parameters)
                return Table(result.columns, result.rows)
            table = tables[relation.name]
            alias = relation.alias_or_name
            alias_node = relation.args.get("alias")
            renames = alias_node.args.get("columns", []) if alias_node else []
            visible = [n.name for n in renames] if renames else [c.key for c in table.columns]
            rename = {column.key: name for column, name in zip(table.columns, visible)}
            bindings[alias] = (
                visible,
                {
                    (rename[path[0]],) + path[1:]: hidden
                    for path, hidden in carriers[relation.name].items()
                },
            )

        def address(node: exp.Expr) -> tuple[str, tuple[str, ...]] | None:
            if isinstance(node, exp.Paren):
                return address(node.this)
            if isinstance(node, exp.Dot):
                base = address(node.this)
                return (base[0], base[1] + (node.expression.name,)) if base else None
            if isinstance(node, exp.Bracket):
                base = address(node.this)
                if (
                    base is None
                    or len(node.expressions) != 1
                    or not isinstance(node.expressions[0], exp.Literal)
                    or node.expressions[0].is_string
                    or not node.expressions[0].this.isdigit()
                ):
                    return None
                # SQLGlot normalizes DuckDB's one-based subscripts to zero-based AST indices.
                return base[0], base[1] + (str(int(node.expressions[0].this) + 1),)
            if not isinstance(node, exp.Column) or isinstance(node.this, exp.Star):
                return None
            if node.db:
                return (node.db, (node.table, node.name)) if node.db in bindings else None
            if node.table in bindings:
                return node.table, (node.name,)
            root = node.table or node.name
            matches = [
                (alias, column)
                for alias, (columns, _) in bindings.items()
                for column in columns
                if column.lower() == root.lower()
            ]
            if len(matches) != 1:
                return None
            alias, root = matches[0]
            return alias, (root, node.name) if node.table else (root,)

        def refs(node: exp.Expr) -> dict[tuple[str, ...], exp.Expr]:
            if isinstance(node, (exp.Alias, exp.Paren)):
                return refs(node.this)
            location = address(node)
            if location:
                alias, prefix = location
                return {
                    path[len(prefix) :]: exp.column(hidden, table=alias)
                    for path, hidden in bindings[alias][1].items()
                    if tuple(part.lower() for part in path[: len(prefix)])
                    == tuple(part.lower() for part in prefix)
                }
            if isinstance(node, exp.Coalesce):
                choices = [node.this, *node.expressions]
                alternatives = [refs(value) for value in choices]
                paths = set().union(*(set(mapping) for mapping in alternatives))
                return {
                    path: exp.Case(
                        ifs=[
                            exp.If(
                                this=exp.Not(this=exp.Is(this=value.copy(), expression=exp.Null())),
                                true=mapping.get(path, self.empty_refs()).copy(),
                            )
                            for value, mapping in zip(choices, alternatives)
                        ],
                        default=self.empty_refs(),
                    )
                    for path in paths
                }
            if isinstance(node, (exp.Case, exp.If)):
                conditions = node.args.get("ifs", []) if isinstance(node, exp.Case) else [node]
                alternatives = [refs(condition.args["true"]) for condition in conditions]
                default = node.args.get("default" if isinstance(node, exp.Case) else "false")
                fallback = refs(default) if default is not None else {}
                paths = set(fallback).union(*(set(mapping) for mapping in alternatives))
                return {
                    path: exp.Case(
                        this=node.this.copy() if isinstance(node, exp.Case) and node.this else None,
                        ifs=[
                            exp.If(
                                this=condition.this.copy(),
                                true=mapping.get(path, self.empty_refs()).copy(),
                            )
                            for condition, mapping in zip(conditions, alternatives)
                        ],
                        default=fallback.get(path, self.empty_refs()).copy(),
                    )
                    for path in paths
                }
            # Arithmetic, transforms, aggregates and window-produced values are
            # intentionally not advertised as direct quoted cell evidence.
            return {}

        projections: list[exp.Expr] = []
        for projection in query.expressions:
            star = isinstance(projection, exp.Star) or (
                isinstance(projection, exp.Column) and isinstance(projection.this, exp.Star)
            )
            if star:
                qualifier = projection.table if isinstance(projection, exp.Column) else None
                projections.extend(
                    exp.column(column, table=alias)
                    for alias, (columns, _) in bindings.items()
                    if qualifier is None or alias == qualifier
                    for column in columns
                )
            else:
                projections.append(projection)
        output_paths: dict[str, tuple[int, tuple[str, ...]]] = {}
        hidden_projections = []
        for index, projection in enumerate(projections):
            for path, expression in sorted(refs(projection).items()):
                hidden = carrier_name()
                output_paths[hidden] = index, path
                hidden_projections.append(exp.alias_(expression, hidden))
        if not output_paths:
            result = self.run_sql(tree.sql(dialect="duckdb"), tables, parameters)
            return Table(result.columns, result.rows)
        query.set("expressions", projections + hidden_projections)
        result = self.run_sql(query.sql(dialect="duckdb"), staged, parameters)
        public_columns = [column for column in result.columns if column.key not in output_paths]
        lineage = []
        rows = []
        for row in result.rows:
            references = {}
            for hidden, (index, path) in output_paths.items():
                values = row[hidden]
                if values:
                    references[(public_columns[index].key,) + path] = list(dict.fromkeys(values))
            lineage.append(references)
            rows.append({column.key: row[column.key] for column in public_columns})
        return Table(public_columns, rows, lineage)

    def relation(self, original: exp.Expr, ctes: dict[str, str]) -> exp.Table:
        if isinstance(original, exp.Subquery):
            table = self.execute(original.this, ctes)
            name = self.store(table)
        elif isinstance(original, exp.Table):
            if isinstance(original.this, exp.Anonymous):
                call = original.this
                positional, keywords = call_parts(call)
                args = [literal_value(v, self.plan.parameters) for v in positional]
                kwargs = {k: literal_value(v, self.plan.parameters) for k, v in keywords.items()}
                lineage_output: dict[tuple[str, ...], list[str]] = {}
                rows = self.dispatch(
                    custom_name(call),
                    args,
                    {**kwargs, "_lineage_output": lineage_output, "_input_lineage": []},
                )
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise SourcesQLError(
                        "invalid_output", "Source adapter must return source records", "acquire"
                    )
                name = self.store(
                    Table(
                        list(SOURCE_COLUMNS),
                        [{c.key: row.get(c.key) for c in SOURCE_COLUMNS} for row in rows],
                        [
                            {
                                path[1:]: references
                                for path, references in lineage_output.items()
                                if len(path) > 1 and path[0] == str(index + 1)
                            }
                            for index in range(len(rows))
                        ],
                    )
                )
            elif original.db:
                name = self.inputs[original.name]
            else:
                name = ctes[original.name]
        else:
            raise SourcesQLError("unsupported_query", "Unsupported staged source", "plan")
        alias = original.args.get("alias")
        if alias:
            alias = alias.copy()
        else:
            alias = exp.TableAlias(this=exp.to_identifier(original.alias_or_name or "__source"))
        return exp.Table(this=exp.to_identifier(name), alias=alias)

    def prepare(self, original: exp.Expr, inherited: dict[str, str]) -> exp.Expr:
        tree, ctes = original.copy(), dict(inherited)
        with_ = tree.args.get("with_")
        if with_:
            # Explicit, ordered materialization is the v0.1 CTE boundary.
            # A never-referenced CTE does not cause remote work.
            definitions = {cte.alias: cte for cte in with_.expressions}
            needed = {
                t.name
                for t in tree.find_all(exp.Table)
                if not t.db
                and t.name in definitions
                and not any(isinstance(p, exp.CTE) for p in _ancestors(t, tree))
            }
            pending = list(needed)
            while pending:
                current = pending.pop()
                for relation in definitions[current].this.find_all(exp.Table):
                    if (
                        not relation.db
                        and relation.name in definitions
                        and relation.name not in needed
                    ):
                        needed.add(relation.name)
                        pending.append(relation.name)
            for cte in with_.expressions:
                if cte.alias not in needed:
                    continue
                table = self.execute(cte.this, ctes)
                renames = cte.args["alias"].args.get("columns")
                if renames:
                    names = [n.name for n in renames]
                    table = Table(
                        [
                            Column(n, c.logical_type, c.nullable)
                            for n, c in zip(names, table.columns)
                        ],
                        [
                            {n: row[c.key] for n, c in zip(names, table.columns)}
                            for row in table.rows
                        ],
                        [
                            {
                                (dict(zip((c.key for c in table.columns), names))[path[0]],)
                                + path[1:]: references
                                for path, references in row.items()
                            }
                            for row in table.lineage
                        ],
                    )
                ctes[cte.alias] = self.store(table)
            tree.set("with_", None)
        if isinstance(tree, exp.SetOperation):
            tree.set("this", self.prepare(tree.this, ctes))
            tree.set("expression", self.prepare(tree.expression, ctes))
            return tree
        from_ = tree.args.get("from_")
        if from_:
            from_.set("this", self.relation(from_.this, ctes))
        for join in tree.args.get("joins", []):
            join.set("this", self.relation(join.this, ctes))
        # Pure correlated subqueries remain inside relational SQL. Their sources
        # are resolved, but their relation is not evaluated without its parent.
        for node in list(_direct_nodes(tree)):
            for child in node.iter_expressions():
                if isinstance(child, exp.Subquery):
                    child.set("this", self.prepare(child.this, ctes))
            for key, value in list(node.args.items()):
                if (
                    isinstance(node, exp.Exists)
                    and key == "this"
                    and isinstance(value, (exp.Select, exp.SetOperation))
                ):
                    node.set(key, self.prepare(value, ctes))
        return tree

    def execute(self, original: exp.Expr, inherited: dict[str, str]) -> Table:
        tree = self.prepare(original, inherited)
        if isinstance(tree, exp.SetOperation):
            # Branches may contain external projections. Materialize them before
            # the final set operation, whose SQL still governs bag semantics.
            return self.execute_prepared(tree)
        return self.execute_prepared(tree)

    def evaluate_arguments(
        self, call: exp.Anonymous, source: exp.Table, table: Table, row_key: str
    ) -> tuple[list[list[Any]], list[list[str]]]:
        args, _ = call_parts(call)
        query = exp.Select(
            expressions=[exp.alias_(exp.column(row_key, table=source.alias), "__row")]
            + [exp.alias_(arg.copy(), f"__arg{i}") for i, arg in enumerate(args)]
        )
        query.set("from_", exp.From(this=source.copy()))
        evaluated = self.sql(query)
        name = custom_name(call)
        required = len(args) if name in {"WEB_SEARCH", "WEB_FETCH"} else 2
        types = {c.key: validate_type(c.logical_type) for c in evaluated.columns}
        if any(types.get(f"__arg{i}") != "VARCHAR" for i in range(required)):
            raise SourcesQLError(
                "invalid_query", "Operator arguments must evaluate to VARCHAR values", "plan"
            )
        if len(evaluated.rows) != len(table.rows):
            raise SourcesQLError(
                "invalid_query", "An operator argument changed source cardinality", "plan"
            )
        by_row = {
            str(row["__row"]): (
                [row[f"__arg{i}"] for i in range(len(args))],
                evaluated.lineage[index].get(("__arg0",), []) if evaluated.lineage else [],
            )
            for index, row in enumerate(evaluated.rows)
        }
        if len(by_row) != len(table.rows):
            raise SourcesQLError(
                "invalid_query", "An operator argument duplicated source identity", "plan"
            )
        ordered = [by_row[str(row[row_key])] for row in table.rows]
        return [item[0] for item in ordered], [item[1] for item in ordered]

    def materialize_call(
        self, call: exp.Anonymous, source: exp.Table, table: Table, row_key: str
    ) -> tuple[str, Table]:
        name = custom_name(call)
        _, keywords = call_parts(call)
        kwargs = {k: literal_value(v, self.plan.parameters) for k, v in keywords.items()}
        if "type" in kwargs:
            kwargs["type"] = str(kwargs["type"]).upper()
        arguments, argument_lineage = self.evaluate_arguments(call, source, table, row_key)
        lineage = (
            [dict(row) for row in table.lineage] if table.lineage else [{} for _ in table.rows]
        )
        key = self.name()
        while any(c.key == key for c in table.columns):
            key = self.name()
        field = None
        for ancestor in _ancestors(call, call.find_ancestor(exp.Select)):
            if isinstance(ancestor, exp.Alias):
                field = ancestor.alias
                break
        if name == "SEM_NORM":
            collection = list(dict.fromkeys(args[0] for args in arguments if args[0] is not None))
            instruction = arguments[0][1] if arguments else ""
            normalized = (
                self.dispatch(
                    name,
                    [collection, instruction],
                    {
                        **kwargs,
                        "_output_field": field,
                        "_lineage_output": {},
                        "_input_lineage": [],
                    },
                )
                if collection
                else []
            )
            if isinstance(normalized, dict):
                mapping = {value: normalized.get(value) for value in collection}
            elif isinstance(normalized, list) and len(normalized) == len(collection):
                mapping = dict(zip(collection, normalized))
            else:
                raise SourcesQLError(
                    "invalid_output",
                    "Normalization must return one mapping for the admitted collection",
                    "semantic",
                )
            values = [mapping.get(args[0]) for args in arguments]
            if any(value is not None and type(value) is not str for value in values):
                raise SourcesQLError(
                    "invalid_output", "Normalization keys must be strings or NULL", "semantic"
                )
        else:
            values = []
            for index, (row, args) in enumerate(zip(table.rows, arguments)):
                # NULL web expressions propagate. Semantic NULLs reach the
                # coordinator so unprocessed coverage remains in the receipt;
                # providers must not spend a model request on absent evidence.
                context = dict(kwargs)
                lineage_output: dict[tuple[str, ...], list[str]] = {}
                context.update(
                    _lineage_output=lineage_output,
                    _input_lineage=argument_lineage[index],
                )
                if name and name.startswith("SEM_"):
                    context.update(
                        {
                            "_output_field": field,
                            "_source_version_id": row.get("source_version_id"),
                            "_source_url": row.get("url"),
                        }
                    )
                value = (
                    None
                    if args[0] is None and name in {"WEB_SEARCH", "WEB_FETCH"}
                    else self.dispatch(name, args, context)
                )
                if name == "SEM_MATCH" and value is not None and type(value) is not bool:
                    raise SourcesQLError(
                        "invalid_output", "Semantic match must return Boolean or NULL", "semantic"
                    )
                if (
                    name == "SEM_SCORE"
                    and value is not None
                    and (type(value) not in (int, float) or not math.isfinite(value))
                ):
                    raise SourcesQLError(
                        "invalid_output",
                        "Semantic score must return a finite number or NULL",
                        "semantic",
                    )
                values.append(value)
                for path, references in lineage_output.items():
                    lineage[index][(key,) + path] = references
        column = Column(key, operator_type(call, self.plan.parameters))
        rows = [{**row, key: value} for row, value in zip(table.rows, values)]
        return key, Table(table.columns + [column], rows, lineage)

    def execute_prepared(self, tree: exp.Expr) -> Table:
        if isinstance(tree, exp.SetOperation):
            for key in ("this", "expression"):
                branch = tree.args[key]
                table = self.execute_prepared(branch)
                name = self.store(table)
                tree.set(key, exp.select("*").from_(name))
            return self.sql(tree)
        calls = [node for node in _direct_nodes(tree) if custom_name(node)]
        if not calls:
            return self.sql(tree)
        from_ = tree.args["from_"]
        source = from_.this
        original_keys = {c.key for c in self.tables[source.name].columns}
        projections = []
        for projection in tree.expressions:
            if (
                not isinstance(projection, exp.Alias)
                and not isinstance(projection, (exp.Star, exp.Explode, exp.Unnest))
                and any(custom_name(n) for n in projection.walk())
            ):
                projections.append(
                    exp.alias_(
                        projection,
                        projection.alias_or_name or projection.sql(dialect="duckdb"),
                        quoted=True,
                    )
                )
            else:
                projections.append(projection)
        tree.set("expressions", projections)
        where = tree.args.get("where")
        predicates = _conjuncts(where.this if where else None)
        deterministic = [p for p in predicates if not any(custom_name(n) for n in p.walk())]
        matches = [p for p in predicates if any(custom_name(n) for n in p.walk())]
        prefilter = exp.select("*")
        prefilter.set("from_", exp.From(this=source.copy()))
        exact = _and(deterministic)
        if exact:
            prefilter.set("where", exp.Where(this=exact))
        table = self.sql(prefilter)
        row_key = self.name()
        while any(c.key == row_key for c in table.columns):
            row_key = self.name()
        table = Table(
            table.columns + [Column(row_key, "BIGINT", False)],
            [{**row, row_key: index} for index, row in enumerate(table.rows)],
            table.lineage,
        )
        source.set("this", exp.to_identifier(self.store(table)))
        # Evaluate/filter match conjuncts first, then projected extractions.
        for predicate in matches:
            call = next(n for n in predicate.walk() if custom_name(n))
            assert isinstance(call, exp.Anonymous)
            key, table = self.materialize_call(call, source, table, row_key)
            call.replace(exp.column(key, table=source.alias))
            source.set("this", exp.to_identifier(self.store(table)))
            filtered = exp.select("*")
            filtered.set("from_", exp.From(this=source.copy()))
            filtered.set("where", exp.Where(this=exp.column(key, table=source.alias)))
            table = self.sql(filtered)
            source.set("this", exp.to_identifier(self.store(table)))
        tree.set("where", None)
        for call in [
            node
            for projection in tree.expressions
            for node in projection.walk()
            if custom_name(node)
        ]:
            key, table = self.materialize_call(call, source, table, row_key)
            call.replace(exp.column(key, table=source.alias))
            source.set("this", exp.to_identifier(self.store(table)))
        # A star means original source columns, never hidden staged values.
        expanded: list[exp.Expr] = []
        for projection in tree.expressions:
            if (
                isinstance(projection, exp.Star)
                or isinstance(projection, exp.Column)
                and isinstance(projection.this, exp.Star)
            ):
                expanded.extend(
                    exp.column(c.key, table=source.alias)
                    for c in table.columns
                    if c.key in original_keys
                )
            else:
                expanded.append(projection)
        tree.set("expressions", expanded)
        return self.sql(tree)


def _ancestors(node: exp.Expr, stop: exp.Expr | None):
    parent = node.parent
    while parent is not None and parent is not stop:
        yield parent
        parent = parent.parent


def execute_plan(
    plan: ParsedQuery,
    inputs: dict[str, Table],
    dispatch: Callable[[str, list[Any], dict[str, Any]], Any],
    run_sql: Callable[[str, dict[str, Table], dict[str, Any]], Table],
) -> Table:
    """Execute one previously admitted plan using coordinator-owned effects."""
    # DuckDB itself checks ordinary binding, grouping, and expression types over
    # empty typed relations. No source/model provider is present in this pass.
    # Actual-row arithmetic errors remain ordinary execution failures.
    empty = {alias: Table(table.columns, []) for alias, table in inputs.items()}
    try:
        _Executor(plan, empty, lambda *_: [], run_sql).execute(plan.tree, {})
    except SourcesQLError as error:
        if error.code in {"invalid_query", "execution_error", "invalid_output"}:
            raise SourcesQLError(
                "invalid_query",
                "SQL failed schema or expression validation before provider dispatch",
            ) from None
        raise
    except Exception:
        raise SourcesQLError(
            "invalid_query", "SQL failed schema or expression validation before provider dispatch"
        ) from None
    return _Executor(plan, inputs, dispatch, run_sql).execute(plan.tree, {})
