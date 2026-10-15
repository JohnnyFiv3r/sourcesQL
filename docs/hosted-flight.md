# MotherDuck Flight execution

The hosted driver runs the installed sourcesQL engine in a bounded MotherDuck
Flight. MotherDuck stores the research result, provenance, engine receipt and
application job record. Reading results, applying corrections and inspecting the
research tree use stored records and do not start Python.

The default hosted query profile is `fixture`: it makes no paid search or model
calls. The same job driver supports table imports and archive restores; these
perform no provider work. An operator can separately enable the bounded `exa`
search profile described below.

## Build a public execution bundle

From the repository root:

```sh
uv build --wheel --out-dir artifacts/hosted-wheel
uv run --frozen python hosted/flight/build.py \
  artifacts/hosted-wheel/sourcesql-0.1.2-py3-none-any.whl \
  --output artifacts/hosted-flight
```

This writes `flight.py`, `requirements.txt` and a hash manifest locally. It does
not connect to MotherDuck, create a Flight, start a job or enable paid services.
Use the coordinator's configured database and schema when provisioning the
single-file program.

The archive includes the public engine wheel with its license/provenance
metadata, plus the reviewed `hosted/exa_profile.py` policy helper. The builder
hashes the helper and compares every engine source file with the wheel and
checks package metadata against the current `pyproject.toml`. A stale wheel,
additional wheel files or an unfamiliar lock marker stop the build. Runtime
requirements use the repository's exact dependency pins, the optional
`motherduck` extra (`psycopg[binary]`) and PyPA `installer` 0.7.0; tests, pytest,
Ruff, mypy and operator files are excluded.

The Flight has no dependency resolver or network installer. A short child
process installs the validated wheel using PyPA `installer` into temporary
storage. Its environment excludes database and provider credentials. The driver
then imports that installed engine; each research SQL worker uses the qualified
Linux Landlock and seccomp protections and a sanitized environment.

## Job ownership and recovery

Each invocation receives these operator-controlled values:

| Value | Meaning |
| --- | --- |
| `DATABASE` | Existing MotherDuck database |
| `NAMESPACE` | 64-character lowercase hexadecimal storage namespace |
| `STORAGE_SCHEMA` | `sourcesql_` followed by the first 32 namespace characters |
| `JOB_ID` | Existing application job UUID |
| `SOURCESQL_MOTHERDUCK_PG_HOST` | Regional Postgres host; defaults to `pg.us-east-1-aws.motherduck.com` |

Native DuckDB persists research records. Flight lifecycle inspection uses the
Postgres endpoint through psycopg with strict TLS verification; the pinned
DuckDB 1.5.0 client does not expose the Flight management functions. Setup must
pass the account's regional Postgres host into the Flight configuration,
including for EU accounts.

The operation and request come from that durable job record. The driver accepts
only `query`, `import_table` and `import`; Flight configuration cannot replace
the operation, query, input relations, profile or policies.

The driver atomically claims the job with a fresh UUID before calling the engine.
A job that is already claimed or terminal is a no-op on a second invocation.
Claimed jobs are not automatically restarted after a crash: a previous execution
may already have made provider requests or committed a result. A lost submission
response is recovered from durable job state and the exact Flight run rather
than blindly submitting again.

The storage adapter binds the claim to the engine run and atomically publishes
the immutable result, engine receipt and completed job record. Cancellation wins
at publication: a cancelled job cannot publish a result. The runner's final
`finish_job` call verifies the existing publication rather than publishing again.
A completed application job can have a `partial` engine receipt; the engine's
`plan_complete` flag and unknown/failed semantic outcomes remain intact.

Hosted exports wrap the original metadata and table JSON strings in a hashed,
base64 archive. This preserves large integers and floating-point values without
converting table values through JavaScript. The Python decoder checks the exact
envelope/record shapes, UTF-8, duplicate JSON keys, hashes, the 16 MiB decoded
limit and a maximum of 64 records. It converts the archive to the standard engine
bundle; the existing importer still validates classification, typed rows,
evidence and the complete ancestor closure. Restore result mappings are stored
with the completed job.

Logs contain a small structured status record with IDs, engine version, bundle
hashes and error classes/codes. They exclude query rows, exception messages,
tracebacks, child output and environment values. Detailed research state is read
through the authenticated storage API.

## Opt-in Exa search

An API key alone does not enable live calls. Configure the same public policy in
the coordinator and the Flight:

