# Project status

sourcesQL includes a research SQL engine, an MCP App, local Docker packaging
and optional Vercel/MotherDuck hosting. **0.2.0** adds compact checkpoints and
manual evidence-backed updates. See the [release notes](docs/releases/0.2.0.md)
for adoption and qualification boundaries.

## Fresh hosting patch: 0.2.1 candidate

A live fresh-setup attempt exposed two Vercel API assumptions. Project creation
rejects a top-level `nodeVersion`; the patch omits it there while retaining Node
24 in deployment settings. A legacy user record can report Hobby but route
unscoped writes to a default Pro team. The existing destination guard stopped
before credentials or MotherDuck resources were written. The patch now refuses
that personal scope before project creation and asks for an explicit workspace.

Both regressions fail on the earlier implementation and pass with the patch;
**21 personal-cloud tests** and **18 affected Python setup/packaging tests** pass.
The app and deployment bundle build successfully. Actual Hobby provisioning and
fixture execution remain pending a usable workspace; this candidate is not yet
published. The released 0.2.0 artifacts remain unchanged.

## Continuation and manual updates: 0.2.0

- Checkpoints retain canonical selections, query provenance, exact amendment and
  source pins, pending identities and remaining work within 24 KiB. Inspection is
  read-only; missing, foreign and stale dependencies block continuation.
- Manual checks separate existing findings from discovery. Canonical fresh source
  versions support proposals; missing hits never delete findings. Accept/Keep
  choices can change before publication, with every decision retained. Publication
  creates an immutable successor preserving original observations and amendments.
- Complete update tables are limited to 100 rows and 200 KB. Explicit
  materialization retains accepted row IDs for further SQL and can consume a
  provider-free hosted Flight. Checkpoint inspection, review and publication
  do not start one.
- Durable retries compare JSON values independent of key ordering. Seven
  sorted-backend regressions cover the earlier ordering failure, including lost
  post-commit acknowledgments without an additional write.

The implementation passed **289 app tests on macOS and Linux**. Linux passes
**477 Python and Flight tests**, with four macOS-only skips; the root macOS
Python suite passes **360**, with 44 Linux-only skips. Wheel and source
installations pass outside the checkout on Python **3.12, 3.13 and 3.14**.
Package audits exclude private documents, credentials and operator state.
An actual Python/SQL-worker fixture run covers fresh observations, canonical
source evidence, review, publication, repeatable materialization and subsequent
SQL. Restricted Docker checks use no networking, a read-only filesystem and a
nonroot user. These checks measure fixture behavior, not live semantic quality.

ChatGPT and Claude both rendered canonical synthetic proposals, including the
retained quote, observation time, previous/proposed values and a separate
discovery candidate. Actual app controls saved Accept → Keep → Accept for the
changed field and Skip → Accept for the addition. Publication stayed disabled
until both findings were reviewed, created a two-row successor, and froze review
choices. Back navigation preserved the original one-row table and its separate
correction. The accepted tables were then reopened from saved state.

Fresh fixture observations were acquired by the local protected Python worker,
exported normally and imported through the documented MotherDuck storage adapter
into the existing owner workspace. Canonical rows, hashes and evidence survived
a fresh native read. Hosted review/publication used those retained results;
this does not qualify a new hosted acquisition Flight. No live provider calls,
Flights or allowance changes were needed for these host checks.

ChatGPT also saved a selected-field checkpoint; a fresh Claude conversation
resumed that same canonical selection/revision as `ready`. Both hosts saved,
read and cancelled a manual update request. Claude prepares a composer draft
that requires Send. The checkpoint file-download control was unavailable in the
measured ChatGPT session and remains unqualified.

The current immutable UI is
`ui://sourcesql/research-a19abdd86f97fd03.html`; ten earlier resources remain
available to older components. The branding footer is removed. Controlled checks
reproduced the old 88-pixel selection jump; the new layout stays the same height
before selection, with its toolbar visible and after dismissal at desktop/mobile
widths. Actual ChatGPT and Claude checks also retained a 240-pixel frame for the
one-row fixture. Targeted resource, deployment and packaging checks pass.

Connect directly through the authenticated HTTPS MCP endpoint; no packaged
plugin is required. Refresh the existing host's tool definitions after an update.
In Claude, use **Connectors → Yours → sourcesQL → More options → Refresh tools
list**, then reopen saved research. A fresh chat alone may retain cached UI
metadata.

