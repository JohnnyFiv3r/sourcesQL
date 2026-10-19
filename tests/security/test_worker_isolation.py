"""Actual macOS sandbox-exec policy checks using safe temporary probe data."""

from __future__ import annotations

from pathlib import Path
import socket
import sys
import time

import pytest

from sourcesql.contracts import SourcesQLError
import sourcesql.execution.worker as worker_module


pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="macOS qualification only")

PROBE_SCRIPT = """
import json
import os
from pathlib import Path
import socket
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    command = request["sql"]
    parameters = request.get("parameters", {})
    result = "ready"
    if command == "file_probe":
        try:
            Path(parameters["path"]).read_bytes()
            result = "read_succeeded"
        except PermissionError as error:
            result = "denied:" + str(error.errno)
        except OSError as error:
            result = "unexpected_error:" + str(error.errno)
    elif command == "network_probe":
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
                connection.settimeout(1)
                connection.connect(("127.0.0.1", parameters["port"]))
            result = "connect_succeeded"
        except PermissionError as error:
            result = "denied:" + str(error.errno)
        except OSError as error:
            result = "unexpected_error:" + str(error.errno)
    elif command == "environment_probe":
        result = json.dumps([name for name in parameters["names"] if name in os.environ])
    elif command == "sleep_probe":
        time.sleep(60)
    print(json.dumps({"columns": [{"key": "result", "logical_type": "VARCHAR", "nullable": False}],
                      "rows": [{"result": result}]}), flush=True)
"""


@pytest.fixture
def probe_worker(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    script = runtime / "probe.py"
    script.write_text(PROBE_SCRIPT)
    command = worker_module.sandbox_command

    def probe_command(_production_script, scratch):
        # Change only the allowed worker script directory. The production policy is unchanged.
        return command(script, scratch)

    monkeypatch.setattr(worker_module, "sandbox_command", probe_command)
    return worker_module.WorkerSession


def test_os_policy_denies_regular_file_content_outside_worker_allowlist(tmp_path, probe_worker):
    private = tmp_path / "private"
    private.mkdir()
    secret = private / "synthetic-probe.txt"
    secret.write_text("SAFE-SYNTHETIC-PROBE-CONTENT")
    assert secret.read_text() == "SAFE-SYNTHETIC-PROBE-CONTENT"
    with probe_worker() as worker:
        result = worker.run_sql("file_probe", {}, {"path": str(secret)}, timeout=5)
    assert result.rows[0]["result"] in {"denied:1", "denied:13"}


def test_os_policy_denies_loopback_socket_connection(probe_worker):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            accepted, _ = listener.accept()
            accepted.close()
        with probe_worker() as worker:
            result = worker.run_sql("network_probe", {}, {"port": port}, timeout=5)
        assert result.rows[0]["result"] in {"denied:1", "denied:13"}
        listener.settimeout(0.05)
        with pytest.raises(socket.timeout):
            listener.accept()


def test_worker_launch_environment_omits_injected_provider_credentials(probe_worker, monkeypatch):
    names = [
        "BRAVE_SEARCH_API_KEY",
        "EXA_API_KEY",
        "SERPER_API_KEY",
        "DEEPSEEK_API_KEY",
        "OPENAI_API_KEY",
        "SOURCESQL_PROFILES_FILE",
        "SOURCESQL_PRINCIPAL",
    ]
    for name in names:
        monkeypatch.setenv(name, "SAFE-SYNTHETIC-CREDENTIAL-PROBE")
    with probe_worker() as worker:
        result = worker.run_sql("environment_probe", {}, {"names": names}, timeout=5)
    assert result.rows == [{"result": "[]"}]


def test_timeout_kills_reaps_worker_closes_pipes_and_removes_scratch(probe_worker):
    worker = probe_worker()
    with pytest.raises(SourcesQLError) as error:
        with worker:
            assert worker.run_sql("ready", {}, timeout=5).rows == [{"result": "ready"}]
            process = worker.process
            scratch = Path(worker.directory.name)
            started = time.monotonic()
            worker.run_sql("sleep_probe", {}, timeout=0.05)
    assert error.value.code == "budget_exhausted"
    assert time.monotonic() - started < 3
    assert process.poll() is not None
    assert all(pipe.closed for pipe in (process.stdin, process.stdout, process.stderr))
    assert not scratch.exists()
