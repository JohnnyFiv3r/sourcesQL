"""Killable, credential-free and filesystem/network-denied relational evaluation."""

from __future__ import annotations
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import select
import signal
import time
from sourcesql.contracts import Column, Table, SourcesQLError, canonical


def sandbox_command(script: Path, scratch: Path) -> list[str]:
    if sys.platform == "linux":
        return [
            sys.executable,
            "-I",
            str(Path(__file__).with_name("linux_sandbox.py")),
            str(script.resolve()),
            str(scratch.resolve()),
            str(os.getpid()),
        ]
    if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists():
        raise SourcesQLError(
            "unsupported_capability", "Supported OS SQL sandbox unavailable", "worker"
        )
    paths = {
        str(Path(sys.base_prefix).resolve()),
        str(Path(sys.prefix).resolve()),
        str(script.parent.resolve()),
        "/System",
        "/usr/lib",
        "/Library/Apple",
        "/private/var/db/dyld",
    }
    exclusions = " ".join(
        '(require-not (subpath "' + p.replace('"', "") + '"))' for p in sorted(paths)
    )
    profile = (
        "(version 1)(allow default)(deny network*)(deny file-read-data (require-all (vnode-type REGULAR-FILE) "
        + exclusions
        + ' (require-not (subpath "/dev"))))(deny file-write* (require-all (require-not (subpath "'
        + str(scratch.resolve())
        + '")) (require-not (subpath "/dev"))))'
    )
    return ["/usr/bin/sandbox-exec", "-p", profile, sys.executable, "-I", str(script)]


def run_sql(
    sql: str, tables: dict[str, Table], parameters: dict | None = None, timeout: float = 30
) -> Table:
    with WorkerSession() as worker:
        return worker.run_sql(sql, tables, parameters, timeout)


class WorkerSession:
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="sourcesql-worker-")
        scratch = Path(self.directory.name)
        script = Path(__file__).with_name("worker_process.py")
        environment = {
            "PATH": "/usr/bin:/bin",
            "TMPDIR": str(scratch),
            "PYTHONDONTWRITEBYTECODE": "1",
            "HOME": str(scratch),
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
        }
        self.process = subprocess.Popen(
            sandbox_command(script, scratch),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=scratch,
            env=environment,
            bufsize=0,
            close_fds=True,
            start_new_session=True,
        )
        return self

    def run_sql(self, sql, tables, parameters=None, timeout=30):
        request = {
            "sql": sql,
            "tables": {k: v.to_dict() for k, v in tables.items()},
            "parameters": parameters or {},
            "max_rows": 1001,
        }
        try:
            self.process.stdin.write(canonical(request) + b"\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise SourcesQLError(
                "unsupported_capability", "OS SQL sandbox could not launch", "worker"
            ) from error
        deadline = time.monotonic() + timeout
        response = bytearray()
        while time.monotonic() < deadline:
            ready, _, _ = select.select(
                [self.process.stdout], [], [], min(0.2, deadline - time.monotonic())
            )
            if ready:
                data = os.read(self.process.stdout.fileno(), 65536)
                if not data:
                    raise SourcesQLError(
                        "unsupported_capability", "OS SQL sandbox could not launch", "worker"
                    )
                response.extend(data)
                if len(response) > 16 * 1024 * 1024:
                    raise SourcesQLError(
                        "budget_exhausted", "Worker result byte limit exceeded", "worker"
                    )
                if response.endswith(b"\n"):
                    break
        else:
            raise SourcesQLError(
                "budget_exhausted", "Relational execution deadline exceeded", "worker"
            )
        import json

        parsed = json.loads(response)
        if "error" in parsed:
            if parsed["error"] == "budget_exhausted":
                raise SourcesQLError(
                    "budget_exhausted", "Relational stage limit exceeded", "worker"
                )
            raise SourcesQLError(
                "invalid_query",
                "Relational evaluation failed; check types and column references",
                "worker",
            )
        return Table(
            [Column(c["key"], c["logical_type"], c["nullable"]) for c in parsed["columns"]],
            parsed["rows"],
        )

    def __exit__(self, *args):
        # The child owns its session/group; Linux denies fork and detachment.
        # Kill the owned group before reaping so its PID cannot be reused here.
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.process.wait(timeout=5)
        for pipe in [self.process.stdin, self.process.stdout, self.process.stderr]:
            pipe.close()
        self.directory.cleanup()
