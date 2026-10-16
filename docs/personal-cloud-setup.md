# Set up a personal cloud workspace

The setup command prepares and provisions one personal Vercel gateway and one
bounded, on-demand MotherDuck Flight. It starts from the installed Python
package; a Git checkout is not required. Each adopter owns their accounts,
credentials and research. The same workspace can be used from several MCP clients
as the configured sole owner.

This is an account setup tool, not a hosted service signup. Account creation,
OAuth registration, login consent and any Vercel protection exception remain
visible account decisions. Setup does not add a payment method, change a plan,
configure a schedule, promote the research app to Production or execute live searches.
A new Vercel project needs a static Production placeholder before the app can
use Preview; this requires an explicit option in the reviewed plan.

`enable_execution` controls all gateway submissions. With the default fixture
provider, only fixtures run. With a deliberately selected live provider, enabling
execution also makes that provider available under its reviewed usage policy.
This choice is bound to the reviewed plan; changing it requires a new plan.

## Prerequisites

- Python 3.12–3.14 with `sourcesql` installed; see [package installation](package.md).
- Node.js **24** and npm on `PATH`. The gateway deployment also pins Node 24.
- Your own MotherDuck account and database permission, with an operator-created
  **Read/Write API/access token** suitable for a persistent gateway. Choose its
  expiration and rotation policy; do not copy an ephemeral CLI-login credential
  into Vercel. Make it available as `MOTHERDUCK_TOKEN` in the setup environment.
- Your own Vercel account and `VERCEL_TOKEN` with access to the intended account.
  Use a Hobby account when eligible for personal, non-commercial work. An existing
  Pro account also works; setup never upgrades or chooses a subscription.
