import { version } from "../package.json";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { mountHostAuth } from "./host-auth.js";
import "./host.css";

const host = document.getElementById("host")!;
host.innerHTML = `<div id="host-error" role="alert"></div><div id="host-auth"></div><iframe title="sourcesQL research workspace" sandbox="allow-scripts allow-forms" style="display:none"></iframe>`;
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
async function start(token = ""): Promise<void> {
  const client = new Client(
    { name: "sourcesQL local preview host", version },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] },
        },
      },
    },
  );
  let activeBridge: AppBridge | undefined;
  let resizeHandler: (() => void) | undefined;
  try {
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
    const resourceUri = (tool._meta?.ui as { resourceUri?: string })
      ?.resourceUri;
    if (!resourceUri)
      throw new Error("The server did not declare its UI resource.");
    const result = await client.callTool({
      name: "open_research",
      arguments: new URLSearchParams(location.search).has("job_id")
        ? { job_id: new URLSearchParams(location.search).get("job_id") }
        : new URLSearchParams(location.search).has("snapshot_id")
          ? {
              snapshot_id: new URLSearchParams(location.search).get(
                "snapshot_id",
              ),
            }
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
      { name: "sourcesQL local host", version },
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
    activeBridge = bridge;
    bridge.oninitialized = async () => {
      await bridge.sendToolInput({ arguments: {} });
      await bridge.sendToolResult(result);
    };
    if (embeddedPreview) {
      bridge.onsizechange = ({ height }) => {
        if (height !== undefined)
          iframe.style.height = `${Math.min(height, window.innerHeight)}px`;
      };
      resizeHandler = () => {
        bridge.setHostContext({
          containerDimensions: {
            maxHeight: Math.min(560, window.innerHeight),
            maxWidth: window.innerWidth,
          },
        });
      };
      window.addEventListener("resize", resizeHandler);
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
    iframe.style.removeProperty("display");
  } catch (error) {
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    await activeBridge?.close().catch(() => {});
    await client.close().catch(() => {});
    throw error;
  }
}
async function initialize(): Promise<void> {
  const response = await fetch("/health", { cache: "no-store" });
  if (!response.ok) throw new Error("Health check failed");
  const health = (await response.json()) as { mode?: string };
  const authentication = document.getElementById("host-auth")!;
  if (health.mode === "protected") {
    mountHostAuth(authentication, (token) => start(token));
  } else if (health.mode === "fixture-anonymous") {
    authentication.remove();
    await start();
  } else {
    throw new Error("Unknown server access mode");
  }
}
void initialize().catch(() => {
  document.getElementById("host-error")!.textContent =
    "Unable to open sourcesQL. Check your connection and reload.";
});
