"""Build a credential-free, source-matched production MotherDuck Flight.

This creates local artifacts only. A coordinator provisions and submits the Flight.
"""

from __future__ import annotations

import argparse
import ast
import base64
from email.parser import Parser
import hashlib
import io
import json
import lzma
from pathlib import Path
import re
import tomllib
import zipfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def runtime_requirements(root: Path) -> tuple[dict, str]:
    """Resolve only reviewed Linux/Python markers from exact repository pins."""
    project_bytes = (root / "pyproject.toml").read_bytes()
    lock_bytes = (root / "uv.lock").read_bytes()
    project = tomllib.loads(project_bytes.decode())["project"]
    if project["requires-python"] != ">=3.12,<3.15":
        raise ValueError("Review the hosted runtime guard after Python support changes")
    lock = tomllib.loads(lock_bytes.decode())
    packages = {package["name"]: package for package in lock["package"]}
    optional = project.get("optional-dependencies", {})
    if set(optional) != {"motherduck"}:
        raise ValueError("Review hosted optional dependency selection after extra changes")
    selected_requirements = project["dependencies"] + optional["motherduck"]
    direct, extras = {}, {}
    for requirement in selected_requirements:
        match = re.fullmatch(
            r"([A-Za-z0-9-]+)(?:\[([A-Za-z0-9,-]+)\])?==([0-9A-Za-z.]+)", requirement
        )
        if match is None:
            raise ValueError("Hosted Flight requires exact repository dependency pins")
        name, extra, version = match.groups()
        if name not in packages or packages[name]["version"] != version:
            raise ValueError("Project and lock disagree for " + name)
        direct[name], extras[name] = version, set(extra.split(",")) if extra else set()
    versions, visited = {}, set()

    def visit(name, selected_extras=()):
        key = (name, tuple(sorted(selected_extras)))
        if key in visited:
            return
        visited.add(key)
        package = packages[name]
        versions[name] = package["version"]
        edges = list(package.get("dependencies", []))
        for extra in selected_extras:
            edges.extend(package.get("optional-dependencies", {})[extra])
        for edge in edges:
            marker = edge.get("marker")
            if marker in ("sys_platform == 'emscripten'", "sys_platform == 'win32'"):
                continue
            if marker not in (
                None,
                "sys_platform != 'emscripten'",
                "python_full_version < '3.13'",
                "implementation_name != 'pypy'",
            ):
                raise ValueError("Unreviewed hosted dependency marker: " + str(marker))
            visit(edge["name"], edge.get("extra", []))

    for name in direct:
        visit(name, extras[name])
    if "installer" in versions:
        raise ValueError("Review the installer pin after runtime dependency changes")
    versions["installer"] = "0.7.0"
    requirements = list(selected_requirements)
    requirements.extend(
        f"{name}=={version}" for name, version in sorted(versions.items()) if name not in direct
    )
    return {
        "project": project["name"],
        "version": project["version"],
        "requires_python": project["requires-python"],
        "versions": dict(sorted(versions.items())),
        "direct_requirements": selected_requirements,
        "base_requirements": project["dependencies"],
        "optional_requirements": optional,
        "selected_extras": ["motherduck"],
        "target": "Linux CPython 3.12 through 3.14; emscripten/win32 dependencies excluded",
        "pyproject_sha256": digest(project_bytes),
        "uv_lock_sha256": digest(lock_bytes),
    }, "\n".join(requirements) + "\n"