- An OAuth issuer, API audience and public PKCE client. The supported gateway
  accepts one immutable owner subject and the `sourcesql:access` scope.
  [Configure OAuth](vercel.md#optional-oauth-for-chatgpt) before provisioning.

Begin with `fixture`; no search or model API key is needed for that path.
Exa, Brave and Serper credentials are only needed when choosing a live provider.
MotherDuck SQL queries, storage and Flights are separate usage; local application limits do not prove a billing hard stop.

## MotherDuck credentials for a persistent gateway

Create a named API/access token in MotherDuck's account settings using its
[access-token instructions](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/authenticating-to-motherduck/#authentication-using-an-access-token).
Use the owner account and database permissions intended for this workspace;
a Read Scaling token cannot provide the required writes. Choose an appropriate
expiry and plan rotation before it expires. A personal operator token is enough;
this setup does not require buying a service-account feature.

`motherduck login` and a successful `motherduck status` are useful for an
interactive provisioning session. They do not establish that the cached login
credential is suitable for an unattended deployment. The lower-level
`hosted/setup.mjs --use-local-login` option is for provisioning only. Configure the
persistent gateway's encrypted `MOTHERDUCK_TOKEN` separately using the named
API/access token. Never embed either token in Flight source, app files or a URL.

To rotate an existing gateway credential:

1. Create the replacement token for the same intended account and database, then
   update the private local credential input.
2. Replace **only** `MOTHERDUCK_TOKEN` in the existing Vercel project's encrypted
   **Preview** environment. Keep Production credentials separate.
3. Redeploy the same reviewed app and retain its stable alias, OAuth settings,
   Flight ID and fingerprints. An environment edit does not update an already
   deployed function. No new Flight or research execution is needed.
4. Verify authenticated saved-result reads through the replacement deployment.
   Revoke the old token after verifying the replacement and settling in-flight
   work that may still use it.

Do not delete setup receipts or rerun provisioning to rotate a credential. A
completed setup's ordinary resume does not rotate already-provisioned secrets.
If expiry causes a failed query or correction response, restore authentication
and inspect the **same** job, request or mutation IDs and canonical revision
before retrying. An authentication error does not prove that an earlier operation
was absent or rolled back. Do not create a fresh ID to bypass an uncertain result.

## Prepare the destination

Create a token-free JSON configuration outside source control, for example
`~/.config/sourcesql/personal.json`:

```json
{
  "project": "my-sourcesql",
  "account_id": "your_hobby_workspace_team_id",
  "team_id": "your_hobby_workspace_team_id",
  "alias": "my-sourcesql-personal.vercel.app",
  "database": "sourcesql_personal",
  "principal": "my-stable-owner-id",
  "create_database": true,
  "allow_static_bootstrap": true,
  "enable_execution": false,
  "daily_flight_seconds": 600,
  "oauth": {
    "issuer": "https://your-tenant.auth0.com/",
    "subject": "auth0|your-immutable-application-user-id",
    "jwks_uri": "https://your-tenant.auth0.com/.well-known/jwks.json"
  },
  "provider": { "name": "fixture" }
}
```

Choose the intended workspace in Vercel and use its exact team ID for both
`account_id` and `team_id`. Vercel represents modern personal workspaces as teams;
select the eligible Hobby workspace rather than your login's user ID. A legacy
user record can report Hobby while unscoped writes route to a default Pro team.
Setup refuses that ambiguous personal scope before looking up or creating a
project. It never switches teams or upgrades a plan to continue.

A legacy personal account without a default team can still use its own account
ID and omit `team_id`. Setup checks the authenticated destination and every
recovered project's owning account. An existing project is used only if this configuration explicitly adds
`"adopt_existing_project": true`; that authorizes changes to its Preview
configuration and alias. Prefer a dedicated project.

Vercel makes a new project's [first deployment Production](https://vercel.com/docs/deployments/environments),
even when Preview is requested. `allow_static_bootstrap: true` permits setup to
fill that slot with one static HTML file, with no functions, database access or
research data. Setup waits for it to be Ready before provisioning backend
resources, encrypting Preview credentials or uploading the app. The plan binds
the placeholder's exact bytes. An interrupted submission recovers the same
attempt; an uncertain match or failed build stops for inspection.

The option defaults to false. Without it, a project that has no Production
deployment stops before backend setup or app upload. An existing project with a
Production deployment does not need another placeholder. The research app still
uses Preview, and the configured alias is assigned only after its Preview target
and setup metadata are verified. The placeholder adds no paid feature or Flight.

The alias must be an explicit `*.vercel.app` hostname. The OAuth API audience must
be `https://<alias>/mcp`. Keep the principal stable: changing it creates a different
research namespace. `subject` is the identity from an actual application login,
not an email address or the OAuth administrator account.

For an EU MotherDuck account, add:

```json
"motherduck_host": "pg.eu-central-1-aws.motherduck.com"
```

The default host is `pg.us-east-1-aws.motherduck.com`. Keep credentials in an
existing secret manager or a private shell environment; never put key values in
this JSON, command arguments, a repository or chat.

## Keep credentials in one private file

For a source checkout, use the ignored `local/credentials/.env` for all setup
keys. There is no need for one file per provider:

```dotenv
VERCEL_TOKEN=your-private-vercel-token
MOTHERDUCK_TOKEN=your-private-motherduck-token
```

Those two credentials are enough for fixture provisioning. Add `EXA_API_KEY`,
`BRAVE_API_KEY` or `SERPER_API_KEY` only for the live provider you choose. Create
this file in an editor or secret manager, keep its directory private, and set
`chmod 600 local/credentials/.env`.
Pass its path with `--env-file local/credentials/.env` on `apply` and `verify`.
The CLI uses Node's native dotenv loader; key values are not shell commands,
arguments or setup output. A symlink or a file readable by other users is refused.

An installed adopter can use the same multi-key convention anywhere private,
for example `~/.config/sourcesql/credentials.env`. The filename is not special.
Existing environment variables and existing provider-specific dotenv files
remain supported; inherited environment values take precedence over the file.
Keep MotherDuck Flight secrets as the runtime provider mechanism. The setup file
is local input and never becomes an uploaded source asset or public state.

## Review a concrete plan

Planning requires no account credentials. It prepares local artifacts and may
download the exact public wheel; it does not provision cloud resources. For a
local preflight, keep `enable_execution` false and use an unapplied workspace
such as `~/.config/sourcesql/cloud/preflight`.

Before preparing the plan you intend to apply, choose whether to qualify one
fixture job. If that execution is approved, keep `provider.name` as `fixture`
and set `enable_execution` true with the agreed daily reservation. Otherwise,
leave it false for connection checks only. Use a separate workspace when the
configuration changes; keep the preflight receipts rather than editing its
saved plan.

```sh
sourcesql setup personal-cloud plan \
  --config ~/.config/sourcesql/personal.json \
  --workspace ~/.config/sourcesql/cloud/my-sourcesql
```

Planning materializes the package's reviewed public templates and prepares the
Flight locally. It downloads only the exact installed sourcesQL wheel from PyPI,
verifies the published SHA-256, then checks its source and runtime requirements.
For an unpublished build or offline preparation, pass `--wheel /path/to/the-current.whl`.
Neither path contacts your cloud accounts or runs research. An unpublished
version requires the explicit matching wheel until that version is on PyPI.

Read `plan.json`, including the destination, exact public file hashes, Flight
fingerprints, mutations, daily reservation and manual steps. The output includes
`plan_sha256`. No credential value is printed. Preparation will stop if the
exact wheel is unavailable, Node 24 is missing or reviewed inputs differ.

Keep this workspace private. It contains plan/state receipts; applying the plan
also saves an owner fallback credential in `owner-secret.json`, with owner-only
permissions. An explicitly provided `RESEARCH_BEARER_TOKEN` is persisted once
as the owner fallback. A conflicting value on resume or verification is refused before
account access; rotate deployed credentials deliberately outside a setup resume.
The deployment uploader includes only declared app build inputs; this directory,
provider keys and setup configuration are never uploaded as app files.

## Apply and resume

After reviewing the planned resources, provide `VERCEL_TOKEN` and
`MOTHERDUCK_TOKEN` through the private environment file or process environment:

```sh
sourcesql setup personal-cloud apply \
  --workspace ~/.config/sourcesql/cloud/my-sourcesql \
  --approve-plan THE_SHA256_FROM_PLAN \
  --env-file local/credentials/.env
```

Setup checks the intended account, creates or recovers the named Vercel project,
completes an explicitly approved static bootstrap when needed, installs locked
local Node dependencies, and provisions one unscheduled F4 Flight with
a 120-second runtime limit, and encrypts only Preview environment variables. It
uploads reviewed public files and assigns the exact alias when the deployment is
Ready. Provider credentials stay in MotherDuck Flight secrets. The database
credential and generated owner bearer are encrypted Vercel Preview variables;
neither is placed in the frontend or source upload.

Applying a plan provisions these resources even when `enable_execution` is false.
It does not start a Flight. MotherDuck SQL, storage and Vercel usage remain
separate from research execution and provider charges.

A build can still be pending when the command returns. Repeat the same command
and approved digest to inspect it and finish alias assignment. A normal resume
reuses the project, Flight, environment and deployment. Changes to the owner,
destination, public sources, Flight or approved policy—including
`enable_execution`—invalidate the plan. Use a separate workspace and review a new
plan for an intentional change; inspect existing resources before authorizing
more provisioning.

```sh
sourcesql setup personal-cloud status \
  --workspace ~/.config/sourcesql/cloud/my-sourcesql
```

`ERROR` and `CANCELED` are terminal deployment states. Setup reports the failed
ID and stops; repeated ordinary `apply` does not create another build. Inspect
its build error or cancellation first. To deliberately submit one replacement
using the same reviewed sources and destination, repeat `apply` with
`--retry-deployment THE_FAILED_DEPLOYMENT_ID`. The saved state retains the old
ID/status and gives the replacement its own attempt marker. A still-building
deployment cannot be replaced through this flag. If the replacement's creation
response is lost, resume ordinary `apply`; setup searches that exact attempt
rather than retrying the failed ID again.

If a deployment creation response is lost, setup looks for exactly one deployment
with this plan's metadata. No match or multiple matches requires inspection; it
will not submit a replacement. A project creation that remains uncertain also
stops for inspection. If the named project exists, inspect its account/name in
Vercel and explicitly pass `--recover-project THE_OBSERVED_PROJECT_ID` with the
same approved plan. Setup will accept only that observed ID in the planned
account and with the planned name; it will not silently adopt a same-name project.
An existing alias attached to another project is refused rather than reassigned.

A Flight login/network error before creation leaves a `prepared` receipt with
an explicit false creation barrier and no Flight name or ID. Repeating the same
approved `apply` safely retries that preparation after configuration checks.
Once the `creating` barrier and attempted name are saved, missing responses stay
uncertain and cannot take this retry path. Legacy receipts without the explicit
barrier remain fenced.

A lost Flight creation response leaves `flight.json` with the attempted name.
Find that exact Flight in MotherDuck's account UI or CLI. Then reconcile its UUID:

```sh
sourcesql setup personal-cloud apply \
  --workspace ~/.config/sourcesql/cloud/my-sourcesql \
  --approve-plan THE_SHA256_FROM_PLAN \
  --recover-flight THE_OBSERVED_FLIGHT_UUID
```

Recovery verifies the saved name, owner/database configuration, source and
dependency hashes, bound secret names, F4 size, runtime and lack of schedule before
saving the UUID. It creates no replacement Flight. Do not delete a receipt to
bypass uncertainty. An `apply.lock` left by an interrupted process requires
checking that process and the saved resource intents before removing the lock.

## Connect and verify

Keep Vercel Deployment Protection on while configuring the app. For a remote
chat client, review an exception for **only the exact configured alias**, with
application OAuth still enabled. Setup does not silently expose Preview domains
or change tenant-wide login policy. Other Preview domains can stay protected.

```sh
sourcesql setup personal-cloud verify \
  --workspace ~/.config/sourcesql/cloud/my-sourcesql \
  --approve-plan THE_SHA256_FROM_PLAN
```

This authenticates with the local owner fallback credential, initializes MCP,
checks tools and capabilities, and reopens a previously completed fixture result
when one is available. It starts no Flight or provider calls. With Vercel
protection still enabled, an independently configured
`VERCEL_AUTOMATION_BYPASS_SECRET` can be supplied in the environment for this
operator check; remote chat clients need their own supported access path.

If the applied plan already approved fixture execution, the following command
qualifies Python execution without search or model calls. Keep `provider.name`
as `fixture` for this onboarding check. The reviewed plan must have approved
`enable_execution: true`; adding `--run-fixture` cannot enable a disabled plan. Run:

```sh
sourcesql setup personal-cloud verify \
  --workspace ~/.config/sourcesql/cloud/my-sourcesql \
  --approve-plan THE_SHA256_FROM_PLAN \
  --run-fixture
```

The command saves one fixture request UUID before dispatch. Repeating it recovers
the same request and polls its durable job; retain the workspace after an
interruption rather than starting setup again. Run ordinary `verify` again after
completion to read the saved result through a fresh connection without another
Flight. A queued job
still needs an explicit `sourcesql_start_job` call with its exact ID; there is no
queue-draining scheduler. Pending, failed and unknown states remain visible.

The installed 0.2.1 CLI completed a clean first-attempt plan/apply/resume
from an empty setup workspace in an existing eligible Hobby workspace. Its static
Production placeholder reached Ready before backend provisioning or credential
upload; ordinary resume then completed the app's Preview deployment without
recovery flags or prior receipts. One F4 fixture Flight, bounded by a 120-second
runtime and daily reservation, produced two saved rows. A fresh MCP session and
actual ChatGPT and Claude apps reopened them after separate real OAuth consent.

This qualifies the measured setup and OAuth/rendering path with existing
accounts. Fresh-account signup, token renewal, live-provider research and complete
client interaction remain separate checks. Setup does not verify subscription
eligibility or accept account terms for the adopter. Follow
[client setup and qualification](clients.md) and
[adoption verification](adoption-verification.md) for the exact evidence boundary.

## Choose a live provider

The reviewed Flight supports fixture plus **one** chosen live provider. Substitute
one provider object in the initial configuration; approve its estimated per-job
and daily usage explicitly. Do not split jobs to evade limits.

Exa:

```json
{
  "name": "exa",
  "secret_name": "sourcesql_exa",
  "approved_cost_microusd": 50000,
  "daily_cost_microusd": 1000000
}
```

Brave or Serper (replace `brave` with `serper` in both names):

```json
{
  "name": "brave",
  "secret_name": "sourcesql_brave",
  "request_cost_microusd": 6000,
  "approved_cost_microusd": 50000,
  "daily_cost_microusd": 1000000
}
```

`6000` is an illustrative operator estimate, not a quoted provider price. Choose
an estimate appropriate to your account and API request. Setup requires
`EXA_API_KEY`, `BRAVE_API_KEY` or `SERPER_API_KEY` in its environment only when
creating the chosen Flight secret. For an existing secret, set `reuse_secret` to
`true` after inspecting its name and ownership. Existing values are not read or
overwritten; their validity needs a separately bounded live check.

The setup process makes no provider requests. It binds the selected secret and
policy to both gateway and Flight. See [hosted provider limits](providers-hosted.md)
for the implemented ceilings, estimated usage accounting and qualification
boundaries. Model inference and hosted private profiles are separate features.
