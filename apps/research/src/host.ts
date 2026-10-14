import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import "./host.css";

const host = document.getElementById("host")!;
host.innerHTML = `<div id="host-error" role="alert"></div><iframe title="Open WebQL research workspace" sandbox="allow-scripts allow-forms"></iframe>`;
const iframe = host.querySelector("iframe")!;
// Optional content-sized host for checking ChatGPT-style embeds locally.
const embeddedPreview = new URLSearchParams(location.search).has("embedded");
if (embeddedPreview) host.classList.add("embedded-preview");
function download(text: string, name: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function start(): Promise<void> {
  const client = new Client(
    { name: "Open WebQL local preview host", version: "0.1.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] },
        },
      },
    },
  );
  const health = (await fetch("/health").then((r) => r.json())) as {
    mode?: string;
  };
  const token =
    health.mode === "protected"
      ? (window.prompt("Server access token") ?? "")
      : "";
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", location.href), {
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    }),
  );
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "open_research");
  if (!tool) throw new Error("The server did not expose open_research.");
  const resourceUri = (tool._meta?.ui as { resourceUri?: string })?.resourceUri;
  if (!resourceUri)
    throw new Error("The server did not declare its UI resource.");
  const result = await client.callTool({
    name: "open_research",
    arguments: new URLSearchParams(location.search).has("snapshot_id")
      ? { snapshot_id: new URLSearchParams(location.search).get("snapshot_id") }
      : {},
  });
  const resource = await client.readResource({
    uri: resourceUri,
  });
  const html = resource.contents.find((c) => "text" in c);
  if (!html || !("text" in html))
    throw new Error("The server did not return its HTML resource.");
  const bridge = new AppBridge(
    client,
    { name: "Open WebQL local host", version: "0.1.0" },
    { serverTools: {}, openLinks: {}, downloadFile: {} },
    {
      hostContext: {
        theme: "light",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        platform: "web",
        researchPreview: true,
        researchInlineSizing: embeddedPreview,
        ...(embeddedPreview
          ? {
              containerDimensions: {
                maxHeight: Math.min(560, window.innerHeight),
                maxWidth: window.innerWidth,
              },
            }
          : {}),
        toolInfo: { tool },
      },
    },
  );
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(result);
  };
  if (embeddedPreview) {
    bridge.onsizechange = ({ height }) => {
      if (height !== undefined)
        iframe.style.height = `${Math.min(height, window.innerHeight)}px`;
    };
    window.addEventListener("resize", () => {
      bridge.setHostContext({
        containerDimensions: {
          maxHeight: Math.min(560, window.innerHeight),
          maxWidth: window.innerWidth,
        },
      });
    });
  }
  bridge.onopenlink = async ({ url }) => {
    if (!["http:", "https:"].includes(new URL(url).protocol))
      return { isError: true };
    window.open(url, "_blank", "noopener,noreferrer");
    return {};
  };
  bridge.ondownloadfile = async ({ contents }) => {
    for (const item of contents) {
      if (item.type !== "resource" || !("text" in item.resource))
        return { isError: true };
      download(
        item.resource.text,
        item.resource.uri.split("/").pop() || "research.json",
        item.resource.mimeType || "application/json",
      );
    }
    return {};
  };
  await bridge.connect(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!),
  );
  // The view is opaque-origin and cannot reach local endpoints directly; all actions cross the SDK bridge.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
  iframe.srcdoc = html.text.replace("<head>", `<head>${csp}`);
}
void start().catch((error) => {
  document.getElementById("host-error")!.textContent =
    `Unable to open the MCP App: ${String(error)}. Check that npm run build completed, then reload.`;
});
