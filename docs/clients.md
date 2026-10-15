# Connect an MCP client

sourcesQL exposes the same MCP tools and interactive research app to compatible
hosts. Hosting and model-host support are separate checks: successful MCP
initialization does not prove the host rendered a table or delivered an app
message. Fixture or saved data is enough for the first connection checks.

| Client path | Connection | Current evidence |
| --- | --- | --- |
| ChatGPT | Personal HTTPS `/mcp` endpoint with OAuth | Owner deployment has passed OAuth, saved-table rendering and bounded workspace interactions; see [status](../STATUS.md) |
| Claude | Remote custom connector with OAuth | Host documents interactive MCP Apps and custom connectors; sourcesQL client qualification must be recorded separately |
| Cursor | Remote Streamable HTTP with owner bearer or OAuth; local stdio also available | Cursor documents MCP Apps; sourcesQL client qualification must be recorded separately |
| Other MCP clients | Supported HTTP or stdio transport | Tools can be used without an interactive renderer; host features vary |

## Claude first

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
Then inspect source links and research-tree/Back navigation. A later qualified
fixture journey should exercise correction/reopen, expansion completion and
refresh review; preserve the exact IDs and report unsupported app messaging or
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
