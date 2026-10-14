# Open WebQL

Open WebQL runs admitted research SQL over web sources and saved typed results. The host authors the query; the engine owns admission, staged execution, finite budgets, evidence and immutable publication. The optional research app owns separate expert corrections, linked investigations and explicit refresh review.

This is a local developer build. Fixture mode is the default and makes no real provider API calls. Live provider quality, hosted ChatGPT/Claude behavior and release qualification are separate from local build evidence.

## Engine quickstart

Python 3.13–3.14 is required. Actual SQL execution currently requires macOS and its `sandbox-exec` worker; unsupported or blocked worker launch is refused.

```sh
uv sync --frozen
uv run webql --store local/cli capabilities --json
uv run webql --store local/cli explain --sql 'SELECT CAST(1 AS BIGINT) AS value'
uv run webql --store local/cli query --sql 'SELECT CAST(1 AS BIGINT) AS value'
uv run webql --store local/cli demo --profile fixture --output artifacts/demo
```

Queries return a run receipt, immutable `result_id`, typed columns, total row count and bounded rows. Read later pages with `webql --store local/cli read <result_id> --offset 100 --limit 100`. Export full data with `webql --store local/cli export --result <result_id> --output artifacts/result-bundle.json`; import it with `webql --store local/cli import artifacts/result-bundle.json --no-network`.

The implemented seven operators are `WEB_SEARCH`, `WEB_FETCH`, `SEM_MATCH`, `SEM_EXTRACT`, `SEM_EXTRACT_ALL`, `SEM_SCORE` and `SEM_NORM`. Read the [implemented SQL subset and signatures](docs/language.md), including admitted staging shapes and refusal cases. This is an explicit allowlist rather than the whole DuckDB language.

## Research app

Install the root Python environment first, then:

```sh
cd apps/research
npm ci
npm run build
npm start
```

Open the [local research workspace](http://127.0.0.1:3117). HTTP starts in `fixture-anonymous` mode with synthetic data, a distinct fixed principal and private engine access disabled. The app preserves contextual correction, tree/Back navigation, source links, tracked expansion, refresh review and full research-bundle import/export. Large results use honest server windows; the engine retains the full dataset.

For an MCP client, use `npm run stdio` or adapt [the example configuration](apps/research/mcp-config.example.json). Stdio uses a configured local principal. In a client, call `webql_capabilities`, then `webql_query` with a new UUID `request_id`. Render the returned result using `open_research` with `result_ref: {result_id, snapshot_id, title}`. A client without MCP Apps can use the same tools and store headlessly.

The standalone CLI store and app bridge store are separate by default. The bridge namespaces `WEBQL_DATA_DIR` by trusted `WEBQL_PRINCIPAL`; changing the principal does not grant access to another principal's result IDs. Use the MCP query → result-reference workflow for app research, and app bundles for cross-store research restoration.

Protected HTTP requires `RESEARCH_AUTH_MODE=protected` and `RESEARCH_BEARER_TOKEN`; the local preview prompts for that token. `WEBQL_PRINCIPAL` selects one server-configured principal, never an incoming request argument. `RESEARCH_DATA_DIR` and `WEBQL_DATA_DIR` select isolated app and engine directories.

Protected mode can forward an operator-configured profile name from `WEBQL_PROFILES_FILE`. The engine still requires explicit `allow_live`, credentials, destination permission and an approved finite budget before live dispatch. Anonymous mode admits fixture profiles only. Private computation permission and private model-host disclosure are separate settings; see [app integration](docs/app-integration.md). No live profile or API spending is configured by this quickstart.

The current app bridge is synchronous with a 30-second response deadline. Longer engine budgets do not imply pending-handle support in the app. Keep the same request key when recovering a timed-out run; do not create a fresh key and repeat paid work.

## Verification

```sh
uv run pytest -q
cd apps/research
npm run build
npm test
```

An outer execution sandbox can prevent the macOS SQL sandbox from launching. Positive worker/SQL tests need authorized local execution; refusal is not a successful execution test. Compiler tests, fixture/provider mocks, actual worker tests, engine/app round trips, live corpus quality and hosted rendering establish different things. See the [qualification notes](docs/qualification.md).

Licensing and source reuse are recorded in [LICENSE](LICENSE), [NOTICE](NOTICE) and [provenance](provenance/app-reuse.json).
