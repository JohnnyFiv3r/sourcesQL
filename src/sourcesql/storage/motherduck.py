"""Durable engine records in an owner-scoped MotherDuck schema.

Only the credential-bearing coordinator uses this connection. Relational SQL
still runs in the credential-free OS worker, never against this connection.
The SQLite store's control/authorization semantics are shared; immutable table
bytes and wire-format bytes replace local files here.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from sourcesql.contracts import Table, Column, SourcesQLError, canonical, digest
from sourcesql.storage.store import Store

TABLES = (
    "CREATE TABLE IF NOT EXISTS usage_notice_dismissals(id VARCHAR PRIMARY KEY,dismissed_at VARCHAR NOT NULL)",
    "CREATE TABLE IF NOT EXISTS usage_flights(run_id VARCHAR PRIMARY KEY,job_id UUID NOT NULL,started_at VARCHAR NOT NULL,ended_at VARCHAR NOT NULL,elapsed_seconds DOUBLE NOT NULL,instance_type VARCHAR NOT NULL)",
    "CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY, namespace VARCHAR NOT NULL, revision BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS results(id VARCHAR PRIMARY KEY, hash VARCHAR NOT NULL, metadata VARCHAR NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, payload VARCHAR NOT NULL, wire_payload VARCHAR NOT NULL, wire_hash VARCHAR NOT NULL)",
    "CREATE TABLE IF NOT EXISTS runs(id VARCHAR PRIMARY KEY, request_id VARCHAR UNIQUE NOT NULL, request_hash VARCHAR NOT NULL, receipt VARCHAR NOT NULL)",
    "CREATE TABLE IF NOT EXISTS semantic_cache(key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)",
    "CREATE TABLE IF NOT EXISTS execution_stages(journal_id VARCHAR NOT NULL, stage_key VARCHAR NOT NULL, status VARCHAR NOT NULL, value_json VARCHAR, error_code VARCHAR, PRIMARY KEY(journal_id,stage_key))",
    "CREATE TABLE IF NOT EXISTS jobs(id UUID PRIMARY KEY, request_id UUID UNIQUE NOT NULL, operation VARCHAR NOT NULL, request_hash VARCHAR NOT NULL, request_json VARCHAR NOT NULL, status VARCHAR NOT NULL, created_at VARCHAR NOT NULL, updated_at VARCHAR NOT NULL, flight_id UUID NOT NULL, flight_version INTEGER, flight_run_id UUID, flight_run_number UBIGINT, dispatch_intent_at VARCHAR, claim_token UUID, engine_run_id VARCHAR, result_id VARCHAR, cancel_requested BOOLEAN NOT NULL DEFAULT false, error_code VARCHAR, error_message VARCHAR, max_runtime_sec INTEGER NOT NULL, output_json VARCHAR, flight_settled BOOLEAN NOT NULL DEFAULT false, flight_invalid BOOLEAN NOT NULL DEFAULT false, provider_policy_sha256 VARCHAR, provider_cost_reserved_microusd BIGINT NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS flight_allowances(day VARCHAR PRIMARY KEY, reserved_seconds BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS provider_allowances(day VARCHAR PRIMARY KEY, reserved_microusd BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY, revision BIGINT NOT NULL, state_json VARCHAR NOT NULL)",
    "CREATE TABLE IF NOT EXISTS app_state_history(revision BIGINT PRIMARY KEY, state_json VARCHAR NOT NULL, created_at VARCHAR NOT NULL)",
)


MIGRATIONS = (
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS provider_policy_sha256 VARCHAR",
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS provider_cost_reserved_microusd BIGINT DEFAULT 0",
)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def schema_for(namespace: str) -> str:
    if not isinstance(namespace, str) or not re.fullmatch(r"[a-f0-9]{64}", namespace):
        raise SourcesQLError("invalid_request", "Invalid configured storage owner", "storage")
    return "sourcesql_" + namespace[:32]


class Transaction:
    """Serialize mutations by touching one owner control row within the transaction."""

    def __init__(self, connection):
        self.connection = connection
        self.writing = False

    def write(self):
        if not self.writing:
            self.connection.execute("UPDATE control SET revision=revision+1 WHERE id=1")
            self.writing = True

    def execute(self, sql, parameters=None):
        if sql == "BEGIN IMMEDIATE":
            self.write()
            return self
        if not sql.lstrip().upper().startswith("SELECT"):
            self.write()
        return self.connection.execute(sql, parameters or [])


class MotherDuckStore(Store):
    def __init__(
        self,
        database: str,
        namespace: str,
        schema: str | None = None,
        quota: int = 100 * 1024 * 1024,
        connector=None,
    ):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", database):
            raise SourcesQLError("invalid_request", "Invalid configured database", "storage")
        expected = schema_for(namespace)
        if schema not in (None, expected):
            raise SourcesQLError("unauthorized", "Storage owner/schema mismatch", "storage")
        self.database, self.namespace, self.schema = database, namespace, expected
        self.quota, self.root = quota, Path("/nonexistent-sourcesql-remote-store")
        self.job_id: str | None = None
        self.claim_token: str | None = None
        self.remote = connector is None
        if connector is None:
            import duckdb

            def connector():
                return duckdb.connect("md:" + database)

        self.connector = connector
        con = self.connector()
        try:
            con.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.schema}"')
            con.execute(f"SET schema='{self.schema}'")
            for sql in (*TABLES, *MIGRATIONS):
                con.execute(sql)
            con.execute("INSERT OR IGNORE INTO control VALUES(1,?,0)", [namespace])
            if con.execute("SELECT namespace FROM control WHERE id=1").fetchone()[0] != namespace:
                raise SourcesQLError("unauthorized", "Storage owner mismatch", "storage")
        finally:
            con.close()
        self.initialize_stage_journal()

    @contextmanager
    def db(self):
        import duckdb

        con = self.connector()
        try:
            con.execute(f"SET schema='{self.schema}'")
            con.execute("BEGIN TRANSACTION")
            transaction = Transaction(con)
            yield transaction
            con.execute("COMMIT")
        except SourcesQLError:
            con.execute("ROLLBACK")
            raise
        except duckdb.Error as error:
            try:
                con.execute("ROLLBACK")
            except duckdb.Error:
                pass
            code = (
                "storage_conflict"
                if isinstance(error, duckdb.TransactionException)
                else "storage_unavailable"
            )
            raise SourcesQLError(
                code, "Durable storage operation failed safely", "storage"
            ) from None
        finally:
            con.close()

    def retained_size(self, db):
        return db.execute(
            "SELECT coalesce(sum(octet_length(encode(metadata))+octet_length(encode(payload))+octet_length(encode(wire_payload))),0) FROM results"
        ).fetchone()[0] + self.stage_bytes(db)

    def _job(self, db, job_id):
        identity = str(uuid.UUID(job_id))
        cursor = db.execute("SELECT * FROM jobs WHERE id=?::UUID", [identity])
        row = cursor.fetchone()
        if row is None:
            raise SourcesQLError("not_found", "Job unavailable", "jobs")
        return dict(zip([item[0] for item in cursor.description], row))

    def bind_job(self, job_id, claim_token):
        self.job_id, self.claim_token = str(uuid.UUID(job_id)), str(uuid.UUID(claim_token))

    def _check_job(self, db):
        if self.job_id is None:
            return
        job = self._job(db, self.job_id)
        if job["cancel_requested"] or job["status"] == "cancelled":
            raise SourcesQLError("cancelled", "Job cancelled", "jobs")
        if str(job["claim_token"]) != self.claim_token or job["status"] != "running":
            raise SourcesQLError("unauthorized", "Job execution ownership unavailable", "jobs")

    def begin_run(self, request, receipt):
        identity = digest(request)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._check_job(db)
            previous = db.execute(
                "SELECT request_hash,receipt FROM runs WHERE request_id=?", [request["request_id"]]
            ).fetchone()
            if previous:
                if previous[0] != identity:
                    raise SourcesQLError(
                        "idempotency_conflict", "Request key already has different inputs"
                    )
                return json.loads(previous[1]), False
            db.execute(
                "INSERT INTO runs VALUES(?,?,?,?)",
                [receipt["run_id"], request["request_id"], identity, canonical(receipt).decode()],
            )
            if self.job_id:
                db.execute(
                    "UPDATE jobs SET engine_run_id=?,updated_at=? WHERE id=?::UUID",
                    [receipt["run_id"], timestamp(), self.job_id],
                )
        return receipt, True

    def _prepare(self, table, metadata):
        from sourcesql.engine import wire_value

        value = table.to_dict()
        payload = canonical(value).decode()
        rid = metadata.get("result_id") or "wq_" + uuid.uuid4().hex
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", rid):
            raise SourcesQLError("invalid_request", "Invalid result identity", "publish")
        metadata = {
            **metadata,
            "result_id": rid,
            "content_sha256": digest(value),
            "row_count": len(table.rows),
            "columns": value["columns"],
        }
        metadata.setdefault("row_ids", ["row_" + uuid.uuid4().hex for _ in table.rows])
        if (
            len(metadata["row_ids"]) != len(table.rows)
            or any(not isinstance(x, str) for x in metadata["row_ids"])
            or len(set(metadata["row_ids"])) != len(table.rows)
        ):
            raise SourcesQLError("invalid_output", "Invalid row identities", "publish")
        wire = canonical(
            {
                "columns": value["columns"],
                "rows": [
                    {
                        column.key: wire_value(row[column.key], column.logical_type)
                        for column in table.columns
                    }
                    for row in table.rows
                ],
            }
        ).decode()
        return metadata, payload, wire, hashlib.sha256(wire.encode()).hexdigest()

    def commit(self, table, metadata):
        metadata, payload, wire, wire_hash = self._prepare(table, metadata)
        rid = metadata["result_id"]
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._check_job(db)
            current = None
            if metadata.get("run_id"):
                row = db.execute(
                    "SELECT receipt FROM runs WHERE id=?", [metadata["run_id"]]
                ).fetchone()
                if row:
                    current = json.loads(row[0])
                    if current["status"] == "cancelled":
                        raise SourcesQLError("cancelled", "Run cancelled", "publish")
                    if current["status"] == "failed":
                        raise SourcesQLError(
                            "invalid_output", "Failed run cannot publish", "publish"
                        )
                    if metadata.get("receipt"):
                        metadata["receipt"] = {
                            **metadata["receipt"],
                            "receipt_revision": current["receipt_revision"] + 1,
                        }
                        metadata["receipt_revision"] = metadata["receipt"]["receipt_revision"]
            for parent in metadata.get("parents", []):
                actual = self._authorize(db, parent["result_id"], set())
                if parent.get("content_sha256") not in (None, actual["content_sha256"]):
                    raise SourcesQLError(
                        "evidence_invalid", "Parent content pin mismatch", "publish"
                    )
            existing = db.execute(
                "SELECT hash,metadata,revoked FROM results WHERE id=?", [rid]
            ).fetchone()
            if existing:
                if existing[0] != metadata["content_sha256"] or existing[2]:
                    raise SourcesQLError(
                        "idempotency_conflict", "Result identity conflict", "publish"
                    )
                retained = self._authorize(db, rid, set())
                if self.job_id:
                    db.execute(
                        "UPDATE jobs SET status='completed',result_id=?,engine_run_id=?,updated_at=? WHERE id=?::UUID",
                        [rid, retained["run_id"], timestamp(), self.job_id],
                    )
                return retained
            if (
                self.retained_size(db)
                + len(payload.encode())
                + len(wire.encode())
                + len(canonical(metadata))
                > self.quota
            ):
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted", "publish")
            db.execute(
                "INSERT INTO results VALUES(?,?,?,0,?,?,?)",
                [
                    rid,
                    metadata["content_sha256"],
                    canonical(metadata).decode(),
                    payload,
                    wire,
                    wire_hash,
                ],
            )
            if metadata.get("run_id") and metadata.get("receipt"):
                db.execute(
                    "UPDATE runs SET receipt=? WHERE id=?",
                    [canonical(metadata["receipt"]).decode(), metadata["run_id"]],
                )
            if self.job_id:
                if not metadata.get("receipt") or metadata["receipt"]["status"] not in {
                    "completed",
                    "partial",
                }:
                    raise SourcesQLError("invalid_output", "Job result is not terminal", "publish")
                db.execute(
                    "UPDATE jobs SET status='completed',result_id=?,engine_run_id=?,updated_at=? WHERE id=?::UUID",
                    [rid, metadata["run_id"], timestamp(), self.job_id],
                )
        return metadata

    def read(self, result_id):
        with self.db() as db:
            meta = self._authorize(db, result_id, set())
            row = db.execute("SELECT payload FROM results WHERE id=?", [result_id]).fetchone()
        try:
            value = json.loads(row[0])
        except (TypeError, ValueError):
            raise SourcesQLError(
                "result_unavailable", "Retained result bytes unavailable", "read"
            ) from None
        if digest(value) != meta["content_sha256"]:
            raise SourcesQLError("evidence_invalid", "Result integrity failure", "read")
        return meta, Table(
            [Column(c["key"], c["logical_type"], c["nullable"]) for c in value["columns"]],
            value["rows"],
        )

    def commit_many(self, items, root_result_id=None, result_mapping=None):
        prepared = [self._prepare(table, metadata) for table, metadata in items]
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            self._check_job(db)
            needed = 0
            for meta, payload, wire, _ in prepared:
                previous = db.execute(
                    "SELECT hash,revoked FROM results WHERE id=?", [meta["result_id"]]
                ).fetchone()
                if previous:
                    if previous[1] or previous[0] != meta["content_sha256"]:
                        raise SourcesQLError(
                            "idempotency_conflict", "Imported result conflicts with local record"
                        )
                else:
                    needed += len(payload.encode()) + len(wire.encode()) + len(canonical(meta))
            if self.retained_size(db) + needed > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted")
            for meta, payload, wire, wire_hash in prepared:
                if db.execute("SELECT 1 FROM results WHERE id=?", [meta["result_id"]]).fetchone():
                    continue
                db.execute(
                    "INSERT INTO results VALUES(?,?,?,0,?,?,?)",
                    [
                        meta["result_id"],
                        meta["content_sha256"],
                        canonical(meta).decode(),
                        payload,
                        wire,
                        wire_hash,
                    ],
                )
                receipt = meta["receipt"]
                db.execute(
                    "INSERT INTO runs VALUES(?,?,?,?)",
                    [
                        receipt["run_id"],
                        receipt["request_id"],
                        digest({"import": meta["result_id"]}),
                        canonical(receipt).decode(),
                    ],
                )
            for meta, _, _, _ in prepared:
                self._authorize(db, meta["result_id"], set())
            if self.job_id:
                root = self._authorize(db, root_result_id, set())
                db.execute(
                    "UPDATE jobs SET status='completed',result_id=?,engine_run_id=?,output_json=?,updated_at=? WHERE id=?::UUID",
                    [
                        root_result_id,
                        root["run_id"],
                        canonical({"result_mapping": result_mapping or {}}).decode(),
                        timestamp(),
                        self.job_id,
                    ],
                )

    def claim_job(
        self,
        job_id,
        claim_token,
        flight_context=None,
        allowed_profiles=("fixture",),
        provider_policy_sha256=None,
    ):
        token = str(uuid.UUID(claim_token))
        context = flight_context or {}
        actual_version = context.get("flight_version")
        if self.remote:
            flight_id = str(uuid.UUID(context.get("flight_id", "")))
            run_id = str(uuid.UUID(context.get("run_id", "")))
            # This DuckDB runtime supports durable SQL but not the Flight-control
            # functions. Verify the actual platform run over its Postgres endpoint.
            import certifi
            import psycopg

            host = os.environ.get("SOURCESQL_MOTHERDUCK_PG_HOST", "pg.us-east-1-aws.motherduck.com")
            if host not in {
                "pg.us-east-1-aws.motherduck.com",
                "pg.eu-central-1-aws.motherduck.com",
            }:
                raise SourcesQLError(
                    "invalid_request", "Invalid configured control endpoint", "jobs"
                )
            try:
                with psycopg.connect(
                    host=host,
                    port=5432,
                    dbname=self.database,
                    user="user",
                    password=os.environ["MOTHERDUCK_TOKEN"],
                    sslmode="verify-full",
                    sslrootcert=certifi.where(),
                    connect_timeout=5,
                    options="-c statement_timeout=15000",
                    autocommit=True,
                ) as control:
                    row = control.execute(
                        "SELECT flight_version FROM md_list_flight_runs("
                        f"""flight_id := '{flight_id}'::UUID, "LIMIT" := 100) WHERE run_id='{run_id}'::UUID""",
                    ).fetchone()
                    actual_version = row[0] if row else None
            except Exception:
                raise SourcesQLError(
                    "storage_unavailable", "Run identity verification unavailable", "jobs"
                ) from None
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            job = self._job(db, job_id)
            if (
                job["cancel_requested"]
                or job["status"] not in {"dispatching", "submission_unknown", "running"}
                or job["claim_token"]
            ):
                return None
            if str(job["flight_id"]) != context.get("flight_id") or not context.get("run_id"):
                raise SourcesQLError("unauthorized", "Flight/job identity mismatch", "jobs")
            if job["flight_version"] is None or actual_version != job["flight_version"]:
                raise SourcesQLError(
                    "unauthorized", "Flight version changed before execution", "jobs"
                )
            run_id = str(uuid.UUID(context["run_id"]))
            if job["flight_run_id"] and str(job["flight_run_id"]) != run_id:
                raise SourcesQLError("unauthorized", "Flight run identity mismatch", "jobs")
            request = json.loads(job["request_json"])
            profile = request.get("profile", "fixture")
            if profile not in allowed_profiles or (
                profile != "fixture"
                and (
                    not provider_policy_sha256
                    or job["provider_policy_sha256"] != provider_policy_sha256
                )
            ):
                raise SourcesQLError(
                    "unsupported_capability", "Hosted live profiles are not configured", "jobs"
                )
            db.execute(
                "UPDATE jobs SET claim_token=?::UUID,status='running',flight_run_id=?::UUID,updated_at=? WHERE id=?::UUID",
                [token, run_id, timestamp(), job_id],
            )
        return {**job, "request": request}

    def finish_job(self, job_id, claim_token, result_id, run_id):
        with self.db() as db:
            job = self._job(db, job_id)
            if (
                job["status"] != "completed"
                or str(job["claim_token"]) != claim_token
                or job["result_id"] != result_id
                or job["engine_run_id"] != run_id
            ):
                raise SourcesQLError("invalid_output", "Job publication is unavailable", "jobs")
        return {"status": "completed", "result_id": result_id, "run_id": run_id}

    def finish_preflight(self, job_id, claim_token, explanation):
        payload = canonical(explanation).decode()
        if len(payload.encode()) > 1_048_576:
            raise SourcesQLError(
                "budget_exhausted", "Validation output exceeds allowance", "admission"
            )
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            job = self._job(db, job_id)
            if job["cancel_requested"] or job["status"] == "cancelled":
                raise SourcesQLError("cancelled", "Validation was cancelled", "admission")
            if (
                job["operation"] != "explain"
                or job["status"] != "running"
                or str(job["claim_token"]) != claim_token
            ):
                raise SourcesQLError("unauthorized", "Validation ownership unavailable", "jobs")
            db.execute(
                "UPDATE jobs SET status='completed',output_json=?,updated_at=? WHERE id=?::UUID",
                [payload, timestamp(), job_id],
            )

    def fail_job(self, job_id, claim_token, code, safe_message, stage="admission"):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            job = self._job(db, job_id)
            if job["status"] in {"completed", "cancelled", "failed"}:
                return
            if str(job["claim_token"]) != claim_token:
                raise SourcesQLError("unauthorized", "Job execution ownership unavailable", "jobs")
            allowed = {
                "unsupported_query",
                "invalid_query",
                "invalid_request",
                "budget_exhausted",
                "unsupported_capability",
                "unauthorized",
                "disclosure_required",
                "evidence_invalid",
                "provider_unavailable",
                "provider_timeout",
                "provider_connection_error",
                "provider_http_error",
                "provider_error",
                "execution_outcome_unknown",
                "storage_conflict",
                "storage_unavailable",
                "invalid_output",
                "cancelled",
            }
            code = code if isinstance(code, str) and code in allowed else "execution_failed"
            stages = {
                "admission",
                "dispatch",
                "acquisition",
                "fetch",
                "semantic",
                "worker",
                "execution",
                "publish",
                "storage",
                "jobs",
                "read",
            }
            stage = stage if isinstance(stage, str) and stage in stages else "execution"
            state = "not_dispatched"
            if job.get("engine_run_id"):
                row = db.execute(
                    "SELECT receipt FROM runs WHERE id=?", [job["engine_run_id"]]
                ).fetchone()
                receipt = json.loads(row[0]) if row else {}
                intents = receipt.get("dispatch_intents", [])
                events = [
                    event
                    for event in receipt.get("provider_events", [])
                    if event.get("kind") != "embedding_cache"
                ]
                known_no_dispatch = (
                    events
                    and all(event.get("status") == "not_dispatched" for event in events)
                    and len(events) >= sum(intent.get("amount", 0) for intent in intents)
                )
                if not row:
                    state = "outcome_unknown"
                elif intents and not known_no_dispatch:
                    state = (
                        "outcome_unknown"
                        if receipt.get("settlement_status") != "settled"
                        or len(events) < sum(intent.get("amount", 0) for intent in intents)
                        or any(
                            event.get("status")
                            not in {
                                "completed",
                                "failed",
                                "rejected",
                                "invalid_output",
                                "completed_validation_failed",
                                "not_dispatched",
                            }
                            for event in events
                        )
                        else "rejected"
                        if code == "provider_http_error"
                        else "settled"
                    )
            db.execute(
                "UPDATE jobs SET status='failed',error_code=?,error_message='Research execution failed safely',output_json=?,updated_at=? WHERE id=?::UUID",
                [
                    code,
                    canonical({"stage": stage, "provider_dispatch": state}).decode(),
                    timestamp(),
                    job_id,
                ],
            )
