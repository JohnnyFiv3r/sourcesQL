"""Immutable effect intents and bounded checkpoints for explicit continuation.

The trusted coordinator supplies hashes/IDs and validated values, and must
reauthorize dependencies before reading them. A retained intent is uncertain;
neither a rejected nor an uncertain effect authorizes an automatic retry.
"""

from __future__ import annotations

import json
import re

from sourcesql.contracts import SourcesQLError, canonical, digest


MAX_STAGE_BYTES = 4 * 1024 * 1024
_VALUE_VERSION = "stage-value.v1"
_ENVELOPE_OVERHEAD = len(
    canonical({"version": _VALUE_VERSION, "content_sha256": "0" * 64, "value": None})
) - len(canonical(None))
MAX_STAGE_SUMMARIES = 128
MAX_JOURNAL_STAGES = 256
_IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_STATUSES = frozenset({"intent", "completed", "rejected", "outcome_unknown"})
_ERROR_CODES = frozenset(
    {
        "unsupported_query",
        "invalid_query",
        "invalid_request",
        "budget_exhausted",
        "unsupported_capability",
        "unauthorized",
        "disclosure_required",
        "evidence_invalid",
        "invalid_output",
        "provider_unavailable",
        "provider_timeout",
        "provider_connection_error",
        "provider_http_error",
        "provider_error",
        "storage_conflict",
        "storage_unavailable",
        "cancelled",
        "execution_outcome_unknown",
        "execution_failed",
    }
)
# Recording an already dispatched failure must survive a payload-quota error.
# No new intent bypasses quota; this is the largest extra terminal metadata per
# previously admitted intent, bounded again by MAX_JOURNAL_STAGES per journal.
MAX_FAILURE_METADATA_BYTES = max(map(len, _STATUSES)) - len("intent") + max(map(len, _ERROR_CODES))
_TABLE = """CREATE TABLE IF NOT EXISTS execution_stages(
    journal_id VARCHAR NOT NULL,
    stage_key VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    value_json VARCHAR,
    error_code VARCHAR,
    PRIMARY KEY(journal_id,stage_key)
)"""


def _identity(value):
    if not isinstance(value, str) or not _IDENTITY.fullmatch(value):
        raise SourcesQLError("invalid_request", "Invalid checkpoint identity", "storage")
    return value


def _read_row(row):
    if row is None:
        return None
    journal_id, key, status, payload, error_code = row
    if status not in _STATUSES:
        raise SourcesQLError("evidence_invalid", "Checkpoint state is invalid", "storage")
    try:
        if (
            payload is not None
            and len(payload.encode("utf-8")) > MAX_STAGE_BYTES + _ENVELOPE_OVERHEAD
        ):
            raise ValueError
        value = json.loads(payload) if payload is not None else None
        if payload is not None and canonical(value).decode() != payload:
            raise ValueError
        if (status == "completed") != (payload is not None):
            raise ValueError
        if status == "completed":
            if (
                not isinstance(value, dict)
                or set(value) != {"version", "content_sha256", "value"}
                or value["version"] != _VALUE_VERSION
                or value["content_sha256"] != digest([journal_id, key, value["value"]])
                or len(canonical(value["value"])) > MAX_STAGE_BYTES
            ):
                raise ValueError
            value = value["value"]
    except (TypeError, ValueError, UnicodeError, OverflowError):
        raise SourcesQLError(
            "evidence_invalid", "Checkpoint value is unavailable or invalid", "storage"
        ) from None
    return {
        "journal_id": journal_id,
        "stage_key": key,
        "status": status,
        "value": value,
        "error_code": error_code if error_code in _ERROR_CODES else None,
    }


