"""Research execution coordinator: authorization, bounded effects, immutable publication."""

from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import threading
import time
import math
from decimal import Decimal, InvalidOperation
from datetime import date
from typing import Any
import uuid
from sourcesql import __version__
from sourcesql.contracts import (
    Budget,
    Column,
    Table,
    SemanticOutcome,
    SourcesQLError,
    canonical,
    digest,
)
from sourcesql.storage.store import Store
from sourcesql.research_quality import validate_requirements, assess_requirements
from sourcesql.query_feedback import build_query_feedback, observe_result
from sourcesql.execution.worker import run_sql, WorkerSession


def now():
    return datetime.now(timezone.utc).isoformat()


def strict_json(value: str | bytes) -> Any:
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                raise SourcesQLError("invalid_request", "Duplicate JSON key")
            result[k] = v
        return result

    def bad_constant(value):
        raise SourcesQLError("invalid_request", "Nonfinite JSON number")

    try:
        return json.loads(value, object_pairs_hook=pairs, parse_constant=bad_constant)
    except (ValueError, UnicodeError) as error:
        raise SourcesQLError("invalid_request", "Invalid JSON") from error


def wire_value(value: Any, logical_type: str) -> Any:
    if value is None:
        return None
    from sqlglot import exp

    dtype = exp.DataType.build(logical_type, dialect="duckdb")

    def convert(v, t):
        if v is None:
            return None
        kind = t.this.value
        if kind in ("BIGINT", "UBIGINT", "HUGEINT", "UHUGEINT", "INT128", "UINT128", "DECIMAL"):
            return str(v)
        if kind == "ARRAY":
            return [convert(x, t.expressions[0]) for x in v]
        if kind == "STRUCT":
            return {f.name: convert(v[f.name], f.args["kind"]) for f in t.expressions}
        return generic_wire(v)

    return convert(value, dtype)


def validate_table(columns, rows, row_ids=None) -> Table:
    from sourcesql.sql.admission import validate_type
    from sqlglot import exp

    if (
        not isinstance(columns, list)
        or not isinstance(rows, list)
        or not 1 <= len(columns) <= 128
        or len(rows) > 1000
        or len(canonical(rows)) > 4194304
    ):
        raise SourcesQLError("budget_exhausted", "Import exceeds storage policy")
    cols = [
        Column(
            c["key"],
            validate_type(c.get("logical_type", c.get("logicalType", "VARCHAR"))),
            c.get("nullable", True),
        )
        for c in columns
    ]
    keys = [c.key for c in cols]
    if len(set(keys)) != len(keys) or any(
        not re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,63}", k) or k in ("constructor", "prototype")
        for k in keys
    ):
        raise SourcesQLError("invalid_request", "Invalid imported columns")
    if any(type(c.nullable) is not bool for c in cols) or any(
        not isinstance(row, dict) or set(row) != set(keys) for row in rows
    ):
        raise SourcesQLError("invalid_request", "Imported rows must match declared columns")
    if row_ids is not None and (
        not isinstance(row_ids, list)
        or len(row_ids) != len(rows)
        or any(
            not isinstance(x, str) or not re.fullmatch("[A-Za-z0-9_-]{1,100}", x) for x in row_ids
        )
        or len(set(row_ids)) != len(rows)
    ):
        raise SourcesQLError("invalid_output", "Invalid row identities")

    def cell(v, t, depth=0):
        if v is None:
            return
        if depth > 8:
            raise ValueError()
        kind = t.this.value
        if kind in ("VARCHAR", "TEXT"):
            if not isinstance(v, str):
                raise ValueError()
        elif kind == "BOOLEAN":
            if type(v) is not bool:
                raise ValueError()
        elif kind in (
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
        ):
            if type(v) is not int and (
                not isinstance(v, str) or not re.fullmatch("-?(0|[1-9][0-9]*)", v)
            ):
                raise ValueError()
            n = int(v)
            bits = {
                "TINYINT": 8,
                "SMALLINT": 16,
                "INT": 32,
                "UINT": 32,
                "BIGINT": 64,
                "UBIGINT": 64,
                "HUGEINT": 128,
                "UHUGEINT": 128,
                "INT128": 128,
                "UINT128": 128,
            }[kind]
            unsigned = kind in ("UINT", "UBIGINT", "UHUGEINT", "UINT128")
            if (
                not (0 if unsigned else -(1 << (bits - 1)))
                <= n
                < (1 << bits if unsigned else 1 << (bits - 1))
            ):
                raise ValueError()
        elif kind in ("DOUBLE", "FLOAT"):
            if type(v) not in (int, float) or not math.isfinite(v):
                raise ValueError()
        elif kind == "DECIMAL":
            if not isinstance(v, str):
                raise ValueError()
            decimal = Decimal(v)
            precision = int(t.expressions[0].this.this)
            scale = int(t.expressions[1].this.this)
            if (
                not decimal.is_finite()
                or decimal != decimal.quantize(Decimal(1).scaleb(-scale))
                or abs(decimal) >= Decimal(10) ** (precision - scale)
            ):
                raise ValueError()
        elif kind == "DATE":
            if not isinstance(v, str) or len(v) != 10:
                raise ValueError()
            date.fromisoformat(v)
        elif kind in ("TIMESTAMP", "TIMESTAMPTZ"):
            if not isinstance(v, str) or "T" not in v:
                raise ValueError()
            parsed = datetime.fromisoformat(v)
            if kind == "TIMESTAMPTZ" and parsed.tzinfo is None:
                raise ValueError()
        elif kind == "ARRAY":
            if not isinstance(v, list) or len(v) > 1000:
                raise ValueError()
            for item in v:
                cell(item, t.expressions[0], depth + 1)
        elif kind == "STRUCT":
            fields = {f.name: f.args["kind"] for f in t.expressions}
            if (
                not isinstance(v, dict)
                or set(v) != set(fields)
                or any(k in ("__proto__", "constructor", "prototype") for k in fields)
            ):
                raise ValueError()
            for k, value in v.items():
                cell(value, fields[k], depth + 1)
        elif kind == "JSON":
            if not isinstance(v, str):
                raise ValueError()
            strict_json(v)
        else:
            raise ValueError()

    try:
        for row in rows:
            for c in cols:
                if row[c.key] is None and not c.nullable:
                    raise ValueError()
                cell(row[c.key], exp.DataType.build(c.logical_type, dialect="duckdb"))
    except (ValueError, TypeError, InvalidOperation, KeyError) as error:
        raise SourcesQLError(
            "invalid_output", "Imported value does not match declared type/nullability"
        ) from error
    return Table(cols, rows)


def generic_wire(value):
    if type(value) is int and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, list):
        return [generic_wire(v) for v in value]
    if isinstance(value, dict):
        return {k: generic_wire(v) for k, v in value.items()}
    return value


