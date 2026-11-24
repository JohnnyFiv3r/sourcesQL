# Implemented SQL and research operators

sourcesQL accepts one DuckDB-style SELECT or nonrecursive WITH query. It resolves
only explicitly bound `input.<alias>` results, CTEs, derived relations and the web
sources below. Closed AST validation rejects commands, physical tables, catalogs,
file readers, extensions, arbitrary functions and multiple statements. Parameters
use `$name` bindings; values never become SQL identifiers or interpolated SQL.
`$` is always a parameter sigil (`$q1,$q2` and `$q1, $q2` admit identically);
dollar-quoted string literals are not part of the language.

Pure SQL includes INNER/LEFT/CROSS joins, DISTINCT, GROUP BY/HAVING, set operations,
ORDER BY/LIMIT/OFFSET, approved arithmetic/string/JSON functions, scalar casts,
projected UNNEST, list/struct access, and the tested ROW_NUMBER/RANK/DENSE_RANK/LAG/
LEAD windows. Pure correlated EXISTS and scalar subqueries are implemented. This
is an allowlist, not a claim of all DuckDB syntax. String helpers include typed `split_part(text, delimiter, integer_index)` and
two-argument `regexp_matches(text, pattern)`; regex options are not admitted.

The installed signatures are:

- `WEB_SEARCH(q1, ..., q32, per_query_limit := 1..100, published_after := 'ISO date or offset-bearing instant', published_before := ..., undated_policy := 'include'|'exclude'|'error', allow_post_filter := true|false)`
Exa accepts up to 100 results per query; other providers and fixture mode accept at most 20. Profile limits and explicitly chosen run budgets also apply. Ordinary defaults remain eight search queries and 200 candidates.

