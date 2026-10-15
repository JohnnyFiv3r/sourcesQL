"""Installed-engine and actual Linux worker qualification using synthetic data.

build.py embeds only reviewed public files. The subprocess environment excludes
all actual provider/database credentials. There is no reference-worker fallback.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time
from uuid import UUID
import xml.etree.ElementTree as ET
import zipfile

BUNDLE_MANIFEST = None
BUNDLE_ENCODED = None

INSTALL_CODE = r"""
from importlib import metadata
import json
from pathlib import Path
import sys
from installer import install
from installer.destinations import SchemeDictionaryDestination
from installer.sources import WheelFile

wheel = Path(sys.argv[1])
target = Path(sys.argv[2]).resolve()
assert metadata.version('installer') == '0.7.0'
scheme = {'purelib': str(target), 'platlib': str(target),
          'scripts': str(target / 'bin'), 'headers': str(target / 'include'),
          'data': str(target)}
destination = SchemeDictionaryDestination(scheme, interpreter=sys.executable,
                                         script_kind='posix', bytecode_optimization_levels=())
with WheelFile.open(wheel) as source:
    source.validate_record(validate_contents=True)
    install(source, destination, additional_metadata={'INSTALLER': b'PyPA installer 0.7.0'})
distribution = metadata.distribution('sourcesql')
assert distribution.version == '0.1.0a1'
assert Path(distribution.locate_file('sourcesql/engine.py')).resolve().is_relative_to(target)
print(json.dumps({'mechanism': 'PyPA installer', 'installer_version': '0.7.0',
                  'record_validated': True, 'offline': True,
                  'dependencies_resolved': False, 'installed_version': distribution.version}))
"""

DEMO_CODE = r"""
import json
from pathlib import Path
import sys
from sourcesql.engine import Engine

root = Path(sys.argv[1])
engine = Engine(root / 'demo-store')
result = engine.query(query=(root / 'examples/01_discovery.sql').read_text(), profile='fixture')
receipt = result['receipt']
assert receipt['status'] == 'completed'
assert receipt['plan_complete'] is True
assert {row['project'] for row in result['rows']} == {'Aurora Campus', 'Birch Campus'}
assert all(source['content_basis'] == 'synthetic_fixture' for source in result['source_versions'])
assert result['evidence'] and any(item.get('support') for item in result['evidence'])
bundle = engine.export(result['result_id'])
print(json.dumps({'passed': True, 'rows': len(result['rows']),
                 'evidence_count': len(result['evidence']),
                 'source_version_count': len(result['source_versions']),
                 'synthetic_sources_only': True, 'receipt_status': receipt['status'],
                 'export_bundle_present': bool(bundle)}))
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def runtime_report():
    abi, abi_error = None, None
    if sys.platform == "linux" and platform.machine() in {"x86_64", "aarch64"}:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        abi = libc.syscall(444, 0, 0, 1)
        if abi < 0:
            abi_error, abi = ctypes.get_errno(), None
    packages = {}
    for name, expected in BUNDLE_MANIFEST["versions"].items():
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            actual = None
        packages[name] = {"expected": expected, "actual": actual, "matches": actual == expected}
    return {
        "python": platform.python_version(), "platform": sys.platform,
        "architecture": platform.machine(), "kernel": platform.release(),
        "uid": os.getuid(), "euid": os.geteuid(),
        "landlock_abi": abi, "landlock_probe_errno": abi_error,
        "pip_available": importlib.util.find_spec("pip") is not None,
        "packages": packages,
        "packages_match": all(item["matches"] for item in packages.values()),
    }


