"""Decode lossless hosted archives before the engine's full import validation."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re

from sourcesql.contracts import SourcesQLError, canonical, digest

MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_RECORDS = 64


def invalid(message: str = "Invalid remote archive") -> SourcesQLError:
    return SourcesQLError("invalid_request", message, "import")


def decode_remote_archive(envelope: dict) -> dict:
    """Return a standard engine bundle without a JavaScript numeric round trip.

    This checks wire integrity and structure. Engine.import_bundle remains the
    authority for result identities, typed rows, classification, evidence and
    complete ancestor closure.
    """
    from sourcesql.engine import strict_json

    if (
        not isinstance(envelope, dict)
        or set(envelope) != {"format", "encoding", "sha256", "data"}
        or envelope.get("format") != "sourcesql.remote-archive.v1"
        or envelope.get("encoding") != "base64"
        or not isinstance(envelope.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", envelope["sha256"])
        or not isinstance(envelope.get("data"), str)
    ):
        raise invalid()
    encoded = envelope["data"]
    if len(encoded) > 4 * ((MAX_ARCHIVE_BYTES + 2) // 3):
        raise invalid("Remote archive exceeds the size limit")
    try:
        raw = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (ValueError, UnicodeError, binascii.Error):
        raise invalid("Invalid remote archive encoding") from None
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise invalid("Remote archive exceeds the size limit")
    if base64.b64encode(raw).decode("ascii") != encoded:
        raise invalid("Invalid remote archive encoding")
    if hashlib.sha256(raw).hexdigest() != envelope["sha256"]:
        raise SourcesQLError("evidence_invalid", "Remote archive integrity failure", "import")
    try:
        contents = strict_json(raw.decode("utf-8"))
        if (
            not isinstance(contents, dict)
            or set(contents) != {"format", "root_result_id", "records"}
            or contents.get("format") != "sourcesql.remote-records.v1"
            or not isinstance(contents.get("root_result_id"), str)
            or not isinstance(contents.get("records"), dict)
            or not 1 <= len(contents["records"]) <= MAX_ARCHIVE_RECORDS
            or contents["root_result_id"] not in contents["records"]
        ):
            raise invalid("Invalid remote archive closure")
        results = {}
        for result_id, record in contents["records"].items():
            if (
                not isinstance(record, dict)
                or set(record) != {"metadata_json", "payload_json"}
                or not isinstance(record["metadata_json"], str)
                or not isinstance(record["payload_json"], str)
            ):
                raise invalid("Invalid remote archive record")
            metadata = strict_json(record["metadata_json"])
            table = strict_json(record["payload_json"])
            if (
                not isinstance(metadata, dict)
                or not isinstance(table, dict)
                or set(table) != {"columns", "rows"}
                or not isinstance(table["columns"], list)
                or not isinstance(table["rows"], list)
            ):
                raise invalid("Invalid remote archive table")
            payload_sha256 = hashlib.sha256(record["payload_json"].encode("utf-8")).hexdigest()
            if payload_sha256 != metadata.get("content_sha256"):
                raise SourcesQLError(
                    "evidence_invalid", "Remote result integrity failure", "import"
                )
            results[result_id] = {"metadata": metadata, "table": table}
        body = {
            "format": "sourcesql.engine-bundle.v1",
            "root_result_id": contents["root_result_id"],
            "results": results,
        }
        if len(canonical(body)) > MAX_ARCHIVE_BYTES:
            raise invalid("Remote archive exceeds the size limit")
        return {**body, "content_sha256": digest(body)}
    except (ValueError, UnicodeError, RecursionError):
        raise invalid() from None
