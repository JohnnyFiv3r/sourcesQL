"""Emit SQL only for the repository-pinned dependency Flight; never connect or run."""

from __future__ import annotations

import argparse
import ast
import hashlib
from pathlib import Path
import re
import tomllib
from uuid import UUID


def manifest_and_requirements(root):
    project_bytes = (root / "pyproject.toml").read_bytes()
    lock_bytes = (root / "uv.lock").read_bytes()
    project = tomllib.loads(project_bytes.decode())["project"]
    lock = tomllib.loads(lock_bytes.decode())
    packages = {package["name"]: package for package in lock["package"]}
    direct = {}
    extras = {}
    for requirement in project["dependencies"]:
        match = re.fullmatch(
            r"([A-Za-z0-9-]+)(?:\[([A-Za-z0-9,-]+)\])?==([0-9A-Za-z.]+)", requirement
        )
        if match is None:
            raise ValueError("Probe requires exact repository dependency pins")
        name, extra, version = match.groups()
        if packages[name]["version"] != version:
            raise ValueError("pyproject.toml and uv.lock disagree for " + name)
        direct[name] = version
        extras[name] = set(extra.split(",")) if extra else set()
    versions = {}
    visited = set()

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
            # Resolve only the markers present in this lock for the Linux Flight target.
            # Refuse unfamiliar markers instead of guessing or changing locked packages.
            if marker == "sys_platform == 'emscripten'":
                continue
            if marker not in (None, "sys_platform != 'emscripten'", "python_full_version < '3.13'"):
                raise ValueError("Unreviewed Flight dependency marker: " + marker)
            visit(edge["name"], edge.get("extra", []))

    for name in direct:
        visit(name, extras[name])
    requirements = list(project["dependencies"])
    requirements.extend(
        f"{name}=={version}" for name, version in sorted(versions.items()) if name not in direct
    )
    manifest = {
        "direct_requirements": project["dependencies"],
        "versions": dict(sorted(versions.items())),
        "requires_python": project["requires-python"],
        "target": "Linux Flight Python 3.12; emscripten-only dependency excluded",
        "pyproject_sha256": hashlib.sha256(project_bytes).hexdigest(),
        "uv_lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
    }
    return manifest, "\n".join(requirements) + "\n", direct


def render(database, request_id="unsubmitted"):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", database):
        raise ValueError("Use a simple disposable probe database identifier")
    if request_id != "unsubmitted":
        request_id = str(UUID(request_id))
    directory = Path(__file__).resolve().parent
    manifest, requirements, direct = manifest_and_requirements(directory.parents[2])
    source = (directory / "flight.py").read_text()
    assignments = {
        node.targets[0].id: ast.literal_eval(node.value)
        for node in ast.parse(source).body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id in {"LOCK_MANIFEST", "DIRECT_PINS"}
    }
    if assignments != {"LOCK_MANIFEST": None, "DIRECT_PINS": direct}:
        raise ValueError("Flight probe pins must be reviewed after repository pin changes")
    if manifest["requires_python"] != ">=3.12,<3.15":
        raise ValueError("Flight runtime check must be reviewed after Python requirement changes")
    source = source.replace("LOCK_MANIFEST = None", "LOCK_MANIFEST = " + repr(manifest), 1)

    def literal(value):
        return "'" + value.replace("'", "''") + "'"

    return f"""-- Exact existing sourcesQL runtime pins; no schedule or run is created.
SELECT * FROM md_create_flight(
  name := 'sourcesql_dependency_probe',
  source_code := {literal(source)},
  requirements_txt := {literal(requirements)},
  config := MAP {{'REQUEST_ID': {literal(request_id)}, 'DATABASE': {literal(database)}}},
  instance_type := 'F4', max_runtime_sec := 120
);"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    parser.add_argument("--request-id", default="unsubmitted")
    args = parser.parse_args()
    print(render(args.database, args.request_id))
