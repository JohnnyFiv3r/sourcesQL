<p align="center">
  <img src="https://raw.githubusercontent.com/JohnnyFiv3r/sourcesQL/main/assets/brand/sourcesql-mcp-icon.png" width="112" alt="sourcesQL logo">
</p>

# sourcesQL

**Web research you can query, inspect and keep working with.**

sourcesQL is an open-source research engine and MCP App. A connected assistant turns your request into SQL, searches the web, builds a structured dataset and presents the finished table in chat. You can inspect its sources, expand a row into a follow-up investigation, amend a field, review a later refresh and move the saved research between compatible installations.

Use it when the answer needs rows: a vendor comparison, a project pipeline, an organization inventory or a collection of claims with supporting sources. The result stays available for further SQL instead of becoming another table trapped in a conversation.

<p>
  <a href="https://github.com/JohnnyFiv3r/sourcesQL/blob/main/LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache%202.0-9AE4C2?style=flat-square&amp;labelColor=0E221D"></a>
  <a href="https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/python-linux-qualification.md"><img alt="Python: 3.12–3.14" src="https://img.shields.io/badge/Python-3.12%E2%80%933.14-9AE4C2?style=flat-square&amp;labelColor=0E221D"></a>
</p>

## Keep working with saved research

Saved research includes the result, its supporting sources and the investigations that follow from it.

- **Expand.** Choose a row or a field within it and ask a follow-up question. The findings open in a linked child table, with the research tree keeping the path back to the parent. For example, expand one company into a table of its announced facilities.
- **Amend.** Correct a value and record why. Amendments have a separate revision history, so original observations stay available. Follow-up SQL can use the original result or a pinned amended view.
- **Refresh.** Check a field, row or table again, then review the proposed changes. Explicitly accept supported updates or keep the current values; earlier observations and amendments remain available.
- **Check for updates.** Revisit selected findings, look for new entities, or do both as separate research scopes. Review dated evidence for additions, changed claims and contradictions. Publish your accepted choices as a new table; missing search hits do not remove existing findings. The first version works with complete tables up to 100 rows and 200 KB.
- **Compact checkpoints.** Save the question, selected rows and fields, exact revisions, query details and pending job IDs in a small continuation record. Resume in another compatible client without copying the conversation or restarting research. Missing data and changed revisions are reported explicitly.
- **Portable snapshots.** Export a research tree as a bundle and restore it in another compatible sourcesQL store. Bundles carry original results, sources, amendments, linked investigations, refresh decisions, checkpoints and manual update review history. Reopen saved findings without repeating web discovery.