- `WEB_FETCH(url1, ..., url32, mode := 'cache_preferred'|'live')` returns the source columns plus `fetch_status` (`ok` or `failed`) and `fetch_failure`. See [Researching URLs your agent found](#researching-urls-your-agent-found).
- `SEM_MATCH(text, 'predicate')` is an LLM semantic predicate returning Boolean or SQL NULL. It does not require embeddings.
- `SEM_EXTRACT(text, 'definition', type := 'VARCHAR'|'BOOLEAN'|'BIGINT'|'DOUBLE'|'DECIMAL(18,2)'|'DATE'|'TIMESTAMPTZ', evidence := true|false)` returns a nullable scalar. Alternatively, named `field := 'definition'` options produce a compile-time VARCHAR struct; `type` cannot combine with named fields.
- `SEM_EXTRACT_ALL(text, 'entity definition', field := 'definition', ..., evidence := 'per_field')` returns a list of structs, or a list of VARCHAR scalars without named fields.
- `SEM_SCORE(text, 'criterion')` returns a finite embedding similarity score or NULL. Use it for optional `ORDER BY` relevance ranking when the criterion is more specific than the original searches. Fixture scores are explicit lookup values; live scores require a separately configured embedding adapter. Scores are not probabilities or comparable across arbitrary models and criteria.
- `SEM_NORM(value, 'equivalence guidance')` materializes one mapping over the eligible source-local collection. Its labels are scoped to that collection.

Publication filters require an explicit `undated_policy`. Date validity is checked
before dispatch. `allow_post_filter := true` explicitly accepts a provider's local
publication filter when native filtering is unavailable. It does not authorize a
provider, private disclosure or live spending. Providers refuse unsupported filter
behavior; source receipts retain population and coverage limits. Search strings
are bounded to 2,000 characters and semantic definitions to 4,000 characters.

External expressions read one materialized source relation. SEM_MATCH supports
projected Booleans and top-level WHERE conjuncts. Projected WEB_SEARCH/WEB_FETCH
can use deterministic row string expressions and feed UNNEST. Stage semantic work
before joining, grouping or windows in a later CTE. Mixed semantic OR/NOT, semantic
JOIN ON, correlated external work, recursive CTEs and table-form UNNEST are refused.

Before provider work, the planner validates ordinary SQL binding and types against
empty typed relations in the restricted worker. External functions then materialize
outside DuckDB. Exact source-local WHERE conjuncts run before semantic calls;
filters do not cross CTE/LIMIT boundaries. A final LIMIT limits output, not model
work. NULL semantic inputs retain an unprocessed outcome, distinct from false.


## Composing a research query

The host authors the search terms, predicates, ranking criteria and projections
for each question. A typical workflow is broad search, conservative source
deduplication, `SEM_MATCH`, detailed extraction on relevant sources, and
`SEM_NORM` followed by ordinary SQL consolidation. `SEM_SCORE` is optional;
search results are already ranked for their original query. A second score is
useful when the requested criterion is more specific, and its placement belongs
to the authored query rather than a fixed engine pipeline.

Ordinary SQL remains available for established exclusions, formatting, joins,
aggregation and ordering. A title, URL or metadata filter is not a prerequisite
for semantic matching. Missing dates, geography or keywords do not establish
irrelevance. Source-local SQL predicates execute where the admitted plan places
them; no hidden topical filter or universal relevance threshold is inserted.

A direct `WHERE SEM_MATCH(content, 'predicate')` retains only true, following
ordinary SQL semantics. If unknown matches need further investigation, project
the predicate in a CTE or saved result and keep its NULL population separately.
For example, with an authorized saved source result bound to `input.sources`
and the task-specific predicate bound to `$predicate`:

```sql
WITH assessed AS (
  SELECT url, source_version_id, content,
         SEM_MATCH(content, $predicate) AS matches
  FROM input.sources
)
SELECT url, source_version_id, content, matches
FROM assessed
WHERE matches = TRUE OR matches IS NULL
```

This query retains unresolved candidates for follow-up; it does not qualify them
as matches. The `OR` here operates on a materialized Boolean column. Calling
external semantic expressions inside `OR` remains unsupported. Extract facts from
sources with enough relevant evidence, and fetch or investigate unresolved sources
only within the approved scope and budget.

Use `SEM_NORM` on extracted values to find equivalent local grouping labels.
Preserve original values beside those labels; normalization alone is not proof
that two organizations, facilities or phases are the same entity. Unknown or
ambiguous mappings remain NULL. Standard SQL casts and string functions handle
deterministic formatting without another model call.

Fixture compiler/planner tests and local engine tests cover these mechanics.
They do not establish live semantic quality or a hosted ChatGPT qualification.


Research requests default to `partial_policy: "retain_partial"`. Missing facts
remain NULL. For named `SEM_EXTRACT` fields and `SEM_EXTRACT_ALL` items, invalid evidence
makes only the affected cell unavailable while independently supported siblings
retain their values and source quotations; the receipt remains partial.
Multi-entity extraction preserves item order and evidence indices, including NULL
slots for unavailable values. Unsupported later transformations still retain
input-set evidence rather than claiming direct cell citations. Set `partial_policy: "strict"` explicitly
when the whole result must be rejected if required semantic processing fails.
A failed field is distinct from an ordinarily absent fact.

All positional `WEB_SEARCH` arguments are query strings. Use
`WEB_SEARCH('query', per_query_limit := 6)` to request six results; a numeric
second positional argument is rejected. `sourcesql_explain` uses the same Python
admission and restricted SQL worker as execution. Local validation is synchronous;
hosted validation is an asynchronous, provider-free Flight. Supply a new
`request_id`, poll its job, and retain the validation output. Validation consumes
configured Flight capacity and does not reserve search or model usage. A later
query needs its own request ID and revalidates its dependencies and limits.

## Search coverage and evidence windows

Search rows expose `search_hits`, a typed list of provider, search ID, query,
query index, rank and optional request ID. `search_hit_count`, `search_query_count`
and `best_search_rank` make coverage usable in ordinary SQL. Several hits can
refer to one document or version; they are not independent confirmations.
Run receipts retain requested and effective per-query intake separately.

`SOURCE_WINDOW(content, start, length)` selects a zero-based character range from
retained text without a provider call. For example:

```sql
SELECT url, SOURCE_WINDOW(content, $start, $length) AS passage
FROM input.sources
```

Bind this saved result to a later extraction query. Supported projections retain
the source version, original character offsets and content hash. Quotes are
validated against those original coordinates. Constructing a look-alike literal
or concatenating unrelated text does not create a source binding. Windowing
neither fetches a newer page nor establishes that omitted text is irrelevant.
Publication, observation and retrieval times remain separate source fields.

`SEM_EXTRACT_ALL` reports its returned-item count and whether it reached the
configured item ceiling. Reaching the ceiling means more items may exist; fewer
items do not prove an exhaustive catalog. Use explicit source windows or further
bounded extraction to investigate omitted material.

## Researching URLs your agent found

A host agent can search with its own web search tool and have sourcesQL fetch the
pages. This needs no sourcesQL search provider. It needs a profile that may fetch:
`allow_public_source_hosts: true` or a non-empty `allowed_source_hosts`, plus a
model for extraction. `sourcesql_capabilities` reports it per profile as
`host_search_route.available`; `search.configured` is false and `fetch.configured`
is true. `WEB_SEARCH` on such a profile is refused with `provider_unavailable`
before any fetch or model call. This route has not been live-qualified: it is
tested with fixtures and controlled HTML, and `fetch.live_qualified` stays false
until a live run over real pages is recorded.

1. Search with your own tool. Treat every title, snippet and date as a lead.
2. Remove duplicate URLs and keep public HTML or text pages.
3. Pass the URLs as parameters to `FROM WEB_FETCH(...)`, then extract from the
   fetched text:

```sql
SELECT url AS source_url,
       fetch_status,
       fetch_failure,
       SEM_EXTRACT(content, 'the name of the project', evidence := true) AS project_name
FROM WEB_FETCH($u1, $u2, $u3)
```

sourcesQL fetches each URL itself and stores a source version, so a cited quote
always comes from text sourcesQL fetched. Titles, snippets and dates reported by a
host search are never evidence and never become source text. Importing host
results as a snapshot is different: the imported rows have no sources and no
citations.

Limits: at most 32 URLs per call, 40 fetches per job by default, 2 MiB per page,
HTML or text only. PDFs fail. sourcesQL reads the HTML as served and runs no
scripts, so a page that builds its content with JavaScript can fetch as `ok` with
only its shell as content; check that the extracted text is what you expected.

A URL that cannot be fetched stays in the result as a row with
`fetch_status = 'failed'`, a `fetch_failure` code and no content, so it cannot be
cited. This is different from a fetched page where extraction found nothing,
which stays NULL with its usual diagnostic. The rest of the job completes and the
receipt reports `fetch_failed`.

| `fetch_failure` | Meaning |
|---|---|
| `blocked_host` | Not on the allowlist, a private or non-public address, or a disallowed port. The URL is never requested. |
| `unsupported_type` | Not HTML or text (for example a PDF), or text that cannot be decoded. |
| `too_large` | The page is over 2 MiB. |
| `http_error` | The server answered with an error status, or a fixture URL is unknown. |
| `too_many_redirects` | More than three redirects, or a redirect with no target. |
| `timeout` | The server did not answer in time. |
| `transport_error` | The connection failed for another reason. |
| `provider_error` | A provider fetch adapter reported a failure without a reason. |

The job does not split itself at the fetch limit. A call that goes over the limit
is refused with `budget_exhausted`, and its receipt says `fetch_cap_hit: true`
and lists `not_fetched_urls` (up to 100, with `not_fetched_count`) for that call.
Pages fetched before the limit are kept; `sourcesql_recover_run` returns them.
Choose the most relevant URLs yourself and say which you left out.

### Keeping many leads: lead sets

With the local app, `add_research_leads` stores hits from your own search before
you fetch any of them. Send up to 150 per call and reuse the `lead_set_id` the
first call returns. A URL submitted again is merged, and every query and rank is
kept. Each call returns the `result_id` of a new revision. Bind it with
`view: "leads"` (one row per URL: `lead_id`, `url`, `title`, `host_query`,
`host_rank`, `host_date`, `times_found`, `lead_status`, `fetch_failure`,
`batch_result_id`) or `view: "hits"` (one row per submission). A set holds at most
2000 leads. Every submission is kept as a hit, limited only by the storage quota.

The URL, title, query, rank and date of a lead were reported by the host.
`times_found` is counted by sourcesQL from the hits submitted, and `lead_id` is
derived from the URL. `lead_status`, `fetch_failure` and `batch_result_id` are
recorded by sourcesQL from its own fetches. A lead set has no source
versions, so it never appears in the `sources` view and no lead is a citation; a
table built from one is classed `host_reported`, whatever public data it joins. A table that
also reads private data is `private_derived`, and keeps the private restrictions.
Fetch the leads you choose with `WEB_FETCH`, at most 40 per job, and join the
fetched rows back on `lead_id` using a staged query (a join needs its own CTE).
Then call `record_lead_batch` with the batch's `result_id` and the `lead_set_id`: it
writes a new revision in which each lead whose URL sourcesQL fetched is
`fetched`, or `failed` with its `fetch_failure`. It uses sourcesQL's own record of
the fetches and never the query's output columns. Bind the revision it returns for
the next batch and select `lead_status = 'pending'`; ask the user before each
further batch. Put `ORDER BY` and `LIMIT` in a CTE before `WEB_FETCH`. The order of pages
fetched is the order of the rows reaching `WEB_FETCH`. A SELECT with `WEB_FETCH`
and no `ORDER BY` or `LIMIT` fetches in stored row order, which is not a ranking,
and stops at the job's fetch limit. In a query that reads a lead set, a SELECT
that calls `WEB_FETCH` and has its own `ORDER BY`, `LIMIT` or `OFFSET` is refused
before any fetch.

```sql
WITH batch AS (
  SELECT lead_id, url FROM input.leads
  WHERE lead_status = 'pending'
  ORDER BY times_found DESC, host_rank
  LIMIT 40
)
SELECT lead_id, WEB_FETCH(url) AS page FROM batch
```

## Missing facts and declared requirements

Unanswered cells remain NULL. Where available, `cell_diagnostics` distinguishes
unstated, uninspected, ambiguous, conflicting, failed and capacity-limited work.
Diagnostics are not citations. The app exposes the original research reason
through the cell and its existing correction flow.

A query may declare `research_requirements` with `key_columns`, `fields` and
`minimum_rows`. These name output column keys and a bounded minimum row count;
they do not impose a hidden topical filter. The result's `research_quality`
records unresolved cell obligations and row shortfall separately from execution
success. `requirements_satisfied` means those declared shape/presence obligations
were met; it does not verify truth, unique entity identity or complete web coverage.
The existing result count labels unresolved declared requirements as partial
research. This assessment describes the saved query output; a later manual
correction does not rewrite that earlier observation. Query the effective view
with declared requirements to assess a corrected result.
Without declared requirements, research completeness remains `not_evaluated`.
Reuse saved sources and inspect relevant windows before targeted gap searches.
Any follow-up still consumes the existing authorized allowances.
