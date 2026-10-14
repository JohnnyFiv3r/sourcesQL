"""Atomic immutable JSON tables and SQLite control records, with dependency revocation."""

from __future__ import annotations
from contextlib import contextmanager
import json
import os
import re
from pathlib import Path
import sqlite3
import uuid
from open_webql.contracts import Column, Table, WebQLError, canonical, digest


class Store:
    def __init__(self, root: Path | str, quota: int = 100 * 1024 * 1024):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.quota = quota
        with self.db() as db:
            db.executescript(
                """CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY, hash TEXT NOT NULL, metadata TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, receipt TEXT NOT NULL);"""
            )

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

    def begin_run(self, request: dict, receipt: dict) -> tuple[dict, bool]:
        identity = digest(request)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT request_hash,receipt FROM runs WHERE request_id=?", (request["request_id"],)
            ).fetchone()
            if previous:
                if previous[0] != identity:
                    raise WebQLError(
                        "idempotency_conflict", "Request key already has different inputs"
                    )
                return json.loads(previous[1]), False
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
                raise WebQLError("not_found", "Run unavailable", "read")
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
            raise WebQLError("not_found", "Run unavailable", "read")
        return json.loads(row[0])

    def retained_size(self, db) -> int:
        """Logical retained result quota, including source/evidence metadata."""
        metadata_bytes = db.execute(
            "SELECT coalesce(sum(length(CAST(metadata AS BLOB))),0) FROM results"
        ).fetchone()[0]
        return metadata_bytes + sum(p.stat().st_size for p in self.root.glob("*.json"))

    def commit(self, table: Table, metadata: dict) -> dict:
        value = table.to_dict()
        payload = canonical(value)
        content_hash = digest(value)
        result_id = metadata.get("result_id") or "wq_" + uuid.uuid4().hex
        if not re.fullmatch("[A-Za-z0-9_-]{1,100}", result_id):
            raise WebQLError("invalid_request", "Invalid result identity", "publish")
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
            raise WebQLError("invalid_output", "Invalid row identities", "publish")
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
                        raise WebQLError("cancelled", "Run cancelled", "publish")
                    if current["status"] == "failed":
                        raise WebQLError("invalid_output", "Failed run cannot publish", "publish")
                    if metadata.get("receipt"):
                        metadata["receipt"] = {
                            **metadata["receipt"],
                            "receipt_revision": current["receipt_revision"] + 1,
                        }
                        metadata["receipt_revision"] = metadata["receipt"]["receipt_revision"]
            for parent in metadata.get("parents", []):
                actual = self._authorize(db, parent["result_id"], set())
                if parent.get("content_sha256") not in (None, actual["content_sha256"]):
                    raise WebQLError("evidence_invalid", "Parent content pin mismatch", "publish")
            existing = db.execute(
                "SELECT hash,metadata FROM results WHERE id=?", (result_id,)
            ).fetchone()
            if existing:
                if existing[0] != content_hash:
                    raise WebQLError("idempotency_conflict", "Result identity conflict", "publish")
                return json.loads(existing[1])
            if self.retained_size(db) + len(payload) + len(canonical(metadata)) > self.quota:
                raise WebQLError("budget_exhausted", "Storage quota exhausted", "publish")
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
            raise WebQLError("invalid_output", "Cyclic result dependencies", "read")
        seen.add(result_id)
        row = db.execute("SELECT metadata,revoked FROM results WHERE id=?", (result_id,)).fetchone()
        if not row or row[1]:
            raise WebQLError("unauthorized", "Result or dependency unavailable", "read")
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
            raise WebQLError(
                "result_unavailable", "Retained result bytes unavailable", "read"
            ) from error
        if digest(data) != meta["content_sha256"]:
            raise WebQLError("evidence_invalid", "Result integrity failure", "read")
        return meta, Table(
            [Column(c["key"], c["logical_type"], c["nullable"]) for c in data["columns"]],
            data["rows"],
        )

    def revoke(self, result_id: str):
        with self.db() as db:
            db.execute("UPDATE results SET revoked=1 WHERE id=?", (result_id,))

    def commit_many(self, items: list[tuple[Table, dict]]) -> None:
        """Make a fully validated imported graph visible in one control transaction."""
        prepared = []
        for table, meta in items:
            value = table.to_dict()
            payload = canonical(value)
            rid = meta["result_id"]
            if not re.fullmatch("[A-Za-z0-9_-]{1,100}", rid):
                raise WebQLError("invalid_request", "Invalid result identity")
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
            needed = 0
            for payload, meta in prepared:
                existing = db.execute(
                    "SELECT hash,revoked FROM results WHERE id=?", (meta["result_id"],)
                ).fetchone()
                if existing:
                    if existing[1] or existing[0] != meta["content_sha256"]:
                        raise WebQLError(
                            "idempotency_conflict", "Imported result conflicts with local record"
                        )
                else:
                    needed += len(payload) + len(canonical(meta))
            if self.retained_size(db) + needed > self.quota:
                raise WebQLError("budget_exhausted", "Storage quota exhausted")
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
