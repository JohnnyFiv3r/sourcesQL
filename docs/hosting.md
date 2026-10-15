# Hosting options

sourcesQL supports local Docker and a personal hosted layout built from Vercel
and MotherDuck. Each adopter owns their accounts, credentials and stored research.
The hosted application currently serves one configured owner workspace; it is not
a shared multi-user service.

For local installation, start with the [Docker guide](docker.md). For a remote
MCP endpoint, follow [MotherDuck setup](motherduck-backend.md) and
[Vercel setup](vercel.md).

## Hosted architecture

Vercel serves the Node MCP gateway and its self-contained app interface.
MotherDuck stores immutable engine results, source evidence, execution receipts,
durable jobs and versioned application state. On-demand Flights execute Python
research jobs; the gateway returns a pending handle rather than waiting for the
whole job in one HTTP request.

The gateway uses MotherDuck's Postgres endpoint for ordinary interaction. It does
not need a resident Python bridge or native DuckDB client. Reopening results,
reading the research tree, applying corrections and inspecting job status do not
start Python. Database reads and writes can still consume MotherDuck SQL compute.
Importing or restoring typed engine data can require a provider-free validation
Flight before the requested operation continues.

Research permits one active job per owner namespace. Queued jobs resume explicitly;
there is no automatic queue-draining scheduler. Keep the original request and job
IDs when recovering a lost response. An uncertain submission is never blindly
repeated. See [durable jobs](motherduck-backend.md#durable-jobs-and-explicit-resume).

For hosted ChatGPT access, an adopter-owned OAuth provider handles login and token
issuance. The gateway verifies the configured owner's identity and workspace
scope. The documented setup uses Auth0; Vercel account login and Deployment
Protection are separate from application authorization. See
[OAuth configuration](vercel.md#optional-oauth-for-chatgpt).

Corrections are append-only application records attached to stable research,
row and column identities. Saved result versions and application revisions
preserve research history independently of MotherDuck's database snapshot
retention. A refresh proposal changes the effective parent view only after an
explicit review decision.

## Qualified scope and current limits

The gateway-to-Postgres-to-Flight lifecycle has been exercised, including exact
run inspection, controlled lost-response recovery and stored-result reopening
without another Flight. The installed Python 3.12 engine and Linux worker
protections have been exercised in native ARM64 Docker and x86-64 MotherDuck
runtimes. See [runtime qualification](python-linux-qualification.md).

Deployed Vercel checks cover public OAuth discovery, anonymous refusal,
authenticated MCP access and saved-result reads. ChatGPT OAuth, app rendering,
reopening after reload, durable corrections, tree/Back navigation, a small live
Exa expansion and a fixture refresh/review have also been exercised. These are
bounded integration checks, not evidence of exhaustive search coverage or live
refresh quality. Claude rendering, fresh-adopter onboarding and Vercel Hobby
plan limits remain separate qualification work. See [current status](../STATUS.md).

Fixture mode remains the default. The currently qualified hosted live policy is
[`exa-search.v1`](hosted-flight.md#opt-in-exa-search): Exa Auto, retained excerpts,
at most two searches and ten candidate pages per job, with no extra fetches or
model calls. It does not provide broad research fanout or hosted semantic
extraction. Private hosted profiles and hosted explain are unavailable. Larger
profiles require their own reviewed configuration, credentials, budgets and
qualification; additional jobs must not be used to evade a configured limit.

Cloudflare is an alternative gateway direction. MotherDuck publishes a
[Workers/Postgres recipe](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/postgres-endpoint/cloudflare-workers/),
but sourcesQL has not qualified a deployed Cloudflare path. Do not infer full
Flight lifecycle compatibility from that recipe alone.

## Cost controls

Use each platform's current account allowances and billing controls when choosing
a plan. Check [MotherDuck pricing](https://motherduck.com/product/pricing/),
[Flight plan limits](https://motherduck.com/docs/concepts/flights/#availability-and-plan-limits)
and [Vercel plans](https://vercel.com/docs/plans). Eligible personal,
non-commercial users can choose their own Vercel Hobby project; the configuration
requires no Pro-only feature. MotherDuck, search and model usage are separate
costs. Included capacity is not a guarantee of a free deployment.

The default reviewed Flight uses F4 with a 120-second runtime limit. The gateway
conservatively reserves up to 600 seconds of execution per owner namespace per
UTC day by default. That reserve is an application limit, not an account-wide
billing cap. Other applications, database compute and provider usage are outside
it. An account with a payment method may incur overage; no-card exhaustion
behavior has not been qualified.

Measure complete research jobs before predicting capacity. Distinguish HTTP
latency, Flight run intervals, billed compute, database usage and provider charges.
A synthetic test or provider estimate does not establish final billing or the
number of real research jobs an allowance will support.

## Runtime and dispatch boundaries

The Flight bundle uses exact dependencies and an offline wheel installer. The
qualified runtime uses Python 3.12; see [Flight packaging](hosted-flight.md).
Native DuckDB persists engine data, while a certificate-verified Postgres
connection inspects Flight lifecycle metadata. Do not assume the pinned native
DuckDB client exposes the same Flight-management functions.

Before dispatch the backend checks the reviewed Flight's size, runtime, owner
configuration and source/dependency fingerprints. The platform run function
selects the current Flight version without an atomic version-pin option, so an
operator update can race preflight. Keep the reviewed Flight unchanged during
dispatch. Version checks and cancellation protect application publication but
cannot guarantee that no compute was billed.

The [setup command](motherduck-backend.md#build-the-reviewed-flight) provisions an
on-demand Flight with submission disabled and writes token-free local settings.
It submits no research job. A lost creation response requires reconciliation;
changing output paths is not a safe reason to create another Flight.
