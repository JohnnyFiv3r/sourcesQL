# Inspecting what a research query does

sourcesQL returns an advisory `query_feedback` record with new query results and
canonical explain output. It describes the admitted SQL independently of the
intended answer. It does not decide whether the research is correct, remove
rows, demand another query or prevent a partial answer from being displayed.

The host agent can preserve the intended answer across research stages with
optional `answer_intent` metadata:

```json
{
  "row_unit": "One product",
  "fields": [
    { "key": "product", "meaning": "Product name" },
    { "key": "price_usd", "meaning": "Current list price in USD; unknown if unstated" }
  ]
}
```

An optional `question` retains the request. This intent is separate from each
query's projection: an intermediate query can return source titles and URLs
without being rejected because `product` and `price_usd` are absent. Keep the
same intent in subsequent queries; changing it changes the request identity.
Existing `research_requirements` assess the columns declared for that particular
result. `answer_intent` instead preserves what the final answer is meant to be.
This intent is recorded by the agent; agreement with it cannot prove that the
agent interpreted the original request correctly.

The actual-query description comes from SQLGlot's admitted AST and bound values,
without consulting the question or intended answer. It retains scoped filters,
joins, aggregates, semantic instructions, ordering and limits. A CTE limit is
described within that CTE, not as a limit on the whole answer. Complex expressions
retain their actual SQL fragment. Bound values are identified as quoted data.
Long descriptions identify truncated fragments and count omitted steps.

Feedback includes hashes of the original SQL, parameters and authorized input
pins. Completed results also record their full row count and NULL counts, even
when a later read returns only one page. These are observations at execution
time; later corrections can differ. They do not establish entity uniqueness,
factual truth, complete discovery or citation adequacy. Matching all intended
column names cannot establish that the right metric was computed.

The agent compares the actual query, intended answer, returned rows and evidence.
It can refine saved-data SQL, inspect another source or present a useful partial
answer within the existing scope and budget. There is no automatic retry or
quality threshold. Missing descriptions and malformed advisory intent do not
invalidate an otherwise valid engine result. MCP arguments retain their normal
bounded schema validation.

In the app, **Table options → How this table was built** opens a read-only view.
It makes no host or provider call. Older saved tables show an unavailable state;
reopening does not manufacture a description or rerun their query. Wire metadata
is separate from the stable snapshot fields so cached widgets can keep displaying
their original cells.

Normal query execution generates feedback in the same operation, with no extra
model call, provider request or Flight. Explicit hosted preflight still consumes
its existing on-demand Flight allowance; feedback does not add a preflight step.