Remaining gates are [fresh-account Hobby onboarding, bounded Vercel Brave/Serper
dispatch and the unqualified client paths](docs/adoption-verification.md).
Earlier provider attempts exhausted their daily reservations; resume under the
same limits after capacity returns. A temporary test-access grant must be revoked
after use. Application reservations do not guarantee account-wide free usage.
Existing Flight definitions embed their reviewed wheel; PyPI publication alone
does not replace that runtime. Fresh hosted acquisition must be checked separately
from stored-data interactions.

See the [continuation guide](docs/continuation.md) for scopes and recovery.

## Working paths

- Research SQL with typed immutable results, retained sources and execution receipts.
- Fixture mode with no search or model credentials; opt-in live provider profiles.
- Local HTTP and stdio MCP transports, an interactive research table, separate
  corrections, linked investigations, explicit refresh review and bundle export/restore.
- Durable MotherDuck results and jobs, bounded on-demand Python Flights, cancellation
  and lost-response recovery. One active job per owner namespace; queued jobs resume explicitly.
- An owner-authenticated ChatGPT app with OAuth and enforced CSP. Saved-table
  rendering, corrections across reload, tree/Back navigation, a small live Auto
  expansion and fixture-based refresh review have been exercised. Saved rendering
  was rechecked after tool refresh. The direct authenticated MCP connection is
  the intended installation path.
- Claude rendered saved hosted research with an encrypted owner bearer header;
  child/Back navigation and synthetic corrections persisted across reload.
- Cursor rendered and paged a nine-row local Docker fixture. In that tested
  setup, host-agent messaging was unavailable and refresh remained disabled.

## Historical checks at initial publication

The macOS/Python 3.12 suite passed **406 tests**, with **44 Linux-only skips**.
The app built and passed **172 tests** on macOS and native ARM64 Linux Docker.
Docker passed **446 Python tests**, with **four macOS-only skips**, plus actual
HTTP/MCP, corrections, export, restart persistence and stdio checks. The README's
fixture SQL example ran against the real engine without provider calls. These
checks made no live search or model calls. See the Docker and runtime guides.

These results establish the tested execution and control paths. They do not
measure broad search recall, live semantic accuracy, a complete research workload
or comparative product quality.

## Published adoption release evidence

These are recorded checks for the 0.1.x releases. Current candidate checks are
listed above; an older passing result does not qualify a changed workflow.

Version **0.1.2** changed dark-mode surfaces to neutral charcoal and gray, keeping
#2CD8B6 accents and the supplied logo. Ten targeted app-resource/Vercel checks
and six packaging checks passed. The Docker runtime and authenticated Preview
endpoint served the new resource and retained older chat resources without new
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
locally audited artifacts exactly. The app passed **197 tests** on Node 24 on
macOS and Linux Docker; **85 packaging and Flight tests** passed. The final Docker
runtime served current and retained UI resources from fresh storage with a
read-only filesystem, no network and a non-root user.

Version **0.1.1** preserved the durable queued job handle when an automatic start is
blocked by the daily allowance. It also included required setup templates and
verified historical app resources in Docker, and documented persistent MotherDuck
token rotation. The app used **#2CD8B6** accents and the supplied rounded footer
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

In the adoption host checks, Refresh tools and reopening a saved synthetic result
restored ChatGPT rendering after a transient component-opening failure, without
a SQL rerun. Claude passed hosted rendering, research-tree child/Back navigation
and a 500-to-501 synthetic correction that survived reload before restoration to 500.
Cursor passed local Docker rendering and paging; the tested host did not expose
agent messaging, so refresh was disabled. These are bounded host checks, not full
Claude/Cursor lifecycle qualification.

## Current limits

The earlier qualified hosted Exa run used `exa-search.v1`: Auto search excerpts,
**two queries and ten candidate pages per job**, with no additional fetches or
model calls. A reviewed `exa-research.v2` Flight is provisioned, but a new live
Vercel Exa check remains pending after an earlier attempt reached its configured
daily Flight reservation. That reservation is an application guard, not
MotherDuck's account-wide free allowance. Provisioning alone is not live provider
qualification.

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

The [roadmap](docs/roadmap.md) separates the remaining adoption and host checks
from implemented checkpoints and bounded manual updates. The next product work
is larger engine-backed update publication; monitoring remains a later option.
See [continuation and manual updates](docs/continuation.md) for the current
contracts alongside existing snapshot and refresh behavior.

Start with the [README](README.md), [Docker guide](docs/docker.md),
[provider configuration](docs/providers.md) or [personal hosting guide](docs/vercel.md).
The [SQL reference](docs/language.md), [qualification notes](docs/qualification.md)
and [runtime qualification](docs/python-linux-qualification.md) describe execution
contracts and the scope of the recorded checks.
