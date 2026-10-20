"""Production sourcesQL Flight: install a reviewed engine, claim one durable job.

The generated program contains public package bytes only. Database/provider
credentials stay in this parent; the engine sanitizes each protected SQL worker.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
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
import zipfile

BUNDLE_MANIFEST = None
BUNDLE_ENCODED = None
SOURCESQL_CONTRACTS_JSON = None

TOKENIZER_HYDRATION = {
    "resource": "sourcesql/_resources/tokenizers/cl100k_base.tiktoken.gz",
    "url": "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken",
    "raw_sha256": "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
    "max_download_bytes": 2_000_000,
    "timeout_seconds": 10,
    "restoration": "gzip-mtime-0",
}

INSTALL_CODE = r"""
from importlib import metadata
from pathlib import Path
import sys
from installer import install
from installer.destinations import SchemeDictionaryDestination
from installer.sources import WheelFile

wheel = Path(sys.argv[1])
target = Path(sys.argv[2]).resolve()
expected_version = sys.argv[3]
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
assert distribution.version == expected_version
assert Path(distribution.locate_file('sourcesql/engine.py')).resolve().is_relative_to(target)
"""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_runtime() -> None:
    if sys.platform != "linux" or not (3, 12) <= sys.version_info[:2] < (3, 15):
        raise RuntimeError("Hosted execution requires supported Python on Linux")
    if platform.machine() not in {"x86_64", "aarch64"}:
        raise RuntimeError("Hosted execution requires a reviewed Linux architecture")
    if platform.python_implementation() != "CPython":
        raise RuntimeError("Hosted execution requires CPython for the pinned binary dependencies")
    for name, expected in BUNDLE_MANIFEST["runtime"]["versions"].items():
        if importlib.metadata.version(name) != expected:
            raise RuntimeError("Hosted package versions differ from the reviewed manifest")


def extract_bundle(root: Path) -> None:
    compressed = base64.b85decode(BUNDLE_ENCODED)
    if digest(compressed) != BUNDLE_MANIFEST["compressed_sha256"]:
        raise ValueError("Compressed bundle hash mismatch")
    data = lzma.decompress(compressed)
    if digest(data) != BUNDLE_MANIFEST["archive_sha256"]:
        raise ValueError("Bundle hash mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(BUNDLE_MANIFEST["archive_files"]):
            raise ValueError("Bundle file manifest mismatch")
        for name, expected in BUNDLE_MANIFEST["archive_files"].items():
            destination = (root / name).resolve()
            if not destination.is_relative_to(root.resolve()):
                raise ValueError("Bundle path outside Flight scratch")
            value = archive.read(name)
            if digest(value) != expected:
                raise ValueError("Bundle file hash mismatch")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(value)


def install_engine(root: Path) -> Path:
    extract_bundle(root)
    target = root / "installed"
    temporary = root / "tmp"
    temporary.mkdir()
    # The trusted installer child has no inherited database/provider credentials
    # in its environment and performs no network/dependency resolution.
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(temporary),
        "TMPDIR": str(temporary),
        "PYTHONPATH": str(target),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            INSTALL_CODE,
            str(root / "wheel" / BUNDLE_MANIFEST["wheel"]),
            str(target),
            BUNDLE_MANIFEST["runtime"]["version"],
        ],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=25,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("Offline wheel installation failed")
    sys.path.insert(0, str(target))
    return target


def configuration() -> dict[str, str]:
    job_id = str(UUID(os.environ["JOB_ID"]))
    values = {"job_id": job_id}
    for name in ("DATABASE", "STORAGE_SCHEMA"):
        value = os.environ[name]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", value):
            raise ValueError("Use simple configured database/schema identifiers")
        values[name.lower()] = value
    namespace = os.environ["NAMESPACE"]
    if not re.fullmatch(r"[0-9a-f]{64}", namespace):
        raise ValueError("Use the configured 64-character lowercase hex namespace")
    if values["storage_schema"] != "sourcesql_" + namespace[:32]:
        raise ValueError("Storage schema differs from the configured namespace")
    values["namespace"] = namespace
    pg_host = os.environ.get("SOURCESQL_MOTHERDUCK_PG_HOST", "pg.us-east-1-aws.motherduck.com")
    if pg_host not in {
        "pg.us-east-1-aws.motherduck.com",
        "pg.eu-central-1-aws.motherduck.com",
    }:
        raise ValueError("Use the configured regional MotherDuck Postgres host")
    values["motherduck_pg_host"] = pg_host
    return values


def flight_context() -> dict[str, str | None]:
    values = {}
    for environment, key in (
        ("MOTHERDUCK_FLIGHT_ID", "flight_id"),
        ("MOTHERDUCK_FLIGHT_RUN_ID", "run_id"),
    ):
        value = os.environ.get(environment)
        values[key] = str(UUID(value)) if value else None
    return values


def load_profile_helper(root: Path):
    path = root / "hosted/exa_profile.py"
    if digest(path.read_bytes()) != BUNDLE_MANIFEST["hosted_profile_sha256"]:
        raise ValueError("Hosted profile policy hash mismatch")
    specification = importlib.util.spec_from_file_location("sourcesql_hosted_exa_profile", path)
    if specification is None or specification.loader is None:
        raise ValueError("Hosted profile policy is unavailable")
    helper = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(helper)
    return helper


def hydrate_embedding_tokenizer(
    installed: Path, manifest: dict, *, timeout_seconds: float = 10
) -> dict:
    """Restore only reviewed public ranks; never receive query text or secrets.

    The package tokenizer remains strictly offline. This trusted Flight-only
    setup step runs before provider dispatch and only for admitted SEM_SCORE.
    """
    import httpx
    from sourcesql.contracts import SourcesQLError

    spec = manifest.get("tokenizer_hydration") or {}
    resource = TOKENIZER_HYDRATION["resource"]
    expected = {
        **TOKENIZER_HYDRATION,
        "distribution_resource_sha256": manifest.get("engine_source_sha256", {}).get(resource),
    }
    if (
        spec != expected
        or not re.fullmatch(r"[0-9a-f]{64}", str(expected["distribution_resource_sha256"]))
        or type(timeout_seconds) not in (float, int)
        or not 0 < timeout_seconds <= TOKENIZER_HYDRATION["timeout_seconds"]
    ):
        raise SourcesQLError(
            "unsupported_capability", "Unreviewed embedding tokenizer setup", "dispatch"
        )
    installed = installed.resolve()
    target = installed / resource
    if not target.resolve().is_relative_to(installed) or target.is_symlink():
        raise SourcesQLError(
            "unsupported_capability", "Invalid embedding tokenizer resource path", "dispatch"
        )
    started = time.monotonic()
    deadline = started + timeout_seconds
    maximum = spec["max_download_bytes"]

    async def download() -> bytes:
        async with asyncio.timeout(timeout_seconds):
            async with httpx.AsyncClient(
                timeout=timeout_seconds, trust_env=False, follow_redirects=False
            ) as client:
                async with client.stream(
                    "GET", spec["url"], headers={"Accept-Encoding": "identity"}
                ) as response:
                    if (
                        response.status_code != 200
                        or response.headers.get("content-encoding", "identity").lower()
                        != "identity"
                    ):
                        raise ValueError("Unexpected tokenizer response")
                    length = response.headers.get("content-length")
                    if length is not None and (not length.isdecimal() or int(length) > maximum):
                        raise ValueError("Tokenizer download is too large")
                    data = bytearray()
                    async for chunk in response.aiter_raw(chunk_size=65_536):
                        if len(data) + len(chunk) > maximum:
                            raise ValueError("Tokenizer download is too large")
                        data.extend(chunk)
                    return bytes(data)

    try:
        if target.exists():
            with gzip.open(target, "rb") as existing:
                data = existing.read(maximum + 1)
            state = "present"
        else:
            data = asyncio.run(download())
            state = "restored"
        if len(data) > maximum or digest(data) != spec["raw_sha256"]:
            raise ValueError("Tokenizer data checksum mismatch")
        compressed = gzip.compress(data, mtime=0) if state == "restored" else None
        if time.monotonic() >= deadline:
            raise TimeoutError("Tokenizer setup exceeded its deadline")
        if compressed is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(compressed)
        return {
            "state": state,
            "raw_sha256": spec["raw_sha256"],
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
    except (OSError, ValueError, EOFError, TimeoutError, httpx.HTTPError) as error:
        raise SourcesQLError(
            "provider_unavailable", "Embedding tokenizer setup is unavailable", "dispatch"
        ) from error


def execute_job(
    store, config: dict, report: dict, root: Path, profile_helper=None, profile_settings=None
) -> None:
    from sourcesql.contracts import SourcesQLError
    from sourcesql.engine import Engine

    from uuid import uuid4

    helper = profile_helper if profile_helper is not None else load_profile_helper(root)
    settings = profile_settings if profile_settings is not None else helper.load_configuration()
    token = str(uuid4())
    report["phase"] = "claim_job"
    job = store.claim_job(
        config["job_id"],
        token,
        flight_context=flight_context(),
        allowed_profiles=settings["allowed_profiles"],
        provider_policy_sha256=settings["provider_policy_sha256"],
    )
    if job is None:
        report.update(status="not_claimed", phase="finished")
        return
    store.bind_job(config["job_id"], token)
    try:
        request = job["request"]
        operation = job.get("operation", "query")
        if not isinstance(request, dict) or operation not in {
            "query",
            "explain",
            "recover_run",
            "import_table",
            "import",
        }:
            raise SourcesQLError("invalid_request", "Unsupported hosted job operation")
        if operation in {"query", "explain"}:
            if request.get("profile", "fixture") != "fixture" and (
                not settings["provider_policy_sha256"]
                or job.get("provider_policy_sha256") != settings["provider_policy_sha256"]
            ):
                raise SourcesQLError("unauthorized", "Hosted provider policy mismatch", "dispatch")
            helper.validate_request(request, settings)
        report.update(phase="engine_operation", operation=operation)

        def before_dispatch(explanation):
            if request.get("profile", "fixture") == "fixture":
                return
            helper.validate_explain(explanation, settings)
            if any(
                stage.get("stage") == "external" and stage.get("operator") == "SEM_SCORE"
                for stage in explanation.get("plan", {}).get("stages", [])
            ):
                report["phase"] = "tokenizer_hydration"
                report["tokenizer_hydration"] = hydrate_embedding_tokenizer(
                    root / "installed", BUNDLE_MANIFEST
                )
                report["phase"] = "engine_operation"

        engine = Engine(
            root=root / "engine",
            store=store,
            allow_private=False,
            profiles=settings["profiles"],
            before_dispatch=before_dispatch,
        )
        if operation == "explain":
            explanation = engine.explain(**request)
            if request.get("profile", "fixture") != "fixture":
                helper.validate_explain(explanation, settings)
            explanation["validation_compute"] = "on_demand_flight"
            explanation["external_calls"] = 0
            store.finish_preflight(config["job_id"], token, explanation)
            report.update(
                status="completed", phase="finished", operation="explain", external_calls=0
            )
            return
        if operation == "query":
            result = engine.query(**request)
        elif operation == "recover_run":
            result = engine.recover_run(**request)
        elif operation == "import_table":
            result = engine.import_table(**request)
        else:
            if set(request) != {"bundle"}:
                raise SourcesQLError("invalid_request", "Invalid hosted restore request")
            result = engine.import_bundle(bundle=request["bundle"])
        receipt = result["receipt"]
        if receipt["status"] not in {"completed", "partial"} or not result.get("result_id"):
            raise SourcesQLError("invalid_output", "Research job returned no durable result")
        # Engine storage commit owns the atomic result/run/job publication.
        # This verifies consistency; it must never create a second publication.
        store.finish_job(config["job_id"], token, result["result_id"], receipt["run_id"])
        report.update(
            status="completed",
            phase="finished",
            result_id=result["result_id"],
            run_id=receipt["run_id"],
            receipt_status=receipt["status"],
            plan_complete=receipt["plan_complete"],
        )
    except SourcesQLError as error:
        store.fail_job(config["job_id"], token, error.code, "Research job failed", error.stage)
        report.update(
            status="cancelled" if error.code == "cancelled" else "failed",
            phase="finished",
            error_code=error.code,
            error_type=type(error).__name__,
        )
    except Exception as error:
        store.fail_job(config["job_id"], token, "execution_failed", "Research job failed")
        report.update(
            status="failed",
            phase="finished",
            error_code="execution_failed",
            error_type=type(error).__name__,
        )


def main() -> int:
    report = {
        "schema": "sourcesql.hosted-flight-run.v1",
        "status": "failed",
        "phase": "configuration",
    }
    store = None
    try:
        if BUNDLE_MANIFEST is None or BUNDLE_ENCODED is None:
            raise RuntimeError("Generate a reviewed single-file Flight using build.py")
        config = configuration()
        report.update(
            job_id=config["job_id"],
            engine_version=BUNDLE_MANIFEST["runtime"]["version"],
            wheel_sha256=BUNDLE_MANIFEST["wheel_sha256"],
        )
        report["phase"] = "runtime_validation"
        validate_runtime()
        with tempfile.TemporaryDirectory(prefix="sourcesql-flight-") as scratch:
            report["phase"] = "offline_wheel_install"
            install_engine(Path(scratch).resolve())
            helper = load_profile_helper(Path(scratch).resolve())
            settings = helper.load_configuration()
            report["provider_policy_sha256"] = settings["provider_policy_sha256"]
            from sourcesql.storage.motherduck import MotherDuckStore

            report["phase"] = "storage_connection"
            store = MotherDuckStore(
                database=config["database"],
                schema=config["storage_schema"],
                namespace=config["namespace"],
            )
            execute_job(store, config, report, Path(scratch).resolve(), helper, settings)
    except Exception as error:
        # Exception messages, traces, stdout/stderr and credentials are never logged.
        report.update(error_type=type(error).__name__, error_code="flight_failed")
    finally:
        close = getattr(store, "close", None)
        if close is not None:
            try:
                close()
            except Exception:
                report["connection_cleanup_failed"] = True
    print(json.dumps(report), flush=True)
    return 0 if report["status"] in {"completed", "cancelled", "not_claimed"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
