# Exa research modes

The hosted Exa adapter previously hardcoded `type: "auto"`. Its first live
qualification deliberately enabled only bounded search excerpts: no document
fetches, semantic model or embedding adapter. That explains why installing an
Exa key did not expose all Exa capabilities. The MCP descriptions also explained
execution recovery without teaching agents to use sourcesQL for initial research.

The updated server publishes a research workflow in MCP initialization and in
query/capability tool descriptions. Agents must discover configured profiles,
choose a live profile explicitly, use sourcesQL for invoked research, preserve
source support, and reopen stored results. Any approved alternative research tool
must keep its own provenance. The engine's default remains synthetic `fixture`;
fixture output is never a fallback for unavailable live research.

Research execution and presentation are separate. Raw discovery and intermediate
SQL results stay behind the scenes; `import_research` saves without rendering.
Only `open_research` advertises a rendering resource, and the agent calls it once
after final filtering, columns and display labels are ready. Completed-query
receipts no longer instruct the host to open every intermediate result.

## Versioned hosted profiles

Existing deployments without `SOURCESQL_EXA_POLICY_VERSION` retain the approved
`exa-search.v1` contract: only `exa` with Auto, a 60-second dispatch window and the
same policy fingerprint. This allows instruction/presentation fixes to ship
without changing the execution resource or secret binding. The following optional
v2 profiles require `SOURCESQL_EXA_POLICY_VERSION=exa-research.v2` and a reviewed
v2 Flight. Its exact version marker is checked before reserving execution.

| Profile | Exa search type | Intended use |
| --- | --- | --- |
| `exa` | `auto` | Broad candidate acquisition across planned complementary queries |
| `exa_deep` | `deep` | Selective multi-step retrieval for difficult questions or evidence gaps |
| `exa_deep_reasoning` | `deep-reasoning` | Explicit higher-effort retrieval when reasoning depth is needed |

All three are operator-controlled profiles, not arbitrary request configuration.
The `exa-research.v2` policy fingerprint includes the exact mapping. Request bodies
cannot replace the provider, mode or search type. Both gateway dispatch and Flight
claim/execution verify the policy. An old queued job with a different policy must
be reconciled rather than silently run with new behavior. Existing saved results
retain their original immutable provenance.

