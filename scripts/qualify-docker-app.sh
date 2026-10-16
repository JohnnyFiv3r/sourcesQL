#!/usr/bin/env bash
# Local integration qualification. Build downloads are public; execution uses fixtures.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
receipt_dir="${SOURCESQL_DOCKER_APP_OUTPUT:-artifacts/docker-app-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$receipt_dir"
sentinel_dir="$(mktemp -d)"
trap 'rm -rf -- "$sentinel_dir"' EXIT
printf '%s\n' 'SAFE-SYNTHETIC-DOCKER-SENTINEL' > "$sentinel_dir/sentinel.txt"
chmod 755 "$sentinel_dir"
chmod 644 "$sentinel_dir/sentinel.txt"
python3 - "$receipt_dir" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path.cwd()
paths = [root / name for name in ("README.md", "hatch_build.py", "pyproject.toml", "uv.lock", "apps/research/package.json", "apps/research/package-lock.json", "apps/research/tsconfig.json", "apps/research/index.html", "apps/research/research.html", "apps/research/vercel.json", "Dockerfile", ".dockerignore", "compose.yaml", "scripts/qualify-docker-app.sh", "hosted/flight/runner.py", "hosted/flight/exa_profile.py", "hosted/flight/tests/test_exa_profile.py")]
for subtree in ("src/sourcesql", "tests", "apps/research/server", "apps/research/src", "apps/research/api", "apps/research/scripts", "apps/research/tests", "apps/research/fixtures"):
    paths.extend(path for path in (root / subtree).rglob("*") if path.is_file() and path.suffix in {".py", ".ts", ".tsx", ".css", ".json"})
(Path(sys.argv[1]) / "source-hashes-before.json").write_text(json.dumps({str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths)}, indent=2) + "\n")
PY
docker build --target qualification --tag sourcesql:qualification-py312 . 2>&1 | tee "$receipt_dir/build-python-qualification.log"
docker build --target app-qualification --tag sourcesql:app-qualification . 2>&1 | tee "$receipt_dir/build-qualification.log"
docker build --target app-runtime --tag sourcesql:app . 2>&1 | tee "$receipt_dir/build-runtime.log"
docker image inspect sourcesql:app --format '{{json .}}' > "$receipt_dir/runtime-image.json"
docker image inspect sourcesql:app-qualification --format '{{json .}}' > "$receipt_dir/qualification-image.json"
docker image inspect sourcesql:qualification-py312 --format '{{json .}}' > "$receipt_dir/python-qualification-image.json"
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 10001:10001 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --entrypoint node \
  sourcesql:app --input-type=module -e \
  'import {spawnSync} from "node:child_process";import{existsSync}from"node:fs";import{release,arch}from"node:os";const p=spawnSync("/opt/venv/bin/python",["-c","import platform;print(platform.python_version())"],{encoding:"utf8"});if(p.status!==0)throw Error("Python unavailable");if(existsSync("/workspace/apps/research/node_modules/typescript")||existsSync("/workspace/apps/research/node_modules/tsx"))throw Error("Development tools remain in runtime");if(["/workspace/hosted","/workspace/tests","/workspace/apps/research/tests"].some(existsSync))throw Error("Qualification source remains in runtime");console.log(JSON.stringify({node:process.version,python:p.stdout.trim(),kernel:release(),architecture:arch(),uid:process.getuid(),production_dependencies_only:true,qualification_source_absent:true,provider_calls:0}));' \
  > "$receipt_dir/runtime-environment.json"
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 10001:10001 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --entrypoint sourcesql \
  sourcesql:app --store /tmp/engine capabilities --json \
  > "$receipt_dir/installed-capabilities.json"
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 10001:10001 \
  --pids-limit 128 --memory 1g --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  sourcesql:app-qualification 2>&1 | tee "$receipt_dir/node-tests.log"
if [[ -n "${SOURCESQL_DOCKER_PYTHON_RECEIPT:-}" ]]; then
  python3 - "$receipt_dir" "$SOURCESQL_DOCKER_PYTHON_RECEIPT" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
