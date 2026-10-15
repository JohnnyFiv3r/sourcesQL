from __future__ import annotations

import hashlib
import io
import json
from types import SimpleNamespace
import sys

import pytest

from sourcesql import onboarding


class Response(io.BytesIO):
    def __init__(self, data: bytes, url: str):
        super().__init__(data)
        self.url = url


def test_release_download_uses_exact_version_and_hash(tmp_path, monkeypatch):
    wheel = b"synthetic wheel bytes"
    calls = []
    metadata = {
        "urls": [
            {
                "filename": "sourcesql-0.1.0-py3-none-any.whl",
                "url": "https://files.pythonhosted.org/packages/current.whl",
                "digests": {"sha256": hashlib.sha256(wheel).hexdigest()},
            }
        ]
    }

    def request(url, *, timeout):
        calls.append((url, timeout))
        return Response(json.dumps(metadata).encode() if "pypi.org" in url else wheel, url)

    monkeypatch.setattr(onboarding, "urlopen", request)
    path = onboarding.download_release_wheel(tmp_path, "0.1.0")
    assert path.read_bytes() == wheel
    assert path.stat().st_mode & 0o777 == 0o600
    assert calls[0][0] == "https://pypi.org/pypi/sourcesql/0.1.0/json"


@pytest.mark.parametrize(
    "url",
    [
        "http://files.pythonhosted.org/a",
        "https://evil.example/a",
        "https://token@files.pythonhosted.org/a",
    ],
)
def test_release_download_refuses_untrusted_destination(tmp_path, monkeypatch, url):
    metadata = {"urls": [{"filename": "sourcesql-0.1.0-py3-none-any.whl", "url": url}]}
    monkeypatch.setattr(
        onboarding, "urlopen", lambda *a, **k: Response(json.dumps(metadata).encode(), a[0])
    )
    with pytest.raises(ValueError, match="untrusted_wheel_location"):
        onboarding.download_release_wheel(tmp_path, "0.1.0")


def test_release_download_refuses_wrong_hash(tmp_path, monkeypatch):
    metadata = {
        "urls": [
            {
                "filename": "sourcesql-0.1.0-py3-none-any.whl",
                "url": "https://files.pythonhosted.org/a",
                "digests": {"sha256": "0" * 64},
            }
        ]
    }
    monkeypatch.setattr(
        onboarding,
        "urlopen",
        lambda url, **k: Response(
            json.dumps(metadata).encode() if "pypi.org" in url else b"wrong wheel", url
        ),
    )
    with pytest.raises(ValueError, match="wheel_integrity"):
        onboarding.download_release_wheel(tmp_path, "0.1.0")
    assert not list(tmp_path.glob("*.whl"))


def test_installed_setup_dispatches_materialized_template_without_secret_arguments(
    tmp_path, monkeypatch
):
    workspace = tmp_path / "personal"
    bundle = workspace / "bundle"
    bundle.mkdir(parents=True)
    (bundle / "manifest.json").write_text("{}")
    calls = []
    root = workspace / "template"
    monkeypatch.setitem(
        sys.modules,
        "sourcesql.resources",
        SimpleNamespace(materialize_personal_cloud=lambda destination: root),
    )
    monkeypatch.setattr(onboarding.shutil, "which", lambda executable: "/node24/bin/node")

    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout="v24.15.0\n", returncode=0)

    monkeypatch.setattr(onboarding.subprocess, "run", run)
    monkeypatch.setenv("MOTHERDUCK_TOKEN", "secret-not-an-argument")
    assert (
        onboarding.run_personal_cloud(
            ["plan", "--workspace", str(workspace), "--config", str(tmp_path / "config.json")]
        )
        == 0
    )
    assert calls[-1][1] == str(root / "hosted/personal-cloud.mjs")
    assert "--config" in calls[-1]
    assert "secret-not-an-argument" not in " ".join(calls[-1])
    assert workspace.stat().st_mode & 0o777 == 0o700


def test_apply_requires_reviewed_digest(tmp_path):
    with pytest.raises(SystemExit) as error:
        onboarding.run_personal_cloud(["apply", "--workspace", str(tmp_path)])
    assert error.value.code == 2


def test_wrong_node_version_reports_sanitized_prerequisite(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(onboarding.shutil, "which", lambda executable: "/node26/bin/node")
    monkeypatch.setattr(
        onboarding.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="v26.0.0\n")
    )
    assert onboarding.run_personal_cloud(["status", "--workspace", str(tmp_path)]) == 1
    assert json.loads(capsys.readouterr().err)["reason"] == "node_24_required"


def test_private_multikey_env_file_uses_native_node_loader(tmp_path, monkeypatch):
    secret_file = tmp_path / ".env"
    secret_file.write_text("MOTHERDUCK_TOKEN=private-md\nEXA_API_KEY=private-exa\n")
    secret_file.chmod(0o600)
    monkeypatch.setitem(
        sys.modules,
        "sourcesql.resources",
        SimpleNamespace(materialize_personal_cloud=lambda destination: destination),
    )
    monkeypatch.setattr(onboarding.shutil, "which", lambda executable: "/node24/bin/node")
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout="v24.15.0\n", returncode=0)

    monkeypatch.setattr(onboarding.subprocess, "run", run)
    assert (
        onboarding.run_personal_cloud(
            ["status", "--workspace", str(tmp_path / "workspace"), "--env-file", str(secret_file)]
        )
        == 0
    )
    assert calls[-1][1] == "--env-file=" + str(secret_file)
    assert "private-md" not in " ".join(calls[-1])
    assert "private-exa" not in " ".join(calls[-1])


def test_world_readable_env_file_is_refused(tmp_path, monkeypatch, capsys):
    secret_file = tmp_path / ".env"
    secret_file.write_text("MOTHERDUCK_TOKEN=never-logged\n")
    secret_file.chmod(0o644)
    monkeypatch.setitem(
        sys.modules,
        "sourcesql.resources",
        SimpleNamespace(materialize_personal_cloud=lambda destination: destination),
    )
    monkeypatch.setattr(onboarding.shutil, "which", lambda executable: "/node24/bin/node")
    monkeypatch.setattr(
        onboarding.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(stdout="v24.15.0\n", returncode=0),
    )
    assert (
        onboarding.run_personal_cloud(
            ["status", "--workspace", str(tmp_path / "workspace"), "--env-file", str(secret_file)]
        )
        == 1
    )
    output = capsys.readouterr().err
    assert "private_env_file_required" in output
    assert "never-logged" not in output
