# Project status

sourcesQL includes a research SQL
engine, an MCP App, local Docker packaging and an optional Vercel/MotherDuck
backend. **0.1.2 is published on PyPI**, including self-contained personal-cloud
setup, the updated app branding and adoption fixes. Source and local Docker
installation remain available.

## Continuation and manual updates: 0.2.0 candidate

The current source and personal Preview endpoint include compact checkpoints and
manual evidence-backed updates. **PyPI remains at 0.1.2**; the 0.2.0 wheel and source
distribution are prepared and qualified locally.

- Checkpoints retain canonical selections, query provenance, exact amendment and
  source pins, pending identities and remaining work within 24 KiB. Inspection is
  read-only; missing, foreign and stale dependencies block continuation.
- Manual checks separate existing findings from discovery. Canonical fresh source
  versions support proposals; missing hits never delete findings. Accept/Keep
  choices can change before publication, with every decision retained. Publication
  creates an immutable successor preserving the original observations/amendments.
- The initial update path accepts complete tables up to 100 rows/200 KB. Explicit
  materialization preserves accepted row IDs for further SQL and can consume a
  provider-free hosted Flight. Checkpoint inspection and publication do not start one.
- Durable retries compare JSON values independent of key ordering. A real hosted
  retry exposed the earlier ordering bug; seven sorted-backend regressions fail
  on the prior implementation and pass with the correction, including lost
  post-commit acknowledgments without an additional write.

The final app passes **289 tests on macOS and Linux**. Linux passes **477 Python
and Flight tests**, with four macOS-only skips; the root macOS Python suite passes
**360**, with 44 Linux-only skips. The wheel and source distribution each pass
installed qualification outside the checkout on Python **3.12, 3.13 and 3.14**.
Package audits exclude private documents, credentials and operator state.

An actual Python/SQL-worker fixture run passes new observations, source evidence,
manual review, successor publication, repeatable materialization and subsequent
SQL. The restricted Docker runtime passes compiled MCP checks with no networking,
a read-only filesystem and a nonroot user. Local browser checks pass checkpoint
saving, changing review choices, inspecting additions, publication, original-value
preservation and research-tree reopening. These checks measure fixture behavior.

The authenticated Preview endpoint passes checkpoint recovery with the **original
saved ID**, fresh-connection continuation, durable manual-request reopening and
explicit cancellation. Original fixture observations and amendments stay unchanged.
This uses stored data only, with **zero new Flights or provider calls**. The current
resource is `ui://sourcesql/research-9b396ddfaead18f3.html`; eight previous immutable
resources remain available to older chat components.

Actual new ChatGPT/Claude update-workflow rendering remains a separate check.
The private ChatGPT **1.0.3 ZIP and PNG are prepared**, with both icon fields pointing
to the supplied image; no reinstall or successful ChatGPT icon display is claimed.
After reconnecting, refresh the host's tool definitions before using the new controls.

Remaining adoption gates are recorded in [adoption verification](docs/adoption-verification.md):
new-account Hobby onboarding, Vercel Brave/Serper dispatch, and unqualified client
lifecycle paths. Both provider test namespaces have reached their existing daily
120-second/$0.01 reservations. Protected test Previews need an explicitly approved
private access path; limits and deployment protection have not been loosened.

See [the continuation guide](docs/continuation.md) for supported scopes and recovery.

## Working paths

- Research SQL with typed immutable results, retained sources and execution receipts.
- Fixture mode with no search or model credentials; opt-in live provider profiles.
- Local HTTP and stdio MCP transports, an interactive research table, separate
  corrections, linked investigations, explicit refresh review and bundle export/restore.
- Durable MotherDuck results and jobs, bounded on-demand Python Flights, cancellation
  and lost-response recovery. One active job per owner namespace; queued jobs resume explicitly.
- An owner-authenticated ChatGPT app with OAuth and enforced CSP. Saved-table
  rendering, corrections across reload, tree/Back navigation, a small live Auto
  expansion and fixture-based refresh review have been exercised. The current
  private plugin package is 1.0.2; saved rendering was rechecked after tool refresh.
- Claude rendered saved hosted research with an encrypted owner bearer header;
  child/Back navigation and synthetic corrections persisted across reload.
- Cursor rendered and paged a nine-row local Docker fixture. In that tested
  setup, host-agent messaging was unavailable and refresh remained disabled.

## Checks at initial publication

The macOS/Python 3.12 suite passes **406 tests**, with **44 Linux-only skips**.
The app builds and passes **172 tests** on macOS and native ARM64 Linux Docker.
Docker passes **446 Python tests**, with **four macOS-only skips**, plus actual
HTTP/MCP, corrections, export, restart persistence and stdio checks. The README's
fixture SQL example runs against the real engine without provider calls. These
checks made no live search or model calls. See the Docker and runtime guides.

These results establish the tested execution and control paths. They do not
measure broad search recall, live semantic accuracy, a complete research workload
or comparative product quality.

