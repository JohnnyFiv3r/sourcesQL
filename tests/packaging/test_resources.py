"""Installed setup refuses corrupt archives and existing adopter changes."""

import hashlib
import io
import json
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
