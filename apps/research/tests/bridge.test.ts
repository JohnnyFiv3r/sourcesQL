import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import { agentMessenger } from "../src/agent-messaging.js";

for (const message of [{ text: {} }, {}]) {
  test(`MCP Apps ${JSON.stringify(message)} message bridge returns results to request polling (simulated research only)`, async () => {
    const seed = snapshotSchema.parse(sample);
    const store = new ResearchStore(
      await mkdtemp(join(tmpdir(), "sourcesql-bridge-")),
      seed,
    );
    const server = createServer(
      store,
      join(process.cwd(), "dist/research.html"),
    );
    const client = new Client({ name: "test-agent", version: "1" });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    const bridge = new AppBridge(
      client,
      { name: "Simulated host", version: "1" },
      { serverTools: {}, message },
      {
        hostContext: {
          toolInfo: { tool: tools.find((t) => t.name === "open_research")! },
        },
      },
    );
    const app = new App(
      { name: "test-app", version: "1" },
      {},
      { autoResize: false },
    );
    const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
    await bridge.connect(hostTransport);
    await app.connect(appTransport);
    try {
      const requestId = randomUUID();
      const prepared = await app.callServerTool({
        name: "expand_research",
        arguments: {
          request_id: requestId,
          snapshot_id: seed.id,
          row_id: "record-1",
          question: "Test a synthetic child result",
        },
      });
      bridge.onmessage = async ({ content }) => {
        assert.match(JSON.stringify(content), new RegExp(requestId));
        const context = await client.callTool({
          name: "get_research_request",
          arguments: { request_id: requestId },
        });
        assert.equal(context.isError, undefined);
        // A real host runs a research query here; synthetic evidence proves only the transport/return contract.
        const returned = await client.callTool({
          name: "append_research",
          arguments: {
            request_id: requestId,
            snapshot: {
              ...seed,
              id: "bridge-child",
              sourceResultSetId: "r123abcdef",
              title: "Synthetic bridge result",
              rows: [],
            },
          },
        });
        assert.equal(returned.isError, undefined);
        return {};
      };
      const send = agentMessenger(app);
      assert.ok(
        send,
        "An advertised text message bridge must enable Ask agent",
      );
      const sent = await send(
        (prepared.structuredContent as { prompt: string }).prompt,
      );
      assert.equal(sent.isError, undefined);
      const status = await app.callServerTool({
        name: "research_status",
        arguments: { snapshot_id: seed.id },
      });
      assert.equal(
        (status.structuredContent as ResearchView).requests[0].resultSnapshotId,
        "bridge-child",
      );
      bridge.onmessage = async () => ({ isError: true });
      assert.equal((await send("Test rejected message")).isError, true);
    } finally {
      await app.close();
      await bridge.close();
      await client.close();
      await server.close();
    }
  });
}