current, previous = (Path(value).resolve() for value in sys.argv[1:])
old = json.loads((previous / "source-hashes.json").read_text())
new = json.loads((current / "source-hashes-before.json").read_text())
def python_inputs(values):
    return {name: value for name, value in values.items()
            if name in {"pyproject.toml", "uv.lock", "Dockerfile", ".dockerignore"}
            or name.startswith(("src/sourcesql/", "tests/", "hosted/flight/"))}
assert python_inputs(old) == python_inputs(new), "Python inputs changed; run the full suite"
old_runtime = json.loads((previous / "runtime-environment.json").read_text())
new_runtime = json.loads((current / "runtime-environment.json").read_text())
for name in ("python", "kernel", "architecture", "uid"):
    assert old_runtime[name] == new_runtime[name], "Python runtime changed; run the full suite"
log = (previous / "pytest.log").read_bytes()
summary = re.search(r"(?m)^(\d+) passed(?:, (\d+) skipped)?(?:, \d+ warnings?)? in [\d.]+s$", log.decode())
assert summary is not None, "Prior Python receipt has no successful summary"
receipt = {"schema": "sourcesql.python-qualification-reuse.v1", "newly_run": False,
           "source_receipt": str(previous), "inputs_identical": True, "runtime_identical": True,
           "passed": int(summary[1]), "skipped": int(summary[2] or 0),
           "pytest_log_sha256": hashlib.sha256(log).hexdigest()}
