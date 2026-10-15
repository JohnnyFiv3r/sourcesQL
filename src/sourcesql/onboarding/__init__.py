"""Reviewed, resumable personal-cloud provisioning; no account or plan upgrades."""

from __future__ import annotations

import argparse
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlparse
from urllib.request import urlopen


MAX_WHEEL_BYTES = 24 * 1024 * 1024


def download_release_wheel(destination: Path, package_version: str) -> Path:
    """Fetch the exact installed release from PyPI; verify its published digest."""
    if not package_version or any(
        c not in "0123456789abcdefghijklmnopqrstuvwxyz.+-" for c in package_version
    ):
        raise ValueError("invalid_package_version")
    with urlopen(f"https://pypi.org/pypi/sourcesql/{package_version}/json", timeout=30) as response:
        metadata = json.loads(response.read(2 * 1024 * 1024))
    name = f"sourcesql-{package_version}-py3-none-any.whl"
    matches = [item for item in metadata["urls"] if item["filename"] == name]
    if len(matches) != 1:
        raise ValueError("exact_release_wheel_unavailable_use_wheel_option")
    item = matches[0]
    url = urlparse(item["url"])
    if (
        url.scheme != "https"
        or url.hostname != "files.pythonhosted.org"
        or url.username
        or url.password
    ):
        raise ValueError("untrusted_wheel_location")
    with urlopen(item["url"], timeout=60) as response:
        final = urlparse(response.url)
        if final.scheme != "https" or final.hostname != "files.pythonhosted.org":
            raise ValueError("untrusted_wheel_location")
        data = response.read(MAX_WHEEL_BYTES + 1)
    if len(data) > MAX_WHEEL_BYTES or hashlib.sha256(data).hexdigest() != item["digests"]["sha256"]:
        raise ValueError("wheel_integrity")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = destination / name
    if output.exists() and (output.is_symlink() or output.read_bytes() != data):
        raise ValueError("existing_wheel_differs")
    output.write_bytes(data)
    output.chmod(0o600)
    return output


def run_personal_cloud(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="sourcesql setup personal-cloud",
        description="Prepare a reviewable personal-cloud plan, then apply/resume its exact digest.",
    )
    parser.add_argument("command", choices=("plan", "apply", "status", "verify"))
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument(
        "--config", type=Path, help="Token-free owner, destination and policy JSON (plan only)"
    )
    parser.add_argument(
        "--wheel", type=Path, help="Exact current wheel; otherwise fetch that version from PyPI"
    )
    parser.add_argument(
        "--approve-plan", help="SHA256 printed by plan (required for apply and verify)"
    )
    parser.add_argument(
        "--env-file", type=Path, help="Private multi-key dotenv file loaded by Node, never uploaded"
    )
    parser.add_argument(
        "--retry-deployment", help="Explicitly replace this observed ERROR/CANCELED deployment once"
    )
    parser.add_argument(
        "--recover-project",
        help="Explicitly reconcile the observed project ID after uncertain creation",
    )
    parser.add_argument(
        "--recover-flight",
        help="Reconcile a known Flight UUID against saved name, code and configuration",
    )
    parser.add_argument(
        "--run-fixture",
        action="store_true",
        help="Deliberately execute/recover one provider-free fixture job",
    )
    args = parser.parse_args(argv)
    if args.command == "plan" and not args.config:
        parser.error("plan requires --config")
    if args.command in ("apply", "verify") and not args.approve_plan:
        parser.error("apply and verify require --approve-plan")
    if args.run_fixture and args.command != "verify":
        parser.error("--run-fixture is only available with verify")
    if args.config and args.command != "plan":
        parser.error("--config is only used by plan; apply resumes saved configuration")
    workspace = args.workspace.expanduser().absolute()
    try:
        if workspace.is_symlink():
            raise ValueError("unsafe_workspace")
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        workspace.chmod(0o700)
        node = shutil.which("node")
        if node is None:
            raise ValueError("node_24_required")
        node_version = subprocess.run(
            [node, "--version"], capture_output=True, text=True, check=True
        ).stdout
        if not node_version.startswith("v24."):
            raise ValueError("node_24_required")
        from sourcesql.resources import materialize_personal_cloud

        root = materialize_personal_cloud(workspace / "template")
        if args.command == "plan" and not (workspace / "bundle/manifest.json").exists():
            wheel = (
                args.wheel.expanduser().resolve()
                if args.wheel
                else download_release_wheel(workspace / "wheel", version("sourcesql"))
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(root / "hosted/flight/build.py"),
                    str(wheel),
                    "--output",
                    str(workspace / "bundle"),
                ],
                cwd=root,
                capture_output=True,
                text=True,
                env={
                    key: value
                    for key, value in os.environ.items()
                    if key in ("PATH", "HOME", "SYSTEMROOT", "TMPDIR")
                },
                check=False,
            )
            if result.returncode:
                raise ValueError("flight_bundle_preparation_failed")
        command = [
            node,
            str(root / "hosted/personal-cloud.mjs"),
            args.command,
            "--root",
            str(root),
            "--workspace",
            str(workspace),
        ]
        if args.env_file:
            env_file = args.env_file.expanduser().absolute()
            if not env_file.is_file() or env_file.is_symlink() or env_file.stat().st_mode & 0o077:
                raise ValueError("private_env_file_required")
            command.insert(1, "--env-file=" + str(env_file))
        if args.retry_deployment:
            if args.command != "apply":
                parser.error("--retry-deployment is only available with apply")
            command.extend(("--retry-deployment", args.retry_deployment))
        if args.recover_project:
            if args.command != "apply":
                parser.error("--recover-project is only available with apply")
            command.extend(("--recover-project", args.recover_project))
        if args.config:
            command.extend(("--config", str(args.config.expanduser().resolve())))
        if args.approve_plan:
            command.extend(("--approve-plan", args.approve_plan))
        if args.recover_flight:
            command.extend(("--recover-flight", args.recover_flight))
        if args.run_fixture:
            command.append("--run-fixture")
        return subprocess.run(command, check=False).returncode
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # Keys, SQL, HTTP bodies and child output never appear in setup errors.
        known = {
            "invalid_package_version",
            "exact_release_wheel_unavailable_use_wheel_option",
            "untrusted_wheel_location",
            "wheel_integrity",
            "existing_wheel_differs",
            "unsafe_workspace",
            "private_env_file_required",
            "node_24_required",
            "flight_bundle_preparation_failed",
        }
        reason = str(error) if str(error) in known else "setup_preparation_failed"
        print(json.dumps({"completed": False, "reason": reason}), file=sys.stderr)
        return 1
