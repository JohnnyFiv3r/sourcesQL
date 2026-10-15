"""Adversarial Python payloads under the actual Linux worker OS policy.

These bypass SQL admission and DuckDB configuration deliberately. Docker's
outer policy is insufficient evidence: parent-side control probes must succeed
while the same access from the worker fails.
"""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
from uuid import uuid4

import pytest

from sourcesql.contracts import SourcesQLError
import sourcesql.execution.worker as worker_module


pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux qualification only")

PROBE_SCRIPT = r"""
import ctypes
import json
import os
from pathlib import Path
import platform
import resource
import socket
import sys
import threading
import time

def denied(operation):
    try:
        operation()
        return "succeeded"
    except OSError as error:
        return "denied:" + str(error.errno)

def raw_syscall(name, args):
    numbers = {
        "x86_64": {"ptrace": 101, "process_vm_readv": 310, "unshare": 272,
                   "setns": 308, "io_uring_setup": 425, "pidfd_open": 434,
                   "pidfd_getfd": 438, "kill": 62, "tkill": 200, "tgkill": 234},
        "aarch64": {"ptrace": 117, "process_vm_readv": 270, "unshare": 97,
                    "setns": 268, "io_uring_setup": 425, "pidfd_open": 434,
                    "pidfd_getfd": 438, "kill": 129, "tkill": 130, "tgkill": 131},
    }
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    result = libc.syscall(numbers[platform.machine()][name], *args)
    if result >= 0:
        if name in {"pidfd_open", "io_uring_setup"}:
            os.close(result)
        return "succeeded"
    return "denied:" + str(ctypes.get_errno())

for line in sys.stdin:
    request = json.loads(line)
    command = request["sql"]
    parameters = request.get("parameters", {})
    result = "ready"
    if command == "file":
        path = Path(parameters["path"])
        operation = parameters["operation"]
        if operation == "read":
            result = denied(path.read_bytes)
        elif operation == "write":
            result = denied(lambda: path.write_text("REPLACED"))
        elif operation == "truncate":
            result = denied(lambda: os.truncate(path, 0))
        elif operation == "read_only_truncate":
            def truncate():
                descriptor = os.open(path, os.O_RDONLY | os.O_TRUNC)
                os.close(descriptor)
            result = denied(truncate)
        elif operation == "unlink":
            result = denied(path.unlink)
        elif operation == "chmod":
            result = denied(lambda: path.chmod(0o777))
        elif operation == "utime":
            result = denied(lambda: os.utime(path, (1, 1)))
        elif operation == "rename_into_scratch":
            result = denied(lambda: path.rename(Path.cwd() / "moved-secret"))
        elif operation == "link_into_scratch":
            result = denied(lambda: os.link(path, Path.cwd() / "linked-secret"))
        elif operation == "symlink_read":
            link = Path.cwd() / "external-link"
            try:
                link.symlink_to(path)
                result = denied(link.read_bytes)
            except OSError as error:
                result = "denied:" + str(error.errno)
        elif operation == "symlink_write":
            link = Path.cwd() / "external-link"
            try:
                link.symlink_to(path)
                result = denied(lambda: link.write_text("REPLACED"))
            except OSError as error:
                result = "denied:" + str(error.errno)
    elif command == "network":
        def connect():
            family = socket.AF_UNIX if parameters["kind"] == "unix" else socket.AF_INET
            kind = socket.SOCK_DGRAM if parameters["kind"] == "udp" else socket.SOCK_STREAM
            with socket.socket(family, kind) as connection:
                connection.settimeout(1)
                if family == socket.AF_UNIX:
                    connection.connect(parameters["address"])
                elif kind == socket.SOCK_DGRAM:
                    connection.sendto(b"WORKER-PROBE", ("127.0.0.1", parameters["port"]))
                else:
                    connection.connect(("127.0.0.1", parameters["port"]))
        result = denied(connect)
    elif command == "environment":
        result = [name for name in parameters["names"] if name in os.environ]
    elif command == "fd":
        result = denied(lambda: os.pread(parameters["fd"], 4096, 0))
    elif command == "session":
        result = denied(os.setsid) if parameters["kind"] == "setsid" else denied(
            lambda: os.setpgid(0, 0))
    elif command == "fork":
        def fork():
            child = os.fork()
            if child == 0:
                os._exit(0)
            os.waitpid(child, 0)
        result = denied(fork)
    elif command == "syscall":
        name = parameters["name"]
        arguments = {
            "ptrace": [16, parameters["parent_pid"], 0, 0],
            "process_vm_readv": [parameters["parent_pid"], 0, 0, 0, 0, 0],
            "unshare": [0x10000000],
            "setns": [-1, 0],
            "io_uring_setup": [1, 0],
            "pidfd_open": [parameters["parent_pid"], 0],
            "pidfd_getfd": [-1, 0, 0],
            "kill": [parameters["parent_pid"], 0],
            "tkill": [parameters["parent_pid"], 0],
            "tgkill": [parameters["parent_pid"], parameters["parent_pid"], 0],
        }
        result = raw_syscall(name, arguments[name])
    elif command == "thread":
        output = []
        def check():
            local = Path.cwd() / "thread-scratch"
            local.write_text("SCRATCH-OK")
            output.append(local.read_text())
            output.append(denied(lambda: Path(parameters["path"]).read_bytes()))
        thread = threading.Thread(target=check)
        thread.start()
        thread.join(2)
        result = output
    elif command == "limit":
        class Limits(ctypes.Structure):
            _fields_ = [("current", ctypes.c_uint64), ("maximum", ctypes.c_uint64)]
        limits = Limits(*resource.getrlimit(resource.RLIMIT_FSIZE))
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        number = 302 if platform.machine() == "x86_64" else 261
        returned = libc.syscall(number, 0, resource.RLIMIT_FSIZE, ctypes.byref(limits), 0)
        result = "succeeded" if returned == 0 else "denied:" + str(ctypes.get_errno())
    elif command == "sleep":
        (Path.cwd() / "sleep-started").write_text("CONTROL")
        time.sleep(60)
    print(json.dumps({"columns": [{"key": "result", "logical_type": "VARCHAR",
                                   "nullable": False}],
                      "rows": [{"result": json.dumps(result)}]}), flush=True)
"""