(current / "pytest-reused.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(f"Reused unchanged Python qualification: {receipt['passed']} passed, {receipt['skipped']} skipped")
PY
else
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 10001:10001 \
  --pids-limit 128 --memory 1g --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --mount "type=bind,source=$sentinel_dir/sentinel.txt,target=/qualification/sentinel.txt,readonly" \
  --env SOURCESQL_QUALIFICATION_SENTINEL_FILE=/qualification/sentinel.txt \
  --env SOURCESQL_QUALIFICATION_SENTINEL_ENV=SAFE-SYNTHETIC-ENV-SENTINEL \
  --workdir /workspace --entrypoint python sourcesql:app-qualification \
  -m pytest -q -ra -p no:cacheprovider tests hosted/flight/tests 2>&1 | tee "$receipt_dir/pytest.log"
fi

# Python is required only for this developer harness, not for Docker adoption.
python3 - "$receipt_dir" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

root = Path.cwd()
receipts = Path(sys.argv[1]).resolve()
project = "sourcesql-app-qual-" + uuid.uuid4().hex[:12]
with socket.socket() as selection:
    selection.bind(("127.0.0.1", 0))
    port = selection.getsockname()[1]
environment = dict(os.environ, SOURCESQL_HTTP_PORT=str(port))
compose = ["docker", "compose", "-p", project]

def docker(args, *, data=None, timeout=120):
    result = subprocess.run(args, cwd=root, env=environment, input=data,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr[-8000:])
    return result.stdout

def http(path, headers=None):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as response:
        return response.code, response.read().decode()

def ready():
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            status, body = http("/health")
            if status == 200 and json.loads(body)["mode"] == "fixture-anonymous":
                return
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    raise RuntimeError("Owned Docker HTTP app did not become healthy")

http_script = r'''
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const mode = process.argv[2];
const client = new Client({name:'docker-qualification',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.PORT}/mcp`)));
async function tool(name,args={}) {
  const r=await client.callTool({name,arguments:args});
  assert.equal(r.isError,undefined,JSON.stringify(r.content));
  return r.structuredContent;
}
try {
  const {tools}=await client.listTools();
  const resource=tools.find(t=>t.name==='open_research')._meta.ui.resourceUri;
  const ui=await client.readResource({uri:resource});
  assert.equal(ui.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.ok(ui.contents[0].text.includes('sourcesQL research workspace'));
  if(mode==='create') {
    const query="SELECT url,SEM_EXTRACT(content,'project name explicitly stated') AS project,SEM_EXTRACT(content,'planned capacity in MW, number only') AS planned_mw FROM WEB_SEARCH('fictional Aurora Birch campuses') WHERE SEM_MATCH(content,'describes a specific data-center campus')";
    const result=await tool('sourcesql_query',{query,profile:'fixture',request_id:randomUUID()});
    assert.equal(result.rows.length,2);
    const view=await tool('open_research',{result_ref:{result_id:result.result_id,snapshot_id:'docker-fixture',title:'Docker fixture research'}});
    const row=view.snapshot.rows.find(r=>r.values.planned_mw==='500');
    assert.ok(row);
    const corrected=await tool('amend_observation',{snapshot_id:view.snapshot.id,row_id:row.id,field:'planned_mw',value:'480',expected_revision:view.revision,mutation_id:randomUUID()});
    assert.equal(corrected.snapshot.rows.find(r=>r.id===row.id).values.planned_mw,'500');
    assert.equal(corrected.amendments.length,1);
    const bundle=await tool('export_research',{snapshot_id:'docker-fixture'});
    assert.equal(bundle.state.amendments.length,1);
    assert.ok(Object.keys(bundle.engineResults).includes(result.result_id));
    console.log(JSON.stringify({snapshot_id:'docker-fixture',result_id:result.result_id,rows:2,revision:corrected.revision,original:'500',correction:'480',resource_uri:resource,provider_calls:0}));
  } else {
    const reopened=await tool('open_research',{snapshot_id:'docker-fixture'});
    assert.equal(reopened.snapshot.rows.length,2);
    assert.equal(reopened.amendments.length,1);
    assert.equal(reopened.amendments[0].value,'480');
    assert.ok(reopened.snapshot.rows.some(r=>r.values.planned_mw==='500'));
    const bundle=await tool('export_research',{snapshot_id:'docker-fixture'});
    assert.equal(bundle.state.amendments.length,1);
    console.log(JSON.stringify({reopened:true,snapshot_id:reopened.snapshot.id,revision:reopened.revision,rows:2,original_preserved:true,correction:'480',exported:true,provider_calls:0}));
  }
} finally {await client.close();}
'''

stdio = None
try:
    docker(compose + ["up", "-d", "--no-build", "sourcesql-app"])
    ready()
    assert http("/", {"Origin": f"http://127.0.0.1:{port}"})[0] == 200
    assert http("/health", {"Host": "attacker.invalid"})[0] == 403
    assert http("/health", {"Origin": "https://attacker.invalid"})[0] == 403
    initial = docker(compose + ["exec", "-T", "--workdir", "/workspace/apps/research", "sourcesql-app", "node", "--input-type=module", "-", "create"], data=http_script)
    (receipts / "http-created.json").write_text(initial)
    docker(compose + ["restart", "--timeout", "10", "sourcesql-app"])
    ready()
    reopened = docker(compose + ["exec", "-T", "--workdir", "/workspace/apps/research", "sourcesql-app", "node", "--input-type=module", "-", "reopen"], data=http_script)
    (receipts / "http-reopened.json").write_text(reopened)
    state = docker(compose + ["ps", "-q", "sourcesql-app"]).strip()
    inspect = json.loads(docker(["docker", "inspect", state]))[0]
    host = inspect["HostConfig"]
    assert host["ReadonlyRootfs"] and host["CapDrop"] == ["ALL"]
    assert "no-new-privileges:true" in host["SecurityOpt"]
    assert inspect["Config"]["User"] == "10001:10001"
    assert all(binding["HostIp"] == "127.0.0.1" for bindings in host["PortBindings"].values() for binding in bindings)
    assert not any(mount["Destination"] == "/var/run/docker.sock" for mount in inspect["Mounts"])
    (receipts / "http-container.json").write_text(json.dumps(inspect, indent=2) + "\n")

    # Exercise the exact adopter Docker command over actual machine-only stdio.
    stderr = (receipts / "stdio.stderr").open("w")
    stdio = subprocess.Popen(compose + ["run", "--rm", "-T", "--no-deps", "sourcesql-mcp"],
                             cwd=root, env=environment, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
    replies = queue.Queue()
    def read_lines():
        for line in stdio.stdout:
            replies.put(json.loads(line))
    threading.Thread(target=read_lines, daemon=True).start()
    message_id = 0
    def send(method, params, notification=False):
        global message_id
        message_id += 1
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            message["id"] = message_id
        stdio.stdin.write(json.dumps(message) + "\n"); stdio.stdin.flush()
        if notification:
            return
        while True:
            reply = replies.get(timeout=40)
            if reply.get("id") == message_id:
                assert "error" not in reply, reply
                return reply["result"]
    initialized = send("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "docker-stdio-qualification", "version": "1"}})
    send("notifications/initialized", {}, notification=True)
    tools = send("tools/list", {})["tools"]
    assert any(tool["name"] == "sourcesql_query" for tool in tools)
    result = send("tools/call", {"name": "sourcesql_query", "arguments": {"query": "SELECT CAST(1 AS BIGINT) AS value", "profile": "fixture", "request_id": str(uuid.uuid4())}})
    assert not result.get("isError"), result
    assert result["structuredContent"]["rows"] == [{"value": "1"}]
    (receipts / "stdio.json").write_text(json.dumps({"protocol_version": initialized["protocolVersion"], "tools": len(tools), "actual_engine_query": True, "rows": [{"value": "1"}], "provider_calls": 0}, indent=2) + "\n")
    stdio.stdin.close()
    stdio.wait(timeout=10)
    assert stdio.returncode == 0
    stderr.close()
    paths = [root / name for name in ("README.md", "hatch_build.py", "pyproject.toml", "uv.lock", "apps/research/package.json", "apps/research/package-lock.json", "apps/research/tsconfig.json", "apps/research/index.html", "apps/research/research.html", "apps/research/vercel.json", "Dockerfile", ".dockerignore", "compose.yaml", "scripts/qualify-docker-app.sh", "hosted/flight/runner.py", "hosted/flight/exa_profile.py", "hosted/flight/tests/test_exa_profile.py")]
    for subtree in ("src/sourcesql", "tests", "apps/research/server", "apps/research/src", "apps/research/api", "apps/research/scripts", "apps/research/tests", "apps/research/fixtures"):
        paths.extend(path for path in (root / subtree).rglob("*") if path.is_file() and path.suffix in {".py", ".ts", ".tsx", ".css", ".json"})
    final_hashes = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths)}
    (receipts / "source-hashes.json").write_text(json.dumps(final_hashes, indent=2) + "\n")
    assert final_hashes == json.loads((receipts / "source-hashes-before.json").read_text()), "Source changed during Docker qualification; repeat after the source freeze"
    print(json.dumps({"http_query": True, "resource": True, "correction": True, "export": True, "restart_persistence": True, "stdio_query": True, "host_origin_guards": True, "provider_calls": 0}))
finally:
    if stdio is not None and stdio.poll() is None:
        stdio.terminate()
        try: stdio.wait(timeout=5)
        except subprocess.TimeoutExpired: stdio.kill(); stdio.wait(timeout=5)
    for name, args in (("compose-status.txt", ["ps", "-a"]),
                       ("compose-logs.txt", ["logs", "--no-color", "--tail", "200"])):
        diagnostics = subprocess.run(compose + args, cwd=root, env=environment,
                                     capture_output=True, text=True, timeout=15)
        (receipts / name).write_text(diagnostics.stdout + diagnostics.stderr)
    # This unique project owns only its synthetic test containers, network and volume.
    subprocess.run(compose + ["down", "--volumes", "--remove-orphans"], cwd=root, env=environment, capture_output=True, text=True, timeout=30)
PY
printf 'Docker App qualification receipts: %s\n' "$receipt_dir"
