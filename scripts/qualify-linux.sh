#!/usr/bin/env bash
# Offline execution after dependency installation. No host credential forwarding.
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
qualification_tag="${SOURCESQL_QUALIFICATION_IMAGE:-sourcesql:qualification-py312}"
runtime_tag="${SOURCESQL_RUNTIME_IMAGE:-sourcesql:local}"
receipt_dir="${SOURCESQL_QUALIFICATION_OUTPUT:-artifacts/linux-py312-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$receipt_dir"
sentinel_dir="$(mktemp -d)"
trap 'rm -rf -- "$sentinel_dir"' EXIT
printf '%s\n' 'SAFE-SYNTHETIC-DOCKER-SENTINEL' > "$sentinel_dir/sentinel.txt"
chmod 755 "$sentinel_dir"
chmod 644 "$sentinel_dir/sentinel.txt"

docker version > "$receipt_dir/docker-version.txt"
docker build --target qualification --tag "$qualification_tag" . 2>&1 | tee "$receipt_dir/build-qualification.log"
docker build --target runtime --tag "$runtime_tag" . 2>&1 | tee "$receipt_dir/build-runtime.log"
docker image inspect "$qualification_tag" --format '{{json .}}' > "$receipt_dir/qualification-image.json"
docker image inspect "$runtime_tag" --format '{{json .}}' > "$receipt_dir/runtime-image.json"

restriction_flags=(
  --rm --network none --read-only --cap-drop ALL
  --security-opt no-new-privileges:true --user 10001:10001
  --pids-limit 128 --memory 1g --cpus 1
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777
)
docker run "${restriction_flags[@]}" -i "$qualification_tag" python - \
  > "$receipt_dir/runtime-environment.json" <<'PY'
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import sys
import tomllib

root = Path("/workspace")
lock = tomllib.loads((root / "uv.lock").read_text())
installed = {}
for package in lock["package"]:
    try:
        installed[package["name"]] = metadata.version(package["name"])
    except metadata.PackageNotFoundError:
        installed[package["name"]] = None
mismatches = {
    package["name"]: {"locked": package["version"], "installed": installed[package["name"]]}
    for package in lock["package"]
    if installed[package["name"]] not in (None, package["version"])
}
files = [root / "pyproject.toml", root / "uv.lock"]
for directory in ("src/sourcesql", "tests"):
    files.extend(sorted((root / directory).rglob("*.py")))
receipt = {
    "schema": "sourcesql.linux-qualification.v1",
    "python": sys.version,
    "platform": platform.platform(),
    "kernel": platform.release(),
    "machine": platform.machine(),
    "uid": os.getuid(),
    "package_requires_python": metadata.metadata("sourcesql")["Requires-Python"],
    "locked_versions": {package["name"]: package["version"] for package in lock["package"]},
    "installed_versions": installed,
    "version_mismatches": mismatches,
    "source_hashes": {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files
    },
    "provider_calls": 0,
    "network": "none",
    "container_user": "10001:10001",
    "capabilities": "all dropped",
    "seccomp": "Docker default plus worker filter",
}
print(json.dumps(receipt, indent=2))
if mismatches:
    raise SystemExit("Installed packages differ from the repository lock")
PY
docker run "${restriction_flags[@]}" \
  --mount "type=bind,source=$sentinel_dir/sentinel.txt,target=/qualification/sentinel.txt,readonly" \
  --env SOURCESQL_QUALIFICATION_SENTINEL_FILE=/qualification/sentinel.txt \
  --env SOURCESQL_QUALIFICATION_SENTINEL_ENV=SAFE-SYNTHETIC-ENV-SENTINEL \
  "$qualification_tag" 2>&1 | tee "$receipt_dir/pytest.log"

# Positive proof from the installed, development-tool-free adoption image.
docker run "${restriction_flags[@]}" "$runtime_tag" \
  --store /tmp/engine capabilities --json > "$receipt_dir/installed-capabilities.json"
docker run "${restriction_flags[@]}" -i "$qualification_tag" python -c \
  'import json, sys; capabilities=json.load(sys.stdin); assert "Linux Landlock+seccomp" in capabilities["worker"]; assert capabilities["default_profile"] == "fixture"; print("Installed runtime capabilities include Linux isolation and fixture defaults.")' \
  < "$receipt_dir/installed-capabilities.json"
docker run "${restriction_flags[@]}" "$runtime_tag" \
  --store /tmp/engine demo --profile fixture --output /tmp/demo \
  > "$receipt_dir/installed-demo.json"
printf 'Installed runtime fixture demo completed; result saved in the receipts.\n'
printf 'Qualification receipts: %s\n' "$receipt_dir"
