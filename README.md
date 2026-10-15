<p align="center">
  <img src="assets/brand/sourcesql-mcp-icon.png" width="112" alt="sourcesQL logo">
</p>

# sourcesQL

**Web research you can query, inspect and keep working with.**

sourcesQL is an open-source research engine and MCP App. A connected assistant turns your request into SQL, searches the web, builds a structured dataset and presents the finished table in chat. You can inspect its sources, expand a row into a follow-up investigation, amend a field, review a later refresh and move the saved research between compatible installations.

Use it when the answer needs rows: a vendor comparison, a project pipeline, an organization inventory or a collection of claims with supporting sources. The result stays available for further SQL instead of becoming another table trapped in a conversation.

<p>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache%202.0-9AE4C2?style=flat-square&amp;labelColor=0E221D"></a>
  <a href="docs/python-linux-qualification.md"><img alt="Python: 3.12–3.14" src="https://img.shields.io/badge/Python-3.12%E2%80%933.14-9AE4C2?style=flat-square&amp;labelColor=0E221D"></a>
</p>

## Keep working with saved research

Saved research includes the result, its supporting sources and the investigations that follow from it.

- **Expand.** Choose a row or a field within it and ask a follow-up question. The findings open in a linked child table, with the research tree keeping the path back to the parent. For example, expand one company into a table of its announced facilities.
- **Amend.** Correct a value and record why. Amendments have a separate revision history, so original observations stay available. Follow-up SQL can use the original result or a pinned amended view.
- **Refresh.** Check a field, row or table again, then review the proposed changes. Explicitly accept supported updates or keep the current values; earlier observations and amendments remain available.
- **Portable snapshots.** Export a research tree as a bundle and restore it in another compatible sourcesQL store. Bundles carry original results, sources, amendments, linked investigations and refresh decisions. Reopen saved findings without repeating web discovery.

