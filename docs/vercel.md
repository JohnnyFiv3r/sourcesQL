# Vercel personal hosting

Vercel hosts the Node MCP gateway and its static interface. MotherDuck stores
research results, jobs and correction history; on-demand Flights run Python.
The gateway is stateless and does not write its deployment filesystem or start
a local Python process. Local [Docker](docker.md) remains a separate adoption
path for an individual who prefers local storage or larger archive transfers.

Use one deployment and one stable owner principal. Every client with its bearer
token can access that owner's workspace. This is not a shared multi-user service.

## Project and build

Set the Vercel project root to **`apps/research`**, framework preset **Other**,
Node.js **24.x**, and use the checked-in `vercel.json`. It sets:

| Setting | Value |
| --- | --- |
| Install | `npm ci` |
| Build | `npm run build:vercel` |
| Static output | `dist` |
| Function | `api/index.ts`, 60-second maximum |
| Region | `iad1` |
| MCP / health | `/mcp` / `/health` |

Node 24 is a [supported Vercel runtime](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
The 60-second function limit fits the documented non-Fluid Hobby maximum too;
Python work continues in MotherDuck rather than holding an HTTP request open.
Actual plan and Fluid limits are listed in [Vercel's function limits](https://vercel.com/docs/functions/limitations).

`build:vercel` first typechecks and builds the two self-contained HTML pages,
then packages their current immutable MCP resource and the declared synthetic
fixture under `.vercel-assets`. The function includes those read-only files via
`includeFiles`, following [Vercel's file packaging guidance](https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions).
The upload allowlist in `.vercelignore` excludes local environment files,
credentials, state, test artifacts and operator UI archives. It includes only
the public code and build inputs. Alongside the current resource, the build
explicitly packages the reviewed public bundles listed in
`scripts/build-vercel.ts` from `ui-history`. Each historical bundle must match
its declared SHA-256 and resource URI. The build does not discover arbitrary
`.ui-builds` archives or silently include an operator's old UI files. Retained
versions keep saved ChatGPT messages readable across deployments; an unlisted
version remains unavailable. Add each released version to the explicit list
before replacing a deployment that has served it.

## Preview configuration

Configure secrets in the project's **Preview** environment. Do not put values in
source control, browser URLs, deployment arguments or public build artifacts.

| Variable | Required value |
| --- | --- |
| `RESEARCH_AUTH_MODE` | `protected` |
| `SOURCESQL_BACKEND` | `motherduck` |
| `SOURCESQL_PRINCIPAL` | An explicit stable owner identifier |
| `RESEARCH_BEARER_TOKEN` | A randomly generated secret of at least 32 characters |
| `RESEARCH_PUBLIC_ORIGIN` | Optional explicit canonical HTTPS origin, e.g. `https://sourcesql.example.com` |
| `MOTHERDUCK_TOKEN` | That owner's MotherDuck credential |
| `MOTHERDUCK_DB` / `MOTHERDUCK_HOST` | Existing database and its allowlisted regional Postgres endpoint |
| `SOURCESQL_FLIGHT_ID` | Reviewed on-demand Flight UUID |
| `SOURCESQL_FLIGHT_SOURCE_SHA256` | Reviewed manifest's `flight_source_sha256` |
| `SOURCESQL_FLIGHT_REQUIREMENTS_SHA256` | Reviewed manifest's `requirements_sha256` |
| `SOURCESQL_ALLOW_FLIGHT_SUBMISSION` | `0` initially; `1` deliberately enables bounded execution |
| `SOURCESQL_FLIGHT_MAX_RUNTIME_SEC` | Default `120`, matching the reviewed Flight |
| `SOURCESQL_FLIGHT_DAILY_SECONDS` | Default `600`, conservatively reserved runtime per owner/day |

The platform-provided `VERCEL_URL` automatically allows that exact deployment
hostname. `RESEARCH_PUBLIC_ORIGIN` adds one explicit HTTPS origin for a custom
domain or stable alias; paths, wildcard hosts and custom ports are rejected.
Incoming forwarded-host headers cannot add an allowed hostname. Browser requests
must use the exact configured origin. Server MCP clients may omit `Origin`.

Leave `SOURCESQL_PROFILES_FILE` unset and both `SOURCESQL_ALLOW_PRIVATE` and
`RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE` disabled. See
[MotherDuck setup](motherduck-backend.md) for provisioning and the
[Flight execution policy](hosted-flight.md) for opt-in Exa configuration. An Exa
key alone does not enable live calls; the coordinator and reviewed Flight must
share the approved public policy and bound secret. Keep Exa credentials in
MotherDuck Flight secrets, outside the Vercel frontend.

Keep `SOURCESQL_ALLOW_PRODUCTION` unset. The serverless gateway refuses
`VERCEL_ENV=production` unless an operator explicitly sets it to `1`; the initial
rollout is preview-only. Preview credentials should not be copied into the
Production environment. A production rollout is a separate operator decision.

## Connecting and operating

Use the preview's `/mcp` endpoint with `Authorization: Bearer <your secret>`.
The browser interface accepts the same owner token through a labelled inline
password form. It clears the field on submission and retains the credential only
in that page's connection, without browser storage or URL parameters.
`/health` and the interface shell are public and do not initialize
the database or disclose the configured principal. Host, origin, request-size
and bearer checks run before a protected request initializes MotherDuck.

Vercel Deployment Protection and the application bearer are separate checks.
Keep Deployment Protection enabled for the initial preview; an external client
must satisfy that protection as well as the bearer check. A Vercel-protected
preview is not automatically a publicly connectable MCP endpoint. ChatGPT cannot
supply this custom static bearer or satisfy Vercel's browser sign-in gate. Use
the optional OAuth configuration below for hosted ChatGPT access. Deployment and
passing local tests do not qualify an external host's authentication or rendering.

### Optional OAuth for ChatGPT

The gateway verifies access tokens; an operator-owned OAuth provider performs
login and issues them. Vercel Deployment Protection and Sign in with Vercel do
not automatically supply authorization for this custom MCP resource. Each adopter
retains their own deployment, provider and fixed owner identity. Local Docker and
direct MCP clients can continue using the existing owner bearer without OAuth.

Set all four variables together, plus a stable `RESEARCH_PUBLIC_ORIGIN`:

| Variable | Value |
| --- | --- |
| `SOURCESQL_OAUTH_ISSUER` | Exact provider issuer, including its trailing slash when present |
| `SOURCESQL_OAUTH_AUDIENCE` | Exact `RESEARCH_PUBLIC_ORIGIN` followed by `/mcp` |
| `SOURCESQL_OAUTH_SUBJECT` | The sole owner's immutable application user `sub`, not their email |
| `SOURCESQL_OAUTH_JWKS_URI` | Explicit HTTPS signing-key URL on that issuer's origin |

Partial configuration fails closed. Verification requires a trusted RS256 or
ES256 signature, issuer, audience, exact owner subject, expiry, any not-before
claim, and the `sourcesql:access` scope. That single scope permits the complete
personal workspace, including queries and corrections; it is not a read-only
grant. A different authenticated user cannot access the configured owner's data.
Denials run before backend initialization. The separate owner bearer remains an
administrative fallback for direct clients and the standalone browser interface.

Public discovery is served at `/.well-known/oauth-protected-resource` and its
`/mcp` suffix. Unauthorized MCP requests advertise that metadata in a Bearer
challenge. All MCP tools carry the OAuth scope in the pinned SDK's supported
`_meta.securitySchemes` compatibility field. No custom authorization server,
password store or token minting is implemented here.

For Auth0, register an RS256 API with the exact MCP URL as its identifier and
permission `sourcesql:access`. Keep user-delegated access limited to the selected
client and disable machine-to-machine access. Enable Auth0's
[Resource Parameter Compatibility Profile and issuer responses](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile).
Use a predefined public client with token endpoint authentication `none`, PKCE
S256, and the exact callback shown by ChatGPT's custom MCP form. Inspect the
selected registration method: Auth0 documents `private_key_jwt` as Enterprise-only,
so do not enable a paid feature merely to import automatic client metadata.
Use features available after the Free trial ends, and do not add a card for this
setup. The Auth0 administrator login is separate from the application's user;
obtain the allowed subject from an actual application login.

In [ChatGPT's Plugins page](https://chatgpt.com/plugins), choose **Add custom MCP
server**, enter the stable `/mcp` URL, select OAuth and the predefined client,
set **Default scopes** to `sourcesql:access`, **Base scopes** to `offline_access`,
and keep **OpenID Connect** disabled for an Auth0 strict third-party client.
Complete login and installation, then use a new
chat and reopen saved research. Refresh the plugin's tool definitions after
metadata changes. The endpoint and discovery must be reachable by ChatGPT's
backend; adjusting Vercel protection is a separate operator access decision.
Keep app authorization enabled when doing so. See
[OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth)
and [connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

For a public personal Preview, assign the reviewed OAuth-configured deployment
one stable alias and add only that alias to Vercel's
[Deployment Protection Exceptions](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/deployment-protection-exceptions).
Exceptions are available on every plan. Other Preview domains can retain Vercel
authentication. An exception exposes every path at that domain, including its
shell and discovery, while the app still authorizes MCP access. It applies to
future deployments assigned that alias too: configure and validate OAuth before
assigning a replacement deployment. Removing the exception restores the project's
Vercel protection for the domain. This does not require a Production promotion.

Auth0's strict third-party client requires a domain-level login connection.
Promoting a connection makes it available to all third-party clients in that
Auth0 tenant; API scope grants remain separate and must stay limited to the
selected client. The owner must deliberately approve that login availability.
The strict client does not support `openid`, `email`, `profile` or OIDC ID tokens.
Its `offline_access` permission enables refresh without requesting those OpenID
scopes. An actual authorization-code exchange establishes initial access;
automatic renewal requires its own check.

### Enable and qualify OAuth renewal

On the intended Auth0 API, enable **Allow Offline Access**. On each intended
public client, enable the **Refresh Token** grant alongside **Authorization
Code**, keep rotation enabled, and configure finite idle and maximum lifetimes.
Request `sourcesql:access offline_access` from the host. The API's delegated
permission remains `sourcesql:access`; keep machine-to-machine access disabled.
The gateway verifies access-token expiry; the host stores and exchanges refresh
tokens. A successful initial login does not establish renewal.

A recommended retained policy is a **7-day idle lifetime** (604800 seconds), a
**30-day maximum lifetime** (2592000 seconds), rotation and a small overlap such
as 3 seconds. Choose these retention limits deliberately: offline access lets the
host renew while the user is away. Keep access-token expiration separate from
refresh-token expiration. See Auth0's [refresh-token issuance](https://auth0.com/docs/secure/tokens/refresh-tokens/get-refresh-tokens),
[rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)
and [finite expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)
instructions.

After enabling refresh, complete consent that explicitly includes offline access.
Existing connections authorized without it may need one setup reconnection;
that reconnection does not qualify renewal. If ChatGPT's saved source OAuth
settings are immutable in its UI, create a corrected temporary registration with
the intended client, callback and scopes. Tool refresh or server changes do not
automatically update the original registration's offline-access setting.
To test, retain the same connection
past access-token expiry, reopen saved research, and confirm both a successful
Auth0 refresh exchange (`sertft`) for the intended client/audience and actual app
rendering. Repeat after the next expiry to check that the host retains the
replacement refresh credential.
Record only safe event metadata and outcomes, with no tokens, headers or browser
storage. A temporary short expiry belongs only to the dedicated test destination
and must be restored after the check.

ChatGPT and Claude each passed two uninterrupted refresh exchanges followed by
new inline apps displaying the saved two rows. ChatGPT's earlier connection with
empty Base scopes failed after expiry and required reconnection; the successful
renewal check used a corrected temporary registration, preserving that failure
as separate history. Test access-token lifetimes were restored afterward, and
both clients saved the 7-day idle/30-day maximum rotating-refresh policy with a
3-second overlap. The checks establish the measured renewal path, not those
long-term expiration boundaries. See the
[client qualification record](clients.md#oauth-renewal-checks) for scope.

The original ChatGPT connection was subsequently recreated deliberately with its
existing endpoint, audience and public client. Offline consent and fresh
saved-result rendering passed while its API access-token lifetime remained
unchanged. This replacement's expiry cycles were not measured; the two-cycle
renewal evidence belongs to the temporary Hobby registrations.

Google login using Auth0's developer keys is suitable for the initial test only.
For continued adoption, configure an adopter-owned Google OAuth client or an
Auth0 database login. Developer keys and a trial-only feature are not a durable
production default; do not add a paid subscription to complete this setup.

Each HTTP request uses a stateless JSON MCP transport. Keep the query's original
`request_id` and the returned job ID. Poll `sourcesql_job_status`; start a queued
job explicitly with `sourcesql_start_job` after capacity is available. There is
no background queue-draining cron. A lost response or unknown submission must
be reconciled using the same IDs. Imports can first return a materialization
job: after it completes, repeat the original operation with the same request ID
or bundle to resume.

Requests and tool responses are capped at **4 MiB**, below Vercel's documented
[4.5 MB function payload limit](https://vercel.com/docs/errors/function_payload_too_large).
Page large results or use local Docker for larger archives. A response can
exceed the cap after a mutation has committed. Its error explicitly preserves
that uncertainty: inspect/retry the same mutation, request or job IDs; never
create a new query UUID merely to recover that response.

## Cost and adoption

Individual adopters create their own project. No Pro-only feature is required
by this configuration.
[Vercel Hobby](https://vercel.com/docs/plans/hobby) is for personal,
non-commercial use, so an adopter must choose a plan appropriate to their use.
This does not make MotherDuck, Exa or model usage free. Use the independent
Flight runtime reservations, provider grants and platform billing controls.
An application cap does not guarantee MotherDuck will reject paid usage on an
account with a payment method.

Local auth, stateless HTTP, durable-state reopening, response recovery and asset
packaging have dedicated offline tests in `tests/vercel.test.ts`. A local build
or passing tests is not evidence of an actual deployed host or external MCP
client qualification; retain separate deployment and integration receipts.

## Qualification and maintenance

The deployed path has passed public OAuth discovery, anonymous MCP refusal,
authenticated initialization, scoped-tool discovery and saved-result reads.
ChatGPT completed OAuth and rendered saved research with `open_research`,
including after reload with custom-app CSP enforcement enabled. Later bounded
checks covered durable corrections, tree/Back navigation, a small live Exa
expansion and fixture refresh acceptance. Separate clean Hobby checks qualified
setup, both hosts' saved-table OAuth rendering and two automatic renewal cycles
per host. These do not establish live semantic quality, fresh-account signup,
long-term token expiration, the full client lifecycle or an adversarial CSP audit.
See [current status](../STATUS.md) for the qualification boundaries.

The qualified hosted live policy is currently `exa-search.v1`: Exa Auto and
retained excerpts, at most two searches and ten candidate pages per job, with no
additional fetches or model calls. Fixture remains the default. See
[Flight policy](hosted-flight.md#opt-in-exa-search) before enabling a live profile.

Refresh the installed client's tool definitions after changing instructions,
tool metadata or rendering resources. Reopen saved research to load a newly
registered UI; existing messages can retain their immutable version. Ordinary
saved-result checks should not submit new Flights or provider calls.

The personal-cloud adoption path connects directly to the HTTPS MCP endpoint.
No plugin ZIP is needed for its tools or interactive research app. Maintain the
existing connection and stable URL when deploying updates; a separately packaged
wrapper is a separate plugin entry and is not part of this setup. Verify host
branding separately from table rendering and connection health.