def validate_wheel(root: Path, wheel: Path, runtime: dict) -> dict[str, str]:
    expected_name = f"sourcesql-{runtime['version']}-py3-none-any.whl"
    if runtime["project"] != "sourcesql" or wheel.name != expected_name:
        raise ValueError("Use the current public sourcesQL universal engine wheel")
    metadata_prefix = f"sourcesql-{runtime['version']}.dist-info/"
    allowed_metadata = {
        metadata_prefix + suffix
        for suffix in (
            "METADATA",
            "WHEEL",
            "entry_points.txt",
            "RECORD",
            "licenses/LICENSE",
            "licenses/NOTICE",
        )
    }
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Wheel contains duplicate paths")
        source_hashes = {}
        for path in sorted((root / "src/sourcesql").rglob("*.py")):
            relative = path.relative_to(root / "src").as_posix()
            data = path.read_bytes()
            if relative not in names or archive.read(relative) != data:
                raise ValueError("Engine wheel differs from current source: " + relative)
            source_hashes[relative] = digest(data)
        if set(names) != set(source_hashes) | allowed_metadata:
            raise ValueError("Wheel contains files outside the reviewed public allowlist")
        for name in ("LICENSE", "NOTICE"):
            if archive.read(metadata_prefix + "licenses/" + name) != (root / name).read_bytes():
                raise ValueError("Wheel license/provenance differs from public repository")
        metadata = Parser().parsestr(archive.read(metadata_prefix + "METADATA").decode())
        if metadata.get("Version") != runtime["version"]:
            raise ValueError("Wheel metadata version differs from repository")

        def normalize_specifiers(value):
            return set(value.replace(" ", "").split(","))

        if normalize_specifiers(metadata.get("Requires-Python", "")) != normalize_specifiers(
            runtime["requires_python"]
        ):
            raise ValueError("Wheel Python support differs from repository")

        def normalize_requirement(value):
            return value.replace(" ", "").replace('"', "'").lower()

        wheel_requirements = sorted(
            normalize_requirement(value) for value in metadata.get_all("Requires-Dist", [])
        )
        expected_requirements = list(runtime["base_requirements"])
        for extra, selected in runtime["optional_requirements"].items():
            expected_requirements.extend(value + ";extra=='" + extra + "'" for value in selected)
        if wheel_requirements != sorted(map(normalize_requirement, expected_requirements)):
            raise ValueError("Wheel dependencies differ from repository")
        if sorted(metadata.get_all("Provides-Extra", [])) != sorted(
            runtime["optional_requirements"]
        ):
            raise ValueError("Wheel optional dependencies differ from repository")
    return source_hashes


def build(wheel: Path, output: Path) -> dict:
    directory = Path(__file__).resolve().parent
    root = directory.parents[1]
    wheel = wheel.resolve()
    runtime, requirements = runtime_requirements(root)
    source_hashes = validate_wheel(root, wheel, runtime)
    profile_source = (directory / "exa_profile.py").read_bytes()
    files = {"wheel/" + wheel.name: wheel.read_bytes(), "hosted/exa_profile.py": profile_source}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    bundle = buffer.getvalue()
    compressed = lzma.compress(bundle)
    manifest = {
        "schema": "sourcesql.hosted-flight-bundle.v1",
        "wheel": wheel.name,
        "wheel_sha256": digest(wheel.read_bytes()),
        "archive_sha256": digest(bundle),
        "archive_bytes": len(bundle),
        "compressed_sha256": digest(compressed),
        "compressed_bytes": len(compressed),
        "encoding": "xz-base85",
        "manifest_encoding": "xz-base64",
        "archive_files": {name: digest(data) for name, data in sorted(files.items())},
        "engine_source_sha256": source_hashes,
        "hosted_profile_sha256": digest(profile_source),
        "hosted_profile_default": "fixture",
        "runtime": runtime,
        "credentials_embedded": False,
        "tests_embedded": False,
    }
    template = (directory / "runner.py").read_text()
    assignments = {
        node.targets[0].id: ast.literal_eval(node.value)
        for node in ast.parse(template).body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id in {"BUNDLE_MANIFEST", "BUNDLE_ENCODED"}
    }
    if assignments != {"BUNDLE_MANIFEST": None, "BUNDLE_ENCODED": None}:
        raise ValueError("Hosted Flight template assignments changed")
    encoded_manifest = base64.b64encode(
        lzma.compress(json.dumps(manifest, separators=(",", ":")).encode())
    ).decode("ascii")
    source = template.replace(
        "BUNDLE_MANIFEST = None",
        "BUNDLE_MANIFEST = json.loads(lzma.decompress(base64.b64decode("
        + repr(encoded_manifest)
        + ")))",
        1,
    )
    source = source.replace(
        "BUNDLE_ENCODED = None",
        "BUNDLE_ENCODED = " + repr(base64.b85encode(compressed).decode("ascii")),
        1,
    )
    if len(source.encode()) > 200_000:
        raise ValueError("Hosted Flight exceeds the 200,000-byte source limit")
    if len(requirements.encode()) > 20_000:
        raise ValueError("Hosted Flight exceeds the 20,000-byte requirements limit")
    output.mkdir(parents=True, exist_ok=True)
    (output / "flight.py").write_text(source)
    (output / "requirements.txt").write_text(requirements)
    (output / "bundle.zip").write_bytes(bundle)
    (output / "bundle.zip.xz").write_bytes(compressed)
    record = {
        **manifest,
        "flight_source_sha256": digest(source.encode()),
        "flight_source_bytes": len(source.encode()),
        "requirements_sha256": digest(requirements.encode()),
    }
    (output / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    print(
        json.dumps(
            {
                key: record[key]
                for key in (
                    "wheel_sha256",
                    "compressed_bytes",
                    "flight_source_bytes",
                    "flight_source_sha256",
                    "requirements_sha256",
                )
            }
        )
    )
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    build(args.wheel, args.output)