For broad discovery, the host agent generates at least six maximally diverse
`WEB_SEARCH` query strings from the user's request, varying terminology, source
type and angle, with relevant synonyms, subcategories and geography. This uses
the host's normal search planning rather than fixed domain templates or a
separate term-generation model. Useful overlap is intentional; near-identical
paraphrases add little coverage. Targeted follow-up research or known-source
checks may need fewer queries. Merge results and deduplicate sources without
losing query-hit provenance. Each input produces a separate Auto request with its own
ranking and source versions. The current hosted allowance permits only two
inputs and ten total pages; it does not implement thousand-page acquisition or
accommodate the six-query broad-discovery instruction. The agent must explain
that constraint before searching and request a suitable configuration or an
explicitly authorized limited pass. It must not silently shrink coverage or
split jobs to evade limits. Updating instructions does not raise execution caps.
Exa also documents
`additionalQueries` for deeper retrieval, but its combined result pool does not
provide the per-input attribution and result limits our SQL operator promises.
We therefore do not silently map variadic SQL inputs onto that different contract.
There is no invented Exa `type: "broad"` value. See the
[official Search API](https://exa.ai/docs/reference/search).

For example, only after an explicitly authorized limited two-query pass, submit
this SQL using `profile: "exa"`, `source_mode: "allow_excerpt"`, and a new hosted
request UUID. This is a limited example, not the broad-discovery default:

```sql
SELECT url, title, content AS source_excerpt
FROM WEB_SEARCH(
  'Tennessee municipal drinking water utilities official directory',
  'Tennessee investor owned water utilities regulated companies official records',
  per_query_limit := 5
)
LIMIT 10
```

These are candidate source pages, not a verified census of ten utilities. Poll
the same job, read its receipt, then use `open_research` with the completed result
reference. A final SQL `LIMIT` does not itself limit provider work.

## SQL controls expensive semantic work

Quality-first means useful coverage and selective strong reasoning, not deep
retrieval for every discovery query or semantic processing of every row. The SQL
pipeline remains authoritative: acquire candidates, apply justified deterministic
filters, merges, joins and source deduplication where admitted, use semantic
matching only where needed, then
extract the requested fields from surviving rows. Source-local ordinary `WHERE`
conjuncts execute before semantic predicates, regardless of their textual order;
`SEM_MATCH` executes before projected extraction. A filter on an extracted value
cannot save the extraction it depends on. Filters do not cross CTE or LIMIT
boundaries, and a final output LIMIT cannot be advertised as a model-call cap.
Only an explicitly staged shortlist permitted by the user's scope reduces that
input population without silently changing the task.

These savings apply to subsequent semantic work. A SQL filter over returned
search pages cannot undo the cost of the Exa request that acquired them. Avoid
unnecessary searches by reusing saved candidates, and choose query scope before
submitting retrieval. Joins may multiply rows; deduplicate repeated source work before semantic
processing. A top-candidate rule must match the requested scope and disclose its
coverage. Deep-reasoning retrieval is an optional escalation, not the default
replacement for broad Auto discovery or SQL-controlled semantics.

The planner regression compares three candidate sources: the unfiltered plan
makes three semantic matches and two extractions; an exact title filter makes
one match and one extraction; an empty exact filter makes no semantic call.
This proves execution mechanics with synthetic providers, not hosted live model
quality. Hosted semantic operators still need a separately configured adapter.

## Costs and limits

The optional v2 limits are two query inputs, two search requests, ten total
candidates, no fetch/model requests, a 100-second dispatch window, F4 runtime at most
120 seconds, $0.05 per-job provider approval and $1 daily provider reservation.
Existing v1 deployments retain their 60-second query window and exact policy.
Search result counts are intentionally bounded by these product limits. The
deep-reasoning HTTP client has a bounded 60-second timeout; no automatic retries
or fallback to ordinary search are added. The engine window leaves 20 seconds
within the Flight limit for startup/finalization and accommodates the documented
12–40 seconds per deep-reasoning request; slow or uncertain work still terminates
honestly instead of silently retrying paid requests.

Exa's October 14, 2026 pricing lists $0.012 for deep, $0.015 for deep-reasoning and
$0.007 for auto per request with up to ten results. Two default Auto searches
therefore have a $0.014 nominal estimate; two deep-reasoning searches are $0.030. These numbers and response estimates are not
reconciled bills. `/search` does not document a per-request cash hard stop; our
finite grants and daily reservations do not promise account-wide billing control.
See [Exa pricing](https://exa.ai/docs/admin/pricing).

The free Exa balance resets to $10 monthly, rather than daily. This allocation,
MotherDuck compute allowances, and sourcesQL's per-day reservations are separate.
Quality-first adoption preserves requested coverage and selective semantic
quality; exhausted allowances are reported rather than silently shrinking scope
or enabling automatic paid top-up. Auto is the intended broad retrieval mode,
not a fallback after the budget is spent.
The application reservation is not a live reading of an account's free credit
balance and cannot guarantee free usage when other applications spend credits.

## Remaining capabilities

Search mode does not enable the hosted `WEB_FETCH` or `SEM_*` operators. The
profile still explicitly reports those limits. Exa's structured `outputSchema`
and grounding need a separate mapping into sourcesQL's typed fields, retained
sources and verified textual support; generated synthesis must not become source
evidence merely because it arrived in the same response.

For asynchronous list building, enrichment and continuing research, Exa's
[Agent API](https://exa.ai/docs/agent/quickstart) is the relevant separate surface.
It needs durable external run IDs, terminal-state inspection, grounding storage,
cancellation and lost-submission recovery. It should not be hidden inside a short
Flight polling loop. The fixed low effort is documented at $0.025; metered auto
has a configurable budget with a $1 minimum and a larger default. No Agent run,
subscription or new credential destination is enabled by this search-mode change.

## Wider research and grounded extraction

The opt-in `exa-research.v3` policy separates ordinary defaults from explicit
research ceilings. Its configured maximums are 32 query strings, 48 search
requests, 2,500 returned candidates, 40 document fetches and four concurrent
search requests. Each Exa query accepts at most 100 results. These are ceilings,
not default work sizes or evidence that a run found that many relevant entities.
Existing v1 and v2 deployments retain their original fingerprints and limits.

Use `SOURCESQL_EXA_POLICY_VERSION=exa-research.v3` in both the gateway and its
reviewed Flight. To enable semantic extraction, configure
`SOURCESQL_OPENAI_MODEL` and `SOURCESQL_OPENAI_SECRET_NAME` together and bind that
MotherDuck Flight secret with its `OPENAI_API_KEY` entry. The gateway needs the
secret's name, not its value. The policy fingerprint includes the model identity
and effective limits; dispatch refuses a different model or missing secret
before reserving or submitting a Flight. Without a model, v3 exposes search and
fetch but reserves zero semantic/model tokens. It never advertises embeddings
as configured merely because a language model is available.

The host still plans the search terms. Inspect the composition of the acquired
sources before semantic work: company profiles may help organization discovery
but provide little project-level evidence. Use task-appropriate SQL to route
source types, deduplicate repeated URLs and preserve the excluded population
for coverage review. Do not turn a prioritized document sample into a claim of
complete entity coverage.

Default to `source_mode: "allow_excerpt"` for discovery. After SQL filtering,
`WEB_FETCH(url)` can materialize retained source text for each surviving row;
use one multi-field `SEM_EXTRACT` or `SEM_EXTRACT_ALL` per document where useful.
Exa Contents is not verified complete document coverage. Setting
`require_document` may trigger fetching all incomplete search hits before SQL
filtering, and refuses text that does not establish completeness.

Native OpenAI extraction uses Responses with storage disabled and no hidden SDK
retries. Explicit OpenAI-compatible endpoints retain Chat Completions. Models
copy exact supporting quotations; the adapter establishes their character
coordinates deterministically in the inspected window. Missing, altered and
ambiguous quotes are refused. Valid preexisting coordinates can disambiguate a
repeated quote. Text support still does not establish factual truth, freshness
or correct entity identity.

The model output ceiling includes reasoning tokens. Input tokens are accounted
from reported usage after dispatch; cost figures and application reservations
remain estimates, not a provider billing hard stop. Use finite request/token
limits and a separate total experiment budget. Broader ceilings do not extend a
Flight's runtime or its daily application reservation. Local qualification and
hosted deployment must be recorded separately.

## Evidence and coverage

Retained exact quotes establish support in the inspected provider text. Final
projections currently carry input-set lineage; they do not establish direct cell
attribution. Inspect the retained field-named support and source dates, and keep
historical plans distinct from current status.

A document can establish one requirement while leaving another unknown. For
entity research, reconcile identity across complementary announcement and progress
sources before making the final eligibility decision. A missing date in one
source is unresolved evidence, not proof that the entity is ineligible. Explicit
shortlists limit coverage and may require a separately authorized follow-up.
