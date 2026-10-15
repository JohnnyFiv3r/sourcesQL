# sourcesQL hosted compatibility probe

This Node gateway reuses the MotherDuck Postgres probe in `../motherduck-worker`.
It has one Vercel function and no Python bridge. MotherDuck Flights execute the
fixed synthetic Python jobs; ordinary result, tree and correction requests use
SQL against stored data. This is an interface experiment, not the full MCP app.

Use an adopter-owned Vercel account (Hobby for eligible individual use) and an
adopter-owned MotherDuck account. The owner's test uses their existing Pro team;
the code does not require a Pro-specific function feature. Actual Hobby
qualification is a separate gate. The [local Docker engine](../../docs/docker.md)
is a tested fixture alternative; packaging the Node/MCP workspace in that image
remains separate work.

Preview configuration requires `MOTHERDUCK_HOST`, `MOTHERDUCK_DB`,
`MOTHERDUCK_TOKEN`, and a separate `GATEWAY_TOKEN`. Store credentials through
`vercel env add NAME preview --sensitive` using stdin. Never put values in argv,
source or chat. Flight provisioning and submission are disabled unless
`ALLOW_FLIGHT_PROVISIONING` and `ALLOW_FLIGHT_SUBMISSION` equal `true`.
`FLIGHT_ID` selects the tiny synthetic job; `DEPENDENCY_FLIGHT_ID` selects the
exact-lock dependency job. There are no schedules, provider calls or automatic
submission retries. Each provisioned Flight explicitly uses F4 and 120 seconds.

Deploy with `vercel deploy --target preview`. Verify the reported target:
Vercel may assign a project's first deployment to production even when preview
was requested. No MotherDuck credentials should be configured for production.
Remove any empty production bootstrap after preview testing. Protected previews
need authenticated operator access or a separately approved temporary automation
secret, which must be revoked afterward.

The `lib/gateway.mjs` copy must match `../motherduck-worker/src/gateway.mjs`.
Generate definitions using that probe's `scripts/prepare-definitions.mjs`, then
copy its generated module into `lib/definitions.mjs`. Give isolated experiments
distinct Flight names. The dependency source and pins derive from the engine
lock; they do not upgrade silently to the latest DuckDB client.

The hosted verification scripts in `../motherduck-worker/scripts` read ignored
operator settings under `local/motherduck-probe`. Provisioning never runs a
Flight. Each verification records local intent before one submission, enforces
the operator's finite attempt count, and never retries an uncertain submission.
The tiny test injects a gateway failure after dispatch and recovers by request
ID. Absence from the latest 20 runs never authorizes another submission. This
does not provide a production distributed idempotency gate or a billing cap.

Disable provisioning/submission and remove executable test deployments after
testing. Reconcile usage separately; observed run time is not billed time.
