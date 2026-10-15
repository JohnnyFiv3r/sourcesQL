# MotherDuck hosted compatibility experiment

This report retains the initial interface experiment on 2026-10-14, before the
Python 3.12/Linux worker qualification phase. Later engine changes do not erase
the strict runtime failure recorded here. See [current qualification](qualification.md)
for the separately measured installed engine.

Measured using an isolated Vercel Node 24 preview, `pg` 8.18.0,
MotherDuck's US Postgres endpoint, and a Lite/Pulse account with a payment
method. The gateway was one approximately 80 KB function, with no Python
process or permanent Python bridge. MotherDuck executed the fixed Python jobs.
This qualifies the tested interfaces; it does not qualify the sourcesQL engine,
Hobby limits, an MCP host, live research quality, or a deployed Cloudflare Worker.

| Test | Result |
| --- | --- |
| Hosted gateway executes SELECT through Postgres | Passed |
| Gateway creates and runs explicit F4/120-second Flights, without schedules | Passed |
| Gateway reads exact run status, effective request config and correlated logs | Passed |
| Gateway reads Flight-written results through fresh connections without Python | Passed |
| Controlled lost submission response recovers by request ID without resubmitting | Passed; see limits below |
| All 31 exact runtime package versions and exercised import/API symbols | Passed on Linux/Python 3.12.14 |
| Fixed SQLGlot/Arrow/DuckDB SQL with explicit execution settings | Passed |
| Append-only correction and result/tree reopen without additional Flights | Passed |
| Engine's Python requirement `>=3.13,<3.15` | **Mismatch: Flight reported 3.12.14** |
| Engine's OS isolation and complete research execution | Not tested in this interface phase; the worker then required macOS |
| Free-allowance exhaustion refuses rather than charges | Not proven on the card-backed account |
| Deployed Cloudflare and Vercel Hobby | Not tested |

## Runtime and dependency evidence

The first dependency run stopped at the engine's declared Python constraint.
Its report showed all 31 versions and imports matched, but Python 3.12.14 did
not satisfy the engine's `>=3.13,<3.15` requirement. That failure was retained.

A second, explicitly diagnostic source revision retained the same package pins
and reported the runtime mismatch while continuing only fixed source-owned SQL.
It passed SQLGlot 30.19.0 parsing, PyArrow 23.0.1 registration and DuckDB 1.5.0
evaluation, then connected to MotherDuck and persisted its report and two rows.
The other direct pins included Pydantic 2.13.3, httpx 0.28.1 and
Pydantic-AI-slim 2.27.0. No package was upgraded to disguise incompatibility.
The interface diagnostic did not change the engine's requirement or worker.
The later qualification phase changes and measures them separately.

The fixed SQL used one thread, a 256 MB configured memory limit, no temporary
spill allowance, locked configuration, disabled external access/extension
autoload/install, and a ten-second interrupt. These settings do not qualify OS
isolation from the Flight's credentials. The actual engine was not installed or
executed inside the Flight. No search or model calls were made.

Stored rows preserved numeric 500 and null, nested evidence, stable row IDs and
the friendly `Planned Capacity (MW)` label alongside the `planned_mw` machine
key. A fresh request reopened the original 500 plus a separate historical 480
correction. Result reads, tree reads and client filtering left run history
unchanged. This is synthetic persistence evidence, not actual MCP rendering.

## Recovery limits

The gateway deliberately returned an error after MotherDuck acknowledged one
submission, withholding its run handle. A subsequent Postgres history request
found the stored `REQUEST_ID` and recovered the exact run without another
dispatch. Status and logs were then correlated to that run.

This is a controlled post-dispatch response-loss simulation. It does not test
every network failure window or prove distributed exactly-once execution. The
probe searches only the latest 20 runs and always says `safe_to_resubmit: false`,
including when none are found. Production adoption still needs durable dispatch
intent, comprehensive recovery, concurrency control and cancellation semantics.

## Usage and cleanup

Three deliberate F4 runs occurred: one tiny fixture, one strict dependency
failure, and one diagnostic dependency pass. Each was limited to 120 seconds.
Their reported wall times were 3.847, 7.705 and 9.616 seconds, respectively.
These are observed run timestamps, not billed compute measurements or research
capacity predictions. Detailed receipts remain ignored under
`artifacts/motherduck-probe`; credentials and raw logs are not in the report.

After the runs, the billing portal displayed four credits and an upcoming draft
of $0.00. Usage-based invoice amounts may change before billing closes. No
precise billed Flight/Pulse reconciliation or account-wide spending stop was
verified. The advertised 30-minute daily F4 allowance applies to no-card Lite;
this account has a card and cannot establish that refusal-at-exhaustion behavior.
See [current pricing](https://motherduck.com/product/pricing/) and
[Flight pricing](https://motherduck.com/docs/billing/pricing/#flights-pricing).

Temporary Vercel automation access was revoked and checked through the project
API. Flight provisioning/submission configuration was disabled. All executable
test deployments, including empty production bootstraps, were removed. The
MotherDuck credential remains encrypted for preview only; the local original
credential was not modified. The isolated nonscheduled Flights and synthetic
database remain for evidence and require no scheduled execution.

## Adoption decision

The thin hosted gateway/Flight/storage approach is viable at the tested interface
level. This experiment identified Python 3.12 and Linux worker qualification as
the next gates. They are now tracked in [current qualification](qualification.md).
Keep Hobby as the intended individual setup default and qualify it explicitly
rather than inferring it from Pro.

Current [packages/runtime docs](https://motherduck.com/docs/key-tasks/flights/packages-and-runtime/),
[create](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-create-flight/)
and [update](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-update-flight/)
references and CLI guide expose no interpreter selector or stated Python version.

A product request identified by the original interface experiment:

> We built and tested a serverless Node/Postgres gateway that provisions and
> runs F4 Flights, recovers a lost submission response and reopens durable
> research results and corrections without starting Python. Our 31 locked
> packages and bounded SQL/persistence diagnostic pass. Flights reports Python
> 3.12.14, while our engine at that point supported 3.13/3.14. Could Flights offer
> explicit interpreter selection or a documented runtime compatibility policy?
> That would make reproducible open-source onboarding easier.

No external message was sent.
