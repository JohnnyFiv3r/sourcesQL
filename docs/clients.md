# Connect an MCP client

sourcesQL exposes the same MCP tools and interactive research app to compatible
hosts. Hosting and model-host support are separate checks: successful MCP
initialization does not prove the host rendered a table or delivered an app
message. Fixture or saved data is enough for the first connection checks.

| Client path | Connection | Current evidence |
| --- | --- | --- |
| ChatGPT | Personal HTTPS `/mcp` endpoint with OAuth | Direct OAuth connection and saved-table rendering on the clean Hobby workspace; tool refresh and bounded lifecycle checks remain scoped in [status](../STATUS.md) |
| Claude | Personal HTTPS `/mcp` endpoint with OAuth; encrypted owner bearer headers are an alternative | Real OAuth and saved-table rendering on the clean Hobby workspace; earlier owner-bearer checks passed child/Back navigation, correction persistence, cross-client checkpoint continuation and manual evidence review/publication |
| Cursor | Local Docker fixture tested; remote Streamable HTTP configuration is documented below | Actual nine-row fixture rendering and paging passed; host-agent messaging was unavailable in this setup and refresh stayed disabled |
| Other MCP clients | Supported HTTP or stdio transport | Tools can be used without an interactive renderer; host features vary |

## ChatGPT: connect over HTTPS

Create the [personal-cloud endpoint](personal-cloud-setup.md), then open
ChatGPT's Plugins page and choose **Add custom MCP server**. Enter the stable
HTTPS `/mcp` URL, select the configured OAuth client and request
`sourcesql:access`. Complete login as the configured owner. This single
connection provides the research tools and interactive app; no plugin ZIP is
needed.

To update sourcesQL, deploy the server to the same stable endpoint and use
**Refresh tools** in the existing connection's settings. Reopen a saved result
to load the current interactive app. Keep the existing registration rather than
adding a packaged wrapper around it.

## ChatGPT: reopen after updating the app

On the existing owner deployment, ChatGPT rendered saved synthetic research
again after **Refresh tools** and reopening the saved result. That check started
no research query.

If an updated app reports that it could not open a component, refresh its tool
definitions in the plugin's settings, then call `open_research` with the same
saved `snapshot_id` or retry that saved component. Do not rerun SQL, expansion or
refresh to repair rendering. If it still fails, keep the error and inspect the
connection/resource response before claiming the table opened.

ChatGPT can hide tool details or its work trace. A missing visible trace is not
evidence that no tool ran, and an assistant saying a table opened is not evidence
that the component rendered. Confirm the actual table. Authentication or mutation
errors need their own recovery; preserve the original IDs rather than treating
them as display failures.

## Claude first

The clean Hobby workspace passed a real OAuth connection and inline saved-table
rendering in Claude. Earlier lifecycle checks used an encrypted
`Authorization: Bearer …` request header through Claude's custom-connector
authentication settings; those observations remain scoped to that connection.

After a server update, open **Customize → Connectors → Yours → sourcesQL →
More options → Refresh tools list**, then reopen saved research. A fresh
conversation alone did not refresh cached UI metadata in the measured host.
Keep the existing connector and credentials. An older chat also retained its
prior tool list; after refreshing, a fresh chat resumed a checkpoint saved in
ChatGPT with the same row, field and amendment revision.

Create the [personal-cloud endpoint](personal-cloud-setup.md) and configure its
OAuth API audience as the exact stable `/mcp` URL. Only the configured immutable
owner subject can access the personal workspace, regardless of which client
completes login. Keep the `sourcesql:access` permission limited to intended
clients; it grants queries and corrections as well as reads.

In Claude's **Customize → Connectors**, add a custom connector with that HTTPS
MCP URL. Choose **Use your own OAuth client** when a predefined OAuth client is
required. Register a public authorization-code/PKCE client in your own OAuth
provider using the callback shown by Claude; Anthropic currently documents
`https://claude.ai/api/mcp/auth_callback`. Grant `sourcesql:access` for that client
and the existing MCP audience. Do not reuse a client whose allowed redirects are
limited to another host, enable an Enterprise-only registration feature, or make
the app anonymous to get past a login error.

Complete consent as the configured application owner, enable the connector in a
new conversation and ask it to reopen an existing fixture research table with
`open_research`. Confirm the table appears in chat, not just a text response.
Then inspect source links and research-tree/Back navigation. The earlier
owner-bearer connection passed rendering, child-table/Back navigation, a synthetic
500-to-501 correction, reload persistence and restoration to 500. The clean OAuth
check confirmed the saved two-row table, title and source links. Neither check
ran new provider research.
Expansion execution, refresh review and the complete lifecycle remain separate
qualification work; preserve the exact IDs and report unsupported app messaging or
view modes rather than assuming they match another host.

