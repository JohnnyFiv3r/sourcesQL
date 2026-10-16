# Connect an MCP client

sourcesQL exposes the same MCP tools and interactive research app to compatible
hosts. Hosting and model-host support are separate checks: successful MCP
initialization does not prove the host rendered a table or delivered an app
message. Fixture or saved data is enough for the first connection checks.

| Client path | Connection | Current evidence |
| --- | --- | --- |
| ChatGPT | Personal HTTPS `/mcp` endpoint with OAuth | Two renewal cycles on a temporary Hobby registration; replacement original connection with offline consent and fresh saved-result rendering; other checks stay scoped in [status](../STATUS.md) |
| Claude | Personal HTTPS `/mcp` endpoint with OAuth; encrypted owner bearer headers are an alternative | OAuth, saved-table rendering and two automatic renewal cycles on the clean Hobby workspace; earlier owner-bearer checks passed child/Back navigation, correction persistence, cross-client checkpoint continuation and manual evidence review/publication |
| Cursor | Local Docker fixture tested; remote Streamable HTTP configuration is documented below | Actual nine-row fixture rendering and paging passed; host-agent messaging was unavailable in this setup and refresh stayed disabled |
| Other MCP clients | Supported HTTP or stdio transport | Tools can be used without an interactive renderer; host features vary |

## ChatGPT: connect over HTTPS

Create the [personal-cloud endpoint](personal-cloud-setup.md), then open
ChatGPT's Plugins page and choose **Add custom MCP server**. Enter the stable
HTTPS `/mcp` URL, select the configured OAuth client and request
`sourcesql:access`. For the Auth0 strict third-party client, set **Default scopes**
to `sourcesql:access`, **Base scopes** to `offline_access`, and keep **OpenID
Connect** disabled. Complete login as the configured owner, including offline
access consent when configuring renewal. This single
connection provides the research tools and interactive app; no plugin ZIP is
needed.

The current ChatGPT icon form requires a PNG within its 10 KB size limit. Use
the supplied [256-pixel upload icon](https://raw.githubusercontent.com/JohnnyFiv3r/sourcesQL/v0.2.3/assets/brand/sourcesql-mcp-icon-small.png).
If ChatGPT reports that the name already exists, choose a distinct connection
name such as **sourcesQL Research**.

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
and the existing MCP audience. For automatic renewal, enable the API's offline
access and the client's Refresh Token grant and rotation, then confirm Claude's
consent explicitly includes offline access. Follow the
[finite renewal settings](vercel.md#enable-and-qualify-oauth-renewal).
Do not reuse a client whose allowed redirects are
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
exchange for the clean 0.2.1 workspace. Each initially used a dedicated public
strict third-party SPA client, authorization-code-only grants and its exact host
callback. The new API granted only delegated `sourcesql:access` to those clients
and denied machine-to-machine access. Neither host used a client secret or fixed
bearer header. The application owner was the configured Google identity; the
existing Auth0 administrator login was a separate identity.

Both hosts displayed the same saved two-row fixture table, title and source links
in their actual inline apps. Native backend records still contained one settled
job/run and no provider reservation after both reads. These initial checks qualify
OAuth and rendering with existing accounts. Renewal was measured separately
below; new-account signup, live-provider research and the full lifecycle remain
separate checks. See
[adoption verification](adoption-verification.md) for the clean CLI setup and
bounded Flight evidence.

## OAuth renewal checks

Renewal requires the API's Allow Offline Access setting, the client's Refresh
Token grant, rotating refresh credentials with finite lifetimes, and a host
request for `sourcesql:access offline_access`. The recommended retained limits are
7 days of inactivity and 30 days total, with rotation enabled; see
[Auth0 renewal setup](vercel.md#enable-and-qualify-oauth-renewal). Initial consent
after changing these settings may require a setup reconnection. Start the renewal
measurement afterward and keep the connection intact.

ChatGPT and Claude each passed two successive automatic renewals with a temporary
120-second access-token lifetime. Each safe Auth0 `sertft` event matched the intended client,
audience, owner and scopes, and each subsequent `open_research` displayed a new
inline app with the saved two rows. No disconnect, login or manual token exchange
occurred between cycles. This qualifies the measured renewal and rendering
path, not long-term expiry, fresh-account signup, provider research or the full
client lifecycle.

ChatGPT's earlier registration had empty Base scopes. After expiry it requested
reconnection and produced no successful refresh event. A corrected registration
with **Base scopes** `offline_access`, **Default scopes** `sourcesql:access` and
OpenID Connect disabled completed offline-access consent and the two measured
renewal cycles. The corrected temporary registration did not automatically update
the original connection. If saved source OAuth settings cannot be edited in the
host UI, create a corrected registration deliberately; tool refresh alone does
not add offline access. Reconnection and consent alone do not pass renewal.

The original ChatGPT connection was later replaced deliberately with one named
sourcesQL registration, reusing the existing Pro endpoint, audience and public
client with the corrected offline-access settings. Consent and fresh published
successor rendering passed. The original API retained its 86400-second access
lifetime; saved refresh settings were reread at 7 days idle, 30 days maximum,
rotation and a 3-second overlap. Expiry cycles were not shortened or measured on
this replacement; the two-cycle proof remains scoped to the temporary Hobby
registrations. Installed ChatGPT settings showed one sourcesQL entry after test
connections were uninstalled. Claude's temporary OAuth connector was removed and
its original bearer connection was retained.

After testing, the API's access-token lifetimes were restored and both clients'
saved rotating-refresh settings were confirmed at a 7-day idle lifetime, 30-day
maximum and 3-second overlap. These configured lifetimes are not a measurement of
long-term expiration. Native backend records still contained one settled job,
one run, one engine result, a 120-second reservation and zero recorded provider cost.

For each host, require a successful refresh event and a saved-data tool operation
after access-token expiry, with actual rendering and no intervening login. Repeat
after the next expiry to confirm the host retains the rotated replacement. Keep
only safe log metadata and outcomes; never read or export token values or hidden
browser storage. Restore temporary test lifetimes after the check.

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
