# Provider setup

Fixture mode is the default and uses fictional Aurora/Birch sources without network calls or spending. The [profile template](../examples/profiles.example.json) also defines Exa, Brave and Serper profiles with live dispatch disabled. Adapter and model mocks are tested. Exa's bounded search-only path now passes actual MotherDuck qualification; Brave, Serper, Contents and live model calls remain separate live gates.

Copy the template to an operator-controlled file outside published artifacts. Load it through `SOURCESQL_PROFILES_FILE` in the CLI or JSON-lines bridge; the Python SDK accepts the same name-to-profile mapping through `Engine(..., profiles=mapping)`. Supply credentials through the named environment variables. Replace both `SET_APPROVED_*_MODEL_NAME` placeholders with exact approved model identifiers before configuring semantic work. No credentials belong in the example file.

```sh
SOURCESQL_PROFILES_FILE=examples/profiles.example.json sourcesql --store local/setup-check capabilities --json
```

This command reads configuration and creates a local store; it does not contact providers. A profile name in capabilities does not establish live qualification.

| Trusted profile field | Actual behavior |
|---|---|
| `mode` | `fixture` or `live`; default is `fixture`. |
| `provider` | Live search adapter: `exa`, `brave` or `serper`. One adapter per profile; no automatic switching. |
| `api_key_env` | Environment variable containing the search credential. |
| `allow_live` | Must be `true` in trusted configuration before live dispatch. |
| `approved_cost_microusd` | Positive integer approval ceiling for a run request. One million micro-USD equals USD 1. This is not a debited account balance or an enforced billing cap. |
| `metering_policy` | These adapters require explicit `estimated`. `strict` refuses before dispatch because hard total cash/token enforcement is unavailable. |
| `allowed_source_hosts` | Exact lowercase hostnames approved for fetching, including redirects. Empty means live fetch is unavailable. Public DNS and permitted HTTP ports are also checked. |
| `model` | `{ "name": "approved-model", "api_key_env": "OPENAI_API_KEY", "retries": 0 }` configures PydanticAI leaf inference. Optional `base_url` selects a trusted OpenAI-compatible destination. |
| `embedding` | `{ "name": "approved-embedding-model", "api_key_env": "OPENAI_API_KEY" }` configures `SEM_SCORE`. Optional `endpoint` selects a trusted embedding destination. No scorer means refusal; there is no lexical substitute. |

Both `model` and `embedding` can be omitted for search-only work. Credentials, destination permissions and a spending grant are separate requirements. Private inputs additionally require exact trusted disclosure permissions; query text cannot grant them.

For a low-cost first run, inspect the provider account's current credit balance, expiry, billing and model access. A free-credit offer does not prove that this account has credits or that an attempted call is free. This build has not verified account balances. Exa's returned `costDollars` is an estimate rather than final billing; unavailable costs remain null. See the [Exa contents reference](https://exa.ai/docs/reference/get-contents).

As checked on October 14, 2026, Exa advertises Starter credits of **$10 each month plus a $10 onboarding bonus**, without a payment method. Its listed Fast/Auto price is **$7 per 1,000 requests for up to ten results**. These published offers do not establish a particular account's entitlement or balance. See [Exa pricing](https://exa.ai/pricing). Search content is included for up to ten results; standalone Contents is separately metered. See [Exa's Contents guide](https://exa.ai/docs/contents/quickstart).

After the owner approves a finite amount, set `allow_live: true` and that amount in `approved_cost_microusd`. Each request must supply a positive `budgets.max_cost_microusd` no larger than the grant. Changing request budgets alone never enables live calls. Begin with one search query, `per_query_limit := 3`, `source_mode: "allow_excerpt"`, and request budgets limiting search queries/requests to one and fetches/model requests to zero. This retains a clearly marked excerpt limitation. Approve selected source hosts before requesting full documents; the default `require_document` mode can schedule additional fetches.

Search and fetch have no automatic retries or provider fallback. Model validation retries default to zero; an explicit `model.retries` of one or two consumes the same run's model-request allowance. OpenAI SDK transport retries are disabled. Request counters reserve before every attempt. Semantic output tokens are narrowed per request; total input/output token caps use reported consumption after responses and cannot guarantee a hard billing ceiling. Review the receipt's counters, provider events, omissions and unknown usage before authorizing more work.

## Exa retrieval contract

The adapter follows Exa's canonical [`build-with-exa` skill](https://github.com/exa-labs/agent-skills/tree/main/skills/build-with-exa) using the existing HTTP client. Search requests use `type: "auto"` and nested `contents: { "highlights": true }`. The default is ten results; another explicit SQL limit or a tighter candidate allowance changes that maximum. `numResults: 10` is omitted. The adapter adds publication bounds or domain controls only when supplied, and never adds summary, deep research or synthesized output. Semantic SQL operators use sourcesQL's separately configured model. See the [search reference](https://exa.ai/docs/reference/search).

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