@pytest.fixture
def probe_worker(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    script = runtime / "probe.py"
    script.write_text(PROBE_SCRIPT)
    production_command = worker_module.sandbox_command

    def probe_command(_production_script, scratch):
        return production_command(script, scratch)

    monkeypatch.setattr(worker_module, "sandbox_command", probe_command)
    return worker_module.WorkerSession


@pytest.fixture
def external_sentinel(tmp_path):
    private = tmp_path / "private"
    private.mkdir()
    sentinel = private / "synthetic-secret.txt"
    sentinel.write_text("SAFE-SYNTHETIC-SECRET")
    sentinel.chmod(0o600)
    return sentinel


def probe(worker, command, **parameters):
    response = worker.run_sql(command, {}, parameters, timeout=5)
    return json.loads(response.rows[0]["result"])


def assert_denied(result):
    assert result in {f"denied:{errno.EPERM}", f"denied:{errno.EACCES}", f"denied:{errno.EXDEV}"}


@pytest.mark.parametrize(
    "operation",
    [
        "read",
        "write",
        "truncate",
        "read_only_truncate",
        "unlink",
        "chmod",
        "utime",
        "rename_into_scratch",
        "link_into_scratch",
        "symlink_read",
        "symlink_write",
    ],
)
def test_external_file_access_and_path_escapes_denied(probe_worker, external_sentinel, operation):
    original = external_sentinel.stat()
    assert external_sentinel.read_text() == "SAFE-SYNTHETIC-SECRET"
    with probe_worker() as worker:
        assert_denied(probe(worker, "file", path=str(external_sentinel), operation=operation))
    assert external_sentinel.read_text() == "SAFE-SYNTHETIC-SECRET"
    after = external_sentinel.stat()
    assert after.st_mode == original.st_mode
    assert after.st_mtime_ns == original.st_mtime_ns


@pytest.mark.parametrize("operation", ["write", "truncate", "read_only_truncate", "chmod", "utime"])
def test_readable_runtime_is_read_only_even_without_newer_landlock_rights(
    probe_worker, tmp_path, operation
):
    # The script-directory read grant is intentional. On Landlock ABI 1/2,
    # deny WRITE_FILE alone cannot stop O_RDONLY|O_TRUNC on this readable file.
    sentinel = tmp_path / "runtime" / "synthetic-library.conf"
    sentinel.write_text("SAFE-READ-ONLY-RUNTIME")
    original = sentinel.stat()
    with probe_worker() as worker:
        assert probe(worker, "file", path=str(sentinel), operation="read") == "succeeded"
        assert_denied(probe(worker, "file", path=str(sentinel), operation=operation))
    assert sentinel.read_text() == "SAFE-READ-ONLY-RUNTIME"
    after = sentinel.stat()
    assert after.st_mode == original.st_mode
    assert after.st_mtime_ns == original.st_mtime_ns


@pytest.mark.parametrize("kind", ["tcp", "udp", "unix"])
def test_worker_cannot_reach_parent_listeners(probe_worker, kind):
    family = socket.AF_UNIX if kind == "unix" else socket.AF_INET
    protocol = socket.SOCK_DGRAM if kind == "udp" else socket.SOCK_STREAM
    with socket.socket(family, protocol) as listener:
        # Linux pathname sockets cap their address at 108 bytes; Flight's
        # nested pytest TMPDIR can exceed that before the worker even starts.
        # A short unique abstract address exercises the same AF_UNIX policy.
        address = "\0sourcesql-isolation-" + uuid4().hex if kind == "unix" else ("127.0.0.1", 0)
        listener.bind(address)
        if protocol == socket.SOCK_STREAM:
            listener.listen(1)
        # Abstract getsockname() returns bytes. Keep the original string so
        # the worker's JSON request represents its leading NUL exactly.
        target = address if kind == "unix" else listener.getsockname()
        # Prove Docker or host network policy did not itself cause the denial.
        with socket.socket(family, protocol) as control:
            if kind == "udp":
                control.sendto(b"PARENT-CONTROL", target)
                assert listener.recv(128) == b"PARENT-CONTROL"
            else:
                control.connect(target)
                accepted, _ = listener.accept()
                accepted.close()
        parameters = (
            {"kind": kind, "address": target}
            if kind == "unix"
            else {"kind": kind, "port": target[1]}
        )
        with probe_worker() as worker:
            assert_denied(probe(worker, "network", **parameters))
        listener.settimeout(0.05)
        with pytest.raises(socket.timeout):
            listener.recv(128) if kind == "udp" else listener.accept()


def test_credentials_and_parent_process_environment_are_inaccessible(probe_worker, monkeypatch):
    names = [
        "EXA_API_KEY",
        "MOTHERDUCK_TOKEN",
        "OPENAI_API_KEY",
        "SOURCESQL_PROFILES_FILE",
        "SOURCESQL_QUALIFICATION_SENTINEL_ENV",
    ]
    for name in names:
        monkeypatch.setenv(name, "SAFE-SYNTHETIC-CREDENTIAL")
    parent_environment = Path(f"/proc/{os.getpid()}/environ")
    assert parent_environment.read_bytes() is not None
    with probe_worker() as worker:
        assert probe(worker, "environment", names=names) == []
        assert_denied(probe(worker, "file", path=str(parent_environment), operation="read"))
        assert_denied(probe(worker, "file", path="/proc/self/environ", operation="read"))


def test_container_mounted_sentinel_is_not_a_worker_read_grant(probe_worker):
    path = os.environ.get("SOURCESQL_QUALIFICATION_SENTINEL_FILE")
    if not path:
        pytest.skip("Optional outer-container mounted sentinel not configured")
    sentinel = Path(path)
    assert sentinel.read_bytes(), "Container parent must be able to read the mounted sentinel"
    with probe_worker() as worker:
        assert_denied(probe(worker, "file", path=path, operation="read"))


def test_preopened_parent_descriptor_is_not_inherited(probe_worker, external_sentinel):
    descriptor = os.open(external_sentinel, os.O_RDONLY)
    high_descriptor = 128
    os.dup2(descriptor, high_descriptor, inheritable=True)
    try:
        assert os.pread(high_descriptor, 4096, 0) == b"SAFE-SYNTHETIC-SECRET"
        with probe_worker() as worker:
            assert probe(worker, "fd", fd=high_descriptor) == f"denied:{errno.EBADF}"
    finally:
        os.close(high_descriptor)
        os.close(descriptor)


def test_worker_installs_its_own_seccomp_filter_and_cleanup_process_group(probe_worker):
    def kernel_status(pid):
        return {
            key: value.strip()
            for key, value in (
                line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines()
            )
        }

    parent = kernel_status(os.getpid())
    with probe_worker() as worker:
        assert probe(worker, "ready") == "ready"
        child = kernel_status(worker.process.pid)
        assert child["NoNewPrivs"] == "1"
        assert child["Seccomp"] == "2"
        assert int(child["Seccomp_filters"]) > int(parent["Seccomp_filters"])
        assert os.getpgid(worker.process.pid) == worker.process.pid
        assert os.getpgid(worker.process.pid) != os.getpgid(os.getpid())


@pytest.mark.parametrize("kind", ["setsid", "setpgid"])
def test_worker_cannot_detach_from_cleanup_process_group(probe_worker, kind):
    with probe_worker() as worker:
        assert_denied(probe(worker, "session", kind=kind))


def test_worker_cannot_spawn_detachable_child_process(probe_worker):
    with probe_worker() as worker:
        assert_denied(probe(worker, "fork"))


def test_worker_can_inspect_but_cannot_change_its_resource_caps(probe_worker):
    with probe_worker() as worker:
        # A no-op setter is safe; rejecting it also rejects attempts to raise
        # the caps when the service parent happens to hold CAP_SYS_RESOURCE.
        assert probe(worker, "limit") == f"denied:{errno.EPERM}"


@pytest.mark.parametrize(
    "name",
    [
        "ptrace",
        "process_vm_readv",
        "unshare",
        "setns",
        "io_uring_setup",
        "pidfd_open",
        "pidfd_getfd",
        "kill",
        "tkill",
        "tgkill",
    ],
)
def test_direct_escape_and_process_inspection_syscalls_are_denied(probe_worker, name):
    with probe_worker() as worker:
        # Invalid pointers/FDs would give EFAULT/EBADF without seccomp. EPERM
        # proves the syscall cannot be used with a corrected request either.
        assert (
            probe(worker, "syscall", name=name, parent_pid=os.getpid()) == f"denied:{errno.EPERM}"
        )


def test_native_runtime_threads_inherit_policy_and_scratch_remains_usable(
    probe_worker, external_sentinel
):
    with probe_worker() as worker:
        result = probe(worker, "thread", path=str(external_sentinel))
    assert result[0] == "SCRATCH-OK"
    assert_denied(result[1])


def test_timeout_kills_reaps_worker_closes_pipes_and_removes_scratch(probe_worker):
    worker = probe_worker()
    with pytest.raises(SourcesQLError) as error:
        with worker:
            assert probe(worker, "ready") == "ready"
            process = worker.process
            scratch = Path(worker.directory.name)
            started = time.monotonic()
            worker.run_sql("sleep", {}, timeout=0.05)
    assert error.value.code == "budget_exhausted"
    assert time.monotonic() - started < 3
    assert process.poll() is not None
    assert all(pipe.closed for pipe in (process.stdin, process.stdout, process.stderr))
    assert not scratch.exists()


@pytest.mark.parametrize("unavailable", ["landlock_syscall", "landlock_abi", "seccomp_filter"])
def test_missing_required_kernel_features_fail_before_payload_execution(
    tmp_path, monkeypatch, unavailable
):
    launcher = Path(worker_module.__file__).with_name("linux_sandbox.py")
    payload = tmp_path / "payload.py"
    payload.write_text(
        "from pathlib import Path\n"
        "Path('unsafe-payload-executed').write_text('UNSAFE-FALLBACK')\n"
        "raise SystemExit(0)\n"
    )
    wrapper = tmp_path / "kernel_failure_injection.py"
    # Execute production __main__, changing only the syscall response that
    # represents an unavailable required feature. Its real error/exit protocol
    # must prevent both exec of the payload and reading the queued query.
    wrapper.write_text(
        f"""
import ctypes
import errno
from pathlib import Path
import runpy
import sys

real = ctypes.CDLL(None, use_errno=True)
real.syscall.restype = ctypes.c_long
failure = {unavailable!r}

class Syscall:
    restype = ctypes.c_long
    def __call__(self, number, *arguments):
        if number == 444 and arguments[-1] == 1:
            if failure == "landlock_syscall":
                ctypes.set_errno(errno.ENOSYS)
                return -1
            if failure == "landlock_abi":
                return 0
        return real.syscall(number, *arguments)

class Kernel:
    syscall = Syscall()
    def prctl(self, option, *arguments):
        if option == 22 and failure == "seccomp_filter":
            Path("seccomp-failure-injected").write_text("CONTROL")
            ctypes.set_errno(errno.EPERM)
            return -1
        return real.prctl(option, *arguments)

ctypes.CDLL = lambda *arguments, **keywords: Kernel()
sys.argv = [{str(launcher)!r}, {str(payload)!r}, sys.argv[1], sys.argv[2]]
runpy.run_path({str(launcher)!r}, run_name="__main__")
"""
    )

    def failure_command(_production_script, scratch):
        return [sys.executable, "-I", str(wrapper), str(scratch), str(os.getpid())]

    monkeypatch.setattr(worker_module, "sandbox_command", failure_command)
    worker = worker_module.WorkerSession()
    with pytest.raises(SourcesQLError) as error:
        with worker:
            process = worker.process
            scratch = Path(worker.directory.name)
            try:
                worker.run_sql("QUERY-MUST-NOT-EXECUTE", {}, timeout=5)
            finally:
                process.wait(timeout=5)
                assert not (scratch / "unsafe-payload-executed").exists()
                if unavailable == "seccomp_filter":
                    assert (scratch / "seccomp-failure-injected").read_text() == "CONTROL"
    assert error.value.code == "unsupported_capability"
    assert process.returncode == 78
    assert not scratch.exists()
    assert all(pipe.closed for pipe in (process.stdin, process.stdout, process.stderr))


def test_mismatched_parent_identity_fails_before_payload_execution(tmp_path, monkeypatch):
    payload = tmp_path / "unsafe-payload.py"
    payload.write_text(
        "from pathlib import Path\nPath('unsafe-payload-executed').write_text('UNSAFE-FALLBACK')\n"
    )
    production_command = worker_module.sandbox_command

    def mismatch_command(_production_script, scratch):
        command = production_command(payload, scratch)
        assert command[-1] == str(os.getpid())
        command[-1] = str(os.getpid() + 1)
        return command

    monkeypatch.setattr(worker_module, "sandbox_command", mismatch_command)
    worker = worker_module.WorkerSession()
    with pytest.raises(SourcesQLError) as error:
        with worker:
            process = worker.process
            scratch = Path(worker.directory.name)
            try:
                worker.run_sql("QUERY-MUST-NOT-EXECUTE", {}, timeout=5)
            finally:
                process.wait(timeout=5)
                assert not (scratch / "unsafe-payload-executed").exists()
    assert error.value.code == "unsupported_capability"
    assert process.returncode == 78
    assert not scratch.exists()


def test_abrupt_parent_death_terminates_the_active_owned_worker(tmp_path):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    payload = runtime / "probe.py"
    payload.write_text(PROBE_SCRIPT)
    surrogate_script = tmp_path / "surrogate.py"
    surrogate_script.write_text(
        f"""
import json
from pathlib import Path
import time
import sourcesql.execution.worker as worker_module

production_command = worker_module.sandbox_command
def probe_command(_production_script, scratch):
    return production_command(Path({str(payload)!r}), scratch)
worker_module.sandbox_command = probe_command
with worker_module.WorkerSession() as worker:
    worker.run_sql("ready", {{}}, timeout=5)
    worker.process.stdin.write(json.dumps({{"sql": "sleep", "tables": {{}}}}).encode() + b"\\n")
    worker.process.stdin.flush()
    scratch = Path(worker.directory.name)
    deadline = time.monotonic() + 3
    while not (scratch / "sleep-started").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("Payload sleep control did not start")
        time.sleep(0.01)
    print(json.dumps({{"worker_pid": worker.process.pid, "scratch": str(scratch)}}), flush=True)
    worker.process.wait(timeout=70)
"""
    )
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if "PYTHONPATH" in os.environ:
        environment["PYTHONPATH"] = os.environ["PYTHONPATH"]
    surrogate = subprocess.Popen(
        [sys.executable, str(surrogate_script)],
        cwd=tmp_path,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        close_fds=True,
        start_new_session=True,
    )
    worker_pid = None
    scratch = None
    identity = None

    def worker_state(pid):
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        except FileNotFoundError:
            return None
        return fields[0], fields[19]

    try:
        ready, _, _ = select.select([surrogate.stdout], [], [], 10)
        assert ready, "Surrogate did not establish the active-worker control"
        control = json.loads(surrogate.stdout.readline())
        worker_pid = control["worker_pid"]
        scratch = Path(control["scratch"])
        assert scratch.is_relative_to(tmp_path)
        assert (scratch / "sleep-started").read_text() == "CONTROL"
        state = worker_state(worker_pid)
        assert state is not None and state[0] != "Z"
        identity = state[1]
        # Kill only the host process. Killing its process group would not test
        # the worker's parent-death protection and could hide the regression.
        started = time.monotonic()
        surrogate.kill()
        surrogate.wait(timeout=3)
        while time.monotonic() - started < 3:
            state = worker_state(worker_pid)
            if state is None or state[0] == "Z" or state[1] != identity:
                break
            time.sleep(0.01)
        else:
            pytest.fail("Worker remained alive after its owning host was killed")
        assert surrogate.returncode == -signal.SIGKILL
    finally:
        if surrogate.poll() is None:
            surrogate.kill()
            surrogate.wait(timeout=3)
        if worker_pid is not None and identity is not None:
            state = worker_state(worker_pid)
            if state is not None and state[0] != "Z" and state[1] == identity:
                os.kill(worker_pid, signal.SIGKILL)
        for pipe in (surrogate.stdout, surrogate.stderr):
            pipe.close()
        # An abruptly killed host cannot remove its own TemporaryDirectory.
        # The observer removes only the known scratch beneath this test root.
        if scratch is not None and scratch.is_relative_to(tmp_path):
            shutil.rmtree(scratch, ignore_errors=True)