See the [research lifecycle](docs/app-integration.md#contracts-and-lifecycle) and [snapshot/export contracts](docs/app-integration.md#snapshots-presentation-and-export) for supported scopes, review behavior and bundle limits.

## How research works

The assistant plans the search terms. sourcesQL executes the query and keeps the data, evidence and execution receipt.

1. **Discover broadly.** Use complementary search terms across terminology, source types and angles. Search results are candidate pages, not verified entities.
2. **Reduce with SQL.** Merge overlapping results, deduplicate sources, filter available fields and join saved datasets before spending on semantic processing.
3. **Extract selectively.** Apply semantic matching, extraction, scoring or normalization to candidates that still need it, using explicitly configured models.
4. **Present the finished table.** Keep intermediate work behind the scenes. Open the final selection with readable labels, useful source links and an intentional row order.
5. **Continue from saved research.** Reopen, query, correct, expand or refresh a result without repeating discovery unnecessarily.

SQL filters run before semantic work where the admitted query plan permits it. A final `LIMIT` bounds returned rows; it does not make earlier search or model work cheaper.

This query runs against the included **fictional fixtures**, with no API keys or network calls:

```sql
SELECT
  SEM_EXTRACT(content, 'project name explicitly stated') AS project,
  SEM_EXTRACT(
    content,
    'planned capacity in MW, number only',
    type := 'DOUBLE'
  ) AS planned_capacity_mw,
  url AS source_url
FROM WEB_SEARCH('fictional Aurora Birch campuses')
WHERE SEM_MATCH(content, 'describes a specific data-center campus')
ORDER BY project, source_url;
```

The engine supports `WEB_SEARCH`, `WEB_FETCH`, `SEM_MATCH`, `SEM_EXTRACT`, `SEM_EXTRACT_ALL`, `SEM_SCORE` and `SEM_NORM`. It accepts an explicit subset of DuckDB-style `SELECT` and nonrecursive `WITH` queries. See the [SQL reference](docs/language.md) for signatures, supported staging and refusals. Operator availability also depends on the selected provider profile.

## The interactive workspace

The MCP App adds an interactive table to compatible clients, including ChatGPT. Use contextual table actions or ask the connected assistant to continue from a saved result. Linked tables are accessible through the research tree. Other MCP clients can use the same tools without rendering the app.

The app decorates column labels and source addresses without rewriting data. Missing values stay missing. Search excerpts remain identified as excerpts, and a supporting quote establishes what a source says rather than proving the claim true.

## Choose an installation

| Path | You run | Best starting point |
| --- | --- | --- |
| **Local Docker** | App, MCP server and Python engine in containers; local persistent volumes | Try the workspace without installing Python or Node |
| **Python / source checkout** | CLI or Python engine; optional Node app | Build queries, integrate the engine or develop the project |
| **Personal cloud** | Vercel gateway, MotherDuck storage and Flights; OAuth for ChatGPT | Use a hosted MCP endpoint without keeping Docker running |

Every path starts in **fixture mode**. Live search and model calls require credentials, an enabled trusted profile and explicit execution budgets.

### Local Docker

Clone this repository and run from its root with Docker running:

```sh
git clone https://github.com/JohnnyFiv3r/sourcesQL.git
cd sourcesQL
docker compose up --build -d sourcesql-app
```

Open **[localhost:3117](http://127.0.0.1:3117)**. The initial workspace uses synthetic data. Its named volume preserves results and corrections across restarts.

To connect a local MCP client over stdio, first build the app image:

```sh
docker compose build sourcesql-mcp
```

Then configure the client to run `docker compose run --rm -T --no-deps sourcesql-mcp` from this checkout. The [Docker guide](docs/docker.md#mcp-over-stdio) includes a complete MCP configuration, storage details and the CLI container. The default stdio container has no network; live providers require deliberate network and credential configuration.

A local endpoint alone is not reachable by hosted ChatGPT. Use the hosted path below for a remotely accessible, authenticated connection.

### Python and CLI

Install [uv](https://docs.astral.sh/uv/) and Python 3.12–3.14, then run from the repository root:

```sh
uv sync --frozen
uv run sourcesql --store local/cli capabilities --json
uv run sourcesql --store local/cli demo --profile fixture --output artifacts/demo
uv run sourcesql --store local/cli query --file examples/01_discovery.sql
```

Each successful query returns an immutable `result_id`, typed columns, a bounded row preview and an execution receipt. Read later pages or export the full result:

```sh
uv run sourcesql --store local/cli read <result_id> --offset 100 --limit 100
uv run sourcesql --store local/cli export --result <result_id> --output result-bundle.json
uv run sourcesql --store local/restored import result-bundle.json --no-network
```

For Python integration, import `Engine` from `sourcesql.engine`. The [examples](examples/) cover discovery, saved-result refinement, row expansion and snapshot comparison.

To run the app from source, install **Node.js 24**, keep the root Python environment above, then run:

```sh
cd apps/research
npm ci
npm run build
npm start
```

Open [localhost:3117](http://127.0.0.1:3117), or use `npm run stdio` with a local MCP client. See the [example client configuration](apps/research/mcp-config.example.json). CLI and app stores are separate by default; use the MCP query/result-reference workflow for app research, or research bundles to move it between stores.

Actual SQL execution requires the supported OS protections: macOS `sandbox-exec`, or Linux Landlock and seccomp. Missing protection causes a refusal. Use Docker on Windows. See [runtime qualification](docs/python-linux-qualification.md) for the tested environments.

### Personal cloud: Vercel + MotherDuck

This path uses your own accounts and one owner workspace:

```text
ChatGPT / MCP client
        │
        ▼
Vercel: MCP tools, app UI, authentication
        │
        ▼
MotherDuck: saved research, evidence, corrections, jobs
        │
        └── on-demand Flight: Python research execution
```

Ordinary reads, tree navigation and corrections use stored records without starting Python. Research runs as a bounded asynchronous job. One job runs at a time per owner namespace; queued jobs resume explicitly. A lost response is recovered using the same request and job IDs.

Setup is manual today:

1. Build and provision a reviewed execution bundle with the [MotherDuck setup guide](docs/motherduck-backend.md#build-the-reviewed-flight). Submission starts disabled.
2. Create a Vercel project rooted at `apps/research`, then configure the gateway and encrypted secrets using the [Vercel guide](docs/vercel.md).
3. For hosted ChatGPT, configure your OAuth provider and sole owner identity. The documented path uses an adopter-owned Auth0 tenant, a public PKCE client and `sourcesql:access`. Follow [OAuth setup](docs/vercel.md#optional-oauth-for-chatgpt), then connect your stable HTTPS `/mcp` URL in ChatGPT.
4. Verify fixture execution and saved-result reopening before enabling live providers.

Eligible personal, non-commercial adopters can choose Vercel Hobby; no Pro-only feature is required by this configuration. MotherDuck, search and model consumption are separate. Included allowances may cover light use, but application budgets do not guarantee that a platform account with billing enabled stops before overage.

## Configure live search and models

Start with the [provider guide](docs/providers.md) and [profile template](examples/profiles.example.json). Keep real configuration and secrets outside version control.

| Capability | Configuration |
| --- | --- |
| Local live search | Exa, Brave or Serper adapter; its API key, live permission and finite budget |
| Semantic extraction / matching / normalization | An explicitly named model and its credential |
| Semantic scoring | An explicitly configured embedding adapter |
| Hosted Exa | A bound MotherDuck Flight secret plus matching gateway/Flight policy; keep the key out of the frontend |

For search-only work, omit model and embedding settings. An Exa API key does not enable semantic operators or authorize spending. Request budgets must fit the trusted profile; source fetching also requires approved destination hosts.

The currently qualified hosted profile, **`exa-search.v1`**, uses Exa Auto and retained excerpts. It permits **two searches and ten candidate pages per job**, with no extra fetches or model calls. It is a small search-only configuration, not broad entity-research capacity. Larger fanout and semantic research need separately configured and qualified execution profiles. See the [hosted policy](docs/hosted-flight.md#opt-in-exa-search) and [Exa research notes](docs/exa-research.md).

## Status and development

The project includes the engine, local Docker app, durable MotherDuck jobs and storage, and hosted ChatGPT OAuth/app rendering. Fixture tests, live provider quality and host integration are different checks; the [current status](STATUS.md) records their scope and remaining gaps. Broad live research quality, hosted semantic models and Claude rendering are not qualified by the small Exa integration.

Run local checks from the repository root:

```sh
uv run pytest -q
npm ci --prefix apps/research
npm --prefix apps/research run check
```

Positive SQL worker tests need permission to launch the OS sandbox. A sandbox refusal is not a passing execution test. See [qualification](docs/qualification.md) and [app integration](docs/app-integration.md) for the execution, evidence and storage contracts.

Licensed under [Apache 2.0](LICENSE). Attribution and source reuse are recorded in [NOTICE](NOTICE) and [provenance](provenance/).
