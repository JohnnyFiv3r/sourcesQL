# Research app integration

`apps/research` contains the Node MCP server and interactive research workspace. Its source origin and modifications are recorded in [app provenance](../provenance/app-reuse.json). Distributed fixtures are synthetic; operator state, credentials and private conversations are not bundled with them.

The app uses its existing MCP lifecycle server and research store. The Python engine retains immutable typed data and dependency closure. The app owns titles, corrections, request scope, parent links, review decisions and archive state. A full local materialization is cached in app state to support exact row lookup and review across the whole dataset. Every engine reference is resolved again on store reads; canonical hash, origin/run identity, schema, capture time and row count are verified. The cache is not a second correction authority.

## Run locally

Install the root Python environment with `uv sync --frozen`, then use Node 24 to run `npm ci`, `npm run build` and `npm test` from `apps/research`. Each widget embeds its generated JavaScript, CSS and fonts; unexpected external asset references fail the build. `npm start` binds `127.0.0.1:3117`. `npm run stdio` serves a local MCP client. Set `RESEARCH_DATA_DIR` and `SOURCESQL_DATA_DIR` explicitly for isolated stores. `SOURCESQL_PYTHON` can override the root `.venv/bin/python` executable. The [Docker package](docker.md) includes the installed engine and compiled app without requiring host Python or Node.

HTTP defaults to `fixture-anonymous`: only synthetic fixture data is exposed, the trusted engine principal is `fixture-anonymous`, and private engine access is disabled. Protected HTTP requires `RESEARCH_AUTH_MODE=protected` and `RESEARCH_BEARER_TOKEN`. It resolves one fixed operator-configured `SOURCESQL_PRINCIPAL`; incoming arguments never select a principal. The standalone browser uses an inline password form for that bearer, clears the field on submission and does not save it in browser storage or URLs. Optional hosted OAuth verifies the sole owner's issuer, audience, subject and workspace scope before opening storage; see [configuration](vercel.md#optional-oauth-for-chatgpt). Stdio is a local protected transport. Private computation additionally requires configured engine permission; private data in model-visible tool content requires `RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE=1`. Self-hosted storage and cloud-model disclosure are separate permissions. An accepted refresh with private source data marks the parent's effective view private-derived for disclosure checks. Private trees, labels and request questions are omitted from authorized public views and global row lookup. Linked children inherit private context classification.

`SOURCESQL_BACKEND=local` is the default. `SOURCESQL_BACKEND=motherduck` selects the native MotherDuck engine and durable app-state backend and requires protected HTTP or stdio. Both use the configured principal; request arguments cannot select a database, storage namespace or identity. A failed durable read does not fall back to local state or seed an empty database. Stored engine results are still authorized and checked against the app reference metadata on every reopen.

