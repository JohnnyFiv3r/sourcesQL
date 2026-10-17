# Exa research modes

Exa acquires source candidates; sourcesQL's SQL operators select, inspect and
combine their evidence. The host assistant plans the terms and writes the query
for each question. The engine admits the query, executes configured providers
within finite limits and retains results and receipts.

Start with `sourcesql_capabilities`. It reports the selected profile's actual
search modes, operators, limits and model availability. Grammar support does not
mean every deployment has the corresponding adapter. Choose a live profile
explicitly: the omitted profile remains synthetic `fixture`, which is never a
fallback for unavailable live research.

## Discovery and search modes

| Profile | Exa search type | Intended use |
| --- | --- | --- |
| `exa` | `auto` | Broad candidate acquisition across complementary queries |
| `exa_deep` | `deep` | Selective retrieval for difficult questions or evidence gaps |
| `exa_deep_reasoning` | `deep-reasoning` | Explicit higher-effort retrieval when reasoning depth is useful |

These are operator-controlled profiles. Query text cannot replace the provider,
mode or trusted configuration. There is no invented `broad` search type.

For broad discovery, generate at least six diverse `WEB_SEARCH` query strings
when the advertised limits and approved budget permit that scope. Vary terms,
source types and angles, including relevant synonyms, subcategories and
geography. Use normal task-specific search planning rather than fixed domain
templates or a separate term-generation model. Useful overlap is intentional;
near-identical paraphrases add little coverage. Targeted follow-up or a known
source may need fewer queries.

