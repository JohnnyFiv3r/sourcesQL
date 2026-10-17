# Research accuracy and completion plan

Updated: 2026-10-16. This is the working backlog for answer quality and reliable
completion. The released baseline is 0.2.3; newer local changes below have not
been deployed or released. Controlled workflow checks, offline regressions and
fresh live research establish different things.

## Current evidence

The released engine preserves valid sibling extraction fields when another
field has invalid evidence. Missing facts remain SQL NULL. Existing ChatGPT and
Claude connections passed the core lifecycle on controlled synthetic data.
A bounded live research pipeline and a retained-source extraction check also
passed. These observations do not establish a first-attempt completion rate or
broad factual accuracy.

Local, unreleased work adds batched OpenAI embedding scoring, duplicate-input
reuse, per-batch usage accounting, explicit unavailable outcomes and matching
hosted policy checks. MCP guidance now describes host-authored semantic
shortlisting without mandatory metadata gates or score-first execution. Exact
model-aware token counting and token-packed batches are implemented locally.
The public Python package bundles tokenizer data and passed offline installed
checks. Compact Flight packaging requires a separate path: an admitted scoring
job retrieves official, hash-pinned tokenizer data before paid calls, within
fixed download/time bounds. The compact build and controlled startup checks
passed locally; actual hosted download remains unqualified. A cold Flight
requires this network step. Scoring uses the supplied source without an
implicit character prefix; inputs beyond the token limit need explicit passage
handling. Hosted activation, live scoring quality and complete fresh-host
research acceptance are pending.

Q01a now preserves known provider failure codes through the Python job writer,
gateway and MCP. Authorized callers receive fixed safe summaries and can inspect
the failed run when one exists. Unknown codes fall back to `execution_failed`;
provider bodies, prompts and credentials are excluded. Local failure injection
exercises the actual embedding adapter, strict engine, Flight runner and job
writer against the same DuckDB storage reopened by the gateway and MCP. This
does not yet qualify the live MotherDuck transport or canonical hosted preflight.

No backlog item is complete merely because its instructions were written or
its mock tests passed. Move an item to live-qualified only with the exercised
configuration, build identity, task, outcome and limitations recorded.

## Workflow contract

The host composes ordinary SQL for the actual question:

1. Search broadly with complementary terminology and retain the query coverage.
2. Deduplicate conservatively, preserving complementary source versions.
3. Use `SEM_MATCH` for semantic predicates. Optionally use `SEM_SCORE` to rank by
   a criterion more specific than the searches; it is not a mandatory stage.
4. Apply `SEM_EXTRACT` or `SEM_EXTRACT_ALL` to relevant source-local evidence in
   feasible batches.
5. Use collection-scoped `SEM_NORM` for equivalent values, then verified identity
   joins, consolidation, final eligibility and presentation in ordinary SQL.

SQL filters and ranking criteria remain task-authored. Missing title, geography
or date metadata is not an automatic exclusion. `WHERE` drops NULL as well as
false; retain unresolved candidates separately when they need follow-up.
Matching should cost less than detailed multi-field extraction, but that is a
measurement target rather than a guarantee from an operator's name.
Embedding similarity is neither truth probability nor an eligibility decision.
Normalization labels are neither canonical identities nor new factual evidence.

## Prioritized backlog

