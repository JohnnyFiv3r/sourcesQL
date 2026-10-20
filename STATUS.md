# Project status

sourcesQL includes a research SQL engine, an MCP App, local Docker packaging
and optional Vercel/MotherDuck hosting. **0.2.3** is published on PyPI and GHCR,
with the release pinned to its reviewed package hashes and tested container.
See the [0.2.3 release](https://github.com/JohnnyFiv3r/sourcesQL/releases/tag/v0.2.3)
and [release notes](docs/releases/0.2.3.md).

## Unreleased citation and result-read correction

Public result rows and retained evidence/source records now have separate byte-
bounded pages, with lossless chunks for a single oversized record. Per-page and
per-chunk authorization remains required; full immutable records stay retained.
Agent-curated fields can attach explicit quotes from authorized canonical source
versions. Invalid individual bindings produce advisory feedback while preserving
rows. Quote existence is not a factual-truth or semantic-entailment guarantee.
Effective-table v2 materialization carries existing citations through unchanged
cells and keeps manual corrections uncited; v1 replay requires exact-handle
inspection before new work. The inline table no longer reserves selection-control
space when no selection is active. These changes require source-matched gateway
and worker qualification before claiming deployed behavior; historical immutable
findings are preserved. See [app integration](docs/app-integration.md) and the
[materialization upgrade procedure](docs/materialization.md).

## Unreleased effective-table and recovery correction

Query, explain and explicit materialization now share a coherent app-state
selection and typed payload contract. Accepted refresh sources and inline private
contributors survive as authorized dependencies; values, row identities and exact
amendment revisions remain distinct from original observations. Hosted effective
inputs bind the outer UUID to their complete import-job set before dispatch, with
atomic reservation, identity conflicts and exact-job recovery. Local keyed replay
compares Python-normalized import identities before creating replacement work.
Legacy and ambiguous UUIDs require exact-handle inspection. See the
[contract and upgrade procedure](docs/materialization.md).

Local fixture coverage exercises the MCP boundary, native SQL controller and
local/DuckDB-backed engine storage. Frozen wheel/source distributions pass their
outside-checkout CLI, reopen, portability and setup checks, and installed lineage
and replay regressions. These checks do not establish remote MotherDuck, real
Flight, live-provider or ChatGPT/Claude acceptance of this correction. Deployment
requires source-matched artifacts and the documented legacy-preparation cutover;
historical missing ancestry is not automatically repaired.

A local workspace harness measures current/history limits and verifies CAS,
no-op behavior and authorization. Identical portable bundle retries no longer add
duplicate history. Current limits remain unchanged; broader immutable-payload
sharing and narrower mutation resolution remain separately designed follow-ups.
Qualification scripts now default to an offline plan, bind reviewed owner/policy
and artifact identities, and require explicit remote execution/submission. See
[qualification instructions](scripts/qualification.md). Detailed measurements and
operator evidence remain outside public artifacts.

## Unreleased research completion work

DeepSeek is now an optional search provider across local/Docker profiles and
reviewed personal-cloud setup. `deepseek-search.v1` enables search;
`deepseek-research.v1` independently opts into the same OpenAI model matching,
extraction and normalization, plus embedding `SEM_SCORE`, as the other providers.
Native DeepSeek Fetch supplies retained Markdown after public-URL authorization.
Provider summaries and ranking remain discovery metadata; unavailable page text
and incomplete coverage remain explicit. Whole-batch input validation catches
unsupported lengths, malformed Unicode and impossible completeness/freshness
requests before paid dispatch. No automatic provider switching is introduced.

Search and fetch share a finite per-run request estimate, with a published-rate
estimate of 750 micro-USD for each successful nonempty response and zero for valid
empty responses. Unknown outcomes and unavailable billing stay unknown. Usage
reports include DeepSeek independently from OpenAI; provider refusals retain
saved work and expose a fixed provider-owned billing destination. No recurring
DeepSeek free allowance is assumed. Versioned job presentation preserves the
strict wire shape accepted by previously published widgets.

DeepSeek now retains identifiable search hits when optional fields or page text
are unavailable. Bad fetch payloads and URL-specific 403/404 refusals produce
per-URL failure records while valid neighbors continue; account refusals and
unknown outcomes still stop without retries. Admission bounds paid fetches as
well as searches, with a shared runtime reservation across both. Stage ceilings
remain independent optional maxima, not a promised total execution cost.
Search-only deployments ignore unrelated OpenAI variables without enabling
semantic operators. Full-batch preparation performs URL authorization and one
DNS check per unique URL before checkpoint splitting. Rate estimates have one
shared constant per language; reports distinguish operator reservations from
published usage estimates. Legacy card projection remains frozen and preserves
the complete capacity reason and service identities in versioned metadata.

Offline qualification covers 1,453 Python/Flight cases (44 opt-in cases skipped),
including 91 DeepSeek adapter cases, plus 515 app/MCP tests and 77 onboarding
checks. The final wheel passes 326 installed regressions, and its
materialized templates load under native Node 24. Gateway and frozen-widget
compatibility checks, Python lint and typing pass. The Docker compiler path emits
loadable JavaScript policy modules while native Node setup still loads TypeScript;
a regression exercises both provider descriptors after emission. A single
compression layer now stores the same execution-wheel file bytes
inside the existing outer XZ bundle, preserving hashes, RECORD verification and
the unchanged 200,000-byte Flight guard while restoring source headroom. No
provider requests, cloud jobs, deployments or release publication are included
in this qualification; live DeepSeek billing, retrieval quality and host
acceptance remain unverified.

Brave and Serper now support optional language-model matching, extraction and
normalization plus independently configured embedding scoring in hosted
research policies (`brave-research.v2` and `serper-research.v2`). Guided setup
shares the same model/embedding configuration across these search providers;
named OpenAI secrets may be shared by those two adapters. The reviewed plan,
gateway and worker bind the same policy, model names, secret references and
effective execution limits. Search-only legacy policies and fingerprints remain
unchanged, and no existing deployment is migrated automatically. Brave/Serper
research fetches public HTML/text directly through the guarded fetcher; rendered
JavaScript and PDF extraction are unavailable on that path. Mocked HTTP with the
real SQL engine exercises qualified answer cells, citations, semantic operators
and saved-source reuse without another search or fetch. This implementation has
not been deployed or live-qualified with those providers.

Provider-independent validation passes 1,284 Python/Flight tests (44 opt-in
cases skipped), 477 app/MCP tests and 69 setup/onboarding checks, plus lint,
typing and the Node 24 build. The built wheel passes 129 installed regressions;
its materialized adopter templates load the shared policies with native Node 24.
The compact Flight source remains under the unchanged 200,000-byte guard.
No provider requests or cloud jobs run during this qualification.

PR #3 review repairs distinguish proven pre-dispatch stops, known provider
refusals, unknown outcomes and completed responses whose payload could not be
retained. Explicit continuation can rearm only proven undispatched stages;
an atomic journal-head claim prevents stale or concurrent branches from reusing
lower counters. Successful publication seals the journal and reclaims duplicate
checkpoint payloads within the publication transaction. A one-time migration
also reclaims older published journals while retaining failed work. Transactional
byte accounting reserves terminal metadata and replaces repeated payload scans;
the unrelated 256-stage cap is removed. Keyset-paginated storage methods own
checkpoint traversal, including recovery racing with publication cleanup.
Hosted validation now runs once before trusted setup and provider preflight;
usage notices observe platform metadata once and summarize month/day from one
read snapshot. These repairs have fixture/mocked-provider regression coverage;
they have not been deployed or published as a new release.

Review-repair validation passes 1,166 Python/Flight tests (44 opt-in cases
skipped), 445 app/MCP tests and 59 setup/onboarding checks, plus lint, Python
typing and the Node 24 production build. The built wheel passes 145 targeted
installed regressions. The compact Flight keeps its existing 200,000-byte
source guard: omitting deployment-only setup helpers produces 194,370 bytes,
while the public wheel retains those helpers. No new paid provider or hosted
Flight execution is included in this qualification.

Provider-managed metering is implemented for new reviewed personal-cloud plans
and can be explicitly enabled on an existing deployment. Accumulated application
reservations neither block dispatch nor grow in that mode. Historical counters,
queued handles, finite per-job budgets and single active/uncertain Flight
protection remain intact. Deployments without the new mode retain their prior
operator safeguards until deliberately migrated.

Run receipts meter Exa response estimates, provider requests and model tokens,
including failed/cancelled work. Observed terminal Flight runtime is stored once;
cost reports reconcile recent platform observations without starting work and
retain unknown database, storage and older runtime components. The authenticated
owner's `sourcesql_usage_report` exposes period/job totals without research text
or credentials. App notices identify estimated sourcesQL reference allowance
crossings and remain nonblocking. Dismissals persist per owner/provider/period.
Provider-owned billing links do not change plans or introduce another consent
step. Safe provider credit/rate/spending refusals retain saved work and recovery
identity; unknown MotherDuck submission outcomes remain uncertain. See
[usage metering](docs/usage-metering.md). Validation passes 905 Python tests
(44 opt-in cases skipped), 444 app/MCP tests, 186 Flight tests and 41 onboarding
tests, plus the Node 24 production build. Synthetic headless checks at 1100,
420 and 320 px cover stable sizing, nonblocking actions, safe billing links,
reduced motion and dismissal recovery. Provider-free Preview verification checks
tool discovery, usage reports, archived widgets and saved research while retaining
queued work and historical counters. Fresh ChatGPT/Claude acceptance remains
separate; the published 0.2.3 artifacts are unchanged. New job presentation fields
use versioned metadata so archived cards retain their strict legacy payload.

Advisory SQL feedback is implemented and deployed on the existing Preview.
Each new query records an
AST-derived description independently of optional intended answer metadata,
alongside exact SQL/parameter/input-pin hashes, missing intended columns and
full-result row/NULL counts. Descriptions retain scoped CTEs, joins, aggregates,
semantic instructions and limits; incomplete descriptions remain explicit.
Missing fields and unavailable explanations do not reject valid research,
remove rows or trigger automatic retries. The agent receives the feedback
through query/result/evidence tools, and Table options opens a read-only
explanation without another model call or Flight. Compatibility metadata stays
outside legacy snapshot wire fields. Local, hosted and user acceptance evidence
are recorded separately; see [query feedback](docs/query-feedback.md).
Large valid rows take priority over optional explanation metadata in the app
window; full feedback remains retained in engine storage and result inspection.
Offline qualification passes 846 Python tests (44 opt-in cases skipped), 186
Flight tests and 408 app/MCP tests, plus Python typing and the Node 24 build.
Desktop and mobile headless checks cover dialog navigation, focus, escaping and
read-only behavior. A user-run fresh ChatGPT mobile research pass subsequently
displayed the requested qualified answer table successfully. This is acceptance
of that research/presentation path, not a general factual-quality benchmark.
Its expansion was blocked by the configured monthly search/model reservation
allowance; it did not establish an expansion execution defect. The user also
reported that ChatGPT's Always allow button leaves the approval card unchanged,
while Allow once starts the tool. A read-only settings inspection found the
plugin-specific permission already set to Allow all actions. Persistent host
approval remains unresolved; tool annotation or connection changes are not a
verified fix.

The agent workflow now explicitly requires reviewing actual saved rows and
supporting evidence, interpreting findings against the requested row unit and
fields, and saving that interpretation through final SQL before opening the
table. The renderer displays saved rows; it cannot turn a source catalog into an
answer from the conversation. Query and render descriptions repeat this handoff
so it is available through tool discovery as well as server instructions.
Missing cells remain valid in honest partial answers, and explicit reopening
does not trigger new research or transformations. This instruction change is
deployed and has the above bounded fresh-host research acceptance; it introduces
no new validation gates or provider calls.

Agent instructions now keep request/mutation IDs internal and avoid separate
code-tool calls solely to generate UUIDs. Existing IDs and idempotent recovery
contracts remain unchanged. Host-generated activity captions and persistent
approval controls remain outside the widget's styling and authorization policy.

Pending expansion/refresh status now uses a compact animated overlay alongside
other notifications instead of a row inside the table. It no longer changes
the frame, table viewport or page sizing. Check, cancellation, error recovery
and cancelled-status dismissal remain available. Isolated synthetic browser
checks pass at desktop and 420/320 px mobile widths, including reduced motion,
stable table/pagination geometry and selected-cell toolbar clearance. This UI
change passes the Node 24 production build and all 412 app/MCP tests; the new
immutable widget also passes archive/upload and package-resource checks. It
still needs fresh ChatGPT acceptance.

The render tool now returns a concise answer-surface handoff alongside saved
data. Its tool-local description requires the requested row unit and answer
fields, treats source hit lists as acquisition unless a catalog was requested,
and keeps follow-up chat brief without duplicating the table. The query tool
also points to declared research requirements. A successful tool response does
not establish that the host displayed the app. All 383 app tests and the
TypeScript production build pass; a recorded 24-source view renders under strict
CSP in independent headless Chrome. The reported ChatGPT loading failure still
needs host-side evidence; these checks do not establish ChatGPT acceptance.
The render tool also mirrors its standard resource URI in ChatGPT's documented
optional template alias. Resource-read regressions keep both paths on the same
immutable bundle; data tools remain without a template. This compatibility
change still needs verification in ChatGPT and is not a confirmed root cause.
Inline sizing now treats nonpositive initial height budgets as unmeasured,
using the existing 560 px fallback. A collapsed-frame reproduction previously
reported zero indefinitely; the fixed bundle requests a positive height and
renders. Four sizing regressions and five independent headless cases pass,
including collapsed frames and partial host context. Positive host limits,
fullscreen and local preview behavior are preserved. Previous public UI
resources remain available under their original content hashes. The actual
ChatGPT client context and end-to-end mobile rendering remain unverified.

Optional HTTP diagnostics now distinguish tool discovery, renderer calls and
public widget resource reads, including JSON-RPC failures carried by HTTP 200.
They log protocol categories and public bundle hashes without credentials,
research arguments, rows or error text. The feature is disabled by default.
Actual HTTP tests cover resource delivery, a missing archived bundle, owner
refusal and private-payload exclusion. Successful server delivery still does
not establish that ChatGPT rendered the widget.

A subsequent mobile trace identified a concrete resource failure: ChatGPT read
the earlier `758dbf283e918839` bundle, which was absent from the deployment's
explicit archive list. Each read returned a JSON-RPC error inside HTTP 200;
authentication succeeded. The original public bytes have been recovered and
added to the checksum-pinned archive and upload list. This repairs that missing
resource without replacing its contents or changing saved research. Actual host
rendering after the repair remains an acceptance check.

The restored mobile widget then exposed a second compatibility problem: its
strict snapshot parser predates quality metadata and per-cell diagnostics. The
gateway now puts those additions in versioned presentation metadata outside the
stable snapshot layout. Current widgets validate and restore them; older widgets
can still show the original cells. Canonical storage, imports and exports retain
strict validation and complete metadata. Bootstrap recovery preserves the exact
table ID, makes at most one automatic saved-state read and rejects another
table. Ambiguous calls without a saved identity no longer choose a default
sample. Recorded-data checks reproduce the old failure and exercise same-table
recovery without provider work. All 399 app tests and the production build pass; both the archived and current widgets render the recorded saved table, and six isolated startup/recovery cases pass. Actual mobile acceptance remains separate.

PR #2 merged as `3cdfa00` after 796 Python and 357 app/gateway/MCP tests passed.
The next local implementation covers canonical hosted preflight, bounded durable
stage journals, explicit restart continuation/source recovery, query-hit
provenance, retained evidence windows, item-level lineage and explained NULLs.
Declared output requirements now separate execution success from unresolved
research obligations and label those gaps in the existing result count. Scoring
persists completed HTTP batches before strict cell validation or later deadlines;
failed and uncertain effects cannot authorize replay. Batched storage checks and
writes reduce per-row cloud overhead while rechecking authorization and cancellation
before each paid batch and final publication. Guided personal-cloud setup accepts explicit model and
embedding bindings while preserving search-only defaults.

Targeted injected-failure and source-local evidence checks pass. The diagnostic
UI keeps selection height stable and uses existing cell/correction affordances.
Full suites pass: 965 Python/Flight tests (44 opt-in cases skipped), 377
app/gateway/MCP tests and 59 onboarding checks. Python lint/type checks and the
Node 24 production build pass. Installed artifacts, Docker, hosted alignment and
fresh ChatGPT/Claude research remain separate acceptance gates. This work has not
changed the published 0.2.3 artifacts. See [the working plan](docs/accuracy-plan.md).

## Unreleased notification UI

Local source replaces in-flow feedback banners with a floating overlay using
the selection toolbar's motion and neutral surface. Success messages dismiss
after six seconds, pause while hovered or focused, and errors stay until
explicitly dismissed. Saved-navigation progress shares the overlay. Hidden
notifications retain their exit animation without remaining interactive.

The standalone build and three resource checks passed. A synthetic fixture
through the actual local MCP bridge verified slide/fade dismissal, interaction
pause, saved-navigation completion, persistent errors, neutral dark styling and
reduced motion. The embedded frame remained 240 px on desktop and 246 px on
mobile before, during and after the notification. No provider calls or hosted
jobs ran. This UI change is not deployed or released; the 0.2.3 tag and hosted
application remain unchanged.

## Unreleased semantic workflow and embedding batches

Local MCP instructions and product documentation now put semantic shortlisting
in host-authored SQL: broad discovery, conservative deduplication, `SEM_MATCH`,
detailed extraction and collection-scoped `SEM_NORM`. Embedding `SEM_SCORE`
ranking is optional for a more specific criterion; metadata gates and
score-first execution are not mandatory.

The OpenAI scorer batches unique inputs, reuses the criterion and vectors within
a run, and preserves row positions, NULLs and unavailable outcomes. Exact score
results can also reuse the existing durable semantic cache. Input allowance is
reserved before dispatch; actual usage is recorded separately and once per
batch. Deadlines and cancellation stop later batches, and cache events cannot
settle an uncertain request. Model-aware tokenization replaces the conservative
byte guard and counts full scoring inputs up to the 8,192-token model window.
Genuinely oversized sources need explicitly selected passages or highlights;
valid sibling rows continue. The public package bundles tokenizer data for
offline cold starts. The compact Flight prepares the same checksum-pinned
public data before live scoring to fit the existing source-size guard.
Scoring uses the candidate allowance separately from generative document work;
shared model-request, token and runtime limits still apply.

Hosted research v3 supports an explicit OpenAI embedding model and bound secret,
with matching gateway/Flight policy fingerprints and advertised capabilities.
Absent embedding settings preserve existing policy fingerprints. This
configuration is prepared locally, not enabled on the deployed Flight.

Verification: 788 Python tests passed, 44 opt-in tests skipped; all 352
app/gateway/MCP checks passed before committing this update. TypeScript and Python type checking,
Python lint and the frozen lock check passed. Tests cover authored SQL ordering,
token boundaries, multilingual inputs, mock HTTP batches, duplicate usage,
persisted scores, unknown outcomes, cancellation and hosted configuration drift.
Installed public-wheel tokenization passed with network/cache access blocked.
The compact Flight built to 159,589 bytes, below its retained 200,000-byte
application guard. Its stripped execution wheel passed installed tokenization
after explicit mocked restoration; timeout, checksum, size and request-identity
checks passed. A real Flight's download path remains unqualified. No paid calls
or live ranking comparisons ran. These changes are not deployed or released.

The [accuracy and completion plan](docs/accuracy-plan.md) records the remaining
work with stable priorities and completion evidence. Canonical hosted preflight
and safe errors, durable successful branches/stages, feasible extraction
continuation, query/source coverage, entity reconciliation, source windows,
claim/cell evidence and bounded gap follow-up remain incomplete. Fresh
natural-language host acceptance and model-capable adopter setup are separate
gates; local regressions do not establish first-attempt research accuracy.

## Unreleased hosted failure diagnostics (Q01a)

The notification and token-aware scoring work above merged in
[PR #1](https://github.com/JohnnyFiv3r/sourcesQL/pull/1) at
`d0bdfbea0c3454afccfa33a3d6abdadb443c388a`. The published 0.2.3 artifacts and
deployed workers are unchanged. External Codex review was requested but has not
acknowledged the request; two independent local source reviews found no blockers.

Q01a now retains known provider failure codes in the Python job writer and
returns fixed safe summaries through the native gateway and MCP. Failed jobs
include an inspectable run handle when execution created one. Run inspection
returns at most eight safe code/stage/message summaries and explicitly flags
truncation. Provider bodies, prompts and arbitrary diagnostic strings stay out
of these responses. Embedding HTTP rejection retains its provider error code
instead of becoming a generic validation error.

Local failure-injection checks exercise the actual embedding adapter, strict
engine, Flight runner and MotherDuckStore writer against one DuckDB file,
then reopen through native gateway and MCP connections. Timeout, connection
failure, HTTP 429 and invalid vectors retain distinct codes without publishing
a result. Another owner cannot inspect their job or run; inspection, replay
and explicit start do not redispatch a terminal job. Full regression passed:
796 Python tests (44 opt-in cases skipped), all 357 app/gateway/MCP tests and
the app build. An independent source review found no blockers. No live or paid
provider calls ran. Canonical hosted preflight, richer dispatch-certainty
diagnostics and live transport qualification remain pending in Q01.

## Release qualification: 0.2.3

The final tag pipeline qualified both Python distributions on Linux Python
3.12–3.14 and published the same Linux AMD64 image it tested. Public PyPI
installation and anonymous container pull matched the recorded artifacts.
The fresh public install passed on a retry; the first probe failed before
product execution and its cause was not established. The local ARM64 container
also passed its lifecycle checks.

A fresh Hobby project completed onboarding on its first public installed-CLI
attempt, then executed one bounded fixture and reopened its stored result in a
new process. This used existing accounts; new-account signup and OAuth setup on
that new alias were not qualified.

The existing ChatGPT and Claude connections rendered actual MCP Apps for saved
research, row expansion, corrections, refresh review and manual update
publication. Both hosts adjusted Accept/Keep decisions before publishing frozen
successors. Fresh conversations reopened each other's compact checkpoints.
Both rendered a configured monthly-capacity notice with disabled resume and a
billing link. Temporary limits and deployments were restored or removed;
queued user jobs remained unchanged. These lifecycle checks used synthetic data
and made no external search or model calls.

Current ChatGPT access uses OAuth; the existing Claude owner-bearer connection
was used for these functional checks. Earlier separate OAuth renewal checks are
recorded below. Host acceptance retained an initial invalid request and recovered
saved views after transient opening issues; it does not establish failure-free
host behavior or exhaustive research quality.

## Research capabilities: 0.2.3

The release adds opt-in wider Exa retrieval, bounded parallel search,
source fetching and configured OpenAI extraction to personal-cloud hosting.
Small defaults and older hosted policies remain unchanged. Native OpenAI uses
Responses; supporting quotes acquire exact coordinates in code. Invalid evidence
is excluded from semantic cache reuse, and incomplete fetched text cannot satisfy
`require_document`. Optional reasoning effort is part of the reviewed policy.
Admission includes typed URL-part splitting and two-argument regular-expression
matching. Hosted failures retain safe application error codes through MCP.
See [the research configuration](docs/exa-research.md).

The existing personal-cloud Preview runs the qualified 0.2.3 runtime.
A capped live pipeline and a separate saved-result projection completed through
Vercel and the versioned Flight; the projection made no provider or model calls.
This is bounded integration qualification, not complete research coverage or
factual-accuracy certification. Personal-cloud onboarding defaults retain their
older search policy unless explicitly reconfigured. The published distributions
and hosted runtime share the qualified source inputs. Operator evidence and
quality experiments remain private.

The release retains partial research by default. Missing facts remain NULL;
named extraction fields with invalid support become unavailable without discarding
independently cited siblings. Explicit strict execution remains available.
Field diagnostics and partial status survive semantic-cache reuse. Multi-entity
extraction also retains item positions and supported sibling fields; an invalid
quotation cannot discard every other entity from that parsed source response.
Invalid-only results are not cached as usable evidence. Bounded batches
and targeted follow-up instructions preserve completed work without repeating
discovery or replaying uncertain submissions.

A separate post-demo check processed two retained official source documents on the
updated hosted worker: two model calls, no search or fetch, six cells with exact
source quotations, and two unsupported publication dates left NULL. This qualifies
that measured path, not automatic gap filling in either host. The operator has a
separate explicit two-dollar per-job research grant; normal adopter settings do
not inherit it. Native hosted tool discovery omits the local-only Explain tool.

Public personal-cloud setup now uploads the reviewed files by content digest
before creating a deployment. Saved upload acknowledgments survive interruption;
an incomplete upload never crosses the deployment-creation barrier. Controlled
tests cover the compact manifest, account/team binding and ordinary recovery.
The fresh Hobby installed-CLI first attempt passed as recorded above.


The release supports authorized reuse of retained source documents and
canonical cell evidence through supported projections and joins. A bounded live
three-document extraction preserved source dates and exact support; subsequent
SQL combined reviewed announcement and progress sources without new provider
calls. Unsupported transformations retain input-set evidence, and unresolved
capacity and identity remain unknown. Saved tables rederive citation annotations
from canonical engine data after immutable-value validation; caller-supplied
imports retain full evidence checks. This does not establish population coverage,
current status beyond the cited dates, or general research-quality parity.

Capacity-blocked hosted jobs have an app view through `open_research({job_id})`.
New guided onboarding defaults to configured monthly reservations of 18,000
maximum-runtime Flight seconds and $10 of search/model work. Existing daily
ledger entries count toward the monthly checks, which run within the serialized
dispatch transaction. Explicit daily guards remain available; legacy environments
without monthly settings retain their earlier daily default. These are app
reservations, not measured free credit balances or an account-wide billing cap.

The capacity view preserves the saved job and reports the actual resource,
authority and reset period, with read-only status checks and explicit resume.
Optional service-specific billing links use fixed official destinations; opening
one starts no research, changes no account and does not raise configured limits.
Uncertain submissions cannot resume. The operator Preview has a separately
bounded testing allocation; adopter defaults do not inherit that override.

Earlier application checks passed 341 tests, setup/onboarding checks passed 47 and public
resource packaging checks passed ten. Eleven browser cases through the actual
local MCP bridge cover daily/monthly limits, provider-reported included fixture
capacity, mobile layout, uncertain submissions and explicit SDK billing-link
clicks. These establish UI behavior, not native free-quota enforcement. New
capacity/billing UI qualification inside actual ChatGPT and Claude was a
separate check. The 0.2.3 host checks above now qualify the configured monthly
notice, restoration and saved-job behavior; native free-quota enforcement remains
separate. Existing queued jobs remained undispatched throughout these checks.
No new provider or Flight calls were needed for capacity qualification.

## Released fixes and runtime alignment: 0.2.2

[Release v0.2.2](https://github.com/JohnnyFiv3r/sourcesQL/releases/tag/v0.2.2)
was published from commit `7e5fb9c834969d87633db2ae8ded779ff27553dc`.
The [release workflow](https://github.com/JohnnyFiv3r/sourcesQL/actions/runs/38846282859)
passed all six installed-artifact checks: wheel and source distribution on Python
3.12, 3.13 and 3.14. Tagged distribution digests matched the qualified candidate
bytes. A fresh public-PyPI install outside the checkout on Python 3.13 matched
the published wheel digest and passed fixture execution, saved reopening and
offline bundle import. A network-disabled, read-only, nonroot Docker smoke
verified version 0.2.2, actual two-row fixture execution, consistent
`synthetic_fixture` metadata and receipts, saved reopening/export, and current
plus retained UI resources. These checks made no provider calls; the focused
Docker smoke did not repeat the full suite or qualify restart persistence.

At the 0.2.2 rollout, all four active hosted Flight definitions used its reviewed
bundle.
Independent fixture query dispatch from ChatGPT and Claude produced two fresh
Pro jobs that succeeded in **10.402** and **10.267 seconds**, reporting
engine 0.2.2 and the exact execution-wheel digest, with consistent result, receipt
and `latest_receipt` fixture classification. Native inspection preserved the
original result and confirmed the Pro reservation at **360 of 600 seconds**,
including an earlier 120 seconds. Provider and Hobby limits stayed unchanged;
neither received new execution. Actual ChatGPT and Claude apps rendered the saved
one-row `proposed` successor
and its published review history after parent refresh. Both displayed the
publication baseline at revision 1 with retained decisions and evidence, without
the earlier stale-baseline rejection message. The current deployed resource is
`ui://sourcesql/research-2511fe6d0adf4f69.html`; the former a19 resource remains
served for older components. The deployment contains 15 static assets, including
the current and 11 historical UI resources. Definition alignment does not qualify
execution of all four workers or broader live research from each MCP host.

Fresh **0.2.2 personal-cloud onboarding remains unqualified**. The packaged setup
still sends inline files; the measured rollout payload was 10.79 MB. Its initial
inline attempt lost status without a deployment ID, while the successful
existing-project rollout used an operator-only content-reference helper. This
does not establish a numeric service limit or qualify the public setup path.
Content-addressed public uploads and fresh provisioning are the next adoption
work; the earlier clean 0.2.1 Hobby result remains historical evidence.

## Fresh hosting: 0.2.1

Fresh setup omits the unsupported `nodeVersion` field from Vercel project
creation while retaining Node.js 24 in deployments. It refuses legacy personal
scopes that route writes to a default team and requires the intended workspace
explicitly. Before backend setup, a fresh project must have an existing
Production slot or approval for a credential-free static bootstrap. The research
app is deployed to Preview after that placeholder reaches Ready.

Regression checks cover the rejected field, destination selection, bootstrap
ordering and recovery using the same saved request. The patch passes 26
personal-cloud tests and 18 affected Python setup/packaging tests. Release
artifacts receive separate archive and installed-package checks.

A clean installed-CLI attempt in an existing eligible Hobby workspace completed
normal plan/apply/resume without repair flags or copied setup receipts. The
static bootstrap reached Ready before dependency installation, Flight creation
or backend credential upload. The app then reached Ready in Preview, with 18
encrypted Preview-only variables and an exception for its exact alias.
Unauthenticated MCP requests returned 401; OAuth discovery remained accessible.

Exactly one F4 Flight succeeded in **10.733 seconds**, returning two fixture
rows within a **120-second** runtime cap and daily application reservation.
A fresh MCP session reopened the stored result. Separate public PKCE clients
then completed actual OAuth in ChatGPT and Claude, and both hosts visibly
rendered the same saved two-row table. Each client received only delegated
`sourcesql:access` for the exact MCP audience; machine-to-machine access stayed
disabled. Neither host used a fixed owner bearer header.

Native storage inspection after both host opens confirmed one completed job,
one settled Flight run and one stored engine result, with zero provider
reservation. Original app connections stayed intact during that Hobby check.
The earlier recovered Hobby attempt took 9.35 seconds and remains separate from
this clean attempt.

ChatGPT and Claude subsequently each passed **two uninterrupted automatic OAuth
renewal cycles** with a temporary 120-second access-token lifetime. Successful
Auth0 refresh events matched the intended client, audience, owner and scopes;
each subsequent `open_research` rendered a new inline app with the saved two rows
after expiry. ChatGPT's original registration with empty Base scopes failed after
expiry and required reconnection. Its successful renewal test used a corrected
temporary registration with explicit `offline_access`; the original connection
was not automatically updated.

After testing, the API's access-token lifetimes were restored to 86400 seconds
and 7200 seconds for implicit/hybrid flows. Offline access stayed enabled; both
clients saved rotating-refresh settings of **7 days idle**, **30 days maximum**
and a **3-second overlap**. Native records remained at one settled job, one run,
one engine result, a 120-second reservation and zero recorded provider cost. These checks
qualify the measured renewal path; new-account signup, long-term token expiration,
provider research in that Hobby workspace and the remaining host lifecycle paths
remain separate checks.

The original ChatGPT connection was later replaced deliberately with one named
sourcesQL registration using the existing Pro endpoint, audience and public
client. Offline consent and saved-result rendering passed with Base scopes
`offline_access`, Default scopes `sourcesql:access` and OpenID Connect disabled.
The original API's 86400-second access-token lifetime stayed unchanged; saved
rotation settings were reread at 7 days idle, 30 days maximum and a 3-second
overlap. Two expiry cycles were measured on the temporary Hobby registrations,
not this replacement. Installed ChatGPT settings showed one sourcesQL entry;
temporary test connections were uninstalled, and Claude's original bearer
connection was retained.

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

The initial host review/publication checks used fresh fixture observations
acquired by the local protected Python worker,
exported normally and imported through the documented MotherDuck storage adapter
into the existing owner workspace. Canonical rows, hashes and evidence survived
a fresh native read. Hosted review/publication used those retained results;
those initial checks did not exercise a hosted acquisition Flight. No live provider calls,
Flights or allowance changes were needed for these host checks.

Subsequent checks used **one fresh shared fixture acquisition through Vercel**
for both hosts, rather than independent ChatGPT and Claude query dispatches.
Both actual apps staged a proposal, exposed its retained quote and observation
time, saved the review decision and published a successor. Each publication
preserved the parent's existing revision-1 correction and created a revision-0
successor with no amendments. Both hosts then passed expansion-tree navigation
and explicit refresh acceptance. That acceptance appended revision 2 to the
parent's correction history; the earlier correction and original engine rows
remained retained.

Fresh sessions in both hosts reopened the exact published successors with the
correct one-row `proposed` result; ChatGPT used the replacement sourcesQL OAuth
registration. A SELECT-only native audit confirmed exactly one new settled
fixture Flight, **10.934 seconds** of runtime, **120 seconds** reserved, zero
provider reservation, no active or queued jobs, and the original result hash
unchanged.

That earlier hosted runtime reported **0.2.0**, while the released library was
**0.2.1**. These checks qualify the shared fixture acquisition and observed host
controls, not an upgraded worker, independent host query dispatches, live-source
research or a complete lifecycle. Reopening showed a UI defect: published review
history displayed a stale-baseline rejection message after parent refresh despite
correct saved data. The 0.2.2 rollout and actual host checks above corrected that
message without changing the retained result.
Claude subsequently completed an actual native full-JSON download of the
published successor, producing a **123,492-byte** file with valid text-resource
metadata. An earlier refresh-child attempt opened a disabled Download dialog and
was cancelled; that remains separate history. ChatGPT still reported that its
host did not support file export. Offline validation matched the downloaded
bytes/SHA and confirmed the revision-0 one-row successor, retained original
observation, separate revision-1/revision-2 amendments, canonical quotes, manual
decision and publication. All four engine archives imported and reopened locally
with zero network attempts, SQL execution or worker dispatch. This does not
qualify full app-store/MCP restoration, Claude-host import or checkpoint-file
download.

The two fixes released in 0.2.2 preserve private-derived classification precedence
and the requirement to recheck unpublished stale proposals. Their initial local
checks passed 12 UI component tests, typechecking, a production build, two focused
engine tests and Ruff; release and actual host evidence is recorded above.

ChatGPT also saved a selected-field checkpoint; a fresh Claude conversation
resumed that same canonical selection/revision as `ready`. Both hosts saved,
read and cancelled a manual update request. Claude prepares a composer draft
that requires Send. The checkpoint file-download control was unavailable in the
measured ChatGPT session and remains unqualified.

The earlier immutable UI was
`ui://sourcesql/research-a19abdd86f97fd03.html` and remains available to older
components. The branding footer is removed. Controlled checks
reproduced the old 88-pixel selection jump; the new layout stays the same height
before selection, with its toolbar visible and after dismissal at desktop/mobile
widths. Actual ChatGPT and Claude checks also retained a 240-pixel frame for the
one-row fixture. Targeted resource, deployment and packaging checks pass.

Connect directly through the authenticated HTTPS MCP endpoint; no packaged
plugin is required. Refresh the existing host's tool definitions after an update.
In Claude, use **Connectors → Yours → sourcesQL → More options → Refresh tools
list**, then reopen saved research. A fresh chat alone may retain cached UI
metadata.

Remaining adoption checks include [fresh-account signup and OAuth enrollment,
provider-specific host rendering and the unqualified client paths](docs/adoption-verification.md).
Fresh 0.2.3 provisioning and the current core host lifecycle passed as recorded above.
The bounded Brave/Serper Vercel HTTP checks below completed after fresh allowance
verification under the original namespaces and limits. Their temporary test-access
grant was revoked. Application reservations do not guarantee account-wide free usage.
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

These are recorded checks for the 0.1.x releases. Current release checks are
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
local MCP; the later Vercel HTTP checks are recorded below.

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

## Bounded provider HTTP checks

On 2026-10-16 UTC, two protected Pro Preview deployments ran the 0.2.1 gateway
against the existing Brave and Serper 0.1.0 Flights. Each completed one query and
returned three excerpt rows, with no page fetches, model calls or provider
retries. Fresh HTTP sessions read the stored results and reopened saved research.
Native records confirmed both successful runs settled; the stable alias kept its
original deployment and the temporary protection bypass was revoked.

The combined reservations were **$0.02 and 240 Flight seconds**, not measured
charges; actual provider billing was unavailable. This qualifies the bounded
HTTP path, without establishing provider-specific ChatGPT/Claude rendering,
broad research quality or upgraded provider workers.

## Current limits

Hosted Exa research is opt-in. The research policy can admit up to 32 query
strings, 2,500 candidates and 40 document fetches, but configured budgets and
explicit approval bound each actual run. These are ceilings, not measured search
coverage. Bounded hosted Auto retrieval and structured extraction have completed;
broad recall, general semantic quality and automatic cell-specific follow-up
remain separate qualification work. Legacy search policies keep their original
limits, and guided onboarding does not silently provision a model-capable profile.

Brave/Serper receipts include earlier bounded Vercel HTTP checks; provider-specific
ChatGPT/Claude rendering and wider coverage remain separate checks. Configured
worker versions and exact execution artifacts must be verified independently of
package publication.

Guided setup supports one configured owner; account creation, OAuth registration
and the exact-domain protection exception remain manual. This is not a shared
multi-tenant service. Fresh-account signup and OAuth enrollment, the full Cursor research lifecycle,
broad live research quality and additional provider/host paths remain open
qualification work. The current ChatGPT/Claude core lifecycle checks passed as
recorded above.
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
