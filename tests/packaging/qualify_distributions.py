"""Qualify built distributions in fresh environments outside the source tree.

Run explicitly: python tests/packaging/qualify_distributions.py --dist dist
Provider calls are never required; all research here uses synthetic fixtures.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import venv
import zipfile


def inspect_distributions(directory: Path) -> tuple[list[Path], dict]:
    artifacts = sorted([*directory.glob("sourcesql-*.whl"), *directory.glob("sourcesql-*.tar.gz")])
    if len(artifacts) != 2 or sum(path.suffix == ".whl" for path in artifacts) != 1:
        raise AssertionError("Expected exactly one sourcesQL wheel and source distribution")
    hashes = {}
    for artifact in artifacts:
        hashes[artifact.name] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        if artifact.suffix == ".whl":
            with zipfile.ZipFile(artifact) as archive:
                names = archive.namelist()
                assert "sourcesql/_resources/personal-cloud.zip" in names
                assert "sourcesql/onboarding/__init__.py" in names
                assert "sourcesql/resources.py" in names
                assert all(name.startswith(("sourcesql/", "sourcesql-")) for name in names)
                with zipfile.ZipFile(
                    io.BytesIO(archive.read("sourcesql/_resources/personal-cloud.zip"))
                ) as templates:
                    names += templates.namelist()
        else:
            with tarfile.open(artifact) as archive:
                members = archive.getmembers()
                assert all(member.isfile() or member.isdir() for member in members)
                names = [member.name.split("/", 1)[-1] for member in members]
                assert "hatch_build.py" in names
                assert "hosted/personal-cloud.mjs" in names
        for name in names:
            parts = Path(name).parts
            assert not any(
                part in {"local", ".git", "node_modules", ".vercel", ".data"} for part in parts
            )
            assert not any(
                part.startswith(".env") or part.lower().endswith(".pdf") for part in parts
            )
    return artifacts, hashes


def qualify(artifact: Path, work: Path) -> dict:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in {"PYTHONPATH", "VIRTUAL_ENV"}
        and not key.startswith("SOURCESQL_")
        and not key.endswith(("_API_KEY", "_TOKEN", "_SECRET"))
    }
    work.mkdir()
    venv_path = work / "venv"
    venv.EnvBuilder(with_pip=True, symlinks=True).create(venv_path)
    python = venv_path / "bin/python"
    cli = venv_path / "bin/sourcesql"

    def run(args):
        result = subprocess.run(
            list(map(str, args)),
            cwd=work,
            env=environment,
            text=True,
            capture_output=True,
            timeout=240,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(
                f"Installed qualification failed ({result.returncode}): {args[0]}\n"
                + result.stdout[-4000:]
                + result.stderr[-4000:]
            )
        return result.stdout

    run([python, "-m", "pip", "install", "--disable-pip-version-check", artifact])
    run([python, "-m", "pip", "check"])
    origin = json.loads(
        run(
            [
                python,
                "-I",
                "-c",
                (
                    "import json, sourcesql; from importlib.metadata import version; "
                    "print(json.dumps({'path': sourcesql.__file__, 'version': version('sourcesql')}))"
                ),
            ]
        )
    )
    assert Path(origin["path"]).resolve().is_relative_to(venv_path.resolve())
    capabilities = json.loads(run([cli, "--store", work / "store", "capabilities", "--json"]))
    assert capabilities["engine_version"] == origin["version"]
    result = json.loads(run([cli, "--store", work / "store", "demo", "--output", work / "demo"]))
    assert result["receipt"]["status"] == "completed"
    assert {row["project"] for row in result["rows"]} == {"Aurora Campus", "Birch Campus"}
    assert all(event.get("fixture_only") for event in result["receipt"]["provider_events"])
    reopened = json.loads(run([cli, "--store", work / "store", "read", result["result_id"]]))
    assert reopened["rows"] == result["rows"]
    imported = json.loads(
        run(
            [cli, "--store", work / "restored", "import", work / "demo/bundle.json", "--no-network"]
        )
    )
    assert imported["rows"] == result["rows"]
    restored = json.loads(run([cli, "--store", work / "restored", "read", imported["result_id"]]))
    assert restored["rows"] == result["rows"]
    assert "personal-cloud" in run([cli, "setup", "--help"])
    assert "--help" in run([cli, "setup", "personal-cloud", "--help"])
    run(
        [
            python,
            "-I",
            "-c",
            (
                "from pathlib import Path; from sourcesql.resources import materialize_personal_cloud; "
                "root=Path('templates'); materialize_personal_cloud(root); "
                "materialize_personal_cloud(root); "
                "assert (root/'apps/research/package-lock.json').is_file(); "
                "assert (root/'hosted/flight/build.py').is_file()"
            ),
        ]
    )
    config_path = work / "personal-cloud.json"
    config_path.write_text(
        json.dumps(
            {
                "project": "personal-research",
                "account_id": "account_fixture1",
                "alias": "personal-research-fixture.vercel.app",
                "database": "research",
                "principal": "personal-owner",
                "oauth": {
                    "issuer": "https://login.example.org/",
                    "subject": "auth0|immutable-owner",
                    "jwks_uri": "https://login.example.org/.well-known/jwks.json",
                },
            }
        )
    )
    wheel = next(artifact.parent.glob("sourcesql-*-py3-none-any.whl"))
    arguments = [
        cli,
        "setup",
        "personal-cloud",
        "plan",
        "--workspace",
        work / "cloud",
        "--config",
        config_path,
        "--wheel",
        wheel,
    ]
    plan = json.loads(run(arguments))
    assert plan["limits"]["live_search_calls_during_setup"] == 0
    assert plan["limits"]["execution_enabled"] is False
    assert len(plan["plan_sha256"]) == 64
    assert json.loads(run(arguments))["plan_sha256"] == plan["plan_sha256"]
    status = json.loads(
        run([cli, "setup", "personal-cloud", "status", "--workspace", work / "cloud"])
    )
    assert status["plan_sha256"] == plan["plan_sha256"]
    return {
        "artifact": artifact.name,
        "version": origin["version"],
        "installed_outside_checkout": True,
        "fixture_rows": len(result["rows"]),
        "saved_result_reopened": True,
        "export_import": True,
        "setup_help": True,
        "templates_materialized_twice": True,
        "installed_cloud_plan_and_resume": True,
        "live_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    artifacts, hashes = inspect_distributions(args.dist.resolve())
    with tempfile.TemporaryDirectory(prefix="sourcesql-installed-") as directory:
        results = [
            qualify(artifact, Path(directory) / str(index))
            for index, artifact in enumerate(artifacts)
        ]
    report = {"schema": "sourcesql.package-qualification.v1", "sha256": hashes, "checks": results}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