For a personal connector, Claude also documents encrypted **Request headers** for
a fixed bearer credential. That can use the setup workspace's owner fallback
credential instead of an OAuth client when deliberately chosen; it grants the
whole personal workspace to that connector. Never publish the header value or
use a shared team connector with this personal-owner credential. See
[Claude's connector authentication options](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).

Claude Code and a terminal MCP client are distinct from Claude's graphical Apps
host. A successful tool call there does not qualify inline table rendering.
Current account/plan access and custom connector controls are described in
[Anthropic's custom-connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
Interactive app support is described in
[Claude's MCP Apps announcement](https://claude.com/resources/articles/interactive-tools-in-claude).

### Continue an app-generated request in Claude

In the measured Claude web host, **Check for updates** saved its request and
placed a prepared message in the chat composer. It did not automatically start
an agent turn. Review that message and press **Send** to continue, then approve
only the intended tool calls. Keep the saved request ID when retrying or asking
for status; do not start another check merely because a turn has not begun.

The controlled check then read and cancelled that exact request without research
execution. Host acceptance of a message and actual agent execution are separate
observations; other hosts may start the turn immediately.

## Cursor next

Cursor's [MCP documentation](https://cursor.com/docs/mcp) lists MCP Apps support
alongside Streamable HTTP. Add the hosted server in Cursor's MCP settings or a
private user configuration. Its documented server shape is:

```json
{
  "mcpServers": {
    "sourcesql": {
      "url": "https://YOUR-EXACT-ALIAS.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer ${env:SOURCESQL_OWNER_TOKEN}"
      }
    }
  }
}
```

Set `SOURCESQL_OWNER_TOKEN` in the environment available to Cursor. Remote MCP
uses environment interpolation, not the stdio-only `envFile` setting. Never
commit a real token in a project `mcp.json`. The owner fallback token
is in the private setup workspace's `owner-secret.json`. It grants the whole
personal research workspace. Alternatively, use Cursor's static OAuth configuration with the same resource
audience, scope and sole owner identity. Register the callback displayed by the
client: current documented desktop callback is `http://localhost:8787/callback`;
web/Agents callback is `https://www.cursor.com/agents/mcp/oauth/callback`.

Restart or refresh the MCP connection after metadata changes. In a new chat,
reopen saved fixture research with `open_research` and confirm the interactive
view appears. Qualify tree navigation, source opening, correction persistence,
refresh review and host messages independently. Cursor states that a tool can
fall back to ordinary MCP output when an app UI is unavailable; that is useful
fallback behavior, not a passed app-rendering check.

The measured Cursor connection rendered a nine-row local Docker fixture and
passed paging. Host-agent messaging was unavailable in that setup; refresh was
disabled accordingly. This does not qualify hosted Cursor authentication,
expansion, refresh review or the full lifecycle.

For local stdio, use the [Docker MCP configuration](docker.md#mcp-over-stdio).
A locally running server does not make an HTTP endpoint reachable from a hosted
chat service.

## Qualification record

For every tested host, retain the client version/account capability, endpoint,
source/deployment revision and observed results. Begin with saved fixtures and
no provider requests. Check authentication refusal for an unintended identity,
final-table-only rendering, source links, navigation, correction durability and
app messages. Expansion or refresh qualification may need bounded fixture
execution; configure that deliberately rather than launching a live search.

Record source review, protocol checks and actual host interaction separately.
The product's [current status](../STATUS.md) is the published evidence boundary.

## Clean Hobby OAuth checks on 2026-10-15

ChatGPT and Claude separately completed OAuth consent and authorization-code
exchange for the clean 0.2.1 workspace. Each used a dedicated public
strict third-party SPA client, authorization-code-only grants and its exact host
callback. The new API granted only delegated `sourcesql:access` to those clients
and denied machine-to-machine access. Neither host used a client secret or fixed
bearer header. The application owner was the configured Google identity; the
existing Auth0 administrator login was a separate identity.

Both hosts displayed the same saved two-row fixture table, title and source links
in their actual inline apps. Native backend records still contained one settled
job/run and no provider reservation after both reads. These checks qualify OAuth
and rendering with existing accounts, not new-account signup, token renewal,
live-provider research or the full lifecycle. See
[adoption verification](adoption-verification.md) for the clean CLI setup and
bounded Flight evidence.

## Continuation checks on 2026-10-15

The direct ChatGPT connection rendered the current app, saved a selected-field
checkpoint through its dialog and delivered a separately scoped update request
to the host agent. The agent read and explicitly cancelled that synthetic
request. A separate MCP session reopened the checkpoint as `ready`; the original
snapshot, amendments, accepted sources and revision stayed unchanged.

A fresh Claude conversation resumed that same checkpoint as `ready`, preserving
its canonical selection and revision, and rendered the current table and controls.
Its manual-update action saved a request and prepared a composer message; after
Send, the agent read and cancelled the exact request. These stored-data checks
started no Flight or provider request. These initial request-only checks were
followed by the manual review/publication checks below.

The checkpoint download control was unavailable in the measured ChatGPT session.
The checkpoint JSON remains readable through `resume_research_checkpoint`;
actual file download is a separate host-capability check. A compact checkpoint
references retained research rather than transferring the full dataset.

## Manual update review in ChatGPT and Claude

Both hosts rendered a retained source quote with its observation time, separate
previous/proposed values and a distinct discovery addition. Their actual app
controls saved revised Accept/Keep choices before publication, required every
finding to be reviewed, published a saved successor and disabled further choices.
Back navigation preserved the original table/correction; reopening the saved
successor retained its accepted values and addition. These synthetic checks used
fresh local engine observations imported through the MotherDuck adapter, with no
new Flights or live provider calls. They qualify host review/publication rather
than fresh hosted acquisition or a complete research workload.