| ID | Work and current state | Completion evidence required |
| --- | --- | --- |
| Q01 | **Hosted preflight and actionable errors — in progress.** Q01a preserves safe provider codes and failed-run handles through the actual Python writer, gateway and MCP in local injected-failure checks. Canonical admission for signatures, schema, dependencies and bounds, richer dispatch-certainty diagnostics and live qualification remain pending. | Retained invalid-signature, timeout, rejection and unknown-outcome cases traverse the complete hosted route. The caller can inspect a failed run and take the permitted recovery action without operator SQL repair. Provider-free validation must describe any compute it consumes honestly. |
| Q02 | **Durable successful work — pending.** Retain successful fanout branches and completed extraction stages when siblings fail or a later stage reaches a deadline. Expose reusable intermediate handles and pending coverage. | Failure injection preserves successful siblings and completed batches across process restart. Known no-dispatch, known rejection and uncertain remote outcome permit different recovery actions; uncertain calls are never replayed automatically. Raw discovery is not presented as completed research. |
| Q03 | **Feasible semantic work and exact accounting — partly local.** Batched embedding scoring, exact model-aware token reservations and token-packed requests are implemented locally; the public wheel passed offline tokenizer checks. Compact Flight build and controlled startup checks passed locally; its live download remains unqualified. Detailed extraction still needs time/output-aware batching and durable continuation; live cost and quality measurements remain pending. Candidate scoring has a separate allowance; `SEM_MATCH`, extraction and `SEM_NORM` share the current semantic-document allowance. Shared request/token/runtime bounds still apply. | Token and input limits cover multilingual and long text; oversized inputs require explicit passage handling. Compact Flight preparation respects package, download and runtime limits and cannot make paid calls after preparation fails. Representative matching, optional scoring, extraction and normalization report actual calls, tokens, elapsed time and coverage. A many-entity request finishes in bounded batches or names what remains without silent truncation. |
| Q04 | **Query coverage and reusable hit provenance — pending.** Make query/facet/rank/request provenance available to SQL. Distinguish hits, document candidates, immutable versions, entity candidates and independent sources. Surface effective search breadth when caps reduce intake. | Overlapping searches retain their provenance and merge complementary hits without consuming the shortlist as duplicate documents. Coverage shows missing facets and can refill an underperforming shortlist. More hits are not reported as more verified entities. |
| Q05 | **Source-local entities and complementary claims — pending.** Preserve provider identity metadata when it is actually supplied and supported by the adapter; derive task-specific identities when needed. Extract local facts, establish explicit identity bridges and combine complementary sources before final eligibility. | Announcement and progress sources jointly support one eligible entity. Similar names for different sites, phases, editions or study arms remain separate. Shared city/company or a normalization label cannot silently merge entities; conflicts remain inspectable. |
| Q06 | **Reach relevant evidence with intact coordinates — pending.** Support retained source windows/sections, inspected and omitted ranges, original offsets and trusted metadata context. Current prefix-oriented retrieval/extraction can miss later facts. | A fact beyond the initial prefix is reachable and cites the exact retained source span. Newly acquired versions are explicit. Publication date, event date, observation time and verification time remain distinct; metadata is not fabricated as a verbatim quote. |
| Q07 | **Claim meaning and cell evidence — partly released.** Exact quotation validation and independent invalid-field isolation exist. Strengthen unit, qualifier, basis, entity/phase scope, status, as-of context and supported lineage through multi-entity transformations. | Tests retain “up to,” approximate, planned/operating and part/whole distinctions. Supported `UNNEST`, filtering and joins retain the correct item/field evidence. Derived sums and normalized values disclose dependencies rather than masquerading as directly quoted values. |
| Q08 | **Explained unknowns and bounded gap follow-up — guidance only.** Add durable entity/field gap state, attempted paths and stopping reasons. Reuse saved sources, then relevant sections, then targeted discovery within the existing authorized allowance. | Unstated, uninspected, ambiguous, conflicting, failed and capacity-limited cells remain distinguishable. Useful unknowns can publish; central omissions make the answer visibly partial. Execution completion and research completeness are evaluated separately. |
| Q09 | **Fresh-host acceptance and independent quality evaluation — pending.** Exercise ordinary prompts in ChatGPT, then Claude, without operator-authored replacement SQL. Record every untouched attempt and safe internal continuation. | Useful final apps appear with no unapproved external-search fallback or false completion claim. Evaluate source-local field adequacy, entity/coverage obligations, meaningful unknowns, citation precision, interventions, latency and costs with small-sample denominators. |
| Q10 | **Adopter access to the research profile — pending.** Guided personal-cloud setup currently defaults to search-only. Add explicit setup for model/embedding capabilities, secret bindings and visible spending/capacity controls after their contracts are qualified. | A clean installed setup advertises and executes exactly its configured adapters. Missing capabilities and exhausted configured capacity produce truthful app states; application reservations never imply a measured provider balance. |

Implement Q01–Q03 first so later accuracy work can finish and recover reliably.
Q04–Q08 form the evidence and coverage work; they should be evaluated on unrelated
tasks rather than domain-specific templates. Q09 is the acceptance gate for each
meaningful change, with Q10 keeping adopter behavior aligned with what passed.

## Active slices

- Q01a: safe failure transport and failed-run inspection — locally verified.
  All 796 Python tests and 357 app/gateway/MCP tests passed, with 44 opt-in
  Python cases skipped; the app build passed. An independent source review found
  no blockers. Live MotherDuck transport qualification remains pending.
- Q01b: canonical hosted preflight — next. Reuse Python admission rather than
  adding a second SQL validator. Record any validation compute separately.
- Q01c: complete dispatch-certainty and recovery diagnostics, then qualify the
  hosted route. An actionable code alone cannot prove whether a remote call ran.

## Acceptance set and recording

Use retained-source regressions and deterministic failure injection before paid
tests. The minimum set includes an invalid SQL signature; failed fanout sibling;
invalid cell among valid siblings; completed stage before a deadline; more
entities than one extraction response can contain; complementary facts across
two sources; look-alike entities that must remain separate; later-section facts;
legitimate unknowns; conflicting quantities; transformed cell lineage; and
capacity exhaustion with saved work preserved.

Then run a small live set spanning a multi-source entity investigation, a
product/policy comparison, a catalog with many entities, and an unrelated study
or documentation question. Define required evidence and coverage before running.
A first attempt is one ordinary request that reaches a useful final app without
operator intervention. Bounded internal stages are allowed. A deliberate
uncertain-outcome failure must stop safely rather than be forced to succeed.

Record each attempt's build and profile hashes, authored SQL, query coverage,
source versions, app outcome, unresolved obligations, intervention count,
dispatch certainty, runtime, reservations and observed provider usage. Keep
private run evidence outside public artifacts. Quote matching alone does not
establish truth, currentness or completeness.