def extract_bundle(root):
    compressed = base64.b85decode(BUNDLE_ENCODED)
    if digest(compressed) != BUNDLE_MANIFEST["compressed_sha256"]:
        raise ValueError("Compressed bundle hash mismatch")
    data = lzma.decompress(compressed)
    if digest(data) != BUNDLE_MANIFEST["archive_sha256"]:
        raise ValueError("Bundle hash mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if set(archive.namelist()) != set(BUNDLE_MANIFEST["archive_files"]):
            raise ValueError("Bundle file manifest mismatch")
        for name, expected in BUNDLE_MANIFEST["archive_files"].items():
            destination = (root / name).resolve()
            if not destination.is_relative_to(root.resolve()):
                raise ValueError("Bundle path outside qualification scratch")
            value = archive.read(name)
            if digest(value) != expected:
                raise ValueError("Bundle file hash mismatch")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(value)


def run_child(command, root, environment, timeout):
    return subprocess.run(command, cwd=root, env=environment, capture_output=True,
                          text=True, timeout=timeout, check=False)


def testcase_name(case):
    # JUnit assertion text, traceback, and captured environment are never persisted.
    value = case.get("classname", "") + "::" + case.get("name", "")
    return re.sub(r"[^A-Za-z0-9_./:\[\]-]", "_", value)[:240]


def test_report(xml_path, exit_code):
    cases = list(ET.parse(xml_path).getroot().iter("testcase"))
    failures = [testcase_name(case) for case in cases if case.find("failure") is not None]
    errors = [testcase_name(case) for case in cases if case.find("error") is not None]
    skipped = [testcase_name(case) for case in cases if case.find("skipped") is not None]
    linux = [case for case in cases if "test_linux_worker_isolation" in case.get("classname", "")]
    linux_passed = sum(not any(case.find(tag) is not None for tag in ("failure", "error", "skipped")) for case in linux)
    passed = (
        exit_code == 0 and len(cases) == BUNDLE_MANIFEST["expected_tests"]
        and len(linux) == BUNDLE_MANIFEST["expected_linux_tests"]
        and linux_passed == len(linux)
        and len(skipped) == BUNDLE_MANIFEST["expected_macos_skips"]
        and all("test_worker_isolation" in name for name in skipped)
        and not failures and not errors
    )
    return {"passed": passed, "exit_code": exit_code, "tests": len(cases),
            "passed_tests": len(cases) - len(failures) - len(errors) - len(skipped),
            "skipped_tests": skipped, "failed_test_names": failures,
            "error_test_names": errors, "linux_tests": len(linux),
            "linux_tests_passed": linux_passed}


def qualification(report):
    if sys.platform != "linux" or not (3, 12) <= sys.version_info[:2] < (3, 15):
        raise RuntimeError("Qualification requires supported Python on actual Linux")
    if not report["runtime"]["packages_match"]:
        raise RuntimeError("Qualification package pins differ")
    with tempfile.TemporaryDirectory(prefix="sourcesql-flight-qualification-") as scratch:
        root = Path(scratch).resolve()
        extract_bundle(root)
        installed = root / "installed"
        temporary = root / "tmp"
        temporary.mkdir()
        sentinel = root / "synthetic-parent-secret.txt"
        sentinel.write_text("SAFE-SYNTHETIC-FLIGHT-PARENT-CONTROL")
        sentinel.chmod(0o600)
        environment = {
            "PATH": "/usr/bin:/bin", "HOME": str(temporary), "TMPDIR": str(temporary),
            "PYTHONPATH": str(installed), "PYTHONDONTWRITEBYTECODE": "1",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            "SOURCESQL_QUALIFICATION_SENTINEL_ENV": "SAFE-SYNTHETIC-FLIGHT-CREDENTIAL",
            "SOURCESQL_QUALIFICATION_SENTINEL_FILE": str(sentinel),
        }
        report["phase"] = "offline_wheel_install"
        install = run_child(
            [sys.executable, "-c", INSTALL_CODE,
             str(root / "wheel" / BUNDLE_MANIFEST["wheel"]), str(installed)],
            root, environment, 25,
        )
        report["wheel_install"] = {"exit_code": install.returncode, "offline": True,
                                  "dependencies_resolved": False,
                                  "mechanism": "PyPA installer", "installer_version": "0.7.0"}
        if install.returncode != 0:
            raise RuntimeError("Offline wheel installation failed")
        report["wheel_install"].update(json.loads(install.stdout))
        report["phase"] = "installed_fixture_pytest"
        started = time.monotonic()
        tests = run_child([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                           "--junitxml", str(root / "pytest.xml"), "tests"],
                          root, environment, 75)
        report["pytest"] = test_report(root / "pytest.xml", tests.returncode)
        report["pytest"]["observed_wall_seconds"] = round(time.monotonic() - started, 3)
        report["phase"] = "installed_fixture_engine_demo"
        demo = run_child([sys.executable, "-c", DEMO_CODE, str(root)], root, environment, 15)
        report["engine_fixture"] = json.loads(demo.stdout) if demo.returncode == 0 else {
            "passed": False, "exit_code": demo.returncode,
        }
        report["passed"] = report["pytest"]["passed"] and report["engine_fixture"].get("passed", False)
        report["phase"] = "qualification_completed"


def persist(report, request_id, database):
    import duckdb

    # Only this credential-bearing parent performs MotherDuck persistence.
    con = duckdb.connect("md:" + database)
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS sourcesql_worker_qualification (
            request_id UUID PRIMARY KEY, report_json VARCHAR)""")
        con.execute("INSERT INTO sourcesql_worker_qualification VALUES (?, ?)",
                    [request_id, json.dumps({**report, "persisted": True})])
    finally:
        con.close()


def main():
    if BUNDLE_MANIFEST is None or BUNDLE_ENCODED is None:
        raise RuntimeError("Generate a reviewed single-file Flight using build.py")
    request_id = str(UUID(os.environ["REQUEST_ID"]))
    database = os.environ["DATABASE"]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", database):
        raise ValueError("Use a simple disposable qualification database identifier")
    context = {}
    for name in ("MOTHERDUCK_FLIGHT_ID", "MOTHERDUCK_FLIGHT_RUN_ID"):
        value = os.environ.get(name)
        context[name] = str(UUID(value)) if value else None
    report = {
        "schema": "sourcesql.worker-qualification.v1", "request_id": request_id,
        "flight_context": context, "runtime": runtime_report(),
        "bundle_manifest": BUNDLE_MANIFEST, "passed": False,
        "fixture": True, "provider_calls": 0, "persisted": False,
        "phase": "bundle_validation",
    }
    try:
        qualification(report)
    except Exception as error:
        report["error_type"] = type(error).__name__
        # Never include exception messages, tracebacks, stdout, stderr, or environment.
    try:
        persist(report, request_id, database)
        report["persisted"] = True
    except Exception as error:
        report["persistence_error_type"] = type(error).__name__
    print(json.dumps(report), flush=True)
    return 0 if report["passed"] and report["persisted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
