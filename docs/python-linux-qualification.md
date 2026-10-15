# Python 3.12 and Linux worker qualification

Measured on October 14, 2026 against the same source-matched sourcesQL
`0.1.0a1` engine. The package now supports Python `>=3.12,<3.15`; all 44
previously locked package versions are unchanged. The lock adds Python 3.12
wheel metadata and the existing conditional typing dependency for that runtime.

| Runtime | Result | Scope |
| --- | --- | --- |
| macOS ARM64, Python 3.12.12 | 191 passed; 44 Linux cases skipped; Ruff and mypy passed | Installed engine and actual macOS worker |
| Native ARM64 Docker, Python 3.12.14, kernel 6.12.76-linuxkit, UID 10001, Landlock ABI 6 | 231 passed; four macOS cases skipped | Installed engine, all 44 Linux isolation cases and two-row fixture demo |
| MotherDuck F4, native x86-64, Python 3.12.14, kernel 6.12.110-135.202.amzn2023.x86_64, UID 0, Landlock ABI 6 | 231 passed; four macOS cases skipped | Installed engine, all 44 Linux checks, fixture demo, export and persisted report reopen |

The complete suite contains 235 cases. Local runs have one existing Pydantic
Graph event-loop deprecation warning. Detailed operator receipts and source
hashes remain ignored under `artifacts/`; public artifacts contain no credentials
or private handoff documents.

## Worker protections

The Linux launcher installs unprivileged Landlock filesystem rules and a
default-deny seccomp filter before importing native SQL dependencies or reading
query input. Only trusted runtime files and worker scratch receive read grants;
scratch permits bounded writes. Native x86-64 and ARM64 have separate reviewed
syscall tables. Missing required protection refuses execution rather than
falling back to an unprotected worker.

The worker receives an explicit environment without provider/database secrets,
inherits no extra parent descriptors, and owns its process group. Normal
timeout kills and reaps it, closes pipes and removes scratch. On Linux, kernel
parent-death signaling also kills an active worker after its owner is abruptly
killed, with checks closing the signal-registration races. An abruptly killed
owner cannot remove scratch; an ephemeral container/Flight or subsequent
housekeeping must reclaim it. Each new engine worker is probed before provider
dispatch, even after an earlier query succeeded.

All 44 adversarial cases execute arbitrary probe Python under the production OS
policy, bypassing SQL admission deliberately. They cover external file access
and mutations, path escapes, writable runtime attempts, TCP/UDP/Unix sockets,
credentials and process environments, inherited descriptors, filter/thread
inheritance, fork/detachment, namespace/process inspection syscalls, resource
limit mutation, timeout cleanup, abrupt parent death, parent-identity mismatch
and unavailable-kernel refusal before payload execution. Unrestricted parent
controls prove these denials came from the worker protections.

The narrow cgroup metadata read grants are required by DuckDB 1.5.0 startup;
they cover its own membership plus CPU/memory limit files. They grant no broad
`/proc` or filesystem access. Device ioctls remain denied with the errno that
allows Python 3.12's normal file-opening fallback.

These checks qualify the recorded kernel/architecture combinations. They do
not establish every Linux kernel, older Landlock ABI, or arbitrary native-code
and kernel vulnerability resistance. Trusted runtime directories must contain
code and libraries rather than application secrets.

## Actual MotherDuck experiment

The final Flight succeeded with all 231 applicable tests, all 44 Linux cases,
and only the four expected macOS skips. All 37 runtime/qualification pins
matched. The installed engine completed two fictional research rows, four
source versions, eight evidence items and an export bundle. The sanitized
report was persisted, then reopened through a fresh Postgres process without
starting another Flight or Python process. This proves actual engine execution
and the recorded OS boundaries, including on MotherDuck's root-UID runtime.

The first run installed all 36 pinned runtime/test packages but failed the
harness's offline pip wheel-install step before running the engine. Its failed
report was written to MotherDuck and reopened through a fresh Postgres
connection. It observed Python 3.12.14, native x86-64, kernel
`6.12.110-135.202.amzn2023.x86_64`, UID 0 and Landlock ABI 6. Availability alone
did not itself prove worker enforcement. The install exit code did not expose
its reason; the corrected runtime separately confirmed no pip module.

The corrected harness adds only qualification tooling, pinned PyPA installer
0.7.0, while retaining all engine pins and the same wheel. It installs the wheel
offline in a credential-free child, validates its RECORD and package location,
then runs the complete fixture suite and actual engine demo. Only the Flight
parent writes the sanitized report to MotherDuck; ordinary report reads launch
no Python. Public wheel/tests/examples/metadata are compressed into a reviewed
193,394-byte single-file program, below the documented source cap. No operator
data, raw captured output or traceback is embedded or persisted.

The second run passed the engine demo and 43 of 44 Linux checks, but a Unix
socket parent-control fixture failed. Its long temporary pathname exceeded
Linux's socket address limit; an offline reproduction failed before worker
launch. The final test uses a short unique abstract address, preserving the
successful parent connection, worker denial and absence of unexpected traffic.
The complete corrected suite passed on both Docker and MotherDuck. This was
a fixture correction, not a relaxed worker rule.

Three deliberate F4 attempts were bounded to 120 seconds each, without schedules,
search/model calls or automatic dispatch retry. The failed first run is
retained separately, as is the Unix-control failure. Reported run wall times
were 5.824, 52.543 and 53.604 seconds. The final pytest portion took 43.643
seconds. Observed run wall time is not billed compute; the
card-backed account does not prove no-card allowance exhaustion or an
account-wide spending stop.

After all runs, the refreshed billing portal displayed **3.99098168 credits**
remaining and a **$0.00 upcoming draft** for November 1, 2026, including $0.00
Pulse and F4 line items. This is a dated draft observation; it can change before
final billing and does not reconcile billed seconds to these individual jobs.

The final wheel SHA-256 is
`f6529c9839f0682e3892bc9e17892d2e073d9b4b246b9e8060b508b48ded72d2`;
Flight source SHA-256 is
`07691349d944faed86342f24eaeb50369208a0ed3884b9ca001b3108c1289924`.
Mac receipts are under `artifacts/python312/macos-3.12.12-qualified-unix/`;
Docker receipts under `artifacts/linux-py312-20261014T163438Z/`; final hosted
receipts under `artifacts/worker-qualification/motherduck-flight/`. The two
failed hosted snapshots have separate retained directories beside it. Engine,
test and metadata hashes match across all final runs. No publication occurred.

## Adoption boundary

The [Docker engine path](docker.md) is available for offline fixtures and
preserves results in its named volume. Packaging the Node/MCP workspace in
Docker remains separate. MotherDuck's execution/isolation gate is now passed;
it still needs qualified durable store adapters, asynchronous job/recovery/cancellation
and authorization before it can host the complete app. Vercel Hobby limits,
live research quality/cost and actual MCP-host rendering remain separate gates.
