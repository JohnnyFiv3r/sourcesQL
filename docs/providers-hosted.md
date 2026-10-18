# Search providers in personal-cloud hosting

The Vercel gateway can use Exa, Brave or Serper through a reviewed MotherDuck
Flight. Choose one live search provider for each Flight. Fixture execution stays
available, and no provider becomes enabled merely because an API key exists.
Local and Docker deployments use the same Python search adapters.

Brave and Serper have synthetic response/policy tests and bounded real Vercel
HTTP checks. On 2026-10-16 UTC, separate protected Pro Preview deployments of the
0.2.1 gateway used the existing 0.1.0 provider Flights. Each made one query,
returned three excerpt rows and used no page fetches, model calls or provider
retries. Fresh HTTP sessions read and reopened the stored research. Native runs
succeeded and settled; the stable alias was unchanged and the temporary
protection bypass was revoked.

The combined **$0.02 provider reservation and 240 reserved Flight seconds** are
not actual charges; provider billing was unavailable. An adopter's account and
Flight configuration still need their own bounded checks. These results do not
qualify provider-specific host rendering, equivalent coverage, full-document
evidence or broad research quality, and do not upgrade the provider workers.

## Choose a provider

| Profile                          | Search behavior                                  | Returned evidence         | Usage reporting                                                       |
| -------------------------------- | ------------------------------------------------ | ------------------------- | --------------------------------------------------------------------- |
| `exa`                            | Exa Auto                                         | Provider text or excerpts | Provider estimate when returned; actual billing unavailable           |
| `exa_deep`, `exa_deep_reasoning` | Explicit Exa research modes on `exa-research.v2` | Provider text or excerpts | Provider estimate when returned; actual billing unavailable           |
| `brave`                          | Brave web search with extra snippets             | Excerpts                  | Actual billing unavailable; operator supplies a request cost estimate |
| `serper`                         | Serper organic web search                        | Excerpts                  | Actual billing unavailable; operator supplies a request cost estimate |

Existing `exa-search.v1` Flights retain their Auto-only profile, fingerprint and
limits. Adding these options does not enable a new provider, add deep profiles to
a v1 Flight or replace an existing Flight definition.

The legacy hosted search profiles allow at most two queries, two
provider requests and ten acquired candidates per job. Brave, Serper and Exa v1
use at most 60 seconds of dispatch time; Exa v2 allows at most 100 seconds. All
search-only profiles disable page fetching, semantic/model requests and hidden retries. A
request may lower those limits. Large research needs a separately reviewed
execution policy; splitting jobs to evade a limit is not supported.

Optional `model` and `embedding` settings select reviewed research policies:
`exa-research.v3`, `brave-research.v2` or `serper-research.v2`. A language model
enables `SEM_MATCH`, `SEM_EXTRACT`, `SEM_EXTRACT_ALL` and `SEM_NORM`; an embedding
adapter enables `SEM_SCORE`. Either may be enabled independently. Search keys
alone never enable semantic work, and existing `brave-search.v1` and
`serper-search.v1` approvals and fingerprints stay unchanged.

Research policies admit up to 32 search queries, 48 search requests, 2,500
candidates, 40 fetches, 96 model/embedding requests and 100 seconds of dispatch time. With a
model, they admit up to 40 semantic documents and 16,000 output tokens; either
semantic adapter admits up to 200,000 input tokens. These are per-job upper bounds,
not automatic calls or promised coverage. Requests may lower them. Brave/Serper
research uses the engine's guarded public-page fetcher for `WEB_FETCH`, including
public-host and redirect checks. Exa uses its Contents fetch path. Excerpts stay
marked incomplete; semantic processing cannot establish evidence absent from the
acquired material.

Credential-free tests verify research policy, gateway/Flight agreement and
synthetic semantic dispatch. Those tests do not extend the dated search-only live
checks above into qualification of live Brave/Serper semantic research or host UI.

Brave and Serper publication-date filtering is a local post-filter, requiring
explicit `allow_post_filter` and `undated_policy`. Missing publication dates stay
unknown. Serper's non-ISO date strings are not guessed into dates. Provider
result rank and each query's hit lineage are retained through merging.

## Configure an adopter-owned account

Use the guided personal-cloud setup to choose a provider and provision its named
Flight secret. Provider keys remain in that secret, and the gateway holds policy
settings and secret references. Keep credentials out of command arguments,
committed configuration and public setup receipts.

For the lower-level provisioning command, first create a MotherDuck Flight
secret whose field is `BRAVE_API_KEY` or `SERPER_API_KEY`, then pass its name:

```sh
node hosted/setup.mjs --database sourcesql --principal YOUR_OWNER_ID \
  --brave-secret sourcesql_brave \
  --brave-request-cost-microusd YOUR_CONSERVATIVE_ESTIMATE \
  --brave-approved-cost-microusd 50000 \
  --brave-daily-cost-microusd 1000000
```

Replace the four `brave` flags with `serper` to select Serper. The per-request
estimate is mandatory and must cover the account's current rate for a search
returning up to ten results. It is a reservation input, not a reported charge.
Check your own provider plan before setting it. One USD is 1,000,000 micro-USD.
The approved per-job bound may be lowered and cannot exceed
1,000,000 micro-USD in the legacy search-only profiles. Explicit research setup
supports at most 2,000,000 micro-USD per job; the default stays 50,000. The daily
field is deprecated metadata in provider-managed usage and does not add a daily
research gate.

To opt into semantic work, add existing OpenAI Flight secret references to the
same command:

```sh
  --openai-model YOUR_APPROVED_MODEL --openai-secret sourcesql_openai \
  --embedding-model text-embedding-3-small --embedding-secret sourcesql_openai
```

Both adapters may share one OpenAI secret. That secret must be different from the
search secret. The generated gateway and Flight settings bind the same research
policy, model names, limits and secret references. Guided setup creates or reuses
these named secrets within the reviewed account; see [semantic onboarding](personal-cloud-setup.md#opt-into-model-extraction-and-embedding-ranking).

The worker applies the complete per-job grant before dispatch. The attempt limit is also bounded
by the job grant divided by the per-request estimate. Provider attempts count
even if they fail or the remote outcome is unknown. Missing billing data never
appears as a zero charge. These controls do not cancel or modify a provider's
billing plan and cannot guarantee a cash ceiling if its configured estimate is
too low.

The generated settings keep Flight submission off. Verify the reviewed source
and requirements hashes, secret binding, owner and limits before enabling it.
Changing providers requires a newly reviewed Flight and matching gateway
configuration. An older job cannot silently run under a different approval.

Reference interfaces: [Brave web search documentation](https://api-dashboard.search.brave.com/app/documentation/web-search/codes)
and [Serper's search response and account setup](https://serper.dev/).
