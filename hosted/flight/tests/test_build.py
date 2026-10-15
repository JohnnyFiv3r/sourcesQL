"""Execution wheels retain research code while omitting only setup templates."""

from __future__ import annotations

import base64
import csv
import hashlib
import importlib.util
import io
from pathlib import Path
import zipfile

import pytest

spec = importlib.util.spec_from_file_location(
    "sourcesql_flight_build", Path(__file__).resolve().parents[1] / "build.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def archive(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        for name, content in files.items():
            output.writestr(name, content)
    return buffer.getvalue()


def test_execution_wheel_omits_only_provisioning_archive_and_recomputes_every_record():
    files = {
        "sourcesql/engine.py": b"# reviewed research engine\n",
        "sourcesql/resources.py": b"# public provisioning helpers\n",
        "sourcesql/_resources/personal-cloud.zip": archive({"setup.mjs": "public installer"}),
        "sourcesql-0.1.0.dist-info/METADATA": b"Version: 0.1.0\n",
        "sourcesql-0.1.0.dist-info/licenses/LICENSE": b"Apache-2.0",
        "sourcesql-0.1.0.dist-info/RECORD": b"original record",
    }
    distribution = archive(files)
    execution = builder.execution_wheel(distribution)
    assert builder.digest(distribution) != builder.digest(execution)
    assert execution == builder.execution_wheel(distribution)
    with zipfile.ZipFile(io.BytesIO(execution)) as output:
        assert set(output.namelist()) == set(files) - {"sourcesql/_resources/personal-cloud.zip"}
        record_path = "sourcesql-0.1.0.dist-info/RECORD"
        records = list(csv.reader(io.StringIO(output.read(record_path).decode())))
        assert {row[0] for row in records} == set(output.namelist())
        for name, digest, size in records:
            if name == record_path:
                assert (digest, size) == ("", "")
                continue
            content = output.read(name)
            assert content == files[name]
            assert digest == "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
            assert size == str(len(content))


def test_execution_wheel_refuses_missing_templates_or_record():
    for files in [
        {"sourcesql-0.1.0.dist-info/RECORD": b""},
        {"sourcesql/_resources/personal-cloud.zip": b"templates"},
        {"sourcesql/_resources/personal-cloud.zip": b"templates", "one.dist-info/RECORD": b"", "two.dist-info/RECORD": b""},
    ]:
        with pytest.raises(ValueError):
            builder.execution_wheel(archive(files))