MotherDuck operator configuration uses `MOTHERDUCK_DB`, the allowlisted `MOTHERDUCK_HOST`, `MOTHERDUCK_TOKEN`, a provisioned `SOURCESQL_FLIGHT_ID` and its reviewed `SOURCESQL_FLIGHT_SOURCE_SHA256` and `SOURCESQL_FLIGHT_REQUIREMENTS_SHA256`. Keep credentials in local secret configuration. Submission defaults off; set `SOURCESQL_ALLOW_FLIGHT_SUBMISSION=1` deliberately to permit new jobs. Before dispatch, the controller verifies the Flight is on demand and still matches its reviewed code, dependencies, owner configuration, F4 size and runtime limit. The default per-Flight limit is 120 seconds and the conservative daily runtime reservation is 600 seconds per configured principal namespace (`SOURCESQL_FLIGHT_MAX_RUNTIME_SEC` and `SOURCESQL_FLIGHT_DAILY_SECONDS`; the latter cannot exceed 1800). These are application limits, not a MotherDuck billing enforcement guarantee or a total account allowance across other applications. Fixture profiles remain the default. The separately enabled and qualified `exa-search.v1` policy admits at most two Exa Auto searches and ten retained candidate excerpts per job, with no additional fetches or model calls. Larger research profiles, private-data research profiles and hosted semantic models require separate configuration and qualification; see [Flight policy](hosted-flight.md#opt-in-exa-search).

The Docker package uses `RESEARCH_BIND_HOST=0.0.0.0` inside its container and publishes the port on host loopback. Normal local execution still binds `127.0.0.1`. Both bind modes retain an explicit Host allowlist for `localhost` and `127.0.0.1`, and exact local Origin checks. Container binding does not make a public anonymous research endpoint. See [Docker setup](docker.md) for build, persistence and protected transport options.

## Contracts and lifecycle

Presentation happens after research transformations are complete. `open_research`
is the only tool registered with an app rendering resource. Query execution,
job polling, result reads, imports and tracked saves do not open a new component.
`import_research` accepts either a bounded snapshot or a canonical engine
`result_ref` and saves it without rendering; its structured view remains available
to the existing app's explicit Import action. Intermediate source tables can be
saved and reused by SQL without showing them in chat. A completed job receipt
does not establish that its table is the user's final deliverable.

The host completes filtering, deduplication, admitted joins, semantic fields,
final column selection and display labels, then calls `open_research` once for
the final curated result. Draft views require an explicit user request. Reopening
saved research on request and retrying a failed final render are separate from
rerunning research. The server cannot infer whether arbitrary SQL satisfies the
user's full question; final selection remains an agent decision, guided by the
MCP instructions and tool descriptions. Tool discovery must be refreshed before
a host will consume changed rendering metadata.

`sourcesql_capabilities`, `sourcesql_explain`, `sourcesql_query`, `sourcesql_run_status`, `sourcesql_read_result`, `sourcesql_inspect_evidence` and `sourcesql_cancel` use the configured engine; the local backend uses its JSON-lines Python bridge. Responses are bounded and errors are safe. Protected mode forwards configured profile names to the local engine, whose trusted configuration enforces live permission, destination grants, credentials and a finite total budget. Anonymous mode only admits fixture profiles and removes configured profile files from its subprocess environment. Live Exa search-only integration is qualified within the narrow hosted policy; broader provider and semantic quality are separate checks. Queries bind scalar parameters and named original/effective result inputs; larger integer values use lossless strings with explicit SQL casts. Effective inputs resolve one canonical app snapshot, require its exact amendment revision, and materialize effective values through `import_table` with the pinned parent dependency and app revision. The engine retains that revision and reauthorizes dependency closure.

Local Python queries return synchronously. MotherDuck queries require a `request_id` UUID before any input materialization and return an asynchronous `job_id`. `sourcesql_job_status` polls that exact job; `sourcesql_cancel_job` records cancellation for it. States are `queued`, `dispatching`, `running`, `submission_unknown`, `completed`, `failed` and `cancelled`. Pending responses contain no result handle or fabricated `result_ref`. Only a completed, authorized result exposes `result_id` for `open_research`. Ordinary result reads and reopening stored research do not submit another Flight. Job receipts expose bounded status metadata rather than query text, credentials or raw execution diagnostics.

Status polling reads and reconciles stored state without launching Python. A queued job can be resumed explicitly with `sourcesql_start_job` and its existing `job_id` when capacity is available; it retains the same saved request and dispatch gate. That tool never recovers an uncertain submission by sending it again. The synchronous local backend does not support job resumption.

Hosted effective inputs and imported engine bundles may first need a provider-free materialization Flight for canonical Python type and dependency validation. `sourcesql_query` returns that dependency's pending handle before submitting the research query. Poll it, then repeat the original query with its original query `request_id` and identical arguments after materialization completes. `import_research_bundle` likewise returns a pending dependency handle without writing app state; repeat it with the same original bundle after completion. Materializations deduplicate their content and provenance so successful retries resolve the same canonical result identity. Imported app IDs, correction revisions and request linkage remain unchanged.

Retry identical query arguments with the same `request_id` to recover the existing job. Changed arguments under that ID conflict. A lost submission response is `submission_unknown`; inspect the same job instead of automatically resubmitting or generating another UUID. Recorded cancellation immediately blocks result publication. A cancelled job can still report `pending:true` until platform stop is confirmed; its active execution slot remains held while unsettled. Engine jobs and app research requests have separate lifecycles: cancelling a job does not automatically close the request created by `expand_research` or `refresh_research`. The host can explicitly close that app request when the user requests it. Successful jobs still need `append_research` to attach the result to that request before opening the saved child.

`open_research` and `append_research` accept `result_ref: {result_id, snapshot_id, title}`. The server resolves full local data; the host does not need to copy a whole dataset into its prompt. The normal expansion sequence remains `find_research_row` → `expand_research` → `get_research_request` → `sourcesql_query` → `append_research` → `open_research`. App requests pin the parent and row/field scope before any execution. Completed retries return the existing child; changed payloads conflict; failed/cancelled requests reject late results. Refresh queries use `row_id_column`: the host projects saved IDs explicitly, the engine validates unique IDs against authorized bound inputs and removes that column from the result schema, and the app checks exact tracked scope and columns. URL/name/position remapping is never implicit. Refresh proposals require explicit `review_refresh` decisions. Legacy `verified` means returned textual support under the app review contract, not a truth guarantee.

Expansion requires an exact row; root/table refresh remains supported. The UI provides contextual correction, research links, tree navigation, Back-state restoration, source navigation, rename, archive/restore and host feature detection. A successful message acknowledgement or save does not establish a host turn or rendered component.

## Snapshots, presentation and export

v1 JSON is preserved verbatim. Its `sourceResultSetId` maps through a tagged `legacy-import` origin helper, and the original date remains declared day precision. v2 has a tagged engine origin, explicit day/instant precision, nullable source URLs, multiple sources, evidence references, full row count and immutable local `dataRef`. New engine runs require an offset-bearing instant and real run ID; imported source identifiers are never fabricated. Inline v2 snapshots enforce actual UTF-8 byte limits. Unknown logical types, unsafe numeric integers, invalid dates/offsets, malformed struct/list values and mismatched schemas are refused.

BIGINT and DECIMAL use lossless strings, DOUBLE uses finite numbers, Boolean stays Boolean, SQL NULL stays JSON null, and declared logical types drive scalar corrections even for all-null columns. Lists and structs display as compact JSON and are read-only. The engine schema, export and UI retain up to 128 declared columns; wide tables scroll horizontally. Display defaults put a human identifier first and source URLs last, decorate raw labels and compact source addresses. Canonical keys, values and SQL row order remain unchanged. User sorting cycles through ascending, descending and the original query order. Single-row payloads beyond the app allowance must be projected more narrowly; the full engine data remains retained.

The UI receives at most 100 rows per server window and automatically smaller windows when needed to fit the snapshot byte allowance. `research_page` reads later windows without rerunning the query. Count and window metadata distinguish preview from full data; search/filter controls apply to the current window. `find_research_row`, correction validation and research requests use the entire canonical local dataset, including rows outside the visible window.

`export_research` composes the full selected research tree and engine bundles, preserving originals, amendments, tree, request history and review decisions. `import_research_bundle` restores the state with identity conflicts refused, typed correction validation and dependency authorization. Engine bundles imported into a clean engine store receive local identity mappings; the app reconciles origin/run/hash/capture metadata while preserving app IDs, row values, correction revisions, tree and request linkage. The UI's Import and Export call those tools. Ordinary bounded `import_research` remains available for v1/v2 snapshots. Transport bundle inputs are capped at 16 MB; v1 limits remain unchanged.

Local app mutations acquire an atomic filesystem writer lock and reread state and revisions while holding it, across store instances and processes. Competing stale revisions conflict; they cannot overwrite an accepted amendment. A writer waits at most three seconds, then returns explicit busy. The lock has a unique owner token and is released in `finally`; there is no expiry, guessed stale owner or automatic takeover. If a process crashes, first stop and verify all writers for that store, inspect `.writer-lock/owner-<token>.json`, and explicitly remove only that confirmed stale lock directory. Do not remove a lock while any writer may still be active.

Durable app mutations use a versioned backend read and one compare-and-swap write. The version belongs to that particular read, while amendment `expected_revision` still checks the logical correction revision. There is no blind retry after a conflicting or uncertain write. A fresh read and the original mutation ID recover an already committed correction without writing it again. This backend bypasses the local filesystem lock and leaves any old local crash lock untouched. MotherDuck retains successive app-state revisions as application history; those records are distinct from platform database snapshot retention.

The local subprocess adapter uses a bounded synchronous 30-second response deadline. On POSIX each bridge runs in its own process group; timeout or response overflow stops that owned group, including its SQL worker. Windows uses ordinary child termination; the SQL worker is already unsupported there. MotherDuck uses durable asynchronous job handles rather than keeping a local Python bridge alive for Flight execution. A local timeout remains an honest transport failure; inspect/retry the same request key to recover existing run state rather than creating duplicate work.

## Qualification scope

Local engine/app tests cover typed values, source references, immutable result
validation, full-data lookup beyond the visible window, pinned corrected inputs,
research bundles, authorization and separate correction histories. Durable
backend regressions cover conflicting writers, restart recovery, idempotency,
uncertain submissions, cancellation and job capacity. Tests use controlled
providers where indicated; they do not measure live semantic quality.

Native Docker and MotherDuck integrations exercise installed execution and
persistent research. A bounded live Exa Flight retained search excerpts and its
result could be saved and reopened without another Flight. The deployed Vercel
endpoint has passed public OAuth discovery, anonymous refusal and authenticated
MCP checks. ChatGPT OAuth, table rendering, reload reconciliation, durable
correction, tree/Back navigation, a small live expansion and a fixture refresh
review have been exercised separately. Enabling custom-app CSP enforcement and
reloading still rendered the table; this is not an adversarial CSP audit.

Presentation checks cover readable labels, explicit missing values, compact
source links, mobile layout and restoration of SQL row order after sorting.
Empty provider titles remain empty in canonical data rather than being invented.
Changed tool definitions must be refreshed in the host, and saved research must
be reopened to consume a new UI resource.

These checks do not qualify broad entity-research coverage, hosted semantic
models, live refresh quality, a fresh adopter's account setup or Claude
rendering. See [current status](../STATUS.md), [provider setup](providers.md) and
[runtime qualification](python-linux-qualification.md) for the current boundaries.

UI bundles use content-derived resource identifiers. When a retired bundle is unavailable, reopen the saved snapshot with `open_research` to render it with the current UI; the saved research itself is unchanged.

Manual update proposals use the existing table controls. The table opens without an inline review panel. Its updates icon opens the full review and publication dialog; selecting a proposed cell reveals Accept proposal and Keep current in the correction panel, with evidence collapsed until requested. Choices remain adjustable until explicit publication creates a successor. Published decisions remain available as history. Ordinary corrections and earlier observations stay separate.


## Bounded result reads and curated citations

`sourcesql_read_result` returns typed rows with actual `next_offset`, source and
evidence totals, and bounded receipt/feedback metadata. It no longer repeats every
retained source body on each row page. Optional `columns` narrows wide rows.
`sourcesql_inspect_evidence` independently pages `evidence_offset/evidence_limit`
and `source_offset/source_limit`; follow the returned offsets for each collection.
An oversized record exposes its immutable index. Request `collection`,
`record_index`, `chunk_offset` and `chunk_limit` on that same tool, concatenate
`json_chunk` strings and parse the complete JSON. Chunk offsets use UTF-16 code
units, with surrogate pairs kept intact. Every page and chunk reauthorizes the
result. Arrays, offsets, omitted metadata and totals describe the response, not
loss of retained data. Full immutable records remain exportable.

Host-authored interpretations can cite already retained passages with the query's
optional `citations` array. Each entry supplies `match`, `column_key`, canonical
`source_version_id`, and an exact `quote`. The selector must uniquely identify an
output row with exact typed wire values; optional `start/end` use Unicode code
points in the canonical source. Repeated quotations require offsets. Source IDs
must belong to the query's authorized inputs or acquisitions. The coordinator
checks source identity, text hash and quote coordinates, then stores the citation
as `agent_selected_quote`. This proves a quotation exists, not semantic
entailment or factual truth. Invalid individual bindings return advisory
`citation_feedback` and cell diagnostics without deleting findings. Missing
prices or other meaningful unknowns remain valid partial research. Citation-only
repairs can use saved inputs and zero search/model budgets.

App display previews bound per-cell sources and quotations; complete canonical
evidence remains inspectable. Effective materialization preserves citations only
for explicitly identified unchanged cells; manual decisions stay separate.
