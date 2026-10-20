"""Allowlisted personal-cloud templates shared by source and installed setup."""

from __future__ import annotations

from fnmatch import fnmatchcase
import hashlib
from importlib.resources import files
import io
import json
from pathlib import Path, PurePosixPath
import zipfile


TEMPLATE_PATTERNS = (
    "hatch_build.py",
    "pyproject.toml",
    "uv.lock",
    "LICENSE",
    "NOTICE",
    "src/sourcesql/**/*.py",
    "src/sourcesql/*.py",
    "src/sourcesql/_resources/tokenizers/cl100k_base.tiktoken.gz",
    "src/sourcesql/_resources/tokenizers/TIKTOKEN_LICENSE.txt",
    "hosted/setup.mjs",
    "hosted/personal-cloud.mjs",
    "hosted/flight/build.py",
    "hosted/flight/runner.py",
    "hosted/flight/exa_profile.py",
    "apps/research/package.json",
    "apps/research/package-lock.json",
    "apps/research/tsconfig.json",
    "apps/research/vercel.json",
    "apps/research/.vercelignore",
    "apps/research/index.html",
    "apps/research/research.html",
    "apps/research/api/*.ts",
    "apps/research/server/*.ts",
    "apps/research/src/*.ts",
    "apps/research/src/*.tsx",
    "apps/research/src/*.css",
    "apps/research/src/brand/*.png",
    "apps/research/src/fonts/*.woff2",
    "apps/research/src/fonts/*LICENSE.txt",
    "apps/research/src/fonts/README.md",
    "apps/research/scripts/build.ts",
    "apps/research/scripts/build-vercel.ts",
    "apps/research/scripts/inline-html.ts",
    "apps/research/fixtures/water-procurement.json",
    "apps/research/ui-history/research-dfe1c3e8aec7c276.html",
    "apps/research/ui-history/research-66390a91a9d5271f.html",
    "apps/research/ui-history/research-b1349a13ba4d1fbe.html",
    "apps/research/ui-history/research-be8725d56a366d19.html",
    "apps/research/ui-history/research-b5ab74c900f06fdb.html",
    "apps/research/ui-history/research-a0b4eab71ba980c1.html",
    "apps/research/ui-history/research-a8517535856c8aa3.html",
    "apps/research/ui-history/research-2e96c79d74441904.html",
    "apps/research/ui-history/research-9b396ddfaead18f3.html",
    "apps/research/ui-history/research-3ad849c41d019ecb.html",
    "apps/research/ui-history/research-a19abdd86f97fd03.html",
    "apps/research/ui-history/research-c97b65618bc77ad2.html",
    "apps/research/ui-history/research-048e54fb9a70888e.html",
    "apps/research/ui-history/research-9fa11ff58ed34fd6.html",
    "apps/research/ui-history/research-2511fe6d0adf4f69.html",
    "apps/research/ui-history/research-614374db1156bf54.html",
    "apps/research/ui-history/research-20919a6895fa9fa4.html",
    "apps/research/ui-history/research-758dbf283e918839.html",
    "apps/research/ui-history/research-05a1fb4763622b13.html",
    "apps/research/ui-history/research-898b5e1c6a61a0b8.html",
    "apps/research/ui-history/research-2f4ed43f372d2823.html",
    "apps/research/ui-history/research-f2cf065f35e39de4.html",
    "apps/research/ui-history/research-cf775e01f999f8db.html",
    "apps/research/ui-history/research-06264491f36e0c07.html",
    "apps/research/ui-history/research-d07eedf22b1e048c.html",
)
MANIFEST = "sourcesql-template-manifest.json"
ARCHIVE = "_resources/personal-cloud.zip"


def template_paths(root: Path) -> list[Path]:
    """Fail if a required input is absent; never discover operator directories."""
    selected: set[Path] = set()
    root = root.resolve()
    for pattern in TEMPLATE_PATTERNS:
        matches = list(root.glob(pattern))
        if not matches:
            raise ValueError("Missing personal-cloud template input: " + pattern)
        for path in matches:
            if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
                raise ValueError("Unsafe personal-cloud template input")
            selected.add(path)
    return sorted(selected)


def build_personal_cloud_archive(root: Path) -> bytes:
    """Create identical provisioning bytes for wheels and Flight validation."""
    root = root.resolve()
    bodies = {path.relative_to(root).as_posix(): path.read_bytes() for path in template_paths(root)}
    manifest = {
        "schema": "sourcesql.personal-cloud-templates.v1",
        "files": {name: hashlib.sha256(body).hexdigest() for name, body in bodies.items()},
    }
    bodies[MANIFEST] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    output = io.BytesIO()
    # The outer wheel compresses this member. Store its inner entries so their
    # bytes stay identical across build/validation hosts with different zlib.
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, body in sorted(bodies.items()):
            entry = zipfile.ZipInfo(name, date_time=(2026, 10, 15, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_STORED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, body)
    return output.getvalue()


def materialize_personal_cloud(destination: Path) -> Path:
    """Write verified installed templates; never overwrite an adopter's edits."""
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError("Template destination must not be a symbolic link")
    destination = destination.resolve()
    data = files("sourcesql").joinpath(ARCHIVE).read_bytes()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or MANIFEST not in names:
            raise ValueError("Invalid personal-cloud template archive")
        if sum(entry.file_size for entry in archive.infolist()) > 50_000_000:
            raise ValueError("Personal-cloud template archive is too large")
        manifest = json.loads(archive.read(MANIFEST))
        expected = manifest.get("files", {})
        if manifest.get("schema") != "sourcesql.personal-cloud-templates.v1" or not expected:
            raise ValueError("Invalid personal-cloud template manifest")
        if set(names) != set(expected) | {MANIFEST}:
            raise ValueError("Personal-cloud template manifest differs from archive")
        verified = {}
        for name in expected:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise ValueError("Unsafe personal-cloud template path")
            if not any(fnmatchcase(name, pattern) for pattern in TEMPLATE_PATTERNS):
                raise ValueError("Unreviewed personal-cloud template input")
            body = archive.read(name)
            if hashlib.sha256(body).hexdigest() != expected[name]:
                raise ValueError("Personal-cloud template hash differs from manifest")
            target = destination / name
            if any(parent.is_symlink() for parent in (target, *target.parents)):
                raise ValueError("Personal-cloud template destination contains a symbolic link")
            if target.exists() and (not target.is_file() or target.read_bytes() != body):
                raise ValueError("Existing personal-cloud template was changed: " + name)
            verified[target] = body
        for target, body in verified.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                with target.open("xb") as stream:
                    stream.write(body)
        return destination