| Variable | Value |
| --- | --- |
| `SOURCESQL_ALLOW_LIVE_EXA` | `1` to enable; absent or `0` keeps fixture-only execution |
| `SOURCESQL_EXA_APPROVED_COST_MICROUSD` | Approved per-job estimate in integer microdollars; default `50000` ($0.05), ceiling `1000000` ($1) |
| `SOURCESQL_EXA_SECRET_NAME` | Bound MotherDuck Flight secret name, for example `sourcesql_exa` |

The public policy fingerprint is SHA256 of sorted compact ASCII JSON containing
exactly `version: "exa-search.v1"`, `approved_cost_microusd`, and `secret_name`
(`null` for a local direct `EXA_API_KEY`). The coordinator's durable job pins that
fingerprint; the Flight supplies its trusted fingerprint and allowed profiles to
the claim operation. Secret values are excluded from policy, artifacts and logs.
The engine also pins the fingerprint in its provider profile revision.

Each Exa query must use `profile: "exa"`, `source_mode: "allow_excerpt"` and
explicit effective budgets no greater than these ceilings:

| Resource | Per-job ceiling |
| --- | --- |
| Search queries / HTTP search requests | 2 / 2 |
| Total candidates | 10 |
| Additional fetches / semantic documents / model calls | 0 / 0 / 0 |
| Concurrency / dispatch deadline | 1 / 60 seconds |
| Output rows / output bytes | 100 / 1 MiB |
| Model input / output tokens | 0 / 0 |
| Estimated cost | The operator's configured grant |

The driver checks the engine's admitted plan before execution and permits only
`WEB_SEARCH` external stages. Exa returns search metadata and retained excerpts;
the initial profile grants no direct source hosts, automatic document fetch,
model, embedding, synthesized Exa output, retry or provider fallback. Missing
credentials or expanded request limits fail before provider dispatch. Table
imports and restores remain provider-free.

Create the secret from a private dotenv file containing the `EXA_API_KEY` field:

```sh
motherduck flight create-secret sourcesql_exa --secrets-file /path/to/private/exa.env
motherduck flight list-secrets -o json
```

The CLI's `--secrets-file` keeps the value out of arguments and shell history;
the listing returns names and shape without values. Bind the secret on the
reviewed Flight using `flight_secret_names := ['sourcesql_exa']` in
`MD_CREATE_FLIGHT`/`MD_UPDATE_FLIGHT`, or the CLI's `flight push --secret-names`.
Binding changes create a new Flight version and require refreshing the reviewed
version pin. Update config and secret-name lists in full: these fields replace
the existing values rather than merging.

MotherDuck's [Flight secret documentation](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/create-secret/#flight-secrets)
specifies runtime names as `<secret_name>_<parameter_name>`. With the example
above the helper references `sourcesql_exa_EXA_API_KEY`; it does not copy the
value into a plain environment variable. For local execution without a secret
name, the helper references `EXA_API_KEY` directly. The documented SQL creation
form is `CREATE SECRET <name> IN MOTHERDUCK (TYPE FLIGHTS, PARAMS MAP {...})`;
SQL/MCP sessions cannot read those parameter values.

For metadata inspection, select only `name`, `type` and `storage` from
`duckdb_secrets()`. To inspect the bound names and public config for a reviewed
version, select `flight_secret_names, config` from `MD_GET_FLIGHT_VERSION` using
`flight_id` and `version_number`. The SQL forms are documented; use the qualified
Postgres control path for Flight functions rather than assuming the pinned
native DuckDB client exposes them. No key value belongs in a query result or
Flight config. See the [create](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-create-flight/),
[update](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-update-flight/)
and [version metadata](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-get-flight-version/)
references.

## Cost controls and qualification

Provision bounded F4 Flights without schedules, keep fixture mode as the default
and stop before enabling paid resources. Application submission limits and Flight
runtime limits bound this path's activity; they do not replace MotherDuck billing
controls or guarantee allowance exhaustion will refuse additional paid usage on
an account with a payment method.

The preceding [Python/Linux qualification](python-linux-qualification.md) proved
the engine and worker protections in MotherDuck and Docker. Qualification of the
production durable-job integration is recorded separately in repository status
and its integration receipts; generating a bundle alone is not a hosted
qualification or deployment.

The October 14, 2026 keyed qualification also verified the prefixed MotherDuck
secret injection contract end to end. One search-only Exa job returned three
retained excerpt sources, reported a $0.007 response estimate and a 10.616-second
Flight interval. Stored-result MCP access, immutable UI resource retrieval and
fresh-factory reopening passed with the platform run count unchanged at one.
No fetches or model calls occurred. This does not establish provider billing,
free-credit balance, corpus completeness or an external ChatGPT/Claude session.