See the [research lifecycle](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/app-integration.md#contracts-and-lifecycle) and [snapshot/export contracts](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/app-integration.md#snapshots-presentation-and-export) for supported scopes, review behavior and bundle limits.

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

The engine supports `WEB_SEARCH`, `WEB_FETCH`, `SEM_MATCH`, `SEM_EXTRACT`, `SEM_EXTRACT_ALL`, `SEM_SCORE` and `SEM_NORM`. It accepts an explicit subset of DuckDB-style `SELECT` and nonrecursive `WITH` queries. See the [SQL reference](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/language.md) for signatures, supported staging and refusals. Operator availability also depends on the selected provider profile.

## The interactive workspace

The MCP App adds an interactive table to compatible clients, including ChatGPT, Claude and Cursor. Use contextual table actions or ask the connected assistant to continue from a saved result. Linked tables are accessible through the research tree. Other MCP clients can use the same tools without rendering the app.

The [client guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/clients.md) covers connection steps and supported interactions. Host support varies: Cursor can render the table while leaving actions that require agent messaging disabled.

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

Then configure the client to run `docker compose run --rm -T --no-deps sourcesql-mcp` from this checkout. The [Docker guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/docker.md#mcp-over-stdio) includes a complete MCP configuration, storage details and the CLI container. The default stdio container has no network; live providers require deliberate network and credential configuration.

A local endpoint alone is not reachable by hosted ChatGPT. Use the hosted path below for a remotely accessible, authenticated connection.

### Python and CLI

Install from [PyPI](https://pypi.org/project/sourcesql/) with Python 3.12–3.14 on macOS or Linux:

```sh
python -m pip install sourcesql
sourcesql --store ./research-data demo --output ./research-demo
sourcesql --store ./research-data capabilities --json
```

The installed demo includes fictional sources and needs no credentials or checkout. Each successful query returns an immutable `result_id`, typed columns, a bounded row preview and an execution receipt. Use the ID printed by `demo` to reopen or export it:

```sh
sourcesql --store ./research-data read RESULT_ID --offset 0 --limit 100
sourcesql --store ./research-data export --result RESULT_ID --output result-bundle.json
sourcesql --store ./restored import result-bundle.json --no-network
```

For source development, clone this repository, install [uv](https://docs.astral.sh/uv/) and run `uv sync --frozen`. Then use `uv run sourcesql` in place of `sourcesql`. See [package installation and release checks](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/package.md).

For Python integration, import `Engine` from `sourcesql.engine`. The [examples](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/examples/) cover discovery, saved-result refinement, row expansion and snapshot comparison.

To run the app from source, install **Node.js 24**, prepare the root Python environment with `uv sync --frozen`, then run:

```sh
cd apps/research
npm ci
npm run build
npm start
```

Open [localhost:3117](http://127.0.0.1:3117), or use `npm run stdio` with a local MCP client. See the [example client configuration](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/apps/research/mcp-config.example.json). CLI and app stores are separate by default; use the MCP query/result-reference workflow for app research, or research bundles to move it between stores.

Actual SQL execution requires the supported OS protections: macOS `sandbox-exec`, or Linux Landlock and seccomp. Missing protection causes a refusal. Use Docker on Windows. See [runtime qualification](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/python-linux-qualification.md) for the tested environments.

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

The installed package includes guided setup:

```sh
sourcesql setup personal-cloud --help
sourcesql setup personal-cloud plan --config personal.json --workspace ./my-cloud
sourcesql setup personal-cloud apply --workspace ./my-cloud --approve-plan PLAN_SHA256
```

Follow the [personal-cloud setup guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/personal-cloud-setup.md) to prepare your accounts, owner identity and token-free configuration. The plan records the exact destination, public source hashes, execution policy and proposed changes before applying them. Repeating an approved plan recovers its saved resources; uncertain creation stops for inspection.

Setup provisions a Vercel Preview gateway and a bounded MotherDuck Flight. It keeps credentials server-side, defaults to fixture mode and leaves account creation, OAuth registration and the exact-domain protection exception as visible account steps. Verify one fixture job and reopen its stored result before enabling live research. The [client guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/clients.md) covers ChatGPT, Claude and Cursor, including which host interactions have actually been qualified.

Eligible personal, non-commercial adopters can choose Vercel Hobby; no Pro-only feature is required by this configuration. MotherDuck, search and model consumption are separate. Included allowances may cover light use, but application budgets do not guarantee that a platform account with billing enabled stops before overage.

## Configure live search and models

Start with the [provider guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/providers.md) and [profile template](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/examples/profiles.example.json). Keep real configuration and secrets outside version control.

| Capability | Configuration |
| --- | --- |
| Local live search | Exa, Brave or Serper adapter; its API key, live permission and finite budget |
| Semantic extraction / matching / normalization | An explicitly named model and its credential |
| Semantic scoring | An explicitly configured embedding adapter |
| Hosted Exa, Brave or Serper | Choose one live provider per reviewed Flight; bind its secret and matching gateway policy |

For search-only work, omit model and embedding settings. An Exa API key does not enable semantic operators or authorize spending. Request budgets must fit the trusted profile; source fetching also requires approved destination hosts.

Hosted setup binds one search provider to each reviewed Flight. The configured profile determines the available search modes, candidate limits, fetching and semantic operators. Start with a small search, inspect its receipt, and configure wider coverage deliberately. A search-only profile returns source excerpts; it does not provide semantic extraction or a complete entity census.

See the [hosted provider guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/providers-hosted.md), [hosted policy](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/hosted-flight.md#opt-in-exa-search) and [Exa research notes](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/exa-research.md) for configuration and current limits.

## Status and development

The [current status](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/STATUS.md) records package, Docker, provider and host qualification separately. Fresh-account Hobby onboarding, broad live research quality and the complete Claude/Cursor lifecycle still need qualification. Hosted semantic models are unavailable in the reviewed profiles.

Run local checks from the repository root:

```sh
uv run pytest -q
npm ci --prefix apps/research
npm --prefix apps/research run check
```

Positive SQL worker tests need permission to launch the OS sandbox. A sandbox refusal is not a passing execution test. See [qualification](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/qualification.md) and [app integration](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/app-integration.md) for the execution, evidence and storage contracts.

Read the [checkpoint and manual update guide](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/continuation.md) for continuation, evidence and review contracts. The [roadmap](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/docs/roadmap.md) covers the remaining adoption checks, larger engine-backed updates and later opt-in monitoring.

Licensed under [Apache 2.0](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/LICENSE). Attribution and source reuse are recorded in [NOTICE](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/NOTICE) and [provenance](https://github.com/JohnnyFiv3r/sourcesQL/blob/main/provenance/).
