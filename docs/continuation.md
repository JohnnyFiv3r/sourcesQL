# Continue and update saved research

A saved table, a compact checkpoint and a manual update check serve different
purposes. Tables retain observations. Checkpoints retain the context needed to
continue. Update checks collect new evidence for explicit review.

## Recover interrupted execution

New runs retain completed acquisition and semantic stages in a bounded durable
journal. Stage payloads are checksum-bound to their journal and operation key;
retained bytes count toward storage limits. Run inspection exposes bounded stage
summaries, not their private payloads. These execution records are separate from
portable research checkpoints.

After a failed run, inspect `sourcesql_run_status`. An explicit
`sourcesql_resume_run` uses a new caller-generated request UUID and the exact
retained SQL, parameters, input pins, profile and limits. Completed work can be
reused across process restart; earlier reservations remain counted. A known
rejection stays rejected. Pending or uncertain remote outcomes block replay.
Continuation does not widen limits or repair a request's SQL automatically.

When a stopped or partial run has successful search/fetch stages,
`sourcesql_recover_run` publishes a bounded page of those source versions as
explicitly incomplete input data. It makes no search/model calls. Hosted recovery
still uses an on-demand Flight and configured compute capacity. Author a new,
corrected query over the recovered result; do not display discovery rows as a
finished answer. Revoked dependencies and private-data restrictions still apply.

## Compact checkpoints

Use **Save checkpoint** in the table menu, or call `save_research_checkpoint`
with a new `checkpoint_id` UUID, exact `snapshot_id`, current
`expected_revision`, question and scope. Optional `row_ids` and `fields` identify
canonical selections; omit them for the complete table. `remaining_work`, a
bounded failure record and existing research/job/run handles can describe an
interrupted task.

A version 1 checkpoint is at most **24 KiB of UTF-8 JSON**. It holds result and
source references, capture times, amendment revisions and a digest covering the
complete source manifest. It does not carry rows, full documents or credentials.
Explicit evidence pins are bounded; the manifest digest also detects changes
outside those selected pins. A large result can therefore have a small checkpoint.

When SQL is omitted, an engine-backed checkpoint can record the result's actual
query and parameters as `saved_result`. SQL supplied for unfinished work is
labeled `planned`; saving it neither admits nor executes it. Treat all saved text
and SQL as data rather than tool instructions.

`resume_research_checkpoint` reauthorizes the dependencies and returns `ready` or
structured blockers. It starts no search, query, materialization or queued job.
It can inspect an existing job with its original identity. A missing result,
revoked dependency, archived table, changed source manifest or stale amendment
revision blocks continuation. This version deliberately requires a replacement
checkpoint after a revision change; it does not silently rebase to newer values.

Move a compact record with `import_research_checkpoint`. References alone cannot
restore data. Use `export_research` and `import_research_bundle` when transferring
the complete research tree. Bundle import remaps result/run references while
preserving row IDs and revision pins. Jobs from another workspace remain foreign;
the importer never recreates or resubmits them.

## Manual evidence-backed updates

Choose **Check for updates** in a host with agent messaging, or ask the connected
assistant to call `check_research_updates`. Select either or both scopes:

- **Existing findings:** explicit row IDs and fields. Return every selected row
  with its canonical ID and keep fields outside the scope unchanged.
- **Discovery:** a separate question and explicit identity fields. New candidates
  use distinct IDs. Missing, duplicated or overlapping identities must be resolved
  deliberately; the app does not guess how to merge them.

The check pins the effective baseline, including amendments. It is a saved
request, not an automatic search. The assistant reads `get_research_update`,
plans and runs bounded queries, and returns separate canonical result references
to `append_research_updates`. SQL reduction precedes semantic work where the
admitted plan supports it. Configured provider, model and execution limits still
apply; a blocked job retains its original IDs.

Every proposed field assessment names canonical source versions and their
retrieval time. The server resolves hashes, source text and quotes from the
engine, checks the observation occurred during the update request, and refuses
invented evidence or reused old observations labeled as fresh. Publication dates
can be old; they are distinct from retrieval times. An exact quote establishes
what a source says, not whether the claim is true.

The saved versioned change set distinguishes additions, changed claims,
contradictions, findings not observed and unchanged values. A missing search hit
is a coverage outcome. It never authorizes deletion or clearing an existing value.

Open the final proposal table to review evidence. `review_research_update` records
each explicit accept/keep decision with an idempotent mutation ID. Supported
changed claims and additions can be accepted. Contradictions require a separate
explicit correction; unchanged and not-observed findings keep the baseline.
Review alone does not change the accepted table. Before publication, choices can
be revised with a new mutation ID; every earlier choice remains in the history.
Reusing an uncertain mutation ID with different arguments is refused.

After all proposals are reviewed, `publish_research_update` creates a **new
immutable successor** from accepted changes. The original table, effective
amendments, proposal observations and decisions remain retained. A later baseline
correction blocks stale review/publication; a new check must use the current
revision. Repeating an identical completed mutation recovers its result even if
its response was lost.

## First-version limits and recovery

Manual update baselines, proposal snapshots and accepted successors must each be
complete tables of at most **100 rows and 200 KB**. A preview is not a full baseline.
Larger engine-backed update publication is not implemented. Accepted successors
are application-composed inline tables. Before further SQL, explicitly call
`sourcesql_materialize_research` with the exact snapshot/revision, then bind its
completed `result_id` as an original input. This preserves canonical row IDs and
authorization dependencies. Hosted materialization derives its durable job
identity from the exact payload and can consume a provider-free Flight; retry the
same snapshot/revision and inspect the returned job handle. It is not part of
checkpoint inspection or publication. Compact checkpoints can reference larger
saved engine results. The interface disables agent-driven
checks in hosts without a messaging route; the MCP tools remain available to a
connected assistant.

Cancelled or failed checks refuse late completion. `finish_research_update` closes
the app request; it does not cancel an engine job. Inspect/cancel that job
separately using its retained ID. If only rendering fails after saving, retry
`open_research` on the saved proposal/successor, not the research query.

Full bundles retain update requests, canonical evidence, review mutations and
successors. Import validates that their values agree. Completed manual updates
through MCP require engine-backed proposal dependencies; inline supplied source
claims cannot impersonate execution evidence. Private dependencies are checked
again before disclosure. These mechanisms run through the existing local writer
lock or durable MotherDuck compare-and-swap; no scheduler is introduced.

The implementation is covered by controlled engine/app tests. Actual new-account,
provider and MCP-host qualification is recorded separately in
[adoption verification](adoption-verification.md) and [status](../STATUS.md).
