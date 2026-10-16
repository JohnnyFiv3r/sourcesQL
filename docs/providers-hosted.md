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

The reviewed hosted search profiles currently allow at most two queries, two
provider requests and ten acquired candidates per job. Brave, Serper and Exa v1
use at most 60 seconds of dispatch time; Exa v2 allows at most 100 seconds. All
profiles disable page fetching, semantic/model requests and hidden retries. A
request may lower those limits. Large research needs a separately reviewed
execution policy; splitting jobs to evade a limit is not supported.

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
The approved per-job and daily reservations may be lowered and cannot exceed
1,000,000 micro-USD in these profiles.

The coordinator reserves the complete job grant before dispatch and does not
release it merely because a response is lost. The attempt limit is also bounded
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
