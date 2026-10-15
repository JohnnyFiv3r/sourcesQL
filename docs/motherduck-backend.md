# Native MotherDuck backend

The Node research server can use MotherDuck for engine records, durable jobs and
research state. It queries MotherDuck's Postgres endpoint directly; research runs
in on-demand Python Flights. The gateway does not need an always-running Python
bridge or a local Docker daemon.

The Flight's credential-bearing parent uses the native DuckDB client for stored
engine data and a verified Postgres connection for Flight run-version
inspection. DuckDB 1.5.0's native catalog did not expose the Flight-management
functions in the measured runtime, despite their availability through the
Postgres endpoint. The optional `motherduck` dependency extra adds
`psycopg[binary]==3.3.3`; existing core dependency versions stay unchanged. The
generated Flight selects 34 exact Linux distributions, including
`psycopg-binary==3.3.3` and `installer==0.7.0`.

**Qualification status:** the native Postgres adapter, protected Python Flight
and MCP tools/state pass the measured synthetic integration below. A Vercel
deployment, Hobby limits, live/private profiles and actual ChatGPT/Claude MCP
App rendering remain separate qualification gates. The earlier
[interface proof](motherduck-compatibility.md) and
[protected-engine qualification](python-linux-qualification.md) retain their
own source snapshots.

## Supported scope

Use one protected deployment with one fixed principal. Every client holding its
bearer token accesses that same owner's workspace. Principal-derived schemas
separate application records; they are not database row-level access control or
a shared multi-tenant service. Keep the configured principal stable across
restarts so the gateway addresses the same stored records.