class StageJournalMixin:
    def initialize_stage_journal(self):
        with self.db() as db:
            db.execute(_TABLE)

    def stage_bytes(self, db):
        """Logical UTF-8 storage, portable across SQLite and DuckDB."""
        total_hex = db.execute(
            "SELECT coalesce(sum(length(hex(journal_id))+length(hex(stage_key))"
            "+length(hex(status))+length(hex(coalesce(value_json,'')))"
            "+length(hex(coalesce(error_code,'')))),0) FROM execution_stages"
        ).fetchone()[0]
        return int(total_hex) // 2

    @staticmethod
    def _stage_row(db, journal_id, key):
        return db.execute(
            "SELECT journal_id,stage_key,status,value_json,error_code "
            "FROM execution_stages WHERE journal_id=? AND stage_key=?",
            [journal_id, key],
        ).fetchone()

    def stage_read(self, journal_id, key):
        journal_id, key = _identity(journal_id), _identity(key)
        with self.db() as db:
            return _read_row(self._stage_row(db, journal_id, key))

    def stage_begin(self, journal_id, key):
        """Commit intent before effects; only a newly created intent can dispatch."""
        journal_id, key = _identity(journal_id), _identity(key)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = self._stage_row(db, journal_id, key)
            if existing is not None:
                return _read_row(existing), False
            count = db.execute(
                "SELECT count(*) FROM execution_stages WHERE journal_id=?", [journal_id]
            ).fetchone()[0]
            if count >= MAX_JOURNAL_STAGES:
                raise SourcesQLError(
                    "budget_exhausted", "Checkpoint stage allowance exhausted", "storage"
                )
            needed = len(journal_id.encode()) + len(key.encode()) + len("intent")
            if self.retained_size(db) + needed > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted", "storage")
            db.execute(
                "INSERT INTO execution_stages VALUES(?,?,'intent',NULL,NULL)", [journal_id, key]
            )
        return {
            "journal_id": journal_id,
            "stage_key": key,
            "status": "intent",
            "value": None,
            "error_code": None,
        }, True

    def stage_finish(self, journal_id, key, value):
        journal_id, key = _identity(journal_id), _identity(key)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = _read_row(self._stage_row(db, journal_id, key))
            if existing is None:
                raise SourcesQLError("not_found", "Checkpoint intent unavailable", "storage")
            if existing["status"] != "intent":
                return existing
            try:
                value_bytes = canonical(value)
            except (TypeError, ValueError, UnicodeError, OverflowError):
                raise SourcesQLError(
                    "invalid_output", "Checkpoint value is invalid", "storage"
                ) from None
            if len(value_bytes) > MAX_STAGE_BYTES:
                raise SourcesQLError(
                    "budget_exhausted", "Checkpoint exceeds its byte allowance", "storage"
                )
            payload = canonical(
                {
                    "version": _VALUE_VERSION,
                    "content_sha256": digest([journal_id, key, value]),
                    "value": value,
                }
            )
            needed = len(payload) + len("completed") - len("intent")
            if self.retained_size(db) + needed > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted", "storage")
            db.execute(
                "UPDATE execution_stages SET status='completed',value_json=?,error_code=NULL "
                "WHERE journal_id=? AND stage_key=? AND status='intent'",
                [payload.decode(), journal_id, key],
            )
        return {
            **existing,
            "status": "completed",
            "value": json.loads(value_bytes),
            "error_code": None,
        }

    def stage_fail(self, journal_id, key, code, remote_outcome_unknown):
        journal_id, key = _identity(journal_id), _identity(key)
        if type(remote_outcome_unknown) is not bool:
            raise SourcesQLError("invalid_request", "Invalid checkpoint failure state", "storage")
        code = code if isinstance(code, str) and code in _ERROR_CODES else "execution_failed"
        status = "outcome_unknown" if remote_outcome_unknown else "rejected"
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = _read_row(self._stage_row(db, journal_id, key))
            if existing is None:
                raise SourcesQLError("not_found", "Checkpoint intent unavailable", "storage")
            if existing["status"] != "intent":
                return existing
            db.execute(
                "UPDATE execution_stages SET status=?,value_json=NULL,error_code=? "
                "WHERE journal_id=? AND stage_key=? AND status='intent'",
                [status, code, journal_id, key],
            )
        return {**existing, "status": status, "error_code": code}

    def stage_summaries(self, journal_id, limit=MAX_STAGE_SUMMARIES):
        journal_id = _identity(journal_id)
        if type(limit) is not int or not 1 <= limit <= MAX_STAGE_SUMMARIES:
            raise SourcesQLError("invalid_request", "Invalid checkpoint summary limit", "storage")
        with self.db() as db:
            total = db.execute(
                "SELECT count(*) FROM execution_stages WHERE journal_id=?", [journal_id]
            ).fetchone()[0]
            rows = db.execute(
                "SELECT stage_key,status,error_code FROM execution_stages "
                "WHERE journal_id=? ORDER BY stage_key LIMIT ?",
                [journal_id, limit],
            ).fetchall()
        return {
            "stages": [
                {
                    "stage_key": key,
                    "status": status if status in _STATUSES else "outcome_unknown",
                    "error_code": code if code in _ERROR_CODES else None,
                }
                for key, status, code in rows
            ],
            "total": int(total),
            "omitted": int(total) - len(rows),
        }
