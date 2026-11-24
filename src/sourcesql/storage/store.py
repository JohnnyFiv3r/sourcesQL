"""Atomic immutable JSON tables and SQLite control records, with dependency revocation."""

from __future__ import annotations
from contextlib import contextmanager
import json
import os
import re
from pathlib import Path
import sqlite3
import uuid
from sourcesql.contracts import Column, Table, SourcesQLError, canonical, digest
from sourcesql.storage.stages import StageJournalMixin
from sourcesql.storage.inspection import InspectionMixin


class _LeadSetMoved(Exception):
    """Another writer got to this lead-set revision first."""


class Store(StageJournalMixin, InspectionMixin):
    # The hosted store keeps no lead-set index, so it revokes only the result it is given.
    has_lead_sets = True

    def __init__(self, root: Path | str, quota: int = 100 * 1024 * 1024):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.quota = quota
        with self.db() as db:
            db.executescript(
                """CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY, hash TEXT NOT NULL, metadata TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, receipt TEXT NOT NULL);CREATE INDEX IF NOT EXISTS runs_request_uuid ON runs(lower(request_id));CREATE TABLE IF NOT EXISTS lead_sets(lead_set_id TEXT NOT NULL, revision INTEGER NOT NULL, leads_result_id TEXT NOT NULL, hits_result_id TEXT NOT NULL, PRIMARY KEY(lead_set_id, revision));CREATE TABLE IF NOT EXISTS lead_requests(request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, reply TEXT NOT NULL);CREATE TABLE IF NOT EXISTS lead_batches(lead_set_id TEXT NOT NULL, batch_result_id TEXT NOT NULL, revision INTEGER NOT NULL, reply TEXT NOT NULL, PRIMARY KEY(lead_set_id, batch_result_id));"""
            )
        self.initialize_stage_journal()

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.root / "control.sqlite", timeout=30)
        os.chmod(self.root / "control.sqlite", 0o600)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def lookup_request(self, request_id: str) -> dict | None:
        """Read through the case-folded index, retaining ambiguous legacy UUID refusal."""
        with self.db() as db:
            rows = db.execute(
                "SELECT receipt FROM runs WHERE lower(request_id)=? LIMIT 2", (request_id.lower(),)
            ).fetchall()
        if len(rows) > 1:
            raise SourcesQLError(
                "idempotency_conflict",
                "Request UUID has ambiguous legacy spellings; inspect its exact runs",
            )
        return json.loads(rows[0][0]) if rows else None

    def begin_run(self, request: dict, receipt: dict) -> tuple[dict, bool]:
        identity = digest(request)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT request_hash,receipt FROM runs WHERE request_id=?", (request["request_id"],)
            ).fetchone()
            if previous:
                if previous[0] != identity:
                    raise SourcesQLError(
                        "idempotency_conflict", "Request key already has different inputs"
                    )
                return json.loads(previous[1]), False
            self._claim_journal(db, receipt)
            db.execute(
                "INSERT INTO runs VALUES(?,?,?,?)",
                (receipt["run_id"], request["request_id"], identity, canonical(receipt).decode()),
            )
        return receipt, True

    def update_run(self, receipt: dict):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT receipt FROM runs WHERE id=?", (receipt["run_id"],)).fetchone()
            if not row:
                raise SourcesQLError("not_found", "Run unavailable", "read")
            current = json.loads(row[0])
            terminal = {"completed", "partial", "failed", "cancelled"}
            if current["status"] in terminal and receipt["status"] != current["status"]:
                return current
            receipt = {
                **receipt,
                "receipt_revision": max(
                    receipt["receipt_revision"], current["receipt_revision"] + 1
                ),
            }
            db.execute(
                "UPDATE runs SET receipt=? WHERE id=?",
                (canonical(receipt).decode(), receipt["run_id"]),
            )
        return receipt

    def run(self, run_id: str) -> dict:
        with self.db() as db:
            row = db.execute("SELECT receipt FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise SourcesQLError("not_found", "Run unavailable", "read")
        return json.loads(row[0])

    def retained_size(self, db) -> int:
        """Logical retained result quota, including source/evidence metadata."""
        metadata_bytes = db.execute(
            "SELECT coalesce(sum(length(CAST(metadata AS BLOB))),0) FROM results"
        ).fetchone()[0]
        return (
            metadata_bytes
            + sum(p.stat().st_size for p in self.root.glob("*.json"))
            + self.stage_bytes(db)
        )

    def commit(self, table: Table, metadata: dict) -> dict:
        value = table.to_dict()
        payload = canonical(value)
        content_hash = digest(value)
        result_id = metadata.get("result_id") or "wq_" + uuid.uuid4().hex
        if not re.fullmatch("[A-Za-z0-9_-]{1,100}", result_id):
            raise SourcesQLError("invalid_request", "Invalid result identity", "publish")
        metadata = {
            **metadata,
            "result_id": result_id,
            "content_sha256": content_hash,
            "row_count": len(table.rows),
            "columns": value["columns"],
        }
        metadata.setdefault("row_ids", ["row_" + uuid.uuid4().hex for _ in table.rows])
        if len(metadata["row_ids"]) != len(table.rows) or len(set(metadata["row_ids"])) != len(
            table.rows
        ):
            raise SourcesQLError("invalid_output", "Invalid row identities", "publish")
        target = self.root / (result_id + ".json")
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if metadata.get("run_id"):
                run = db.execute(
                    "SELECT receipt FROM runs WHERE id=?", (metadata["run_id"],)
                ).fetchone()
                if run:
                    current = json.loads(run[0])
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
                "SELECT hash,metadata FROM results WHERE id=?", (result_id,)
            ).fetchone()
            if existing:
                if existing[0] != content_hash:
                    raise SourcesQLError(
                        "idempotency_conflict", "Result identity conflict", "publish"
                    )
                return json.loads(existing[1])
            self._finish_journal(db, metadata.get("receipt"))
            if self.retained_size(db) + len(payload) + len(canonical(metadata)) > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted", "publish")
            temp = self.root / ("." + uuid.uuid4().hex + ".tmp")
            with temp.open("xb") as handle:
                os.chmod(temp, 0o600)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, target)
            db.execute(
                "INSERT INTO results(id,hash,metadata) VALUES(?,?,?)",
                (result_id, content_hash, canonical(metadata).decode()),
            )
            if metadata.get("run_id") and metadata.get("receipt"):
                db.execute(
                    "UPDATE runs SET receipt=? WHERE id=?",
                    (canonical(metadata["receipt"]).decode(), metadata["run_id"]),
                )
        return metadata

    def authorize(self, result_id: str, seen: set[str] | None = None) -> dict:
        with self.db() as db:
            return self._authorize(db, result_id, set() if seen is None else seen)

    def _authorize(self, db, result_id: str, seen: set[str]) -> dict:
        if result_id in seen:
            raise SourcesQLError("invalid_output", "Cyclic result dependencies", "read")
        seen.add(result_id)
        row = db.execute("SELECT metadata,revoked FROM results WHERE id=?", (result_id,)).fetchone()
        if not row or row[1]:
            raise SourcesQLError("unauthorized", "Result or dependency unavailable", "read")
        meta = json.loads(row[0])
        for parent in meta.get("parents", []):
            ancestor = self._authorize(db, parent["result_id"], set(seen))
            if ancestor.get("data_classification") in ("private_local", "private_derived"):
                meta = {**meta, "data_classification": "private_derived"}
        return meta

    def read(self, result_id: str) -> tuple[dict, Table]:
        meta = self.authorize(result_id)
        path = self.root / (result_id + ".json")
        try:
            data = json.loads(path.read_bytes())
        except (OSError, ValueError) as error:
            raise SourcesQLError(
                "result_unavailable", "Retained result bytes unavailable", "read"
            ) from error
        if digest(data) != meta["content_sha256"]:
            raise SourcesQLError("evidence_invalid", "Result integrity failure", "read")
        return meta, Table(
            [Column(c["key"], c["logical_type"], c["nullable"]) for c in data["columns"]],
            data["rows"],
        )

    def revoke(self, result_id: str):
        with self.db() as db:
            db.execute("UPDATE results SET revoked=1 WHERE id=?", (result_id,))
            # A lead set is one body of host-reported data in many revisions: withdrawing
            # one revision withdraws them all.
            sets = (
                ()
                if not self.has_lead_sets
                else db.execute(
                    "SELECT DISTINCT lead_set_id FROM lead_sets WHERE leads_result_id=?1 OR hits_result_id=?1",
                    (result_id,),
                ).fetchall()
            )
            for (lead_set_id,) in sets:
                for revision in db.execute(
                    "SELECT leads_result_id,hits_result_id FROM lead_sets WHERE lead_set_id=?",
                    (lead_set_id,),
                ).fetchall():
                    db.executemany(
                        "UPDATE results SET revoked=1 WHERE id=?", [(rid,) for rid in revision]
                    )

    def lead_set_head(self, lead_set_id: str, db=None) -> dict | None:
        """The newest revision of a lead set, or None when it has none."""
        if db is None:
            with self.db() as own:
                return self.lead_set_head(lead_set_id, own)
        row = db.execute(
            "SELECT revision,leads_result_id,hits_result_id FROM lead_sets "
            "WHERE lead_set_id=? ORDER BY revision DESC LIMIT 1",
            (lead_set_id,),
        ).fetchone()
        return (
            {"revision": row[0], "leads_result_id": row[1], "hits_result_id": row[2]}
            if row
            else None
        )

    def lead_set_results(self, lead_set_id: str) -> set[str]:
        """Every leads and hits result of every revision of a lead set."""
        with self.db() as db:
            rows = db.execute(
                "SELECT leads_result_id,hits_result_id FROM lead_sets WHERE lead_set_id=?",
                (lead_set_id,),
            ).fetchall()
        return {result for row in rows for result in row}

    def lead_batch_reply(self, lead_set_id: str, batch_result_id: str) -> str | None:
        """The reply that recorded this batch, or None when it was never recorded."""
        with self.db() as db:
            row = db.execute(
                "SELECT reply FROM lead_batches WHERE lead_set_id=? AND batch_result_id=?",
                (lead_set_id, batch_result_id),
            ).fetchone()
        return row[0] if row else None

    def remember_lead_request(self, request_id: str, request_hash: str, reply: str) -> None:
        """Keep a request ID answering with the reply it was given, whichever call first made it."""
        with self.db() as db:
            db.execute(
                "INSERT OR IGNORE INTO lead_requests(request_id,request_hash,reply) VALUES(?,?,?)",
                (request_id, request_hash, reply),
            )

    def lead_request(self, request_id: str) -> tuple[str, str] | None:
        """The stored (request hash, reply) of an earlier intake call."""
        with self.db() as db:
            return db.execute(
                "SELECT request_hash,reply FROM lead_requests WHERE request_id=?", (request_id,)
            ).fetchone()

    def commit_lead_revision(
        self,
        items: list[tuple[Table, dict]],
        lead_set_id: str,
        revision: int,
        request_id: str,
        request_hash: str,
        reply: dict,
        batch_result_id: str | None = None,
        hits_result_id: str | None = None,
    ) -> bool:
        """Publish a lead-set revision, its index row and its request record together.

        A revision that records a batch adds only the leads result: it keeps the hits result
        of the revision before it, and its batch is noted so recording it twice is a no-op.

        Returns False without writing when another writer already added this revision, so the
        caller can merge onto the new head and try again.
        """
        leads_id = items[0][1]["result_id"]
        hits_id = hits_result_id or items[1][1]["result_id"]

        def check(db):
            head = self.lead_set_head(lead_set_id, db)
            if (head["revision"] if head else 0) != revision - 1:
                raise _LeadSetMoved
            if db.execute(
                "SELECT 1 FROM lead_requests WHERE request_id=?", (request_id,)
            ).fetchone():
                raise _LeadSetMoved
            if (
                batch_result_id
                and db.execute(
                    "SELECT 1 FROM lead_batches WHERE lead_set_id=? AND batch_result_id=?",
                    (lead_set_id, batch_result_id),
                ).fetchone()
            ):
                raise _LeadSetMoved

        def record(db):
            db.execute(
                "INSERT INTO lead_sets(lead_set_id,revision,leads_result_id,hits_result_id) "
                "VALUES(?,?,?,?)",
                (lead_set_id, revision, leads_id, hits_id),
            )
            db.execute(
                "INSERT INTO lead_requests(request_id,request_hash,reply) VALUES(?,?,?)",
                (request_id, request_hash, canonical(reply).decode()),
            )
            if batch_result_id:
                db.execute(
                    "INSERT INTO lead_batches(lead_set_id,batch_result_id,revision,reply) "
                    "VALUES(?,?,?,?)",
                    (lead_set_id, batch_result_id, revision, canonical(reply).decode()),
                )

        try:
            self.commit_many(items, before_write=check, after_write=record)
        except _LeadSetMoved:
            return False
        return True

    def commit_many(
        self,
        items: list[tuple[Table, dict]],
        root_result_id=None,
        result_mapping=None,
        before_write=None,
        after_write=None,
    ) -> None:
        """Make a fully validated imported graph visible in one control transaction.

        The hooks run inside that transaction, so the caller's own rows commit or roll back
        with the results.
        """
        prepared = []
        for table, meta in items:
            value = table.to_dict()
            payload = canonical(value)
            rid = meta["result_id"]
            if not re.fullmatch("[A-Za-z0-9_-]{1,100}", rid):
                raise SourcesQLError("invalid_request", "Invalid result identity")
            prepared.append(
                (
                    payload,
                    {
                        **meta,
                        "columns": value["columns"],
                        "row_count": len(table.rows),
                        "content_sha256": digest(value),
                    },
                )
            )
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            if before_write:
                before_write(db)
            needed = 0
            for payload, meta in prepared:
                existing = db.execute(
                    "SELECT hash,revoked FROM results WHERE id=?", (meta["result_id"],)
                ).fetchone()
                if existing:
                    if existing[1] or existing[0] != meta["content_sha256"]:
                        raise SourcesQLError(
                            "idempotency_conflict", "Imported result conflicts with local record"
                        )
                else:
                    needed += len(payload) + len(canonical(meta))
            if self.retained_size(db) + needed > self.quota:
                raise SourcesQLError("budget_exhausted", "Storage quota exhausted")
            for payload, meta in prepared:
                rid = meta["result_id"]
                if db.execute("SELECT 1 FROM results WHERE id=?", (rid,)).fetchone():
                    continue
                temp = self.root / ("." + uuid.uuid4().hex + ".tmp")
                with temp.open("xb") as handle:
                    os.chmod(temp, 0o600)
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp, self.root / (rid + ".json"))
                db.execute(
                    "INSERT INTO results(id,hash,metadata) VALUES(?,?,?)",
                    (rid, meta["content_sha256"], canonical(meta).decode()),
                )
                receipt = meta["receipt"]
                db.execute(
                    "INSERT INTO runs(id,request_id,request_hash,receipt) VALUES(?,?,?,?)",
                    (
                        receipt["run_id"],
                        receipt["request_id"],
                        digest({"import": rid}),
                        canonical(receipt).decode(),
                    ),
                )
            if after_write:
                after_write(db)
