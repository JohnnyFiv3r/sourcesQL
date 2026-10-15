"""Unprivileged Linux SQL launcher: Landlock plus a default-deny seccomp filter.

Restrictions install in this single-threaded, credential-free process before
exec/import of DuckDB/Arrow or reading any query. There is no unsafe fallback.
"""

from __future__ import annotations

import ctypes
import errno
import importlib.util
import os
from pathlib import Path
import platform
import resource
import signal
import sys
import sysconfig


class IsolationUnavailable(Exception):
    pass


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class Filter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_uint16),
        ("jt", ctypes.c_uint8),
        ("jf", ctypes.c_uint8),
        ("k", ctypes.c_uint32),
    ]


class Program(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]


def checked(result):
    if result < 0:
        raise IsolationUnavailable()
    return result


def cgroup_runtime_files():
    """Only DuckDB's own CPU/memory metadata leaves, never a /proc grant."""
    membership = Path("/proc/self/cgroup")
    data = membership.read_text()
    if len(data) > 65536:
        raise IsolationUnavailable()
    base = Path("/sys/fs/cgroup").resolve()
    suffixes = {""}
    for line in data.splitlines():
        fields = line.split(":", 2)
        if len(fields) == 3:
            suffixes.add(fields[2].lstrip("/"))
    result = {membership.resolve()}
    for suffix in suffixes:
        for directory, names in (
            (base / suffix, ("cpu.max", "memory.max")),
            (base / "cpu" / suffix, ("cpu.cfs_quota_us", "cpu.cfs_period_us")),
            (base / "memory" / suffix, ("memory.limit_in_bytes",)),
        ):
            for name in names:
                path = (directory / name).resolve()
                if not path.is_relative_to(base):
                    raise IsolationUnavailable()
                if path.exists():
                    result.add(path)
    return result


def restrict_files(libc, script: Path, scratch: Path):
    # Landlock syscall numbers are common to the two explicitly supported ABIs.
    abi = checked(libc.syscall(444, 0, 0, 1))
    if abi < 1:
        raise IsolationUnavailable()
    handled = (1 << 13) - 1
    if abi >= 2:
        handled |= 1 << 13  # REFER
    if abi >= 3:
        handled |= 1 << 14  # TRUNCATE
    if abi >= 5:
        handled |= 1 << 15  # IOCTL_DEV (also denied globally by seccomp)
    attrs = Ruleset(handled)
    ruleset_fd = checked(libc.syscall(444, ctypes.byref(attrs), ctypes.sizeof(attrs), 0))
    read = (1 << 2) | (1 << 3)
    paths: dict[Path, int] = {}
    for name in ("stdlib", "platstdlib", "purelib", "platlib"):
        path = Path(sysconfig.get_path(name)).resolve()
        paths[path] = read
    for location in (
        "/lib",
        "/lib64",
        "/usr/lib",
        "/usr/lib64",
        "/usr/share/zoneinfo",
        "/etc/ld.so.cache",
        "/etc/localtime",
    ):
        path = Path(location)
        if path.exists():
            paths[path.resolve()] = read
    paths[script.parent.resolve()] = read
    # DuckDB 1.5.0 probes file existence before opening these metadata files;
    # denying their contents triggers a native NULL-handle initialization bug.
    for path in cgroup_runtime_files():
        paths[path] = read
    paths[Path(sys.executable).resolve()] = read | 1  # interpreter EXECUTE only
    libdir = sysconfig.get_config_var("LIBDIR")
    library = sysconfig.get_config_var("LDLIBRARY")
    if libdir and library:
        shared_python = Path(libdir) / library
        if shared_python.exists():
            paths[shared_python.resolve()] = read
    configuration = Path(sys.prefix) / "pyvenv.cfg"
    if configuration.exists():
        paths[configuration.resolve()] = read
    for loader in ("/lib/ld-linux-aarch64.so.1", "/lib64/ld-linux-x86-64.so.2"):
        if Path(loader).exists():
            paths[Path(loader).resolve()] = read | 1
    paths[scratch.resolve()] = read | (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8)
    if abi >= 3:
        paths[scratch.resolve()] |= 1 << 14
    for location, rights in (("/dev/null", read | (1 << 1)), ("/dev/urandom", read)):
        paths[Path(location).resolve()] = rights
    try:
        for path, rights in paths.items():
            if not path.exists():
                raise IsolationUnavailable()
            if not path.is_dir():
                rights &= ~((1 << 3) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8))
            descriptor = os.open(path, getattr(os, "O_PATH") | os.O_CLOEXEC)
            try:
                rule = PathRule(rights & handled, descriptor)
                checked(libc.syscall(445, ruleset_fd, 1, ctypes.byref(rule), 0))
            finally:
                os.close(descriptor)
        checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        checked(libc.syscall(446, ruleset_fd, 0))
    finally:
        os.close(ruleset_fd)
    return abi