The default hosted execution profile is `fixture`: synthetic research with no
live search or model calls. Operators can explicitly enable bounded
[Exa search](hosted-flight.md#opt-in-exa-search); its one-request live dispatch,
secret injection, retained result and MCP reopening now pass qualification.
Hosted private profiles and live semantic models remain unavailable.
`explain` requires the local engine. Imports and restores still undergo engine
validation and dependency authorization; using a hosted store does not make an
untrusted archive authoritative.

## What runs Python

| Action | Execution path |
|---|---|
| Execute a research query | A bounded Python Flight using the installed engine and protected SQL worker |
| Materialize an effective input or restore an engine archive | A Python Flight for typed validation and atomic publication, without search/model calls |
| Read or page a retained result, export a result graph | Native gateway SQL; no Flight |
| Reopen the research tree, rename a table, append a correction | Native gateway SQL; no Flight |
| Poll a job or inspect its exact platform run | Stored records and Flight-management SQL; no new Flight |

An effective input can require a materialization Flight before its research
query. A correction itself does not launch Python. Ordinary reads preserve
machine keys, display labels, types, nulls, row identities and evidence. For
example, `planned_mw` can display as `Planned Capacity (MW)`.

## Build the reviewed Flight

From the repository root, with the development build tools installed:

```sh
uv build --wheel
python hosted/flight/build.py dist/sourcesql-0.1.1-py3-none-any.whl \
  --output artifacts/hosted-flight
```

The builder checks the wheel against current engine source and dependency
metadata. It emits `flight.py`, `requirements.txt` and `manifest.json`. The Flight
contains the public engine wheel; it does not bundle operator credentials,
private files or the test suite. MotherDuck installs the pinned requirements as
part of Flight startup. The program installs its embedded wheel offline using
PyPA `installer==0.7.0`, verifies the runtime and claims one durable job.

Install the Node gateway dependencies, then provision the reviewed artifacts:

```sh
npm ci --prefix apps/research
node hosted/setup.mjs \
  --database sourcesql_personal \
  --principal sourcesql-owner \
  --bundle artifacts/hosted-flight \
  --output local/motherduck/setup.json \
  --use-local-login
```

The explicit `--use-local-login` option uses the cached MotherDuck CLI login
credential for this provisioning session only. Do not copy that ephemeral login
credential into a persistent gateway. Alternatively, configure an operator-created
Read/Write API/access token as `MOTHERDUCK_TOKEN` securely in the command's
environment and omit `--use-local-login`. The deployed gateway needs its own
explicitly configured durable credential and rotation policy. Choose `MOTHERDUCK_HOST` for the account's region; the
default is the US endpoint. The database must exist unless you explicitly add
`--create-database`.

Setup checks artifact fingerprints and creates one **F4**, **120-second**,
on-demand Flight. It does not submit a research job. Its local receipt and
companion `.env` settings are created with mode `0600`, contain no access token,
and default to `SOURCESQL_ALLOW_FLIGHT_SUBMISSION="0"`. Configure gateway
authentication and its MotherDuck secret separately.

If setup loses its creation response, do not delete the receipt or blindly run
it again with another output path. Inspect the saved creation intent and Flight
name, reconcile them with MotherDuck's Flight listing/version metadata, and
recover the created Flight ID if present. An absent response does not prove that
creation failed. Setup refuses an already-used receipt path rather than
automatically repeating creation.

The setup command configures these Flight keys; they must remain consistent if
you use MotherDuck's [creation interface](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-create-flight/)
directly:

| Flight config | Value |
|---|---|
| `DATABASE` | The configured MotherDuck database |
| `NAMESPACE` | Lowercase SHA-256 of the gateway principal's UTF-8 bytes |
| `STORAGE_SCHEMA` | `sourcesql_` followed by the first 32 namespace characters |
| `JOB_ID` | Setup uses `unsubmitted`; the gateway overrides it with each durable job's UUID |
| `SOURCESQL_MOTHERDUCK_PG_HOST` | The selected MotherDuck Postgres endpoint, matching the gateway's region |

The gateway and Flight must use the same owner, database and namespace. The
Flight needs MotherDuck persistence permission. Configure credentials through
the platform's credential facilities; keep them out of the generated source and
requirements. Submit jobs through the gateway rather than manually running the
placeholder configuration.

The internal Postgres control connection verifies the full server certificate
against the pinned `certifi` CA bundle. Its Flight-function identifiers are
validated UUID literals, avoiding the measured ambiguity of parameterized
table-function arguments. Research SQL still executes only in the protected
worker; it never runs on this credential-bearing control connection.

## Gateway configuration

The existing Node server selects this adapter with the following environment.
Keep secrets in local ignored configuration or encrypted hosting environment
variables. Never include real tokens in source, deployment arguments or a public
example.

| Variable | Purpose/default |
|---|---|
| `SOURCESQL_BACKEND` | `motherduck` |
| `RESEARCH_AUTH_MODE` | `protected` for HTTP; stdio is already protected |
| `RESEARCH_BEARER_TOKEN` | A strong secret for protected HTTP requests |
| `SOURCESQL_PRINCIPAL` | Explicit, stable owner identifier |
| `MOTHERDUCK_TOKEN` | Operator-created Read/Write API/access token for the owner account; choose expiry and rotation for persistent hosting |
| `MOTHERDUCK_DB` | Database identifier, up to 63 characters |
| `MOTHERDUCK_HOST` | `pg.us-east-1-aws.motherduck.com` or `pg.eu-central-1-aws.motherduck.com` |
| `SOURCESQL_FLIGHT_ID` | The reviewed Flight's UUID |
| `SOURCESQL_FLIGHT_SOURCE_SHA256` | Generated manifest's `flight_source_sha256` |
| `SOURCESQL_FLIGHT_REQUIREMENTS_SHA256` | Generated manifest's `requirements_sha256` |
| `SOURCESQL_EXA_POLICY_VERSION` | Defaults to `exa-search.v1` (existing Auto-only Flight); `exa-research.v2` requires a matching reviewed v2 Flight and explicit deployment configuration |
| `SOURCESQL_FLIGHT_MAX_RUNTIME_SEC` | Default `120`, range `30`–`120`; must equal the Flight limit |
| `SOURCESQL_FLIGHT_DAILY_SECONDS` | Default `600`, range `0`–`1800`; reserved execution seconds per UTC day |
| `SOURCESQL_ALLOW_FLIGHT_SUBMISSION` | Default off; set `1` only for an explicitly enabled deployment |

Leave `SOURCESQL_PROFILES_FILE` unset, `SOURCESQL_ALLOW_PRIVATE` disabled, and
`RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE` disabled for this supported scope. The
backend refuses a private/live profile configuration rather than silently
substituting local storage or fixture results.

With that environment configured, the existing server can be run with:

```sh
npm ci --prefix apps/research
npm --prefix apps/research run build
npm --prefix apps/research start
```

This starts the Node gateway; its presence is not evidence of a qualified Vercel
deployment. A serverless entry point, deployment environment and MCP connection
must also be tested in their actual host.

## Gateway token lifetime and rotation

Use a named Read/Write API/access token from the intended owner's account for
persistent hosting. MotherDuck documents token creation and expiration choices in
[access-token authentication](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/authenticating-to-motherduck/#authentication-using-an-access-token).
A cached interactive CLI-login credential can expire independently of the app;
`motherduck status` reporting authenticated does not qualify that credential's
remaining lifetime. `--use-local-login` is a provisioning convenience, not a
persistent-gateway credential strategy. A service account is optional when
appropriate to the adopter's account; do not enable a paid feature merely to
satisfy this setup.

Rotate the existing Vercel project's encrypted **Preview** `MOTHERDUCK_TOKEN`,
update the private local credential input, and redeploy the same reviewed app.
Keep its owner, database, Flight ID, source/dependency fingerprints, OAuth settings
and stable alias unchanged. Updating an environment variable does not replace a
running deployment's environment. This rotation requires neither another Flight
nor a research job. Confirm authenticated saved-result reads on the replacement
deployment, settle in-flight work, and then revoke the old token. Keep Production
credentials separate. See the [personal-cloud rotation steps](personal-cloud-setup.md#motherduck-credentials-for-a-persistent-gateway).

If authentication fails during a mutation or job response, retain the exact IDs.
After restoring access, inspect the canonical revision and the same mutation/job
before deciding whether an identical retry is needed. Failed authentication is
not proof that an earlier request never committed. Never switch to a new request
or mutation ID merely to recover an uncertain response, and do not recreate the
Flight to fix an expired gateway token.

## Durable jobs and explicit resume

The owner selected **one active job per owner namespace, with explicit resume
for queued jobs**. The adapter implements that policy; it does not automatically
drain the queue when capacity becomes available.

For a query, retain one `request_id` UUID and identical arguments across retries.
An initial request can start its job when submission is enabled and capacity is
available. The response may instead be a pending or queued job handle.

Poll `sourcesql_job_status` using the same `job_id`. Polling does not dispatch
Python. A job that remains `queued` needs an explicit `sourcesql_start_job` call;
there is no background scheduler that automatically drains the queue. The host
or user must retain the job handle and resume it. If effective-input
materialization is pending, poll that job first, then repeat the original query
with the same query request ID and arguments. The research query has not yet
been submitted during materialization.

Before dispatch, the gateway verifies the configured Flight's on-demand status,
F4 size, runtime cap, owner configuration and source/requirements fingerprints.
It records durable dispatch intent and reserves the worst-case runtime in one
owner transaction. Dispatching, uncertain or unsettled prior work blocks a new
dispatch. The engine's result, receipt and completed job become visible in one
publication transaction. Cancellation competes through the same owner control
row and prevents a late result from publishing after cancellation wins.

A lost submission response is not permission to submit again. Recovery uses the
stored exact run identity, or searches the latest 100 Flight runs for the job's
configuration. No match or multiple matches stays uncertain. A crash between
recording intent and submitting can therefore require operator reconciliation;
the application cannot infer that no Flight ran from an absent response or a
limited history search. Do not bypass that fence with a fresh request ID.

## Limits of the safety and cost controls

MotherDuck's [version metadata function](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-get-flight-version/)
provides the instance type, runtime cap, config, source and requirements used for
preflight checks. [Submission](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-run-flight/)
always selects the current version; the documented function has no version-pin
or conditional-version argument. An operator update between inspection and
submission can therefore change the selected version. Keep the reviewed Flight
unchanged during active dispatch. Version checks fence job execution. When a
dispatch response identifies a mismatched run, the gateway attempts to cancel
it; that does not guarantee that cancellation was acknowledged or that no
compute was billed.

The daily reserve is an application allowance for one namespace. It conservatively
charges the full configured runtime before each deliberate submission, including
work whose dispatch outcome is uncertain. It is not a provider-reported usage
meter, a refund calculation, a MotherDuck account-wide allowance, or a hard stop
before billing. Other applications, database queries, storage and external
provider usage need separate accounting. A card-backed account can incur
overage; this adapter does not prove refusal at the free-tier boundary.

Stored result and research-history quotas also do not impose an account-wide
database storage cap. Reopening data consumes no Flight execution, but its SQL
requests can consume database compute. Real research runtime, cold startup,
provider spend and Hobby limits remain measured adoption gates.

The [local Docker/DuckDB path](docker.md) remains available independently of this
hosted adapter. It packages the CLI and HTTP/stdio MCP app. The measured Docker app preserves
research and corrections across container restarts; actual model-host rendering
remains separate.


## Measured fixture integration, October 14, 2026

The actual MotherDuck test passed research execution, controlled lost-response
recovery without resubmission, typed import, a query over that saved input, and
a two-result archive restore. Fresh Postgres reads preserved BIGINT
`9007199254740993` and the restored content hash. The reserve guard refused a
submission before dispatch; queued cancellation and actual Flight cancellation
settled without a late result. All runs were terminal at completion.

The MCP integration opened the completed engine table, saved a separate
correction, refused a stale edit, retried an identical mutation without a new
revision, and reopened the correction/history through a fresh backend. It
started no Flight and did not modify canonical engine data.

Seven deliberate F4 runs reported 51.833 seconds in aggregate start/end
intervals: four succeeded, two failed, one was cancelled. The failed native
control attempt and unsupported harness query remain in the receipts. No
search/model calls or schedules were used. The test conservatively reserved
840 seconds; the default application allowance remains 600. These are
execution observations, not a reconciled invoice or proof of a platform billing
hard stop.

The frozen source passed 241 macOS Python tests, 281 applicable Linux Python
tests (including all 44 isolation cases), and 90 app tests on both macOS and
Docker. Ruff, mypy and TypeScript/build passed. Operator receipts are under
`artifacts/hosted-storage-20261014/`,
`artifacts/python312/macos-hosted-storage-final-20261014/` and
`artifacts/docker-app-20261014T182313Z/`; they are excluded from public packages.
See [current status](../STATUS.md) for source fingerprints and remaining gates.
