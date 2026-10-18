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
_IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_STATUSES = frozenset(
    {"intent", "completed", "rejected", "outcome_unknown", "not_dispatched", "completed_unretained"}
)
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
# Reserve terminal metadata when admitting each intent, so recording a known
# outcome cannot fail just because payloads used the remaining quota.
MAX_FAILURE_METADATA_BYTES = max(map(len, _STATUSES)) - len("intent") + max(map(len, _ERROR_CODES))
_METADATA_RESERVE = len("intent") + MAX_FAILURE_METADATA_BYTES
_TABLE = """CREATE TABLE IF NOT EXISTS execution_stages(
    journal_id VARCHAR NOT NULL,
    stage_key VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    value_json VARCHAR,
    error_code VARCHAR,
    PRIMARY KEY(journal_id,stage_key)
)"""
_JOURNALS = "CREATE TABLE IF NOT EXISTS execution_journals(journal_id VARCHAR PRIMARY KEY,head_run_id VARCHAR NOT NULL,closed INTEGER NOT NULL DEFAULT 0)"
_USAGE = "CREATE TABLE IF NOT EXISTS execution_stage_usage(id INTEGER PRIMARY KEY,retained_bytes BIGINT NOT NULL)"
# Used only for legacy initialization and release of one published journal.
_ROW_BYTES_SQL = (
    "length(hex(journal_id))/2+length(hex(stage_key))/2+length(hex(coalesce(value_json,'')))/2+"
    f"CASE WHEN length(hex(status))/2+length(hex(coalesce(error_code,'')))/2>{_METADATA_RESERVE} "
    "THEN length(hex(status))/2+length(hex(coalesce(error_code,'')))/2 "
    f"ELSE {_METADATA_RESERVE} END"
)


