"""Record installed fixture-suite qualification without provider or cloud calls.

Run this script with the interpreter being qualified after a frozen installation.
The receipt records source hashes before and after every check, so a concurrently
edited checkout cannot be mistaken for a fixed qualification snapshot.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import tomllib


def source_hashes(root: Path) -> dict[str, str]:
    files = [root / "pyproject.toml", root / "uv.lock"]
    for directory in ("src/sourcesql", "tests"):
        files.extend(sorted((root / directory).rglob("*.py")))
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-minor", default="3.12")
    args = parser.parse_args()
    observed_minor = f"{sys.version_info.major}.{sys.version_info.minor}"
    if observed_minor != args.expected_minor:
        parser.error(f"Expected Python {args.expected_minor}; observed {observed_minor}")

    root = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock = tomllib.loads((root / "uv.lock").read_text())
    installed = {}
    for package in lock["package"]:
        name = package["name"]
        try:
            installed[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            # Conditional dependencies may be legitimately absent on this OS.
            installed[name] = None
    mismatches = {
        package["name"]: {
            "locked": package["version"],
            "installed": installed[package["name"]],
        }
        for package in lock["package"]
        if installed[package["name"]] not in (None, package["version"])
    }
    receipt = {
        "schema": "sourcesql.python-qualification.v1",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "interpreter": sys.executable,
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "package_requires_python": metadata.metadata("sourcesql")["Requires-Python"],
        "locked_versions": {p["name"]: p["version"] for p in lock["package"]},
        "installed_versions": installed,
        "version_mismatches": mismatches,
        "checks": [],
        "provider_calls": 0,
        "cloud_calls": 0,
        "qualification_scope": "installed fixture engine and host OS isolation tests",
    }
    if mismatches:
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        raise SystemExit("Installed packages differ from the repository lock")

    # The fixture suite receives only ordinary runtime paths and locale settings.
    # Configured search/model/database credentials never enter the test process.
    safe_names = ("PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT")
    environment = {name: os.environ[name] for name in safe_names if name in os.environ}
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    stages = (
        ("pytest", ["-m", "pytest", "-q", "--junitxml", str(output / "pytest.xml")]),
        ("ruff", ["-m", "ruff", "check", "src", "tests", "scripts/qualify_python.py"]),
        ("mypy", ["-m", "mypy", "src"]),
    )
    passed = True
    for name, command in stages:
        before = source_hashes(root)
        started = time.monotonic()
        run = subprocess.run(
            [sys.executable, *command],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        after = source_hashes(root)
        (output / f"{name}.log").write_text(run.stdout + run.stderr)
        stable = before == after
        receipt["checks"].append({
            "name": name,
            "exit_code": run.returncode,
            "seconds": round(time.monotonic() - started, 3),
            "source_hashes_before": before,
            "source_hashes_after": after,
            "source_stable_during_check": stable,
        })
        passed = passed and run.returncode == 0 and stable
        print(f"{name}: exit={run.returncode}, source_stable={stable}", flush=True)
        print(run.stdout + run.stderr, flush=True)
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")

    receipt["completed_at"] = datetime.now(timezone.utc).isoformat()
    receipt["passed"] = passed
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
