# Provider setup

Fixture mode is the default and uses fictional Aurora/Birch sources without network calls or spending. The [profile template](../examples/profiles.example.json) also defines Exa, Brave, Serper and DeepSeek profiles with live dispatch disabled. Configuration, adapter tests and live research quality are separate checks; see [current qualification](../STATUS.md) for the recorded deployment and host evidence.

Copy the template to an operator-controlled file outside published artifacts. Load it through `SOURCESQL_PROFILES_FILE` in the CLI or JSON-lines bridge; the Python SDK accepts the same name-to-profile mapping through `Engine(..., profiles=mapping)`. Supply credentials through the named environment variables. Replace both `SET_APPROVED_*_MODEL_NAME` placeholders with exact approved model identifiers before configuring semantic work. No credentials belong in the example file.

```sh
SOURCESQL_PROFILES_FILE=examples/profiles.example.json sourcesql --store local/setup-check capabilities --json
```

This command reads configuration and creates a local store; it does not contact providers. A profile name in capabilities does not establish live qualification.

| Trusted profile field | Actual behavior |
|---|---|
| `mode` | `fixture` or `live`; default is `fixture`. |
| `provider` | Live search adapter: `exa`, `brave`, `serper` or `deepseek`. One adapter per profile; no automatic switching. |
| `api_key_env` | Environment variable containing the search credential. |
| `allow_live` | Must be `true` in trusted configuration before live dispatch. |
| `approved_cost_microusd` | Positive integer approval ceiling for a run request. One million micro-USD equals USD 1. This is not a debited account balance or an enforced billing cap. |
| `metering_policy` | These adapters require explicit `estimated`. `strict` refuses before dispatch because hard total cash/token enforcement is unavailable. |
| `allowed_source_hosts` | Exact lowercase hostnames approved for fetching, including redirects. Empty means live fetch is unavailable unless an explicit public-source grant is configured. Public DNS and permitted HTTP ports are also checked. |
| `model` | `{ "name": "approved-model", "api_key_env": "OPENAI_API_KEY", "retries": 0 }` configures PydanticAI leaf inference. Optional `base_url` selects a trusted OpenAI-compatible destination. |
| `embedding` | `{ "name": "text-embedding-3-small", "api_key_env": "OPENAI_API_KEY" }` configures `SEM_SCORE`. Optional `endpoint` selects a trusted compatible destination. An unfamiliar compatible model also needs an explicit supported `encoding`, currently `cl100k_base`. Known model/encoding conflicts refuse. No scorer means refusal; there is no lexical substitute. |
| `allow_public_source_hosts` | Exact `true` opts into public HTTP(S) source fetching. Public DNS, standard ports and redirects are still checked. This does not authorize private-source disclosure. |

Both `model` and `embedding` can be omitted for search-only work. Credentials, destination permissions and a spending grant are separate requirements. Private inputs additionally require exact trusted disclosure permissions; query text cannot grant them.

## Semantic matching, ranking and normalization

Use the language model for `SEM_MATCH` predicates, `SEM_EXTRACT` and
`SEM_EXTRACT_ALL` detailed fields, and `SEM_NORM` equivalent-value mappings.
Matching discovery sources before detailed extraction avoids extracting full
records from irrelevant pages. Missing or failed evidence stays distinct from a
negative match. Normalization labels apply to the inspected collection, not a
global entity registry.

`SEM_SCORE` is optional embedding relevance ranking. Start with
`text-embedding-3-small` when configuring the OpenAI adapter; use a different
approved model only after checking its quality and cost for your sources. Search
results are already ranked for their original query, so request another score
when a more specific criterion will help order candidates. Do not apply a
universal cutoff or compare scores across different models and criteria. SQL
chooses whether and where ranking occurs; it is not a required gate before
`SEM_MATCH`.

For a local profile, add:

```json
{
  "embedding": {
    "name": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY"
  }
}
```