def restrict_syscalls(libc, constants):
    architecture, allowed, special = constants
    allow = (0x06, 0, 0, 0x7FFF0000)
    deny = (0x06, 0, 0, 0x00050000 | errno.EPERM)

    def load(offset):
        return (0x20, 0, 0, offset)

    def equals(value, yes=0, no=0):
        return (0x15, yes, no, value)

    instructions = [load(4), equals(architecture, 1), deny, load(0)]

    def rule(name, block):
        if name in special:
            instructions.append(equals(special[name], 0, len(block)))
            instructions.extend(block)

    # Even old Landlock ABIs are protected against read-only O_TRUNC. Other
    # truncate variants, openat2, ioctl and attribute mutations are not allowed.
    for name, argument in (("open", 1), ("openat", 2)):
        rule(
            name,
            [
                load(16 + 8 * argument),
                (0x45, 0, 3, os.O_TRUNC),
                (0x54, 0, 0, os.O_ACCMODE),
                equals(0, 0, 1),
                deny,
                allow,
            ],
        )
    rule(
        "clone",
        [
            load(20),
            equals(0, 1),
            deny,
            load(16),
            (0x45, 0, 1, 0x7E822000),
            deny,
            (0x45, 1, 0, 0x00010000),
            deny,
            allow,
        ],
    )
    # glibc can fall back to filtered clone for native threads. clone3 has a
    # pointer to flags which BPF cannot inspect and is never executed.
    rule("clone3", [(0x06, 0, 0, 0x00050000 | errno.ENOSYS)])
    # CPython 3.12 fileutils falls back from FIOCLEX to fcntl on EACCES,
    # but not EPERM. Every ioctl remains denied; none reaches a device driver.
    rule("ioctl", [(0x06, 0, 0, 0x00050000 | errno.EACCES)])
    # Read-only limit queries for this process. A privileged Flight must not
    # be able to raise the hard limits installed by the launcher.
    rule(
        "prlimit64",
        [
            load(16),
            equals(0, 1),
            deny,
            load(32),
            equals(0, 1),
            deny,
            load(36),
            equals(0, 1),
            deny,
            allow,
        ],
    )
    rule("tgkill", [load(16), equals(os.getpid(), 1), deny, allow])
    for name, options, argument in (
        ("fcntl", (0, 1, 2, 3, 4, 1030), 1),
        ("prctl", (15, 16, 21, 39), 0),
    ):
        block = [load(16 + 8 * argument)]
        for option in options:
            block.extend([equals(option, 0, 1), allow])
        block.append(deny)
        rule(name, block)
    for number in allowed:
        instructions.extend([equals(number, 0, 1), allow])
    instructions.append(deny)
    array = (Filter * len(instructions))(*(Filter(*item) for item in instructions))
    program = Program(len(instructions), array)
    checked(libc.prctl(22, 2, ctypes.byref(program), 0, 0))  # PR_SET_SECCOMP/FILTER


def launch(script: Path, scratch: Path, expected_parent: int):
    if sys.platform != "linux" or sys.byteorder != "little":
        raise IsolationUnavailable()
    # -I removes the script directory from sys.path; import only this trusted
    # sibling before installing restrictions. No application/provider imports.
    spec = importlib.util.spec_from_file_location(
        "sourcesql_linux_syscalls", Path(__file__).with_name("linux_syscalls.py")
    )
    if spec is None or spec.loader is None:
        raise IsolationUnavailable()
    constants = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(constants)
    syscall_constants = constants.SYSCALLS.get(platform.machine())
    if syscall_constants is None:
        raise IsolationUnavailable()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # Close both parent-death races: death before registration and death
    # between registration and verification. This survives exec of Python.
    if expected_parent <= 0 or os.getppid() != expected_parent:
        raise IsolationUnavailable()
    checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))  # PR_SET_PDEATHSIG
    if os.getppid() != expected_parent:
        raise IsolationUnavailable()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    restrict_files(libc, script, scratch)
    restrict_syscalls(libc, syscall_constants)
    os.execv(sys.executable, [sys.executable, "-I", str(script.resolve())])


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise IsolationUnavailable()
        launch(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]))
    except Exception:
        # Never expose paths, environment, provider configuration or tracebacks.
        print("sourcesQL Linux SQL isolation unavailable", file=sys.stderr)
        raise SystemExit(78) from None