class Engine:
    def __init__(
        self,
        root: Path | str,
        profiles: dict | None = None,
        worker=run_sql,
        allow_private: bool = True,
        store: Store | None = None,
        before_dispatch=None,
    ):
        self.store = store if store is not None else Store(root)
        self.profiles = {"fixture": {"mode": "fixture", "provider": "fixture"}, **(profiles or {})}
        self.worker = worker
        self.allow_private = allow_private
        # Launcher-owned setup only; a query cannot supply or bypass this hook.
        self.before_dispatch = before_dispatch
        self.active: dict[str, Budget] = {}
        self.lock = threading.Lock()
        self.worker_checked = False
        with self.store.db() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS semantic_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL)"
            )

    def capabilities(self):
        from sourcesql.sql.admission import EXTERNAL

        return {
            "engine_version": __version__,
            "dialect": "duckdb",
            "sqlglot_version": "30.19.0",
            "operators": sorted(EXTERNAL),
            "input_views": ["original", "effective", "sources"],
            "default_profile": "fixture",
            "profiles": [
                {
                    "name": k,
                    "mode": v.get("mode", "fixture"),
                    "provider": v.get("provider", "fixture"),
                    "live_qualified": False,
                }
                for k, v in self.profiles.items()
            ],
            "limits": Budget().limits,
            "semantic_limits": {"extract_all_max_items_per_call": 8},
            "sql_shapes": [
                "select",
                "nonrecursive_cte",
                "inner_left_join",
                "group_having",
                "order_limit",
                "set_operations",
                "row_number",
                "unnest",
                "source_local_external_stages",
            ],
            "worker": "macOS sandbox-exec or Linux Landlock+seccomp; protected launch required",
            "qualification": {"fixture": "mechanics_passed", "live": "not_run", "host": "not_run"},
            "limitations": [
                "No historical index replay",
                "Semantic source-local shape restrictions",
                "Cell lineage for supported projections and joins; other shapes retain input-set lineage",
                "No schedules",
                "No automatic provider fallback",
            ],
        }

    def _inputs(self, bindings):
        tables = {}
        parents = []
        classification = "public_web"
        for alias, binding in bindings.items():
            if not re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,63}", alias) or alias in (
                "constructor",
                "prototype",
            ):
                raise SourcesQLError("invalid_request", "Invalid input alias")
            if not isinstance(binding, dict) or set(binding) - {
                "result_id",
                "view",
                "amendment_revision",
            }:
                raise SourcesQLError("invalid_request", "Invalid input binding")
            view = binding.get("view", "original")
            revision = binding.get("amendment_revision")
            if (
                view not in ("original", "effective", "sources")
                or (view in ("original", "sources") and revision is not None)
                or (view == "effective" and (type(revision) is not int or revision < 0))
            ):
                raise SourcesQLError(
                    "invalid_request", "Bind an exact effective revision or original view"
                )
            meta = self.store.authorize(binding["result_id"])
            if not self.allow_private and meta.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError("unauthorized", "This launcher cannot access private data")
            meta, table = self.store.read(binding["result_id"])
            if (
                view == "effective"
                and meta.get("provenance", {}).get("amendment_revision") != revision
            ):
                raise SourcesQLError(
                    "revision_conflict", "Effective input revision does not match retained view"
                )
            if view == "sources":
                from sourcesql.execution.evidence import retained_sources
                from sourcesql.sql.admission import SOURCE_COLUMNS

                documents = retained_sources(self.store, meta["result_id"])
                table = Table(
                    list(SOURCE_COLUMNS),
                    [
                        {column.key: source.get(column.key) for column in SOURCE_COLUMNS}
                        for _, source in sorted(documents.items())
                    ],
                )
            tables[alias] = table
            parents.append(
                {
                    "result_id": meta["result_id"],
                    "content_sha256": meta["content_sha256"],
                    "view": view,
                    "amendment_revision": revision,
                }
            )
            if meta.get("data_classification") in ("private_local", "private_derived"):
                classification = "private_derived"
        return tables, parents, classification

    def _admit(self, request):
        from sourcesql.sql.admission import admit

        allowed = {
            "query",
            "request_id",
            "parameters",
            "inputs",
            "profile",
            "budgets",
            "partial_policy",
            "source_mode",
            "row_id_column",
            "continuation_of",
            "research_requirements",
            "answer_intent",
        }
        if not isinstance(request, dict) or set(request) - allowed:
            raise SourcesQLError("invalid_request", "Unknown request field")
        query = request.get("query")
        if not isinstance(query, str) or not 0 < len(query.encode()) <= 32768:
            raise SourcesQLError("invalid_request", "Query must be bounded text")
        parameters = request.get("parameters", {})
        if not isinstance(parameters, dict) or len(parameters) > 64:
            raise SourcesQLError("invalid_request", "Invalid parameters")
        for key, value in parameters.items():
            if not re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,63}", key) or type(value) not in (
                str,
                int,
                float,
                bool,
                type(None),
            ):
                raise SourcesQLError("invalid_request", "Parameters must be bound scalars")
            if type(value) is int and abs(value) > 9007199254740991:
                raise SourcesQLError(
                    "invalid_request", "Use a lossless string and explicit cast for large integers"
                )
        canonical(parameters)
        profile_name = request.get("profile", "fixture")
        if profile_name not in self.profiles:
            raise SourcesQLError("unsupported_capability", "Profile unavailable")
        profile = self.profiles[profile_name]
        inputs, parents, classification = self._inputs(request.get("inputs", {}))
        plan = admit(query, parameters, {k: v.columns for k, v in inputs.items()})
        validate_requirements(request.get("research_requirements"), plan.columns)
        operators = getattr(plan, "operators", getattr(plan, "custom_operators", []))
        has_external = any(operator != "SOURCE_WINDOW" for operator in operators)
        if classification == "private_derived" and has_external:
            grants = profile.get("private_disclosure", {})
            required = [p["result_id"] for p in parents]
            if not all(
                set(required) <= set(grants.get(dest, [])) for dest in ["search", "semantic"]
            ):
                raise SourcesQLError(
                    "disclosure_required",
                    "Private dependencies require exact destination permission",
                )
        if request.get("partial_policy", "retain_partial") not in ("strict", "retain_partial"):
            raise SourcesQLError("invalid_request", "Invalid partial policy")
        if request.get("source_mode", "require_document") not in (
            "require_document",
            "allow_excerpt",
        ):
            raise SourcesQLError("invalid_request", "Invalid source mode")
        budget = Budget(request.get("budgets"))
        return plan, inputs, parents, classification, profile, budget

    def explain(self, **request):
        from sourcesql.execution.planner import validate_plan

        plan, inputs, parents, classification, profile, budget = self._admit(request)
        deadline = time.monotonic() + budget.limits["dispatch_deadline_seconds"]
        session = None

        def check_active():
            if budget.cancelled:
                raise SourcesQLError("cancelled", "Validation cancelled", "worker")
            with self.store.db() as db:
                check_job = getattr(self.store, "_check_job", None)
                if check_job is not None:
                    check_job(db)
                for parent in parents:
                    actual = self.store._authorize(db, parent["result_id"], set())
                    if actual["content_sha256"] != parent["content_sha256"]:
                        raise SourcesQLError(
                            "evidence_invalid", "Parent content pin mismatch", "admission"
                        )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SourcesQLError("budget_exhausted", "Validation deadline exceeded", "worker")
            return remaining

        def checked_worker(sql, tables, params):
            remaining = check_active()
            worker = session.run_sql if session else self.worker
            result = worker(sql, tables, params, timeout=min(30, remaining))
            check_active()
            return result

        try:
            check_active()
            if self.worker is run_sql:
                session = WorkerSession().__enter__()
            # Every protected validation owns its launch and checks it. An
            # earlier query or explain cannot attest a new sandbox process.
            checked_worker("SELECT 1 AS worker_probe", {}, {})
            validate_plan(plan, inputs, checked_worker)
            check_active()
        finally:
            if session is not None:
                session.__exit__(None, None, None)
        return {
            "plan": getattr(plan, "explain", {}),
            "query_feedback": build_query_feedback(plan, request, parents),
            "input_pins": parents,
            "data_classification": classification,
            "effective_limits": budget.limits,
            "profile": request.get("profile", "fixture"),
            "mode": profile.get("mode", "fixture"),
            "external_calls": 0,
        }

    def resume_run(self, run_id, request_id):
        receipt = self.run_status(run_id)
        request = receipt.get("resume_request")
        if not isinstance(request, dict):
            raise SourcesQLError(
                "unsupported_capability", "This run has no retained continuation request", "read"
            )
        return self.query(**{**request, "request_id": request_id, "continuation_of": run_id})

    def recover_run(self, run_id, offset=0, limit=1000):
        """Publish a page of retained discovery as explicitly incomplete input data."""
        from sourcesql.sql.admission import SOURCE_COLUMNS
        from sourcesql.providers.common import project_search_provenance

        receipt = self.run_status(run_id)
        if receipt["status"] not in {"failed", "cancelled", "partial"}:
            raise SourcesQLError(
                "invalid_request", "Only stopped or partial research can be recovered", "read"
            )
        if (
            type(offset) is not int
            or offset < 0
            or type(limit) is not int
            or not 1 <= limit <= 1000
        ):
            raise SourcesQLError("invalid_request", "Invalid recovery page", "read")
        journal = receipt.get("journal_id", run_id)
        sources = {}
        if receipt.get("result_id"):
            saved = self.read_result(receipt["result_id"])
            sources.update((s["source_version_id"], s) for s in saved.get("source_versions", []))
        for key in self.store.iter_stage_keys(journal):
            state = self.store.stage_read(journal, key)
            if state is None:
                # A continuation may publish and compact this journal between
                # key pagination and this read. Recovery never starts effects.
                continue
            if state["status"] != "completed":
                continue
            value = state["value"]
            if value.get("operator") not in {"WEB_SEARCH", "WEB_FETCH"}:
                continue
            for source in value["data"]:
                if source.get("status") == "acquired" and isinstance(source.get("content"), str):
                    sid = source["source_version_id"]
                    if sid in sources:
                        sources[sid].setdefault("hits", []).extend(source.get("hits", []))
                    else:
                        sources[sid] = source
        retained = [project_search_provenance(source) for _, source in sorted(sources.items())]
        selected = retained[offset : offset + limit]
        if not selected:
            raise SourcesQLError("not_found", "No retained sources in this recovery page", "read")
        rows = [
            {column.key: source.get(column.key) for column in SOURCE_COLUMNS} for source in selected
        ]
        identity = digest([run_id, offset, limit, rows])
        result_id, recovered_run = "wq_recovery_" + identity[:32], "run_recovery_" + identity[:32]
        row_ids = [
            "row_" + digest([identity, source["source_version_id"]])[:32] for source in selected
        ]
        parents = receipt.get("parents", [])
        stamp = now()
        final = {
            "run_id": recovered_run,
            "request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, identity)),
            "receipt_id": "receipt_" + identity[:32],
            "receipt_revision": 1,
            "status": "partial",
            "settlement_status": "settled",
            "unsettled_requests": 0,
            "started_at": stamp,
            "finished_at": stamp,
            "plan_complete": False,
            "result_id": result_id,
            "counts": {"output_rows": len(rows)},
            "usage": [],
            "errors": [],
            "goal_status": "not_evaluated",
            "parents": parents,
            "data_classification": receipt["data_classification"],
            "recovery": {
                "from_run": run_id,
                "source_versions": len(retained),
                "offset": offset,
                "next_offset": offset + limit if offset + limit < len(retained) else None,
                "research_complete": False,
            },
        }
        pending = {**final, "status": "running", "result_id": None, "finished_at": None}
        previous, created = self.store.begin_run(
            {"request_id": final["request_id"], "recovery_digest": identity}, pending
        )
        if not created and previous.get("result_id"):
            return self.read_result(previous["result_id"])
        self.store.commit(
            Table(list(SOURCE_COLUMNS), rows),
            {
                "result_id": result_id,
                "run_id": recovered_run,
                "parents": parents,
                "data_classification": receipt["data_classification"],
                "row_ids": row_ids,
                "created_at": stamp,
                "receipt": final,
                "source_versions": selected,
                "source_bindings": [
                    {
                        "row_id": row_id,
                        "column_key": "content",
                        "value_path": [],
                        "source_version_id": source["source_version_id"],
                    }
                    for row_id, source in zip(row_ids, selected)
                ],
                "lineage_precision": "retained_sources",
                "provenance": final["recovery"],
            },
        )
        return self.read_result(result_id)

    def lookup_request(self, request_id, expected_request=None, materializations=None):
        try:
            key = str(uuid.UUID(request_id))
        except (ValueError, TypeError, AttributeError):
            raise SourcesQLError("invalid_request", "request_id must be UUID") from None
        receipt = self.store.lookup_request(key)
        if receipt is None:
            return {"found": False}
        effective = []
        for parent in receipt.get("parents", []):
            meta = self.store.authorize(parent["result_id"])
            if not self.allow_private and meta.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError("unauthorized", "This launcher cannot access private data")
            if parent.get("view") == "effective":
                effective.append(
                    meta.get("provenance", {}).get("materialization_contract")
                    == "sourcesql.app-effective.v1"
                )
        result = {
            "found": True,
            "run_id": receipt["run_id"],
            "status": receipt["status"],
            "current_recipe": bool(effective) and all(effective),
        }
        if expected_request is not None:
            if (
                not result["current_recipe"]
                or not isinstance(expected_request, dict)
                or not isinstance(materializations, dict)
            ):
                raise SourcesQLError(
                    "idempotency_conflict", "Existing request requires exact run inspection"
                )
            expected = {**expected_request, "inputs": dict(expected_request.get("inputs", {}))}
            for alias, payload in materializations.items():
                if (
                    alias not in expected["inputs"]
                    or expected["inputs"][alias].get("view") != "effective"
                ):
                    raise SourcesQLError("invalid_request", "Invalid prepared input")
                _, _, provenance, _, identity = self._normalize_import(**payload)
                expected["inputs"][alias] = {
                    "result_id": "wq_import_" + identity[:32],
                    "view": "effective",
                    "amendment_revision": provenance.get("amendment_revision"),
                }
            if digest(expected) != digest(receipt.get("resume_request")):
                raise SourcesQLError(
                    "idempotency_conflict",
                    "Existing request has different captured inputs; inspect its exact run",
                )
            profile = self.profiles.get(expected.get("profile", "fixture"), {})
            revision = digest(
                {
                    k: v
                    for k, v in profile.items()
                    if not any(
                        x in k.lower()
                        for x in ["key", "token", "client", "model_adapter", "embedding_adapter"]
                    )
                }
            )
            if receipt.get("profile_revision") != revision:
                raise SourcesQLError(
                    "idempotency_conflict",
                    "Existing request profile changed; inspect its exact run",
                )
            result.update(compatible=True, result_id=receipt.get("result_id"))
        return result

    def query(self, **request):
        from sourcesql.providers import ProviderRegistry
        from sourcesql.execution.planner import execute_plan

        plan, inputs, parents, classification, profile, budget = self._admit(request)
        continuation = None
        if request.get("continuation_of"):
            continuation = self.run_status(request["continuation_of"])
            previous = continuation.get("resume_request")

            def comparable(value):
                return {
                    k: v for k, v in value.items() if k not in {"request_id", "continuation_of"}
                }

            if (
                continuation["status"] != "failed"
                or not isinstance(previous, dict)
                or comparable(previous) != comparable(request)
            ):
                raise SourcesQLError(
                    "invalid_request",
                    "Continuation requires the same failed query, inputs and limits",
                    "admission",
                )
            if continuation.get("settlement_status") != "settled":
                raise SourcesQLError(
                    "execution_outcome_unknown", "Unsettled work cannot be replayed", "dispatch"
                )
            budget.counts = dict(continuation.get("counts", {}))
        request_id = request.get("request_id") or str(uuid.uuid4())
        try:
            uuid.UUID(request_id)
        except (ValueError, TypeError):
            raise SourcesQLError("invalid_request", "request_id must be UUID")
        run_id = "run_" + uuid.uuid4().hex
        receipt = {
            "run_id": run_id,
            "request_id": request_id,
            "receipt_id": "receipt_" + uuid.uuid4().hex,
            "receipt_revision": 0,
            "status": "running",
            "settlement_status": "settled",
            "unsettled_requests": 0,
            "started_at": now(),
            "finished_at": None,
            "plan_complete": False,
            "result_id": None,
            "counts": dict(budget.counts),
            "usage": [],
            "warnings": [],
            "errors": [],
            "effective_limits": budget.limits,
            "corpus_coverage": "bounded_fixture"
            if profile.get("mode", "fixture") == "fixture"
            else "unknown",
            "goal_status": "not_evaluated",
            "data_classification": classification,
            "query_feedback": build_query_feedback(plan, request, parents),
            "parents": parents,
            "resume_request": dict(request),
            "journal_id": continuation.get("journal_id", continuation["run_id"])
            if continuation
            else run_id,
            "continuation_of": request.get("continuation_of"),
        }
        pinned = {
            **request,
            "request_id": request_id,
            "profile_revision": digest(
                {
                    k: v
                    for k, v in profile.items()
                    if not any(
                        x in k.lower()
                        for x in ["key", "token", "client", "model_adapter", "embedding_adapter"]
                    )
                }
            ),
            "input_pins": parents,
        }
        if continuation and continuation.get("profile_revision") != pinned["profile_revision"]:
            raise SourcesQLError(
                "unsupported_capability", "Continuation provider configuration changed", "admission"
            )
        receipt["profile_revision"] = pinned["profile_revision"]
        prior, new = self.store.begin_run(pinned, receipt)
        if not new:
            if prior["result_id"]:
                return self.read_result(prior["result_id"])
            return {"run_id": prior["run_id"], "receipt": prior, "result_id": None}
        self.active[run_id] = budget
        from sourcesql.execution.evidence import EvidenceContext

        attribution = EvidenceContext()
        sources = attribution.sources
        evidence = list(attribution.records.values())
        outcomes = []
        used_documents = {
            tuple(value) for value in (continuation or {}).get("semantic_document_keys", [])
        }
        deadline = time.monotonic() + budget.limits["dispatch_deadline_seconds"]
        registry = None
        session = None
        score_batch_scope = False
        score_guard_enabled = False
        stage_proofs = {}

        def check_active(*, force=False):
            if budget.cancelled:
                raise SourcesQLError("cancelled", "Run cancelled", "dispatch")
            if score_batch_scope and not force:
                # Only retained in-memory score preparation/consumption occurs
                # here. HTTP batches and publication use a fresh durable guard.
                return receipt
            if force and score_guard_enabled:
                with self.store.db() as db:
                    check_job = getattr(self.store, "_check_job", None)
                    if check_job is not None:
                        check_job(db)
                    row = db.execute("SELECT receipt FROM runs WHERE id=?", (run_id,)).fetchone()
                    if row is None:
                        raise SourcesQLError("not_found", "Run unavailable", "read")
                    current = strict_json(row[0])
                    for parent in parents:
                        actual = self.store._authorize(db, parent["result_id"], set())
                        if parent.get("content_sha256") not in (
                            None,
                            actual["content_sha256"],
                        ):
                            raise SourcesQLError(
                                "evidence_invalid", "Parent content pin mismatch", "dispatch"
                            )
            else:
                current = self.store.run(run_id)
                for parent in parents:
                    self.store.authorize(parent["result_id"])
            if budget.cancelled or current["status"] == "cancelled":
                budget.cancelled = True
                raise SourcesQLError("cancelled", "Run cancelled", "dispatch")
            return current

        def reserved(counter, amount):
            if score_batch_scope and counter in {
                "scoring_documents",
                "cache_hits",
                "checkpoint_hits",
            }:
                # Limits still apply to each in-memory Budget.reserve. These
                # counters authorize no effects; persist their cumulative counts
                # with the next dispatch reservation or final receipt.
                return
            current = check_active(force=score_batch_scope)
            receipt.update(
                counts=dict(budget.counts), receipt_revision=current["receipt_revision"] + 1
            )
            if counter in ("search_requests", "fetches", "model_requests"):
                receipt.setdefault("dispatch_intents", []).append(
                    {"counter": counter, "amount": amount, "reserved_at": now()}
                )
                if profile.get("mode", "fixture") != "fixture":
                    receipt.update(
                        settlement_status="pending",
                        unsettled_requests=len(receipt["dispatch_intents"]),
                    )
            saved = self.store.update_run(receipt)
            if saved["status"] == "cancelled":
                budget.cancelled = True
                raise SourcesQLError("cancelled", "Run cancelled", "dispatch")
            receipt["receipt_revision"] = saved["receipt_revision"]

        budget.on_reserve = reserved

        def capture_provider_state():
            if registry is None:
                return
            events = registry.events
            receipt["provider_events"] = events
            receipt["source_hits"] = [*(continuation or {}).get("source_hits", []), *registry.hits]
            receipt["search_coverage"] = [
                *(continuation or {}).get("search_coverage", []),
                *getattr(getattr(registry, "search_provider", None), "search_coverage", []),
            ]
            attempted = sum(i["amount"] for i in receipt.get("dispatch_intents", []))
            dispatched = [e for e in events if e.get("kind") != "embedding_cache"]
            unresolved = max(0, attempted - len(dispatched)) + sum(
                e.get("status") in ("dispatched", "remote_outcome_unknown") for e in dispatched
            )
            receipt.update(
                settlement_status="pending" if unresolved else "settled",
                unsettled_requests=unresolved,
                semantic_document_keys=sorted(used_documents),
                checkpoints=self.store.stage_summaries(receipt["journal_id"]),
            )

        def stage_begin(operator, arguments, options):
            check_active()
            key = digest([operator, arguments, options, pinned["profile_revision"], parents])
            state, created = self.store.stage_begin(
                receipt["journal_id"], key, retry_not_dispatched=continuation is not None
            )
            if not created:
                if state["status"] == "completed":
                    budget.reserve("checkpoint_hits", limit="unbounded_counter")
                    return key, state["value"]["data"], True
                raise SourcesQLError(
                    "execution_outcome_unknown"
                    if state["status"] in {"intent", "outcome_unknown"}
                    else "storage_unavailable"
                    if state["status"] == "completed_unretained"
                    else (state["error_code"] or "execution_failed"),
                    "A retained effect requires inspection before further work",
                    "dispatch",
                )
            stage_proofs[key] = (
                {id(e) for e in registry.events},
                sum(
                    budget.counts.get(k, 0)
                    for k in ("search_requests", "fetches", "model_requests")
                ),
            )
            return key, None, False

        def stage_finish(key, operator, value):
            try:
                self.store.stage_finish(
                    receipt["journal_id"], key, {"operator": operator, "data": value}
                )
            except Exception:
                # Work returned a response. Persistence failure cannot turn it
                # into an undispatched or safely replayable request.
                try:
                    self.store.stage_fail(
                        receipt["journal_id"],
                        key,
                        "storage_unavailable",
                        False,
                        completed_unretained=True,
                    )
                except Exception:
                    pass  # The original intent still prevents replay.
                raise

        def stage_fail(key, error):
            certainty = getattr(error, "effect_state", None)
            if certainty not in {
                "not_dispatched",
                "rejected",
                "outcome_unknown",
                "completed_unretained",
            }:
                prior_events, attempted = stage_proofs.get(key, (set(), 0))
                states = {e.get("status") for e in registry.events if id(e) not in prior_events}
                current_attempts = sum(
                    budget.counts.get(k, 0)
                    for k in ("search_requests", "fetches", "model_requests")
                )
                certainty = (
                    "outcome_unknown"
                    if getattr(error, "remote_outcome_unknown", False)
                    or states & {"dispatched", "remote_outcome_unknown"}
                    else "completed_unretained"
                    if "completed" in states
                    else "rejected"
                    if "failed" in states
                    else "outcome_unknown"
                    if not states and current_attempts > attempted
                    else "not_dispatched"
                )
            self.store.stage_fail(
                receipt["journal_id"],
                key,
                error.code,
                certainty == "outcome_unknown",
                not_dispatched=certainty == "not_dispatched",
                completed_unretained=certainty == "completed_unretained",
            )

        def checkpoint(operator, arguments, options, work):
            key, value, reused = stage_begin(operator, arguments, options)
            if reused:
                return value, True
            try:
                value = work()
            except SourcesQLError as error:
                stage_fail(key, error)
                raise
            stage_finish(key, operator, value)
            return value, False

        def checked_worker(sql, tables, params):
            check_active()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SourcesQLError("budget_exhausted", "Execution deadline exceeded", "worker")
            worker = session.run_sql if session else self.worker
            return worker(sql, tables, params, timeout=min(30, remaining))

        try:
            attribution.seed(inputs, request.get("inputs", {}), self.store)
            evidence.extend(attribution.records.values())
            registry = ProviderRegistry(profile)
            registry.stage_call = checkpoint
            registry.stage_journal = {
                "begin": stage_begin,
                "finish": stage_finish,
                "fail": stage_fail,
            }
            if self.worker is run_sql:
                session = WorkerSession().__enter__()
            # A new protected process is owned by each query. An earlier
            # session's probe cannot attest that this launch succeeded.
            if session is not None or not self.worker_checked:
                checked_worker("SELECT 1 AS worker_probe", {}, {})
                self.worker_checked = True

            prepared_scores = {}
            durable_scores = set()
            consumed_scores = set()
            score_cache = {}
            score_cache_known = set()

            def prepare_semantic(operator, args, kwargs):
                check_active()
                if time.monotonic() > deadline:
                    raise SourcesQLError(
                        "budget_exhausted", "Dispatch deadline exceeded", "dispatch"
                    )
                context = {k: v for k, v in kwargs.items() if k.startswith("_")}
                options = {k: v for k, v in kwargs.items() if not k.startswith("_")}
                text = args[0]
                instruction = args[1] if len(args) > 1 else ""
                if operator == "SEM_NORM" and not instruction:
                    instruction = "Group equivalent entity names; keep distinct entities separate"
                fields = {k: v for k, v in options.items() if k not in ("type", "evidence")}
                options = {k: v for k, v in options.items() if k in ("type", "evidence")}
                if operator == "SEM_SCORE":
                    options["score_adapter_revision"] = getattr(
                        registry.embedding_provider, "CONTRACT_VERSION", "custom.v1"
                    )
                if operator == "SEM_NORM":
                    options["collection"] = text
                text_hash = (
                    hashlib.sha256(text.encode()).hexdigest()
                    if isinstance(text, str)
                    else digest(text)
                )
                source = attribution.source_for(context.get("_input_lineage", []), text)
                if source:
                    window = source.get(
                        "_input_window", {"start": 0, "end": len(source["content"])}
                    )
                    options.update(
                        source_version_id=source["source_version_id"],
                        document_id=source.get("document_id"),
                        source_window_start=window["start"],
                        source_content_sha256=hashlib.sha256(
                            source["content"].encode()
                        ).hexdigest(),
                        source_characters=len(source["content"]),
                    )
                    if request.get(
                        "source_mode", "require_document"
                    ) == "require_document" and not source.get("coverage", {}).get("complete"):
                        raise SourcesQLError(
                            "unsupported_capability",
                            "Document content is required before semantic processing",
                            "semantic",
                        )
                document_key = ("score" if operator == "SEM_SCORE" else "semantic", text_hash)
                if text is not None and document_key not in used_documents:
                    budget.reserve(
                        "scoring_documents" if operator == "SEM_SCORE" else "semantic_documents",
                        limit="max_candidates"
                        if operator == "SEM_SCORE"
                        else "max_semantic_documents",
                    )
                    used_documents.add(document_key)
                cachekey = digest(
                    [operator, text, instruction, fields, options, pinned["profile_revision"]]
                )
                return context, options, fields, text, instruction, source, cachekey

            def dispatch_scores(calls):
                nonlocal score_batch_scope, score_guard_enabled
                previous_scope = score_batch_scope
                score_guard_enabled = True
                score_batch_scope = True
                try:
                    check_active(force=True)
                    values = dispatch_score_batch(calls)
                    check_active(force=True)
                    return values
                finally:
                    score_batch_scope = previous_scope

            def dispatch_score_batch(calls):
                pending = {}
                groups = {}
                for args, kwargs in calls:
                    _, options, _, text, instruction, _, cachekey = prepare_semantic(
                        "SEM_SCORE", args, kwargs
                    )
                    # Source identities bind saved values, not vector batching.
                    scoring_options = {
                        k: v
                        for k, v in options.items()
                        if k
                        not in {
                            "source_version_id",
                            "document_id",
                            "source_window_start",
                            "source_content_sha256",
                            "source_characters",
                        }
                    }
                    group = digest([instruction, scoring_options])
                    entry = groups.setdefault(group, (instruction, scoring_options, {}))
                    entry[2][cachekey] = text
                    if cachekey in pending or cachekey in prepared_scores:
                        continue
                    pending[cachekey] = text
                missing = [key for key in pending if key not in score_cache_known]
                if missing:
                    with self.store.db() as db:
                        # Below SQLite's portable parameter allowance; the same
                        # bounded keyed reads work with native DuckDB storage.
                        for offset in range(0, len(missing), 128):
                            keys = missing[offset : offset + 128]
                            placeholders = ",".join("?" for _ in keys)
                            score_cache.update(
                                db.execute(
                                    "SELECT key,value FROM semantic_cache "
                                    f"WHERE key IN ({placeholders})",
                                    keys,
                                ).fetchall()
                            )
                    score_cache_known.update(missing)
                for cachekey in list(pending):
                    cached = score_cache.get(cachekey)
                    if cached and strict_json(cached).get("status") in {
                        "processed",
                        "unknown",
                        "not_stated",
                    }:
                        pending.pop(cachekey)
                for instruction, options, all_keys in groups.values():
                    check_active()
                    ordered = sorted(all_keys)
                    positions = {key: index for index, key in enumerate(ordered)}
                    # The original complete set, including cached inputs, makes
                    # ranges stable across restart and changing cache coverage.
                    # A sparse failed batch conservatively blocks intervening
                    # unresolved keys; it never permits an uncertain replay.
                    prefix = (
                        "score_"
                        + digest(
                            [
                                ordered,
                                instruction,
                                options,
                                pinned["profile_revision"],
                                parents,
                            ]
                        )[:48]
                        + "_"
                    )
                    for journal_key in self.store.iter_stage_keys(receipt["journal_id"]):
                        if not journal_key.startswith(prefix):
                            continue
                        span = re.fullmatch(r"(\d+)_(\d+)_(\d+)", journal_key[len(prefix) :])
                        if span is None:
                            raise SourcesQLError(
                                "evidence_invalid", "Scoring checkpoint range is invalid", "storage"
                            )
                        first, last, _ = map(int, span.groups())
                        if not 0 <= first <= last < len(ordered):
                            raise SourcesQLError(
                                "evidence_invalid", "Scoring checkpoint range is invalid", "storage"
                            )
                        retained = self.store.stage_read(receipt["journal_id"], journal_key)
                        if retained["status"] == "not_dispatched" and continuation:
                            continue
                        if retained["status"] != "completed":
                            if any(key in pending for key in ordered[first : last + 1]):
                                raise SourcesQLError(
                                    "execution_outcome_unknown"
                                    if retained["status"] in {"intent", "outcome_unknown"}
                                    else (retained["error_code"] or "execution_failed"),
                                    "A retained scoring effect requires inspection before further work",
                                    "dispatch",
                                )
                            continue
                        value = retained["value"]
                        if value.get("operator") != "SEM_SCORE" or not isinstance(
                            value.get("data"), list
                        ):
                            raise SourcesQLError(
                                "evidence_invalid", "Scoring checkpoint is invalid", "storage"
                            )
                        for saved in value["data"]:
                            cachekey = saved.get("key")
                            outcome = saved.get("outcome")
                            if (
                                cachekey not in positions
                                or not first <= positions[cachekey] <= last
                                or not isinstance(outcome, dict)
                                or outcome.get("status") != "processed"
                            ):
                                raise SourcesQLError(
                                    "evidence_invalid", "Scoring checkpoint is invalid", "storage"
                                )
                            if cachekey not in pending:
                                continue
                            restored = SemanticOutcome(**outcome)
                            restored.usage = {
                                **restored.usage,
                                "requests": 0,
                                "input_tokens": 0,
                                "reserved_input_tokens": 0,
                                "state": "checkpoint_reuse",
                            }
                            prepared_scores[cachekey] = restored
                            durable_scores.add(cachekey)
                            pending.pop(cachekey)
                            budget.reserve("checkpoint_hits", limit="unbounded_counter")
                    keys = [key for key in all_keys if key in pending]
                    if not keys:
                        continue
                    active_batch = None
                    persisted = set()
                    unflushed = {}

                    def flush_scores():
                        if not unflushed:
                            return
                        saved = list(unflushed.items())
                        with self.store.db() as db:
                            for offset in range(0, len(saved), 128):
                                batch = saved[offset : offset + 128]
                                placeholders = ",".join("(?,?)" for _ in batch)
                                db.execute(
                                    "INSERT OR REPLACE INTO semantic_cache VALUES " + placeholders,
                                    [
                                        item
                                        for key, value in batch
                                        for item in (key, canonical(value).decode())
                                    ],
                                )
                        durable_scores.update(unflushed)
                        unflushed.clear()

                    def begin_score_batch(indices):
                        nonlocal active_batch
                        check_active(force=True)
                        selected = [positions[keys[index]] for index in indices]
                        ordinal = budget.counts.get("model_requests", 0) + 1
                        journal_key = prefix + f"{min(selected)}_{max(selected)}_{ordinal}"
                        state, created = self.store.stage_begin(
                            receipt["journal_id"],
                            journal_key,
                            retry_not_dispatched=continuation is not None,
                        )
                        if not created:
                            raise SourcesQLError(
                                "execution_outcome_unknown"
                                if state["status"] in {"intent", "outcome_unknown"}
                                else "storage_conflict",
                                "Scoring checkpoint changed before dispatch",
                                "dispatch",
                            )
                        active_batch = {"key": journal_key, "scores": {}}
                        stage_proofs[journal_key] = (
                            {id(e) for e in registry.events},
                            sum(
                                budget.counts.get(k, 0)
                                for k in ("search_requests", "fetches", "model_requests")
                            ),
                        )

                    def persist_score(index, outcome):
                        cachekey = keys[index]
                        if cachekey in persisted or outcome.status != "processed":
                            return
                        value = {
                            "value": outcome.value,
                            "status": outcome.status,
                            "support": outcome.support,
                            "usage": outcome.usage,
                        }
                        unflushed[cachekey] = value
                        if active_batch is not None:
                            active_batch["scores"][cachekey] = value
                        persisted.add(cachekey)

                    def complete_score_batch():
                        nonlocal active_batch
                        if active_batch is not None:
                            stage_finish(
                                active_batch["key"],
                                "SEM_SCORE",
                                [
                                    {"key": key, "outcome": outcome}
                                    for key, outcome in sorted(active_batch["scores"].items())
                                ],
                            )
                            active_batch = None
                        flush_scores()

                    def fail_score_batch(indices, failure):
                        nonlocal active_batch
                        error = SourcesQLError(
                            failure.get("code", "execution_failed"),
                            "Embedding batch failed",
                            "semantic",
                        )
                        setattr(
                            error,
                            "remote_outcome_unknown",
                            failure.get("remote_outcome_unknown") is True,
                        )
                        error.effect_state = failure.get("effect_state")
                        if active_batch is not None:
                            stage_fail(active_batch["key"], error)
                            active_batch = None

                    values = registry.score_many(
                        [pending[key] for key in keys],
                        instruction,
                        {
                            **options,
                            "deadline_monotonic": deadline,
                            "check_active": lambda: check_active(force=True),
                            "on_score_batch_start": begin_score_batch,
                            "on_completed_score": persist_score,
                            "on_score_batch_completed": complete_score_batch,
                            "on_score_batch_failed": fail_score_batch,
                        },
                        budget,
                    )
                    if len(values) != len(keys):
                        raise SourcesQLError(
                            "invalid_output", "Scoring must preserve row identity", "semantic"
                        )
                    # Trusted custom scorers may return one complete batch.
                    for index, outcome in enumerate(values):
                        persist_score(index, outcome)
                    flush_scores()
                    prepared_scores.update(zip(keys, values, strict=True))
                return [dispatch("SEM_SCORE", args, kwargs) for args, kwargs in calls]

            def dispatch(operator, args, kwargs):
                check_active()
                if time.monotonic() > deadline:
                    raise SourcesQLError(
                        "budget_exhausted", "Dispatch deadline exceeded", "dispatch"
                    )
                context = {k: v for k, v in kwargs.items() if k.startswith("_")}
                options = {k: v for k, v in kwargs.items() if not k.startswith("_")}
                if operator == "SOURCE_WINDOW":
                    value, handle = attribution.window(
                        args[0], context.get("_input_lineage", []), args[1], args[2]
                    )
                    if handle and isinstance(context.get("_lineage_output"), dict):
                        context["_lineage_output"][()] = [handle]
                    return value
                if operator in ("WEB_SEARCH", "WEB_FETCH"):
                    options["source_mode"] = request.get("source_mode", "require_document")
                    rows = (
                        registry.search(args, options, budget)
                        if operator == "WEB_SEARCH"
                        else registry.fetch(args, options, budget)
                    )
                    normalized = []
                    for row in rows:
                        if row.get("status") == "fetch_failed":
                            receipt["errors"].append(
                                {
                                    "code": row.get("error_code", "fetch_failed"),
                                    "stage": "fetch",
                                    "safe_message": "Source fetch failed",
                                }
                            )
                            if request.get("partial_policy", "retain_partial") == "strict":
                                raise SourcesQLError(
                                    "provider_unavailable", "Required source fetch failed", "fetch"
                                )
                            continue
                        if isinstance(row.get("content"), str):
                            row.setdefault(
                                "source_version_id",
                                "src_" + hashlib.sha256(row["content"].encode()).hexdigest()[:32],
                            )
                            attribution.add_source(row)
                        normalized.append(row)
                    if rows and not normalized:
                        raise SourcesQLError(
                            "provider_unavailable",
                            "No requested source was acquired",
                            "acquisition",
                        )
                    target = context.get("_lineage_output")
                    if isinstance(target, dict):
                        for index, row in enumerate(normalized, 1):
                            if isinstance(row.get("content"), str):
                                target[(str(index), "content")] = [attribution.source_handle(row)]
                    return normalized
                context, options, fields, text, instruction, source, cachekey = prepare_semantic(
                    operator, args, kwargs
                )
                cached = None
                if operator == "SEM_SCORE" and score_batch_scope and cachekey in score_cache_known:
                    if cachekey in score_cache:
                        cached = (score_cache[cachekey],)
                elif cachekey not in durable_scores:
                    with self.store.db() as db:
                        cached = db.execute(
                            "SELECT value FROM semantic_cache WHERE key=?", (cachekey,)
                        ).fetchone()
                cacheable = {"supported_text", "processed", "not_stated", "unknown", "no_match"}
                if cached and strict_json(cached[0]).get("status") not in cacheable:
                    cached = None
                if operator == "SEM_SCORE" and cachekey in prepared_scores:
                    # A score just persisted by this run still owns its actual
                    # usage. Only later runs or duplicate positions reuse it.
                    cached = None
                if cached:
                    value = strict_json(cached[0])
                    budget.reserve("cache_hits", limit="unbounded_counter")
                    value["usage"] = {
                        "requests": 0,
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cost_microusd": 0,
                        "state": "cache_reuse",
                        "original_usage": value.get("usage", {}),
                        "field_errors": value.get("usage", {}).get("field_errors", []),
                        **{
                            key: value.get("usage", {})[key]
                            for key in (
                                "field_outcomes",
                                "inspected_windows",
                                "input_omitted_characters",
                                "source_characters",
                                "content_sha256",
                                "extraction_capacity",
                            )
                            if key in value.get("usage", {})
                        },
                    }
                else:
                    outcome = prepared_scores.get(cachekey) if operator == "SEM_SCORE" else None
                    if outcome is None:
                        if operator == "SEM_SCORE":
                            outcome = registry.semantic(
                                operator, text, instruction, fields, options, budget
                            )
                        else:

                            def semantic_work():
                                result = registry.semantic(
                                    operator,
                                    text,
                                    instruction,
                                    fields,
                                    {**options, "deadline_monotonic": deadline},
                                    budget,
                                )
                                return {
                                    "value": result.value,
                                    "status": result.status,
                                    "support": result.support,
                                    "usage": result.usage,
                                }

                            saved, reused = checkpoint(
                                operator, [text, instruction, fields], options, semantic_work
                            )
                            outcome = SemanticOutcome(**saved)
                            if reused:
                                outcome.usage = {
                                    **outcome.usage,
                                    "requests": 0,
                                    "state": "checkpoint_reuse",
                                }
                    elif cachekey in consumed_scores:
                        # Reusing a failed batch outcome must not retry or charge usage twice.
                        from dataclasses import replace

                        outcome = replace(
                            outcome,
                            usage={
                                **outcome.usage,
                                "requests": 0,
                                "input_tokens": 0,
                                "reserved_input_tokens": 0,
                                "state": "run_reuse",
                            },
                        )
                    consumed_scores.add(cachekey)
                    value = {
                        "value": outcome.value,
                        "status": outcome.status,
                        "support": outcome.support,
                        "usage": outcome.usage,
                    }
                    if source:
                        for support in value["support"]:
                            start, end = support.get("start"), support.get("end")
                            if (
                                type(start) is not int
                                or type(end) is not int
                                or not 0 <= start < end <= len(source["content"])
                                or source["content"][start:end] != support.get("quote")
                            ):
                                raise SourcesQLError(
                                    "evidence_invalid",
                                    "Supporting text span does not match inspected source",
                                    "semantic",
                                )
                    if value["status"] in cacheable and cachekey not in durable_scores:
                        with self.store.db() as db:
                            db.execute(
                                "INSERT OR REPLACE INTO semantic_cache VALUES(?,?)",
                                (cachekey, canonical(value).decode()),
                            )
                outcomes.append(
                    {
                        "operator": operator,
                        "source_version_id": source.get("source_version_id") if source else None,
                        "status": value["status"],
                        "field_errors": (value.get("usage") or {}).get("field_errors", []),
                        "field": context.get("_output_field"),
                        "support": value["support"],
                        "extraction_capacity": (value.get("usage") or {}).get(
                            "extraction_capacity"
                        ),
                        "inspected_windows": (value.get("usage") or {}).get(
                            "inspected_windows", []
                        ),
                        "input_omitted_characters": (value.get("usage") or {}).get(
                            "input_omitted_characters"
                        ),
                        "inspected_input": text
                        if source is None and isinstance(text, str)
                        else None,
                    }
                )
                receipt["usage"].append(
                    value.get("usage")
                    or {"state": "unavailable", "cost_microusd": None, "basis": "not_reported"}
                )
                target = context.get("_lineage_output")
                if isinstance(target, dict):
                    attribution.record_outcome(
                        {
                            "operator": operator,
                            "status": value["status"],
                            "source_version_id": source.get("source_version_id")
                            if source
                            else None,
                            "usage": value.get("usage") or {},
                            "field_errors": (value.get("usage") or {}).get("field_errors", []),
                        },
                        value["value"],
                        fields,
                        target,
                    )
                if value["support"]:
                    base = {
                        "evidence_id": "e_" + uuid.uuid4().hex,
                        "operator": operator,
                        "field": context.get("_output_field"),
                        "source_version_id": source.get("source_version_id") if source else None,
                        "support": value["support"],
                        "status": value["status"],
                        "semantic_truth_verified": False,
                        "inspected_input": text
                        if source is None and isinstance(text, str)
                        else None,
                    }
                    target = context.get("_lineage_output")
                    records = (
                        attribution.record(base, fields, target) if isinstance(target, dict) else []
                    )
                    evidence.extend(records or [base])
                if (
                    value["status"]
                    in (
                        "failed",
                        "not_processed",
                        "unprocessed",
                        "evidence_invalid",
                        "invalid_output",
                    )
                    or (value.get("usage") or {}).get("field_errors")
                ) and request.get("partial_policy", "retain_partial") == "strict":
                    field_errors = (value.get("usage") or {}).get("field_errors") or []
                    if field_errors:
                        code = field_errors[0].get("code")
                        if code not in {"invalid_output", "evidence_invalid"}:
                            code = "invalid_output"
                        raise SourcesQLError(
                            code, "Required semantic field is unavailable", "semantic"
                        )
                    failure = (value.get("usage") or {}).get("failure") or {}
                    failure_messages = {
                        "provider_timeout": "Semantic model request timed out",
                        "provider_connection_error": "Semantic model connection failed",
                        "provider_http_error": "Semantic model provider rejected the request",
                        "provider_error": "Semantic model request failed",
                        "provider_unavailable": "Semantic provider is unavailable",
                    }
                    if failure.get("code") in failure_messages:
                        raise SourcesQLError(
                            failure["code"], failure_messages[failure["code"]], "semantic"
                        )
                    validation = (value.get("usage") or {}).get("validation_error") or {}
                    if validation.get("code") in {"invalid_output", "evidence_invalid"}:
                        raise SourcesQLError(validation["code"], validation["message"], "semantic")
                    raise SourcesQLError(
                        "invalid_output", "Required semantic processing failed", "semantic"
                    )
                return value["value"]

            def semantic_batch(operator, calls):
                # Each completed effect is durable before the next call starts. A
                # later deadline can continue without repeating completed work.
                return [dispatch(operator, args, kwargs) for args, kwargs in calls]

            def before_dispatch():
                # The executor invokes this only after its canonical binding
                # pass, before acquisition, scoring or semantic provider work.
                check_active()
                if self.before_dispatch is not None:
                    self.before_dispatch(
                        {
                            "plan": strict_json(canonical(getattr(plan, "explain", {}))),
                            "effective_limits": dict(budget.limits),
                            "profile": request.get("profile", "fixture"),
                            "mode": profile.get("mode", "fixture"),
                            "external_calls": 0,
                        }
                    )
                check_active()
                registry.preflight(plan.custom_operators, budget)

            table = execute_plan(
                plan,
                inputs,
                dispatch,
                checked_worker,
                score_batch=dispatch_scores,
                semantic_batch=semantic_batch,
                on_validated=before_dispatch,
            )
            if (
                len(table.rows) > budget.limits["max_output_rows"]
                or len(canonical(table.to_dict())) > budget.limits["max_output_bytes"]
            ):
                raise SourcesQLError(
                    "budget_exhausted", "Full result exceeds publication allowance", "publish"
                )
            if budget.cancelled:
                raise SourcesQLError("cancelled", "Run cancelled", "publish")
            partial = bool(receipt["errors"]) or any(
                o["status"]
                in ("failed", "not_processed", "unprocessed", "evidence_invalid", "invalid_output")
                or bool(o.get("field_errors"))
                for o in outcomes
            )
            capture_provider_state()
            receipt["usage"].extend(
                e["usage"]
                for e in registry.events
                if "usage" in e and e.get("kind") in ("search", "fetch")
            )
            receipt.update(
                status="partial" if partial else "completed",
                finished_at=now(),
                plan_complete=not partial,
                counts=budget.counts,
                receipt_revision=self.store.run(run_id)["receipt_revision"] + 1,
            )
            receipt["result_id"] = "wq_" + uuid.uuid4().hex
            row_ids = ["row_" + uuid.uuid4().hex for _ in table.rows]
            if request.get("row_id_column"):
                column = request["row_id_column"]
                parent_ids = {
                    rid for p in parents for rid in self.store.authorize(p["result_id"])["row_ids"]
                }
                row_ids = [row.get(column) for row in table.rows]
                if (
                    not row_ids
                    or len(set(row_ids)) != len(row_ids)
                    or not all(rid in parent_ids for rid in row_ids)
                ):
                    raise SourcesQLError(
                        "invalid_output",
                        "Explicit row identities must uniquely reference authorized input rows",
                        "publish",
                    )
                table = Table(
                    [c for c in table.columns if c.key != column],
                    [{k: v for k, v in row.items() if k != column} for row in table.rows],
                    [
                        {path: refs for path, refs in tags.items() if path[0] != column}
                        for tags in table.lineage
                    ],
                )
            evidence, source_bindings, bound_cells, cell_diagnostics = attribution.bind(
                table, row_ids, evidence
            )
            requirements = validate_requirements(
                request.get("research_requirements"), table.columns
            )
            quality = assess_requirements(table, row_ids, cell_diagnostics, requirements)
            receipt["query_feedback"] = observe_result(receipt["query_feedback"], table)
            receipt["goal_status"] = quality["goal_status"]
            receipt["research_quality"] = quality
            with self.lock:
                if budget.cancelled:
                    raise SourcesQLError("cancelled", "Run cancelled", "publish")
                if score_guard_enabled:
                    check_active(force=True)
                result_classification = (
                    classification
                    if classification == "private_derived"
                    else (
                        "synthetic_fixture"
                        if profile.get("mode", "fixture") == "fixture"
                        else "public_web"
                    )
                )
                meta = self.store.commit(
                    table,
                    {
                        "result_id": receipt["result_id"],
                        "run_id": run_id,
                        "parents": parents,
                        "row_ids": row_ids,
                        "data_classification": result_classification,
                        "query": request["query"],
                        "parameters": request.get("parameters", {}),
                        "query_sha256": digest(request["query"]),
                        "profile_revision": pinned["profile_revision"],
                        "receipt_id": receipt["receipt_id"],
                        "receipt_revision": 1,
                        "receipt": {**receipt, "data_classification": result_classification},
                        "source_versions": list(sources.values()),
                        "evidence": evidence,
                        "operator_outcomes": outcomes,
                        "lineage_precision": "cell_where_proven" if bound_cells else "input_set",
                        "bound_evidence_cells": bound_cells,
                        "source_bindings": source_bindings,
                        "cell_diagnostics": cell_diagnostics,
                        "research_requirements": requirements,
                        "research_quality": quality,
                        "query_feedback": receipt["query_feedback"],
                        "replay_level": "recomputable_inputs" if sources else "values_only",
                        "created_at": receipt["finished_at"],
                    },
                )
            return self.read_result(meta["result_id"])
        except SourcesQLError as error:
            capture_provider_state()
            current = self.store.run(run_id)
            receipt.update(
                status="cancelled"
                if budget.cancelled or current["status"] == "cancelled" or error.code == "cancelled"
                else "failed",
                finished_at=now(),
                result_id=None,
                plan_complete=False,
                counts=budget.counts,
                receipt_revision=current["receipt_revision"] + 1,
                errors=[
                    {"code": error.code, "stage": error.stage, "safe_message": error.safe_message}
                ],
            )
            self.store.update_run(receipt)
            raise
        except Exception as error:
            capture_provider_state()
            current = self.store.run(run_id)
            if current.get("result_id"):
                return self.read_result(current["result_id"])
            receipt.update(
                status="cancelled"
                if budget.cancelled or current["status"] == "cancelled"
                else "failed",
                finished_at=now(),
                result_id=None,
                plan_complete=False,
                counts=budget.counts,
                receipt_revision=current["receipt_revision"] + 1,
                errors=[
                    {
                        "code": "execution_failed",
                        "stage": "execution",
                        "safe_message": "Execution failed",
                    }
                ],
            )
            self.store.update_run(receipt)
            raise SourcesQLError("execution_failed", "Execution failed", "execution") from error
        finally:
            self.active.pop(run_id, None)
            if session:
                session.__exit__(None, None, None)

    def read_result(self, result_id, offset=0, limit=100, columns=None):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise SourcesQLError("invalid_request", "Invalid page bounds", "read")
        meta = self.store.authorize(result_id)
        if not self.allow_private and meta.get("data_classification") in (
            "private_local",
            "private_derived",
        ):
            raise SourcesQLError("unauthorized", "This launcher cannot access private data", "read")
        meta, table = self.store.read(result_id)
        selected = [c for c in table.columns if columns is None or c.key in columns]
        if columns is not None and len(selected) != len(columns):
            raise SourcesQLError("invalid_request", "Unknown selected column", "read")
        rows = [
            {c.key: wire_value(row[c.key], c.logical_type) for c in selected}
            for row in table.rows[offset : offset + limit]
        ]
        latest_receipt = (
            self.store.run(meta["run_id"]) if meta.get("run_id") else meta.get("receipt")
        )
        return {
            **meta,
            "columns": [c.to_dict() for c in selected],
            "rows": rows,
            "row_ids": meta["row_ids"][offset : offset + limit],
            "offset": offset,
            "next_offset": offset + limit if offset + limit < len(table.rows) else None,
            "latest_receipt": latest_receipt,
            "source_versions": meta.get("source_versions", []),
            "evidence": meta.get("evidence", []),
        }

    def _normalize_import(
        self,
        columns,
        rows,
        row_ids=None,
        data_classification="private_local",
        provenance=None,
        parents=None,
    ):
        if data_classification not in (
            "public_web",
            "private_local",
            "private_derived",
            "synthetic_fixture",
        ):
            raise SourcesQLError("invalid_request", "Invalid classification")
        if not self.allow_private and data_classification in ("private_local", "private_derived"):
            raise SourcesQLError("unauthorized", "This launcher cannot import private data")
        table = validate_table(columns, rows, row_ids)
        provenance = provenance or {}
        parents = parents or []
        if provenance.get("engine_result_id") and not parents:
            parents = [{"result_id": provenance["engine_result_id"]}]
        for p in parents:
            meta = self.store.authorize(p["result_id"])
            p.update(content_sha256=meta["content_sha256"])
            if meta["data_classification"] in ("private_local", "private_derived"):
                data_classification = "private_derived"
        if not self.allow_private and data_classification in ("private_local", "private_derived"):
            raise SourcesQLError("unauthorized", "This launcher cannot derive private data")
        identity = digest([table.to_dict(), row_ids, data_classification, provenance, parents])
        return table, data_classification, provenance, parents, identity

    def import_table(
        self,
        columns,
        rows,
        row_ids=None,
        data_classification="private_local",
        provenance=None,
        parents=None,
    ):
        table, data_classification, provenance, parents, identity = self._normalize_import(
            columns, rows, row_ids, data_classification, provenance, parents
        )
        stamp = now()
        run_id = "run_import_" + identity[:32]
        receipt = {
            "run_id": run_id,
            "request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, identity)),
            "receipt_id": "receipt_import_" + identity[:32],
            "receipt_revision": 1,
            "status": "completed",
            "settlement_status": "settled",
            "unsettled_requests": 0,
            "started_at": stamp,
            "finished_at": stamp,
            "plan_complete": True,
            "result_id": "wq_import_" + identity[:32],
            "counts": {"output_rows": len(rows)},
            "usage": [],
            "warnings": [],
            "errors": [],
            "goal_status": "not_evaluated",
            "data_classification": data_classification,
            "parents": parents,
        }
        pending = {
            **receipt,
            "status": "running",
            "finished_at": None,
            "result_id": None,
            "plan_complete": False,
            "data_classification": data_classification,
            "parents": parents,
        }
        self.store.begin_run(
            {"request_id": receipt["request_id"], "import_digest": identity}, pending
        )
        try:
            self.store.commit(
                table,
                {
                    "result_id": "wq_import_" + identity[:32],
                    "run_id": run_id,
                    "parents": parents,
                    "data_classification": data_classification,
                    "provenance": provenance,
                    "row_ids": row_ids
                    or ["row_" + digest([identity, i])[:32] for i in range(len(rows))],
                    "created_at": stamp,
                    "receipt": receipt,
                    "lineage_precision": "input_set",
                    "replay_level": "values_only",
                },
            )
        except SourcesQLError:
            pending.update(status="failed", finished_at=now())
            self.store.update_run(pending)
            raise
        return self.read_result("wq_import_" + identity[:32])

    def export(self, result_id):
        records = {}

        def include(rid):
            meta = self.store.authorize(rid)
            if not self.allow_private and meta.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError("unauthorized", "This launcher cannot export private data")
            meta, table = self.store.read(rid)
            for parent in meta.get("parents", []):
                if parent["result_id"] not in records:
                    include(parent["result_id"])
            records[rid] = {"metadata": meta, "table": table.to_dict()}

        include(result_id)
        body = {
            "format": "sourcesql.engine-bundle.v1",
            "root_result_id": result_id,
            "results": records,
        }
        return {**body, "content_sha256": digest(body)}

    def import_bundle(self, bundle):
        if isinstance(bundle, dict) and bundle.get("format") == "sourcesql.remote-archive.v1":
            from sourcesql.storage.archive import decode_remote_archive

            bundle = decode_remote_archive(bundle)
        if (
            not isinstance(bundle, dict)
            or set(bundle) != {"format", "root_result_id", "results", "content_sha256"}
            or bundle.get("format")
            not in {"sourcesql.engine-bundle.v1", "open-webql.engine-bundle.v1"}
        ):
            raise SourcesQLError("invalid_request", "Invalid bundle")
        body = {k: v for k, v in bundle.items() if k != "content_sha256"}
        if digest(body) != bundle["content_sha256"] or len(canonical(body)) > 16 * 1024 * 1024:
            raise SourcesQLError("evidence_invalid", "Bundle integrity or size invalid")
        results = bundle["results"]
        mapping = {}
        visiting = set()
        classifications = {}
        if (
            not isinstance(results, dict)
            or len(results) > 64
            or bundle["root_result_id"] not in results
        ):
            raise SourcesQLError("invalid_request", "Invalid bundle closure")

        def check(rid):
            if rid in visiting:
                raise SourcesQLError("invalid_request", "Cyclic imported graph")
            record = results[rid]
            meta = record["metadata"]
            table = record["table"]
            if meta.get("result_id") != rid:
                raise SourcesQLError("evidence_invalid", "Bundle record identity mismatch")
            if digest(table) != meta["content_sha256"]:
                raise SourcesQLError("evidence_invalid", "Invalid result digest")
            validate_table(table["columns"], table["rows"], meta["row_ids"])
            classification = meta.get("data_classification")
            if classification not in (
                "private_local",
                "private_derived",
                "synthetic_fixture",
                "public_web",
            ):
                raise SourcesQLError("invalid_request", "Invalid imported classification")
            if not self.allow_private and meta.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError("unauthorized", "This launcher cannot import private data")
            with self.store.db() as db:
                known = db.execute("SELECT 1 FROM results WHERE id=?", (rid,)).fetchone()
            if known:
                self.store.authorize(rid)
            for source in meta.get("source_versions", []):
                if isinstance(source.get("content"), str) and hashlib.sha256(
                    source["content"].encode()
                ).hexdigest() != source.get("content_sha256"):
                    raise SourcesQLError("evidence_invalid", "Source content hash mismatch")
            visiting.add(rid)
            for p in meta.get("parents", []):
                if p["result_id"] not in results:
                    raise SourcesQLError("invalid_request", "Missing result ancestor")
                if p.get("content_sha256") != results[p["result_id"]]["metadata"]["content_sha256"]:
                    raise SourcesQLError("evidence_invalid", "Parent content pin mismatch")
                check(p["result_id"])
                if classifications[p["result_id"]] in ("private_local", "private_derived"):
                    classification = "private_derived"
            visiting.remove(rid)
            classifications[rid] = classification

        for rid in results:
            check(rid)
        source_texts = {}
        for record in results.values():
            for source in record["metadata"].get("source_versions", []):
                sid, text = source.get("source_version_id"), source.get("content")
                if isinstance(text, str):
                    if sid in source_texts and source_texts[sid] != text:
                        raise SourcesQLError(
                            "evidence_invalid", "Conflicting imported source identity"
                        )
                    source_texts[sid] = text
        for record in results.values():
            for item in record["metadata"].get("evidence", []) + record["metadata"].get(
                "operator_outcomes", []
            ):
                text = source_texts.get(item.get("source_version_id")) or item.get(
                    "inspected_input"
                )
                if (
                    item.get("support")
                    and item.get("source_version_id")
                    and item["source_version_id"] not in source_texts
                ):
                    raise SourcesQLError(
                        "evidence_invalid", "Imported source support requires retained source text"
                    )
                for support in item.get("support", []):
                    start, end = support.get("start"), support.get("end")
                    window = support.get(
                        "inspected_window",
                        {"start": 0, "end": len(text) if isinstance(text, str) else 0},
                    )
                    if (
                        not isinstance(text, str)
                        or type(start) is not int
                        or type(end) is not int
                        or not 0 <= start < end <= len(text)
                        or text[start:end] != support.get("quote")
                        or type(window.get("start")) is not int
                        or type(window.get("end")) is not int
                        or not 0 <= window["start"] <= start < end <= window["end"] <= len(text)
                    ):
                        raise SourcesQLError(
                            "evidence_invalid", "Imported support span does not match retained text"
                        )
        mapping = {
            rid: "wq_restore_" + digest([bundle["content_sha256"], rid])[:32] for rid in results
        }
        prepared = []
        for rid, record in results.items():
            meta = record["metadata"]
            table = record["table"]
            stamp = now()
            local_id = mapping[rid]
            parents = [{**p, "result_id": mapping[p["result_id"]]} for p in meta.get("parents", [])]
            original_receipt = meta.get("receipt", {})
            receipt = {
                "run_id": "run_restore_" + digest([bundle["content_sha256"], rid])[:32],
                "request_id": str(uuid.uuid5(uuid.NAMESPACE_URL, local_id)),
                "receipt_id": "receipt_restore_" + digest(local_id)[:32],
                "receipt_revision": 1,
                "status": "partial" if original_receipt.get("status") == "partial" else "completed",
                "settlement_status": "settled",
                "unsettled_requests": 0,
                "started_at": stamp,
                "finished_at": stamp,
                "plan_complete": original_receipt.get("plan_complete", True),
                "result_id": local_id,
                "counts": {"output_rows": len(table["rows"])},
                "usage": [],
                "warnings": ["Imported retained data without provider work"],
                "errors": [],
                "data_classification": classifications[rid],
                "parents": parents,
                "goal_status": "not_evaluated",
            }
            imported_meta = {
                **meta,
                "result_id": local_id,
                "run_id": receipt["run_id"],
                "parents": parents,
                "receipt": receipt,
                "data_classification": classifications[rid],
                "receipt_id": receipt["receipt_id"],
                "receipt_revision": 1,
                "foreign_receipt": original_receipt,
                "provenance": {
                    **meta.get("provenance", {}),
                    "foreign_result_id": rid,
                    "bundle_sha256": bundle["content_sha256"],
                },
                "created_at": stamp,
            }
            prepared.append(
                (validate_table(table["columns"], table["rows"], meta["row_ids"]), imported_meta)
            )
        self.store.commit_many(
            prepared, root_result_id=mapping[bundle["root_result_id"]], result_mapping=mapping
        )
        result = self.read_result(mapping[bundle["root_result_id"]])
        result["result_mapping"] = mapping
        return result

    def run_status(self, run_id):
        receipt = self.store.run(run_id)
        if not self.allow_private and receipt.get("data_classification") in (
            "private_local",
            "private_derived",
        ):
            raise SourcesQLError("unauthorized", "This launcher cannot read private run metadata")
        for parent in receipt.get("parents", []):
            ancestor = self.store.authorize(parent["result_id"])
            if not self.allow_private and ancestor.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError(
                    "unauthorized", "This launcher cannot read private run metadata"
                )
        if receipt.get("result_id"):
            result = self.store.authorize(receipt["result_id"])
            if not self.allow_private and result.get("data_classification") in (
                "private_local",
                "private_derived",
            ):
                raise SourcesQLError(
                    "unauthorized", "This launcher cannot read private run metadata"
                )
        return receipt

    def cancel(self, run_id):
        receipt = self.run_status(run_id)
        if receipt["status"] in ("completed", "partial", "failed", "cancelled"):
            return receipt
        with self.lock:
            receipt = self.store.run(run_id)
            if receipt["status"] in ("completed", "partial", "failed", "cancelled"):
                return receipt
            if run_id in self.active:
                self.active[run_id].cancelled = True
            receipt.update(
                status="cancelled",
                finished_at=now(),
                plan_complete=False,
                result_id=None,
                receipt_revision=receipt["receipt_revision"] + 1,
            )
            return self.store.update_run(receipt)
