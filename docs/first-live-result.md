# First live result (local)

Status: documented, not live-qualified. The steps work in fixture mode, and the fetch step is tested against a mocked page. A full search, fetch and cited result has not yet been run on this recipe with a real provider key.

This route runs from a source checkout. It needs one search provider key, plus a model key if you want semantic extraction (`SEM_` functions). It needs no other account.

Without steps 4 to 6 you are in **fixture mode**, which uses synthetic data and calls nothing. Fixture mode remains the default. Live use needs your explicit choices, marked "your choice" below.

The approved amount you set in step 5 is a ceiling for authorizing work. It is not a billing cap or a balance. Check your provider's own limits and usage.

## Steps

1. **Clone and prepare Python.** Needs [uv](https://docs.astral.sh/uv/).
   ```sh
   git clone https://github.com/JohnnyFiv3r/sourcesQL && cd sourcesQL && uv sync --frozen
   ```
2. **Install the app.** Needs Node 24.
   ```sh
   cd apps/research && npm ci
   ```
3. **Build it.** The server reads the built widget.
   ```sh
   npm run build
   ```
4. **Copy the live profile template.** The template does not enable live use as shipped: `allow_live` is `false` and the approved amount is `0`. The `local/` folder is not tracked by git.
   ```sh
   mkdir -p ../../local && cp ../../examples/profiles.live.example.json ../../local/profiles.json
   ```
5. **Open `local/profiles.json` and make the choices only you can make.** Use `live-search` (search and fetch) or `live-fetch` (fetch only, no search key).
   - Set `allow_live` to `true`. *Your choice.*
   - Set `approved_cost_microusd` to the most you authorize. 1,000,000 is one US dollar. *Your choice.*
   - List the sites it may fetch in `allowed_source_hosts`, for example `["example.org"]`. *Your choice.* An empty list refuses every fetch.
   - Replace `SET_APPROVED_MODEL_NAME` with a model you can use, or delete the `model` block if you will not use `SEM_` functions. *Your choice.*
   - To search with another provider, change `provider` and `api_key_env` on `live-search`; see [providers.md](providers.md) and `examples/profiles.example.json`.
6. **Set your keys in your shell or the client's `env`, never in the profile file.** `EXA_API_KEY` for search (skip for `live-fetch`) and `OPENAI_API_KEY` for extraction (skip if you will not use `SEM_` functions).
7. **Add the server to your MCP client.** Copy `apps/research/mcp-config.live.example.json` into your client's configuration and start the client from the clone root; its paths are relative to that folder. If your client cannot start servers there, replace the relative paths with absolute ones. The file has no key entries. If your client passes your shell's environment to the server, the keys from step 6 reach it as they are. If it does not, add `"EXA_API_KEY"` and `"OPENAI_API_KEY"` to the `env` block of your own copy, not the shipped file.
8. **Restart the client and ask for a result.** Each query on a live profile needs its own budget, so your prompt must give an amount within the approved amount. *Your choice.* Searching and fetching are two asks, so the fetch is explicit. Example:
   > Use the live-search profile. Search for public pages about X with source_mode allow_excerpt, then fetch the three best pages with WEB_FETCH and give me a table with a cited quote from each fetched page. Spend at most 50,000 micro-USD on each query.

   Ask the agent to call `sourcesql_capabilities` first. Its reply says at the top level whether `profiles_file` is `not_set`, `missing` or `loaded`, and lists each profile's `allow_live` and `approved_cost_microusd`.
9. **Check it is real.** Check the fetch and the citations separately; they can be different results.
   - The fetch: ask the agent to read the receipt of the result from your fetch query. `data_classification` should be `public_web`, not `synthetic_fixture`, and `counts.fetches` should be above 0.
   - The citations: open the saved table and click a cited cell. It shows a **Visit source** link to the page, and the table's evidence list has an item for each cited cell. The final table's own receipt may show no fetch count when the fetch ran in an earlier query, and it does not need a model key.

The recipe is 9 numbered actions. The personal-cloud route is about 10 steps over a longer guide, with three accounts.

## No search key?

Use the `live-fetch` profile in step 8, give the agent the URLs, and ask it to fetch and extract from them. See [Researching URLs your agent found](language.md#researching-urls-your-agent-found) for the full route.

## Wider access

Setting `allow_public_source_hosts` to `true` in place of a host list lets the profile fetch any public site. Prefer a list; the wider setting means a search hit can send the fetcher to any public page.

## If it is refused

- **`Profile unavailable ... Available profiles: fixture`.** Your profiles file is not loaded. If `sourcesql_capabilities` shows `profiles_file` as `missing`, the path in `SOURCESQL_PROFILES_FILE` does not exist yet. If it shows `not_set`, the client config has no such entry.
- **`Live dispatch requires a trusted finite spending grant`.** Either `allow_live` is `false` or the approved amount is `0` (step 5), or the query has no `budgets.max_cost_microusd`. Set a positive amount no larger than the approved amount.
- **`Search credentials are not configured`.** Set the environment variable the message names, then restart the client. Or use `WEB_FETCH` with URLs you already have.
- **`Live fetch requires permitted source hosts`.** Add the sites to `allowed_source_hosts` (step 5).
- **A semantic refusal about the model.** The model name is still the placeholder, or its key is not set (steps 5 and 6).
