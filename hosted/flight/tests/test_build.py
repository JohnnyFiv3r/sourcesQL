"""Flight wheels retain code/licenses and declare size-bounded setup omissions."""

from __future__ import annotations

import base64
import csv
import hashlib
import importlib.util
import io
from pathlib import Path
import zipfile

import pytest

from sourcesql.resources import build_personal_cloud_archive

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


def test_execution_wheel_omits_only_declared_resources_and_recomputes_every_record():
    files = {
        "sourcesql/engine.py": b"# reviewed research engine\n",
        "sourcesql/resources.py": b"# public provisioning helpers\n",
        "sourcesql/_resources/tokenizers/cl100k_base.tiktoken.gz": b"reviewed tokenizer data",
        "sourcesql/_resources/tokenizers/TIKTOKEN_LICENSE.txt": b"MIT tokenizer license",
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
        assert set(output.namelist()) == set(files) - set(builder.EXECUTION_OMISSIONS)
        record_path = "sourcesql-0.1.0.dist-info/RECORD"
        records = list(csv.reader(io.StringIO(output.read(record_path).decode())))
        assert {row[0] for row in records} == set(output.namelist())
        for name, digest, size in records:
            if name == record_path:
                assert (digest, size) == ("", "")
                continue
            content = output.read(name)
            assert content == files[name]
            assert (
                digest
                == "sha256="
                + base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
            )
            assert size == str(len(content))


def test_execution_wheel_refuses_missing_templates_or_record():
    for files in [
        {"sourcesql-0.1.0.dist-info/RECORD": b""},
        {"sourcesql/_resources/personal-cloud.zip": b"templates"},
        {
            "sourcesql/_resources/personal-cloud.zip": b"templates",
            "one.dist-info/RECORD": b"",
            "two.dist-info/RECORD": b"",
        },
        {
            "sourcesql/_resources/personal-cloud.zip": b"templates",
            "sourcesql-0.1.0.dist-info/RECORD": b"",
        },
    ]:
        with pytest.raises(ValueError):
            builder.execution_wheel(archive(files))


def test_full_current_source_flight_retains_the_reviewed_200kb_limit(tmp_path):
    """Exercise the real builder against every current runtime/resource byte."""
    root = Path(__file__).resolve().parents[3]
    runtime, _ = builder.runtime_requirements(root)
    metadata_prefix = f"sourcesql-{runtime['version']}.dist-info/"
    files = {
        path.relative_to(root / "src").as_posix(): path.read_bytes()
        for path in (root / "src/sourcesql").rglob("*.py")
    }
    for resource in (
        builder.TOKENIZER_RESOURCE,
        "sourcesql/_resources/tokenizers/TIKTOKEN_LICENSE.txt",
    ):
        files[resource] = (root / "src" / resource).read_bytes()
    files["sourcesql/_resources/personal-cloud.zip"] = build_personal_cloud_archive(root)
    requirements = list(runtime["base_requirements"])
    for extra, values in runtime["optional_requirements"].items():
        requirements.extend(value + ";extra=='" + extra + "'" for value in values)
    metadata = [
        "Metadata-Version: 2.4",
        "Name: sourcesql",
        "Version: " + runtime["version"],
        "Requires-Python: " + runtime["requires_python"],
        *["Requires-Dist: " + value for value in requirements],
        *["Provides-Extra: " + extra for extra in runtime["optional_requirements"]],
        "",
        (root / "README.md").read_text(),
    ]
    files[metadata_prefix + "METADATA"] = "\n".join(metadata).encode()
    files[metadata_prefix + "WHEEL"] = b"Wheel-Version: 1.0\nTag: py3-none-any\n"
    files[metadata_prefix + "entry_points.txt"] = (
        b"[console_scripts]\nsourcesql=sourcesql.cli:main\n"
    )
    for name in ("LICENSE", "NOTICE"):
        files[metadata_prefix + "licenses/" + name] = (root / name).read_bytes()
    record_path = metadata_prefix + "RECORD"
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for name, data in files.items():
        encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow((name, "sha256=" + encoded, len(data)))
    writer.writerow((record_path, "", ""))
    files[record_path] = record.getvalue().encode()
    wheel = tmp_path / f"sourcesql-{runtime['version']}-py3-none-any.whl"
    wheel.write_bytes(archive(files))
    manifest = builder.build(wheel, tmp_path / "flight")
    assert manifest["flight_source_bytes"] <= 200_000
    assert manifest["execution_wheel_omitted_files"] == list(builder.EXECUTION_OMISSIONS)
    assert manifest["tokenizer_hydration"] == {
        **builder.TOKENIZER_HYDRATION,
        "distribution_resource_sha256": builder.digest(files[builder.TOKENIZER_RESOURCE]),
    }
    assert builder.TOKENIZER_RESOURCE in manifest["engine_source_sha256"]