## Adoption release checks

Version **0.1.2** changes dark-mode surfaces to neutral charcoal and gray, keeping
#2CD8B6 accents and the supplied logo. Ten targeted app-resource/Vercel checks
and six packaging checks pass. The Docker runtime and authenticated Preview
endpoint serve the new resource and retain older chat resources without new
research execution. Its distributions passed installed qualification on
Linux/Python 3.12, 3.13 and 3.14 before publication; public PyPI digests match
those workflow artifacts. This style patch did not repeat the full engine suite.


The published 0.1.0 wheel and source distribution passed clean installed checks
outside the checkout on macOS/Python 3.13 and Linux/Python **3.12, 3.13 and 3.14**:
fixture execution, saved-result reopening, bundle restore, packaged setup
templates and repeatable personal-cloud planning. Linux installed qualification
completed before publishing through the `pypi` trusted-publisher environment.

The **0.1.1** distributions also passed installed qualification on Linux/Python
**3.12, 3.13 and 3.14** before publication. The public PyPI digests match the
locally audited artifacts exactly. The app passes **197 tests** on Node 24 on
macOS and Linux Docker; **85 packaging and Flight tests** pass. The final Docker
runtime served current and retained UI resources from fresh storage with a
read-only filesystem, no network and a non-root user.

This patch preserves the durable queued job handle when an automatic start is
blocked by the daily allowance. It also includes required setup templates and
verified historical app resources in Docker, and documents persistent MotherDuck
token rotation. The app uses **#2CD8B6** accents and the supplied rounded footer
logo. Its new resource passed authenticated Preview reads and actual ChatGPT
rendering with saved synthetic data, without a new query or Flight.

The adoption source checks passed **435 Python tests** with **44 Linux-only skips**,
**192 app tests** on Node 24 and **35 setup tests**. Setup tests cover account and
alias ownership, encrypted Preview configuration, uncertain resource creation,
explicit failed-deployment retry, and repeated application. These use controlled
account responses; they do not establish fresh-account provisioning.

Hosted Brave and Serper share the existing Python adapters and now have gateway,
Flight-policy and secret-binding paths. Controlled checks cover provider selection,
request affordability, durable reservations and duplicate-submission recovery.
Credentialed checks then ran one Brave request and one Serper request in actual
MotherDuck Flights, retaining three candidates each. Their control gateway was
local MCP; the Vercel provider path was not exercised by those receipts.

Installed personal-cloud setup also passed repeated application against the
existing operator account/project, fixture execution and fresh-connection
saved-result reopening without another Flight. This does not establish a
brand-new account or Vercel Hobby onboarding path.

The private ChatGPT plugin package was uploaded as **1.0.2** with the supplied
logo. After a transient component-opening failure, Refresh tools and reopening
the same saved synthetic result restored actual ChatGPT rendering without a SQL
rerun. Claude passed hosted rendering, research-tree child/Back navigation and a
500-to-501 synthetic correction that survived reload before restoration to 500.
Cursor passed local Docker rendering and paging; the tested host did not expose
agent messaging, so refresh was disabled. These are bounded host checks, not full
Claude/Cursor lifecycle qualification.

## Current limits

The earlier qualified hosted Exa run used `exa-search.v1`: Auto search excerpts,
**two queries and ten candidate pages per job**, with no additional fetches or
model calls. A reviewed `exa-research.v2` Flight is now provisioned, but a new live
Vercel Exa check has not run: the configured **600-second daily Flight reserve**
was reached. That is an application reservation, not MotherDuck's account-wide
free allowance. Do not treat provisioning as live provider qualification.

Broad discovery instructions ask for at least six diverse queries. An agent must
report when the configured profile cannot accommodate that coverage; it must not
silently shrink the task or bypass execution limits. Broad fanout, hosted
semantic processing and live research quality remain unqualified. Brave/Serper
receipts cover bounded real Flight execution through a local control gateway,
not the equivalent Vercel path.

Guided setup supports one configured owner; account creation, OAuth registration
and the exact-domain protection exception remain manual. This is not a shared
multi-tenant service. Fresh-account Hobby onboarding, the full Claude/Cursor
research lifecycle, broad live research quality and Vercel provider coverage
remain open qualification work.
Application allowances are finite reservations, not account-wide provider billing
hard stops or a guarantee of free hosting.

## Setup and references

The [roadmap](docs/roadmap.md) completes adoption qualification before compact
research checkpoints and manual evidence-backed updates. Those two product
capabilities are planned work; current snapshot and refresh contracts still apply.

Start with the [README](README.md), [Docker guide](docs/docker.md),
[provider configuration](docs/providers.md) or [personal hosting guide](docs/vercel.md).
The [SQL reference](docs/language.md), [qualification notes](docs/qualification.md)
and [runtime qualification](docs/python-linux-qualification.md) describe execution
contracts and the scope of the recorded checks.
