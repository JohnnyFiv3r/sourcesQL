"""Build an allowlisted, credential-free installed-engine qualification Flight.

This emits local artifacts only. Provisioning and execution remain operator actions.
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def collected_test_counts(root):
    # Collect the current public suite without running tests or copying operator
    # credentials into the subprocess. Do not guess parametrized case counts.
    names = ("PATH", "TMPDIR", "LANG", "LC_ALL")
    environment = {name: os.environ[name] for name in names if name in os.environ}
    environment.update({"PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", "tests"],
        cwd=root, env=environment, capture_output=True, text=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        raise ValueError("Current public fixture test collection failed")
    identifiers = [line for line in result.stdout.splitlines() if line.startswith("tests/") and "::" in line]
    summary = re.search(r"(\d+) tests? collected", result.stdout)
    if summary is None or int(summary.group(1)) != len(identifiers):
        raise ValueError("Test collection identifiers and summary disagree")
    linux = sum(name.startswith("tests/security/test_linux_worker_isolation.py::") for name in identifiers)
    macos = sum(name.startswith("tests/security/test_worker_isolation.py::") for name in identifiers)
    if linux != 44 or macos != 4:
        raise ValueError("Review the Linux/macOS isolation contract after suite changes")
    return {"expected_tests": len(identifiers), "expected_linux_tests": linux,
            "expected_macos_skips": macos, "collected_nodeids_sha256": digest("\n".join(identifiers).encode())}


def build(wheel: Path, output: Path):
    directory = Path(__file__).resolve().parent
    root = directory.parents[2]
    wheel = wheel.resolve()
    if wheel.name != "sourcesql-0.1.0a1-py3-none-any.whl":
        raise ValueError("Use the explicitly reviewed sourcesQL engine wheel")
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        source_hashes = {}
        for path in sorted((root / "src/sourcesql").rglob("*.py")):
            relative = str(path.relative_to(root / "src"))
            data = path.read_bytes()
            if relative not in names or archive.read(relative) != data:
                raise ValueError("Engine wheel differs from current source: " + relative)
            source_hashes[relative] = digest(data)
        wheel_sources = {name for name in names if name.startswith("sourcesql/") and name.endswith(".py")}
        if wheel_sources != set(source_hashes):
            raise ValueError("Wheel contains an unexpected source file")
        metadata_prefix = "sourcesql-0.1.0a1.dist-info/"
        allowed_metadata = {metadata_prefix + suffix for suffix in (
            "METADATA", "WHEEL", "entry_points.txt", "RECORD", "licenses/LICENSE", "licenses/NOTICE",
        )}
        if names != wheel_sources | allowed_metadata:
            raise ValueError("Wheel contains files outside the reviewed public allowlist")
        for name in ("LICENSE", "NOTICE"):
            if archive.read(metadata_prefix + "licenses/" + name) != (root / name).read_bytes():
                raise ValueError("Wheel license/provenance differs from public repository files")

    spec = importlib.util.spec_from_file_location("dependency_manifest", directory.parent / "dependencies/setup.py")
    dependency_manifest = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dependency_manifest)
    runtime, requirements, _ = dependency_manifest.manifest_and_requirements(root)
    lock = tomllib.loads((root / "uv.lock").read_text())
    packages = {package["name"]: package for package in lock["package"]}
    pins = dict(runtime["versions"])

    def visit(name):
        package = packages[name]
        pins[name] = package["version"]
        for edge in package.get("dependencies", []):
            marker = edge.get("marker")
            if marker == "sys_platform == 'win32'":
                continue
            if marker not in (None, "python_full_version < '3.13'"):
                raise ValueError("Unreviewed pytest dependency marker: " + str(marker))
            if edge["name"] not in pins:
                visit(edge["name"])

    visit("pytest")
    # Qualification-only installer; it is not an engine dependency and does
    # not resolve/download dependencies or require pip in the Flight runtime.
    pins["installer"] = "0.7.0"
    for name, version in sorted(pins.items()):
        if name not in runtime["versions"]:
            requirements += f"{name}=={version}\n"

    files = {"wheel/" + wheel.name: wheel.read_bytes()}
    for path in sorted((root / "tests").rglob("*.py")):
        files[str(path.relative_to(root))] = path.read_bytes()
    for path in sorted((root / "examples").glob("*.sql")):
        files[str(path.relative_to(root))] = path.read_bytes()
    for name in ("pyproject.toml", "uv.lock"):
        files[name] = (root / name).read_bytes()
    buffer = io.BytesIO()
    # Compress the public archive once with XZ. Deflating each member first
    # prevents XZ from sharing repeated test/source material across members.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    bundle = buffer.getvalue()
    compressed = lzma.compress(bundle)
    counts = collected_test_counts(root)
    manifest = {
        "schema": "sourcesql.worker-qualification-bundle.v1",
        "wheel": wheel.name,
        "wheel_sha256": digest(wheel.read_bytes()),
        "archive_sha256": digest(bundle),
        "archive_bytes": len(bundle),
        "compressed_bytes": len(compressed),
        "compressed_sha256": digest(compressed),
        "encoding": "xz-base85",
        "manifest_encoding": "xz-base64",
        "archive_files": {name: digest(data) for name, data in sorted(files.items())},
        "engine_source_sha256": source_hashes,
        "versions": dict(sorted(pins.items())),
        "runtime_manifest": runtime,
        **counts,
        "synthetic_data_only": True,
    }
    template = (directory / "flight.py").read_text()
    assignments = {
        node.targets[0].id: ast.literal_eval(node.value)
        for node in ast.parse(template).body
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id in {"BUNDLE_MANIFEST", "BUNDLE_ENCODED"}
    }
    if assignments != {"BUNDLE_MANIFEST": None, "BUNDLE_ENCODED": None}:
        raise ValueError("Qualification Flight template assignments changed")
    encoded_manifest = base64.b64encode(lzma.compress(json.dumps(manifest, separators=(",", ":")).encode())).decode("ascii")
    source = template.replace("BUNDLE_MANIFEST = None", "BUNDLE_MANIFEST = json.loads(lzma.decompress(base64.b64decode(" + repr(encoded_manifest) + ")))", 1)
    source = source.replace("BUNDLE_ENCODED = None", "BUNDLE_ENCODED = " + repr(base64.b85encode(compressed).decode("ascii")), 1)
    if len(source.encode()) > 200000:
        raise ValueError("Qualification Flight exceeds the 200,000-byte source limit")
    if len(requirements.encode()) > 20000:
        raise ValueError("Qualification Flight exceeds the 20,000-byte requirements limit")
    output.mkdir(parents=True, exist_ok=True)
    (output / "flight.py").write_text(source)
    (output / "requirements.txt").write_text(requirements)
    (output / "bundle.zip").write_bytes(bundle)
    (output / "bundle.zip.xz").write_bytes(compressed)
    record = {**manifest, "flight_source_sha256": digest(source.encode()), "flight_source_bytes": len(source.encode()), "flight_source_encoding": "plain-python", "requirements_sha256": digest(requirements.encode())}
    (output / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({key: record[key] for key in ("wheel_sha256", "archive_bytes", "compressed_bytes", "compressed_sha256", "encoding", "flight_source_bytes", "flight_source_sha256", "requirements_sha256")}))
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    build(arguments.wheel, arguments.output)
