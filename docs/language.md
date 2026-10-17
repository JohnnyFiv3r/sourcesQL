# Implemented SQL and research operators

sourcesQL accepts one DuckDB-style SELECT or nonrecursive WITH query. It resolves
only explicitly bound `input.<alias>` results, CTEs, derived relations and the web
sources below. Closed AST validation rejects commands, physical tables, catalogs,
file readers, extensions, arbitrary functions and multiple statements. Parameters
use `$name` bindings; values never become SQL identifiers or interpolated SQL.

Pure SQL includes INNER/LEFT/CROSS joins, DISTINCT, GROUP BY/HAVING, set operations,
ORDER BY/LIMIT/OFFSET, approved arithmetic/string/JSON functions, scalar casts,
projected UNNEST, list/struct access, and the tested ROW_NUMBER/RANK/DENSE_RANK/LAG/
LEAD windows. Pure correlated EXISTS and scalar subqueries are implemented. This
is an allowlist, not a claim of all DuckDB syntax. String helpers include typed `split_part(text, delimiter, integer_index)` and
two-argument `regexp_matches(text, pattern)`; regex options are not admitted.

The installed signatures are:

- `WEB_SEARCH(q1, ..., q32, per_query_limit := 1..100, published_after := 'ISO date or offset-bearing instant', published_before := ..., undated_policy := 'include'|'exclude'|'error', allow_post_filter := true|false)`
Exa accepts up to 100 results per query; other providers and fixture mode accept at most 20. Profile limits and explicitly chosen run budgets also apply. Ordinary defaults remain eight search queries and 200 candidates.

- `WEB_FETCH(url1, ..., url32, mode := 'cache_preferred'|'live')`
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
second positional argument is rejected. `sourcesql_explain` is available with
the local Python engine; native hosted connections do not expose that tool.
