"""Lossless archive wire validation and handoff to authoritative engine import."""

from __future__ import annotations

import base64
import copy
import hashlib
import json

import pytest

from sourcesql.contracts import SourcesQLError, canonical, digest
from sourcesql.engine import Engine
from sourcesql.storage import archive
from sourcesql.storage.archive import decode_remote_archive


def envelope_bytes(value):
    return {
        "format": "sourcesql.remote-archive.v1",
        "encoding": "base64",
        "sha256": hashlib.sha256(value).hexdigest(),
        "data": base64.b64encode(value).decode("ascii"),
    }


def records_body(bundle):
    return {
        "format": "sourcesql.remote-records.v1",
        "root_result_id": bundle["root_result_id"],
        "records": {
            rid: {
                "metadata_json": canonical(record["metadata"]).decode(),
                "payload_json": canonical(record["table"]).decode(),
            }
            for rid, record in bundle["results"].items()
        },
    }


def wrap(value):
    return envelope_bytes(canonical(value))


@pytest.fixture
def source_bundle(tmp_path):
    engine = Engine(tmp_path / "source")
    result = engine.import_table(
        [{"key": "n", "logical_type": "BIGINT"}, {"key": "f", "logical_type": "DOUBLE"}],
        [{"n": 9007199254740993, "f": 1.0 + 1e-7}],
        data_classification="synthetic_fixture",
    )
    return engine.export(result["result_id"])


def test_remote_archive_preserves_large_integer_and_double_through_restore(source_bundle, tmp_path):
    decoded = decode_remote_archive(wrap(records_body(source_bundle)))
    original = source_bundle["results"][source_bundle["root_result_id"]]["table"]["rows"][0]
    values = decoded["results"][decoded["root_result_id"]]["table"]["rows"][0]
    assert values == original == {"n": 9007199254740993, "f": 1.0000001}
    assert type(values["n"]) is int and type(values["f"]) is float
    assert decoded["content_sha256"] == digest(
        {key: value for key, value in decoded.items() if key != "content_sha256"}
    )
    restored = Engine(tmp_path / "restored")
    result = restored.import_bundle(decoded)
    assert restored.store.read(result["result_id"])[1].rows == [original]


def test_remote_archive_does_not_bypass_private_import_authorization(tmp_path):
    source = Engine(tmp_path / "source")
    private = source.import_table([{"key": "value"}], [{"value": "SAFE-PRIVATE-FIXTURE"}])
    decoded = decode_remote_archive(wrap(records_body(source.export(private["result_id"]))))
    restricted = Engine(tmp_path / "restricted", allow_private=False)
    with pytest.raises(SourcesQLError) as error:
        restricted.import_bundle(decoded)
    assert error.value.code == "unauthorized"
    with restricted.store.db() as db:
        assert db.execute("SELECT count(*) FROM results").fetchone()[0] == 0


def test_integral_double_and_small_exponent_keep_the_original_python_values(tmp_path):
    source = Engine(tmp_path / "source")
    result = source.import_table(
        [{"key": "f", "logical_type": "DOUBLE"}],
        [{"f": 1.0}, {"f": 1e-7}],
        data_classification="synthetic_fixture",
    )
    decoded = decode_remote_archive(wrap(records_body(source.export(result["result_id"]))))
    rows = decoded["results"][decoded["root_result_id"]]["table"]["rows"]
    assert rows == [{"f": 1.0}, {"f": 1e-7}]
    assert all(type(row["f"]) is float for row in rows)
    restored = Engine(tmp_path / "restored")
    imported = restored.import_bundle(decoded)
    assert restored.store.read(imported["result_id"])[1].rows == rows


def test_corrupted_outer_hash_is_rejected(source_bundle):
    envelope = wrap(records_body(source_bundle))
    envelope["sha256"] = "0" * 64
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(envelope)
    assert error.value.code == "evidence_invalid"


def test_corrupted_payload_hash_is_rejected(source_bundle):
    body = records_body(source_bundle)
    record = body["records"][body["root_result_id"]]
    payload = json.loads(record["payload_json"])
    payload["rows"][0]["n"] += 1
    record["payload_json"] = canonical(payload).decode()
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(wrap(body))
    assert error.value.code == "evidence_invalid"


@pytest.mark.parametrize("encoded", ["!", "\u2603", "YWJj\n", "YQ===", "YQ", "YR=="])
def test_invalid_or_noncanonical_base64_is_rejected(encoded):
    envelope = envelope_bytes(b"a")
    envelope["data"] = encoded
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(envelope)
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize("raw", [b"\x80", b"not-json", b'{"value": NaN}'])
def test_invalid_utf8_json_or_nonfinite_literal_is_rejected(raw):
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(envelope_bytes(raw))
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize("size", [33, 40])
def test_archive_size_is_bounded_before_parsing(monkeypatch, size):
    monkeypatch.setattr(archive, "MAX_ARCHIVE_BYTES", 32)
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(envelope_bytes(b"x" * size))
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize("mutation", ["extra", "format", "encoding", "sha_type", "data_type"])
def test_unsupported_envelope_shape_is_rejected(source_bundle, mutation):
    envelope = wrap(records_body(source_bundle))
    if mutation == "extra":
        envelope["unexpected"] = True
    elif mutation == "format":
        envelope["format"] = "sourcesql.remote-archive.v2"
    elif mutation == "encoding":
        envelope["encoding"] = "gzip"
    elif mutation == "sha_type":
        envelope["sha256"] = 1
    else:
        envelope["data"] = []
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(envelope)
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize(
    "mutation",
    [
        "extra",
        "format",
        "missing_root",
        "too_many",
        "record_extra",
        "record_type",
        "metadata_type",
        "table_extra",
        "rows_type",
    ],
)
def test_unsupported_record_shape_is_rejected(source_bundle, mutation):
    body = records_body(source_bundle)
    record = body["records"][body["root_result_id"]]
    if mutation == "extra":
        body["unexpected"] = True
    elif mutation == "format":
        body["format"] = "sourcesql.remote-records.v2"
    elif mutation == "missing_root":
        body["root_result_id"] = "missing"
    elif mutation == "too_many":
        body["records"] = {str(i): copy.deepcopy(record) for i in range(65)}
        body["root_result_id"] = "0"
    elif mutation == "record_extra":
        record["unexpected"] = True
    elif mutation == "record_type":
        record["metadata_json"] = {}
    elif mutation == "metadata_type":
        record["metadata_json"] = "[]"
    elif mutation == "table_extra":
        payload = json.loads(record["payload_json"])
        payload["unexpected"] = True
        record["payload_json"] = canonical(payload).decode()
    else:
        payload = json.loads(record["payload_json"])
        payload["rows"] = {}
        record["payload_json"] = canonical(payload).decode()
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(wrap(body))
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize("where", ["outer", "metadata", "payload"])
def test_duplicate_json_keys_are_rejected(source_bundle, where):
    body = records_body(source_bundle)
    if where == "outer":
        raw = canonical(body).decode()
        raw = raw[:-1] + ',"records":{}}'
        envelope = envelope_bytes(raw.encode())
    else:
        record = body["records"][body["root_result_id"]]
        if where == "metadata":
            raw = record["metadata_json"]
            record["metadata_json"] = raw[:-1] + ',"result_id":"duplicate"}'
        else:
            raw = record["payload_json"]
            record["payload_json"] = raw[:-1] + ',"rows":[]}'
        envelope = wrap(body)
    with pytest.raises(SourcesQLError) as error:
        decode_remote_archive(envelope)
    assert error.value.code == "invalid_request"
