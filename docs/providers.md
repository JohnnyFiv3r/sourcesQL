# Provider setup

Fixture mode is the default and uses fictional Aurora/Birch sources without network calls or spending. The [profile template](../examples/profiles.example.json) also defines Exa, Brave and Serper profiles with live dispatch disabled. Adapter and model mocks are tested; live provider qualification remains separate.

Copy the template to an operator-controlled file outside published artifacts. Load it through `WEBQL_PROFILES_FILE` in the CLI or JSON-lines bridge; the Python SDK accepts the same name-to-profile mapping through `Engine(..., profiles=mapping)`. Supply credentials through the named environment variables. Replace both `SET_APPROVED_*_MODEL_NAME` placeholders with exact approved model identifiers before configuring semantic work. No credentials belong in the example file.

```sh
WEBQL_PROFILES_FILE=examples/profiles.example.json webql --store local/setup-check capabilities --json
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

After the owner approves a finite amount, set `allow_live: true` and that amount in `approved_cost_microusd`. Each request must supply a positive `budgets.max_cost_microusd` no larger than the grant. Changing request budgets alone never enables live calls. Begin with one search query, `per_query_limit := 3`, `source_mode: "allow_excerpt"`, and request budgets limiting search queries/requests to one and fetches/model requests to zero. This retains a clearly marked excerpt limitation. Approve selected source hosts before requesting full documents; the default `require_document` mode can schedule additional fetches.

Search and fetch have no automatic retries or provider fallback. Model validation retries default to zero; an explicit `model.retries` of one or two consumes the same run's model-request allowance. OpenAI SDK transport retries are disabled. Request counters reserve before every attempt. Semantic output tokens are narrowed per request; total input/output token caps use reported consumption after responses and cannot guarantee a hard billing ceiling. Review the receipt's counters, provider events, omissions and unknown usage before authorizing more work.