Each query string creates a separate request with its own ranking and source
versions. Preserve that membership when merging overlapping results. Exa's
`additionalQueries` combines retrieval differently; the adapter does not silently
substitute it for variadic SQL inputs and their per-query limits. See the
[Search API](https://exa.ai/docs/reference/search).

Bind `q1` through `q6` to the assistant's terms and submit this candidate-discovery
query only when the profile and budget permit six requests and up to thirty hits:

```sql
SELECT title AS source_title, url AS source_url, content AS source_excerpt
FROM WEB_SEARCH($q1, $q2, $q3, $q4, $q5, $q6, per_query_limit := 5)
```

Use `source_mode: "allow_excerpt"` for discovery. These rows are source pages,
not a verified entity inventory. All positional arguments are strings; a count
belongs in `per_query_limit`. A final SQL `LIMIT` only bounds returned rows.

If the configured limits cannot support the requested coverage, explain the
constraint before searching and obtain a suitable configuration or an explicitly
limited pass. Do not silently shrink the research, raise caps or split jobs to
evade limits.

## Semantic shortlisting and detailed extraction

The host composes each research query with supported SQL and semantic operators:

1. Acquire complementary sources and conservatively deduplicate equivalent
   source versions. Preserve versions that contain different dates, entities or
   supporting facts.
2. Use `SEM_MATCH` as the LLM predicate for source relevance. Ordinary SQL filters
   are available for established exclusions in the user's scope; title, URL and
   metadata filters are not mandatory gates. Missing metadata is not evidence of
   irrelevance.
3. Optionally use `SEM_SCORE` in an ordering stage when the criterion is more
   specific than the original searches. Discovery results are already ranked for
   their search terms. Additional scoring is neither a required first stage nor
   a replacement for factual qualification.
4. Fetch additional retained text when necessary, then run `SEM_EXTRACT` or
   `SEM_EXTRACT_ALL` on relevant sources. Extract multiple precise fields from a
   source together where useful, preserving units, dates and qualifiers.
5. Apply `SEM_NORM` to equivalent extracted values, then use ordinary SQL joins,
   grouping, projections and ordering to consolidate the final table.

The selected language model executes matching, extraction and normalization.
The embedding adapter executes scoring. `SEM_MATCH` does not require embeddings;
a language model alone does not enable `SEM_SCORE`. Scores measure relevance,
not truth, and do not have a universal cutoff across models or criteria.
Normalization labels belong to the inspected collection and do not establish
that similarly named entities are identical. Use ordinary SQL for deterministic
formatting and preserve original observations beside normalized values.

Ordinary SQL semantics apply. `WHERE SEM_MATCH(...)` keeps true and drops false
and NULL. If inconclusive candidates need investigation, project the match into
a CTE or saved result and retain NULL rows separately for bounded follow-up.
An excerpt may omit the relevant fact; fetch or inspect the retained source
before treating that gap as a negative. Retaining an unresolved candidate does
not qualify it for the final answer. The [language reference](language.md)
contains an example and the admitted SQL subset.

Source-local ordinary `WHERE` conjuncts execute before semantic predicates, and
`SEM_MATCH` runs before projected extraction. Those mechanics do not require a
metadata filter in every query. Filters on extracted fields run after their
extraction. Filters do not cross CTE or LIMIT boundaries. An explicitly staged
shortlist or extraction batch can bound later work; it must preserve the user's
requested coverage or disclose what remains unresolved.

`SEM_EXTRACT_ALL` supports at most eight items per source invocation. Partition
larger requested entity sets or supported source windows into explicit batches
and retain completed handles. This limits one invocation, not the total answer.
Neither model-call limits nor a Flight's runtime guarantee that every configured
maximum can be consumed in one job.

## Fetching, evidence and reuse

Use `WEB_FETCH` only for known source URLs allowed by the trusted fetch policy.
Fetch relevant or unresolved sources when their retained excerpt is insufficient.
`require_document` can fetch incomplete hits before SQL shortlisting, so it is
not the broad-discovery default. Exa Contents text remains a bounded provider
representation, not verified complete document coverage.

An input binding with `view: "sources"` and `amendment_revision: null` exposes
retained canonical source documents from an authorized result and its ancestors
without another fetch. Reuse those saved rows for semantic follow-up, ordinary
SQL and gap investigation. Keep successful batch handles instead of repeating
all discovery after an extraction failure.

Native OpenAI extraction uses Responses with storage disabled and no hidden SDK
retries. Explicit OpenAI-compatible endpoints use Chat Completions. Models copy
supporting quotations; the adapter checks their coordinates in the inspected
text. Missing, altered or ambiguous quotes leave the affected value unavailable
under `retain_partial`, while independently supported siblings can survive.
An ordinarily missing fact remains distinct from failed processing.

Exact quotes establish textual support, not truth, freshness or identity. Carry
source publication and claim-specific as-of dates separately from retrieval time.
Historical announcements do not establish current progress. A source can support
one requirement while leaving another unresolved. Combine complementary facts
only after a shared entity or site identifier, address or explicit source bridge
establishes identity; a common company, region or investment amount is only a
lead. Preserve unresolved identities separately.

Canonical cell evidence survives supported direct projections, aliases, CTEs,
struct fields, filters, ordering, joins and branch-specific `CASE`/`COALESCE`.
Aggregates, set operations and unsupported transformations retain input-set
evidence rather than claiming direct cell citations. Inspect evidence before
promising cell-level support; a URL or matching value alone is insufficient.

## Hosted configuration and limits

The gateway and Flight must agree on the reviewed policy and its fingerprint.
Saved results retain their original immutable provenance. A queued job with a
different policy must be reconciled rather than silently run under new settings.

- `exa-search.v1` is the legacy Auto search-only policy with a 60-second dispatch
  window.
- `exa-research.v2` adds the search-mode profiles above, while retaining a small
  search-only allowance: two inputs, two requests and ten candidates, with a
  100-second dispatch window.
- `exa-research.v3` permits configured research ceilings of 32 query strings,
  48 search requests, 2,500 candidates, 40 fetches and four concurrent searches.
  Exa accepts at most 100 results per query. Language-model and embedding work
  are separate opt-ins.

These are policy ceilings, not default workloads or a statement about which
version a particular endpoint is running. Read that endpoint's capabilities.
A higher candidate ceiling does not lengthen the F4 Flight's 120-second maximum
runtime. Runtime, request and token limits still bound each stage.

Configure `SOURCESQL_EXA_POLICY_VERSION=exa-research.v3` in the gateway and its
reviewed Flight. For matching, extraction and normalization, set
`SOURCESQL_OPENAI_MODEL` and `SOURCESQL_OPENAI_SECRET_NAME` together. Bind that
MotherDuck Flight secret with its `OPENAI_API_KEY` entry. The gateway receives
the secret name, not its value.

For optional OpenAI embedding scoring, set
`SOURCESQL_OPENAI_EMBEDDING_MODEL` and
`SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME` together. The hosted adapter accepts
`text-embedding-3-small` or `text-embedding-3-large`; start with the small model
and qualify its ranking on representative retained sources. The embedding secret
also supplies `OPENAI_API_KEY`. Explicitly naming the existing model secret can
reuse its credential without treating language-model setup as embedding consent.
The reviewed Flight must bind the named secret and match the descriptor.

The embedding adapter uses model-aware local tokenization and reserves exact
input token counts before dispatch. The public package bundles tokenizer data;
the compact Flight prepares the same checksum-pinned public data before live
scoring. The `openai-embeddings.v2` descriptor binds this behavior;
an earlier scorer's cached results cannot substitute for the new contract.
See [scoring limits and passage handling](providers.md#semantic-matching-ranking-and-normalization).

Model and embedding identities participate in the policy fingerprint. Leaving
embeddings absent preserves the existing unconfigured contract; only an
explicitly configured scorer advertises `SEM_SCORE`. Configuration and fixture
checks do not establish live ranking quality or latency.

## Costs, capacity and presentation

Search, Contents, language-model inference, embeddings and MotherDuck compute
are separately metered. Consult [Exa pricing](https://exa.ai/pricing) and the
configured model provider's pricing rather than assuming an advertised credit
balance is available to this account. Response usage and application reservations
are estimates, not reconciled bills or account-wide hard stops. Other applications
can consume the same credits.

All calls require finite approved budgets. A SQL filter cannot undo acquisition
costs already incurred. Saved data can avoid repeat retrieval, and semantic
shortlisting reduces detailed extraction work. Do not infer a cost or latency
advantage solely from an operator name; measure the configured providers and
actual batch sizes.

Keep source discovery and intermediate tables behind the scenes.
`import_research` saves without rendering. After final filtering, consolidation,
column selection, labels and ordering, call `open_research` once for the finished
table. A stored result or completed query is not automatically the final answer.
Reopening it performs no new search. Actual host rendering must be verified
separately from a successful tool response.

When capacity is exhausted, retain the job and show its returned capacity state
in the app. Do not change providers, increase limits or claim a platform's free
balance is empty based only on an application reservation. An explicitly approved
limited or partial result must disclose its coverage.

## Separate Exa capabilities

Exa structured `outputSchema` and grounding need a separate mapping into typed
fields, retained sources and verified textual support. Generated synthesis does
not become source evidence simply because it arrived with search results.

The asynchronous [Agent API](https://exa.ai/docs/agent/quickstart) is a separate
integration for list building and longer research. It needs durable external run
IDs, status inspection, grounding retention and lost-submission recovery. It is
not enabled by selecting deep search and should not become a hidden polling loop
inside a short Flight. No Agent run or subscription is implied by this setup.
