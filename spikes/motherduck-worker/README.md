# MotherDuck / Cloudflare gateway probe

This isolated integration probe investigates whether a Cloudflare Worker can submit a Python Flight, inspect its exact run, and read its stored output through **one Postgres wire-protocol connection path**. It contains no native DuckDB client or Python bridge in the gateway. The Flight itself uses native DuckDB inside MotherDuck's managed Python runtime.

Current interface evidence: 24 offline gateway tests and a Wrangler dry-run pass. The [Vercel adapter](../sourcesql-vercel/README.md) passed the live Postgres/Flight lifecycle, controlled response-loss recovery and stored-result/correction reopen. Three deliberate interface runs occurred; the exact-lock diagnostic passed SQL/persistence while retaining the then-current Python requirement mismatch. Temporary access and executable test deployments were removed. No Cloudflare Worker was deployed. See the [measured report](../../docs/motherduck-compatibility.md). Actual installed-engine/Linux qualification is a separate phase; this gateway fixture is not MCP Apps qualification or a research throughput benchmark.

## Local checks

From this directory, with Node 22 or newer:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run setup-sql -- your_probe_database
```

The build uses `wrangler deploy --dry-run`; it does not publish. The setup command prints SQL only. Dependencies are isolated from the existing research app and locked. `pg` provides TCP/TLS via Workers' `nodejs_compat` runtime. Ordinary data uses bound parameters. Flight-control SQL uses validated UUID/UBIGINT literals because the detailed reference requires literals or `getvariable()` for exact-run inspection. Native DuckDB types such as maps are projected as JSON text; unsigned run numbers are decimal strings.

## Live qualification, pending account configuration

1. For the no-card free adoption test, use a MotherDuck Lite account without a credit card and confirm allowances remain. The owner's actual account is card-backed Lite; its shared monthly credits and paid overage differ from the no-card daily allowance. Choose a disposable writable probe database. The 120-second F4 fixture makes no Exa, model, or other external provider calls. Its timeout is not a guarantee about billed startup or install time.
2. Run the printed setup SQL in MotherDuck, in that same database. Save the returned `flight_id`. Creating this fixture through the UI is provisioning, not evidence that Flight creation works over Postgres. There is no schedule. The predefined `REQUEST_ID` config key allows per-run overrides.
3. Copy `.dev.vars.example` to ignored `.dev.vars`. Fill in `MOTHERDUCK_DB`, `MOTHERDUCK_TOKEN`, a separate random `GATEWAY_TOKEN`, and `FLIGHT_ID`. Use the EU hostname in Wrangler if the account is in Europe. Set `ALLOW_FLIGHT_SUBMISSION=true` only for this deliberate probe.
4. Run `npm run dev`. MotherDuck documents possible direct-Postgres local `Connection terminated` errors. If that occurs, a Hyperdrive local connection or authenticated `wrangler dev --remote` is a separate connection-path test; this probe currently implements the direct endpoint. Authenticate Cloudflare before remote execution. A local workerd pass does not establish a deployed Worker pass.
5. In a second shell, configure `PROBE_URL` to the tested Worker origin and `GATEWAY_TOKEN` locally, then explicitly opt in:

   ```sh
   ALLOW_LIVE_PROBE=true npm run verify-live
   ```

The verifier attempts **one** Flight submission. Its tiny-job test deliberately loses the gateway response after the database acknowledges dispatch, then recovers the exact run by `REQUEST_ID` without resubmitting. It polls the recovered `run_number` for at most three minutes. Set `PROBE_KIND=dependencies` for the separately configured exact-lock job. Each HTTP request has a deadline. Local ignored receipts include operation timing, IDs, raw run timestamps, observed wall time, dependency reports and the failed phase. Billed Flight seconds remain `null` until reconciled against provider usage; wall time is not billing evidence. Credentials, raw logs and source content are not printed or saved in receipts.

If submission times out or the response cannot be reconciled, inspect `md_list_flight_runs` for the receipt's `REQUEST_ID`. Do not rerun the verifier to recover that submission: it would create a fresh request ID and potentially another run. Disable submission after qualification. The probe has no durable dispatch gate or automatic deduplication; it is not a production job service.

Current primary sources do not specify the Flight Python interpreter version or expose an interpreter selector. The dependency job reports `sys.version` and verifies the engine's current `>=3.12,<3.15` constraint at runtime; the Flight content `--version` flag does not select Python.

The separate `qualification/` harness installs a source-matched engine wheel
offline inside the Flight and executes the actual fixture suite and Linux worker
checks. Its single-file payload uses compressed public files, exact runtime and
pytest pins, and no operator state. `qualification/run.mjs` records intent before
one F4/120-second submission and supports read-only status, recovery and report
retrieval. It requires the local MotherDuck credential and a reviewed generated
bundle; it is an operator experiment, not an adopter-facing job service. Raw logs
and credential-bearing errors never enter its receipts.

## Pass criteria

- The actual Worker connects through `pg` and submits `md_run_flight` with a correlated `REQUEST_ID`.
- `md_get_flight_run` polls the exact returned run without a native client/HTTP Python bridge, retaining its UUID, version, unsigned run number and effective config.
- The run reaches `RUN_STATUS_SUCCEEDED` with exit code 0; `md_get_flight_logs` returns the matching request's fixture completion marker.
- Native Flight writes and gateway reads round-trip numbers, nulls, JSON evidence, row IDs and stored `Planned Capacity (MW)` metadata.
- A correction appends a durable revision; reopening retains the original 500 MW plus the separate 480 MW amendment.
- Stored table/tree reads and a client display filter create no additional runs, checked against before/after run history on this dedicated fixture Flight. Connections are opened and closed per request, so correction reopen exercises a fresh database session.

This pass proves only the named interfaces on the tested account, region, Worker runtime and package versions. Before adopting the architecture, port and qualify SQL admission/isolation, access checks, durable dispatch and retries, cancellation, budgets, app revisions/checkpoints and actual research execution. Measure full research jobs separately, including installs, waiting, retries, search/model cost and both MotherDuck compute meters.

## Primary references

- [Official Workers connection guide](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/postgres-endpoint/cloudflare-workers/) and [cookbook](https://github.com/motherduckdb/motherduck-cookbook/tree/main/cloudflare-workers).
- [Postgres endpoint restrictions](https://motherduck.com/docs/sql-reference/postgres-endpoint/).
- [Create](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-create-flight/), [run](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-run-flight/), [exact run](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-get-flight-run/), [history](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-list-flight-runs/) and [logs](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/flights/md-get-flight-logs/).
- [Configuration and credentials](https://motherduck.com/docs/key-tasks/flights/flights-authentication-config-and-secrets/), [Lite Flight limits](https://motherduck.com/docs/concepts/flights/#availability-and-plan-limits) and [pricing](https://motherduck.com/product/pricing/).

The current SQL reference uses `md_list_flight_runs`; the marketing page's `md_flight_runs` name is not treated as a verified alias. Official documentation is reference material, not authorization to provision, deploy, spend or submit feedback.
