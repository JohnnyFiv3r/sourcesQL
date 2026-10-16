"""Installed setup refuses corrupt archives and existing adopter changes."""

import hashlib
import io
import json
from pathlib import Path
import tomllib
import zipfile

import pytest

from sourcesql import resources


def archive_for(bodies, hashes=None):
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        manifest = {
            "schema": "sourcesql.personal-cloud-templates.v1",
            "files": hashes
            or {name: hashlib.sha256(body).hexdigest() for name, body in bodies.items()},
        }
        for name, body in bodies.items():
            archive.writestr(name, body)
        archive.writestr(resources.MANIFEST, json.dumps(manifest))
    return result.getvalue()


def installed_archive(tmp_path, monkeypatch, data):
    package = tmp_path / "package"
    path = package / resources.ARCHIVE
    path.parent.mkdir(parents=True)
    path.write_bytes(data)
    monkeypatch.setattr(resources, "files", lambda package_name: package)


def test_materialization_reopens_exact_files_without_overwriting_changes(tmp_path, monkeypatch):
    installed_archive(
        tmp_path, monkeypatch, archive_for({"LICENSE": b"public", "NOTICE": b"notice"})
    )
    output = tmp_path / "project"
    assert resources.materialize_personal_cloud(output) == output
    resources.materialize_personal_cloud(output)
    (output / "LICENSE").write_bytes(b"adopter edit")
    with pytest.raises(ValueError, match="was changed"):
        resources.materialize_personal_cloud(output)
    assert (output / "LICENSE").read_bytes() == b"adopter edit"


@pytest.mark.parametrize("name", ["../escape.py", "/outside.py", "local/credentials.env"])
def test_materialization_rejects_unreviewed_paths(tmp_path, monkeypatch, name):
    installed_archive(tmp_path, monkeypatch, archive_for({name: b"never write"}))
    output = tmp_path / "project"
    with pytest.raises(ValueError):
        resources.materialize_personal_cloud(output)
    assert not output.exists()


def test_materialization_verifies_every_hash_before_writing(tmp_path, monkeypatch):
    installed_archive(
        tmp_path,
        monkeypatch,
        archive_for(
            {"LICENSE": b"public", "NOTICE": b"changed"},
            {"LICENSE": hashlib.sha256(b"public").hexdigest(), "NOTICE": "0" * 64},
        ),
    )
    output = tmp_path / "project"
    with pytest.raises(ValueError, match="hash"):
        resources.materialize_personal_cloud(output)
    assert not output.exists()


def test_materialization_does_not_follow_existing_symlinks(tmp_path, monkeypatch):
    installed_archive(tmp_path, monkeypatch, archive_for({"LICENSE": b"public"}))
    outside = tmp_path / "outside"
    outside.mkdir()
    output = tmp_path / "project"
    output.mkdir()
    (output / "LICENSE").symlink_to(outside / "secret")
    with pytest.raises(ValueError, match="symbolic link"):
        resources.materialize_personal_cloud(output)
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize(
    ("filename", "size", "sha256"),
    [
        ("research-2511fe6d0adf4f69.html", 676875, "2511fe6d0adf4f693803ff5bd8e4760f3de0cae78593150ddb827c7d521c6475"),
        ("research-9fa11ff58ed34fd6.html", 676864, "9fa11ff58ed34fd69608d172b43004a532aa9ef09ff9d481a3a883d39c28e462"),
        ("research-048e54fb9a70888e.html", 685308, "048e54fb9a70888eef16c2694fe4a24a7d7a7ccadb7b6b29592933276721e598"),
    ],
)
def test_previous_deployed_widget_is_an_exact_materializable_public_template(tmp_path, monkeypatch, filename, size, sha256):
    root = Path(__file__).resolve().parents[2]
    name = "apps/research/ui-history/" + filename
    body = (root / name).read_bytes()
    assert len(body) == size
    assert hashlib.sha256(body).hexdigest() == sha256
    configuration = tomllib.loads((root / "pyproject.toml").read_text())
    assert name in configuration["tool"]["hatch"]["build"]["targets"]["sdist"]["include"]
    installed_archive(tmp_path, monkeypatch, archive_for({name: body}))
    output = resources.materialize_personal_cloud(tmp_path / "project")
    assert (output / name).read_bytes() == body