This is a profile fragment, not a complete live configuration. The existing
credential can serve both model adapters, but both capabilities must be opted
into separately. The OpenAI adapter returns cosine similarity of the bounded
source text and criterion. It does not score truth or establish source support.
Inspect omissions and unavailable outcomes instead of interpreting them as a
zero score. Hosted Exa, Brave, Serper and DeepSeek can independently opt into the same model
and embedding adapters; see the [hosted provider guide](providers-hosted.md) and
[guided onboarding](personal-cloud-setup.md#opt-into-model-extraction-and-embedding-ranking).
The search provider remains responsible for discovery: hosted Brave/Serper
research can fetch public pages through the engine's guarded fetcher, while Exa
research uses Contents fetching. DeepSeek research uses its native Markdown
fetch endpoint.
No semantic adapter establishes evidence missing from the acquired material.

Scoring batches unique source inputs sharing a criterion and embeds that criterion
once. The adapter caches exact submitted text by model and endpoint for its own
lifetime; this is not a durable embedding index across jobs or Flights. Batch
limits bound request size. Model-aware `tiktoken` counting reserves actual input
tokens before dispatch, once per unique submitted input. OpenAI's third-generation
embedding models use `cl100k_base`. The public Python package and Docker image
bundle its data for offline loading. The compact Flight prepares the same
checksum-pinned data from the official public host before a live scoring job;
it never sends research text or credentials in that request. Source text
containing special-token spellings is encoded as ordinary text. See the
[OpenAI embedding guide](https://developers.openai.com/api/docs/guides/embeddings)
and [Flight packaging](hosted-flight.md).

The scorer accepts up to 8,192 tokens per input, with batches bounded by
300,000 tokens and 128 inputs. There is no default byte or character cutoff for
scoring; retrieval may have its own documented content window. Genuinely
oversized inputs remain unavailable with `embedding_input_limit`, while valid
sibling inputs proceed. Choose retained passages explicitly in SQL when a
source exceeds the model's token window. That score describes the selected
passage; the engine does not silently average chunk scores into a document score.
An explicitly configured adapter text window records omitted characters.
Scoring counts
unique non-null texts against `max_candidates`, separately from the
`max_semantic_documents` allowance shared by matching, extraction and
normalization. Model-request and input-token allowances still apply across
both stages. Batching changes dispatch cost and latency, not SQL ordering or
which sources are eligible. Live latency and ranking quality require separate
qualification on representative sources.

For a low-cost first run, inspect the provider account's current credit balance, expiry, billing and model access. A free-credit offer does not prove that this account has credits or that an attempted call is free. This build has not verified account balances. Exa's returned `costDollars` is an estimate rather than final billing; unavailable costs remain null. See the [Exa contents reference](https://exa.ai/docs/reference/get-contents).

As checked on October 14, 2026, Exa advertises Starter credits of **$10 each month plus a $10 onboarding bonus**, without a payment method. Its listed Fast/Auto price is **$7 per 1,000 requests for up to ten results**. These published offers do not establish a particular account's entitlement or balance. See [Exa pricing](https://exa.ai/pricing). Search content is included for up to ten results; standalone Contents is separately metered. See [Exa's Contents guide](https://exa.ai/docs/contents/quickstart).

After the owner approves a finite amount, set `allow_live: true` and that amount in `approved_cost_microusd`. Each request must supply a positive `budgets.max_cost_microusd` no larger than the grant. Changing request budgets alone never enables live calls. Begin with one search query, `per_query_limit := 3`, `source_mode: "allow_excerpt"`, and request budgets limiting search queries/requests to one and fetches/model requests to zero. This retains a clearly marked excerpt limitation. Approve selected source hosts before requesting full documents; the default `require_document` mode can schedule additional fetches.

Search and fetch have no automatic retries or provider fallback. Model validation retries default to zero; an explicit `model.retries` of one or two consumes the same run's model-request allowance. OpenAI SDK transport retries are disabled. Request counters reserve before every attempt. Semantic output tokens are narrowed per request; generative input/output totals use reported consumption after responses. Embedding input allowance uses exact model-tokenizer counts before dispatch and stays held afterward, with provider-reported usage recorded separately. These application limits cannot guarantee a hard billing ceiling. Review the receipt's counters, provider events, omissions and unknown usage before authorizing more work.

## Exa retrieval contract

The adapter follows Exa's canonical [`build-with-exa` skill](https://github.com/exa-labs/agent-skills/tree/main/skills/build-with-exa) using the existing HTTP client. Search requests use `type: "auto"` and nested `contents: { "highlights": true }`. The default is ten results; another explicit SQL limit or a tighter candidate allowance changes that maximum. `numResults: 10` is omitted. The adapter adds publication bounds or domain controls only when supplied, and never adds summary, deep research or synthesized output. `SEM_MATCH`, `SEM_EXTRACT`, `SEM_EXTRACT_ALL` and `SEM_NORM` use sourcesQL's separately configured language model. `SEM_SCORE` uses a separate embedding adapter; it does not reuse Exa search rank or an LLM response as its score. See the [search reference](https://exa.ai/docs/reference/search).

Returned URLs, titles, publication dates, provider document IDs and query/rank membership remain source provenance. Highlights are retained as incomplete excerpts; a missing or invalid publication date stays unknown. Native Exa date filters remove undated pages, so dated queries must use `undated_policy := 'exclude'`; `include` and `error` refuse before dispatch. These filters cannot establish comprehensive coverage.

An explicit Exa Contents fetch sends one approved public URL per request and requests text capped at 16,000 characters. `mode := 'live'` sends `maxAgeHours: 0` with a ten-second crawl timeout. `cache_preferred` leaves freshness unset, allowing Exa's cache-first retrieval and internal crawl fallback within that one request. This is separate from an application retry or provider switch. The adapter checks the per-URL success status and refuses a different returned source URL; it does not follow that URL with another request. A capped provider representation remains incomplete. See the [contents reference](https://exa.ai/docs/reference/get-contents).

For the first search-only qualification, omit `model` and `embedding` from the trusted profile and use an owner-approved request like this:

```json
{
  "query": "SELECT url, title, published_at, content FROM WEB_SEARCH('public data center planning announcements', per_query_limit := 3)",
  "profile": "exa",
  "source_mode": "allow_excerpt",
  "budgets": {
    "max_search_queries": 1,
    "max_search_requests": 1,
    "max_candidates": 3,
    "max_fetches": 0,
    "max_model_requests": 0,
    "max_cost_microusd": 10000
  }
}
```

The example's 10,000 micro-USD is USD 0.01 of requested allowance, subject to the trusted grant. At the published Auto rate, one such search has a nominal USD 0.007 search charge before credits; the response estimate and dashboard billing must still be checked. The finite counters prove one application request with no subsequent fetches or model calls. A passing search-only run does not qualify document fetches, semantic inference or free-credit eligibility.

On October 14, 2026, the actual MotherDuck Flight executed one Auto search for
`MotherDuck Flights documentation`, requested three results and retained all
three with excerpt coverage. The response reported an estimated 7,000 micro-USD
($0.007); final billing remains unavailable. The Flight interval was 10.616
seconds. There were no extra fetches, model calls, provider switches or automatic
retries. The key came from a bound MotherDuck Flight secret. The stored result
then passed MCP open/save and fresh-factory reopening without another Flight.
Operator receipts remain outside public artifacts under
`artifacts/hosted-exa-20261014/`.

## DeepSeek retrieval contract

The `deepseek` adapter uses the official [Search API](https://api-docs.deepseek.com/api/search/)
and [Fetch API](https://api-docs.deepseek.com/api/fetch/) with `DEEPSEEK_API_KEY`.
Search requests ask for page content, default to ten results and accept an
explicit `per_query_limit` from one to 50. Queries must contain one to 128 Unicode
characters. The complete query batch is checked before dispatch; long queries are
not truncated. Narrow or split a long criterion deliberately in the authored SQL.
Ordinary SQL may shortlist and reconcile acquired sources before semantic work.
Publication-date options use the shared explicit local post-filter contract;
missing dates remain unknown. Domain and query syntax do not become implicit
relevance gates.

Page content is retained as incomplete provider text. A summary or snippet
without page content remains discovery metadata rather than quoted page evidence.
The provider's `rerank_score` and `authority` values are source metadata; neither
replaces the separately configured embedding `SEM_SCORE` or proves a claim true.
`SEM_MATCH`, `SEM_EXTRACT`, `SEM_EXTRACT_ALL` and `SEM_NORM` use the independently
configured model on acquired text, with the same missing-evidence behavior as
other search providers.

Set `"fetch_adapter": "deepseek"` in a local profile to use native Fetch instead
of the guarded direct-page fetcher. Explicit source hosts or a public-source
grant are still required; public DNS and permitted HTTP ports are checked before
sending the source URL. Fetch returns incomplete provider Markdown. Only
`mode := 'cache_preferred'` is supported: the API has no documented force-fresh
option, so `mode := 'live'` refuses before dispatch instead of promising freshness.
DeepSeek supports `source_mode: "allow_excerpt"` only: provider text cannot
establish whole-source completeness. `require_document` refuses before paid
acquisition rather than spending on an impossible completeness guarantee.
No application retries, hidden fetches or provider fallback are added.

As checked on October 18, 2026, DeepSeek lists search and fetch at **$0.75 per
1,000 successful nonempty requests**. The adapter records a 750 micro-USD
operation estimate for such a response and zero for a valid empty result.
Unavailable usage or an uncertain remote outcome stays unknown. This is an
estimate, not a provider billing statement. No recurring free allowance for these
endpoints is documented; setup does not assume one. Check the account's own
credit and billing state before enabling live work. See DeepSeek's
[Search and Fetch guide](https://api-docs.deepseek.com/guides/search/).

DeepSeek is an optional explicitly selected provider. Configuration, mocked
adapter tests and packaging do not qualify live retrieval quality, billing,
hosted execution or ChatGPT/Claude behavior for an adopter's account.