def _row_bytes(row):
    journal, key, status, value, error = row
    return (
        len(journal.encode())
        + len(key.encode())
        + len((value or "").encode())
        + max(len(status.encode()) + len((error or "").encode()), _METADATA_RESERVE)
    )


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
            db.execute("BEGIN IMMEDIATE")
            db.execute(_TABLE)
            db.execute(_JOURNALS)
            db.execute(_USAGE)
            if (
                db.execute("SELECT retained_bytes FROM execution_stage_usage WHERE id=1").fetchone()
                is None
            ):
                total = db.execute(
                    f"SELECT coalesce(sum({_ROW_BYTES_SQL}),0) FROM execution_stages"
                ).fetchone()[0]
                db.execute("INSERT INTO execution_stage_usage VALUES(1,?)", [int(total)])
                self._migrate_published_journals(db)

    def _migrate_published_journals(self, db):
        """One-time reclamation of duplicate payloads from pre-upgrade results."""
        groups = {}
        for row in db.execute("SELECT receipt FROM runs").fetchall():
            receipt = json.loads(row[0])
            if receipt.get("journal_id"):
                groups.setdefault(receipt["journal_id"], []).append(receipt)
        for journal, members in groups.items():
            ancestors = {r.get("continuation_of") for r in members}
            tips = [r for r in members if r.get("run_id") not in ancestors]
            if len(tips) != 1:
                continue
            tip = tips[0]
            if tip.get("status") not in {"completed", "partial"} or not tip.get("result_id"):
                continue
            result = db.execute(
                "SELECT metadata FROM results WHERE id=?", [tip["result_id"]]
            ).fetchone()
            if result is None or json.loads(result[0]).get("run_id") != tip.get("run_id"):
                continue
            head = db.execute(
                "SELECT head_run_id,closed FROM execution_journals WHERE journal_id=?", [journal]
            ).fetchone()
            if head is None:
                db.execute(
                    "INSERT INTO execution_journals VALUES(?,?,0)",
                    [_identity(journal), tip["run_id"]],
                )
                self._finish_journal(db, tip)
            elif head == (tip["run_id"], 0):
                self._finish_journal(db, tip)

    def stage_bytes(self, db):
        """Constant-size read of transactional UTF-8 accounting and terminal headroom."""
        return int(
            db.execute("SELECT retained_bytes FROM execution_stage_usage WHERE id=1").fetchone()[0]
        )

    def _claim_journal(self, db, receipt):
        journal = receipt.get("journal_id")
        if journal is None:
            return
        journal = _identity(journal)
        head = db.execute(
            "SELECT head_run_id,closed FROM execution_journals WHERE journal_id=?", [journal]
        ).fetchone()
        previous = receipt.get("continuation_of")
        if head is None and previous:
            # One-time adoption of legacy journals. Refuse ambiguous branching.
            runs = [json.loads(row[0]) for row in db.execute("SELECT receipt FROM runs").fetchall()]
            members = [r for r in runs if r.get("journal_id", r.get("run_id")) == journal]
            ancestors = {r.get("continuation_of") for r in members}
            tips = [r for r in members if r.get("run_id") not in ancestors]
            if len(tips) != 1:
                raise SourcesQLError(
                    "invalid_request", "Journal continuation history is ambiguous", "storage"
                )
            tip = tips[0]
            head = (tip["run_id"], int(tip.get("result_id") is not None))
            db.execute("INSERT INTO execution_journals VALUES(?,?,?)", [journal, *head])
        if head is not None:
            if head[1] or previous != head[0]:
                raise SourcesQLError(
                    "invalid_request",
                    "Continue only the latest failed run; this journal head has changed or published",
                    "storage",
                )
            row = db.execute("SELECT receipt FROM runs WHERE id=?", [head[0]]).fetchone()
            prior = json.loads(row[0]) if row else {}
            if prior.get("status") != "failed" or prior.get("settlement_status") != "settled":
                raise SourcesQLError(
                    "execution_outcome_unknown",
                    "Only the latest settled failed run can continue",
                    "storage",
                )
            if receipt.get("counts", {}) != prior.get("counts", {}):
                raise SourcesQLError(
                    "invalid_request", "Continuation must retain cumulative usage", "storage"
                )
            db.execute(
                "UPDATE execution_journals SET head_run_id=? WHERE journal_id=?",
                [receipt["run_id"], journal],
            )
        else:
            if previous:
                raise SourcesQLError(
                    "invalid_request", "Continuation journal unavailable", "storage"
                )
            db.execute("INSERT INTO execution_journals VALUES(?,?,0)", [journal, receipt["run_id"]])

    def _finish_journal(self, db, receipt):
        if (
            not receipt
            or receipt.get("status") not in {"completed", "partial"}
            or not receipt.get("journal_id")
        ):
            return
        journal = _identity(receipt["journal_id"])
        head = db.execute(
            "SELECT head_run_id,closed FROM execution_journals WHERE journal_id=?", [journal]
        ).fetchone()
        if head is None or head[0] != receipt.get("run_id") or head[1]:
            raise SourcesQLError(
                "storage_conflict", "Publication no longer owns the journal", "publish"
            )
        released = int(
            db.execute(
                f"SELECT coalesce(sum({_ROW_BYTES_SQL}),0) FROM execution_stages WHERE journal_id=?",
                [journal],
            ).fetchone()[0]
        )
        db.execute("DELETE FROM execution_stages WHERE journal_id=?", [journal])
        db.execute(
            "UPDATE execution_stage_usage SET retained_bytes=retained_bytes-? WHERE id=1",
            [released],
        )
        db.execute("UPDATE execution_journals SET closed=1 WHERE journal_id=?", [journal])

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

    def stage_begin(self, journal_id, key, *, retry_not_dispatched=False):
        """Commit intent before effects; only a newly created intent can dispatch."""
        journal_id, key = _identity(journal_id), _identity(key)
        if type(retry_not_dispatched) is not bool:
            raise SourcesQLError("invalid_request", "Invalid checkpoint retry", "storage")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            closed = db.execute(
                "SELECT closed FROM execution_journals WHERE journal_id=?", [journal_id]
            ).fetchone()
            if closed and closed[0]:
                raise SourcesQLError(
                    "invalid_request", "Published journal cannot restart", "storage"
                )
            existing = self._stage_row(db, journal_id, key)
            if existing is not None:
                state = _read_row(existing)
                if state["status"] == "not_dispatched" and retry_not_dispatched:
                    db.execute(
                        "UPDATE execution_stages SET status='intent',error_code=NULL WHERE journal_id=? AND stage_key=?",
                        [journal_id, key],
                    )
                    return {**state, "status": "intent", "error_code": None}, True
                return _read_row(existing), False
            needed = _row_bytes((journal_id, key, "intent", None, None))
            if self.retained_size(db) + needed > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted", "storage")
            db.execute(
                "INSERT INTO execution_stages VALUES(?,?,'intent',NULL,NULL)", [journal_id, key]
            )
            db.execute(
                "UPDATE execution_stage_usage SET retained_bytes=retained_bytes+? WHERE id=1",
                [needed],
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
            needed = len(payload)
            if self.retained_size(db) + needed > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted", "storage")
            db.execute(
                "UPDATE execution_stages SET status='completed',value_json=?,error_code=NULL "
                "WHERE journal_id=? AND stage_key=? AND status='intent'",
                [payload.decode(), journal_id, key],
            )
            db.execute(
                "UPDATE execution_stage_usage SET retained_bytes=retained_bytes+? WHERE id=1",
                [needed],
            )
        return {
            **existing,
            "status": "completed",
            "value": json.loads(value_bytes),
            "error_code": None,
        }

    def stage_fail(
        self,
        journal_id,
        key,
        code,
        remote_outcome_unknown,
        *,
        not_dispatched=False,
        completed_unretained=False,
    ):
        journal_id, key = _identity(journal_id), _identity(key)
        if (
            any(
                type(v) is not bool
                for v in (remote_outcome_unknown, not_dispatched, completed_unretained)
            )
            or sum((remote_outcome_unknown, not_dispatched, completed_unretained)) > 1
        ):
            raise SourcesQLError("invalid_request", "Invalid checkpoint failure state", "storage")
        code = code if isinstance(code, str) and code in _ERROR_CODES else "execution_failed"
        status = (
            "not_dispatched"
            if not_dispatched
            else "completed_unretained"
            if completed_unretained
            else "outcome_unknown"
            if remote_outcome_unknown
            else "rejected"
        )
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

    def stage_keys(self, journal_id, limit=MAX_STAGE_SUMMARIES, after=None):
        journal_id = _identity(journal_id)
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise SourcesQLError("invalid_request", "Invalid checkpoint key limit", "storage")
        if after is not None:
            after = _identity(after)
        with self.db() as db:
            return [
                row[0]
                for row in db.execute(
                    "SELECT stage_key FROM execution_stages WHERE journal_id=?"
                    + (" AND stage_key>?" if after is not None else "")
                    + " ORDER BY stage_key LIMIT ?",
                    [journal_id, *([after] if after is not None else []), limit],
                ).fetchall()
            ]

    def iter_stage_keys(self, journal_id):
        journal_id = _identity(journal_id)
        after = None
        while keys := self.stage_keys(journal_id, after=after):
            yield from keys
            after = keys[-1]

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
