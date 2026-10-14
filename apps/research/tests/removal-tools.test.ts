import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

test("MCP exposes removal and undo with exact IDs, honest receipts and actionable errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-removal-tools-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const seed = snapshotSchema.parse(sample);
  const store = new ResearchStore(join(directory, "data"), seed);
  await store.import({ ...seed, id: "child", parentSnapshotId: seed.id });
  const server = createServer(store, htmlPath);
  const client = new Client({ name: "removal-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    for (const name of ["remove_research", "restore_research"]) {
      const tool = tools.find((t) => t.name === name)!;
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.equal(
        tool.annotations?.destructiveHint,
        name === "remove_research",
      );
      assert.deepEqual(tool.inputSchema.required, ["snapshot_id"]);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool._meta?.ui, undefined);
    }
    const args = {
      name: "remove_research",
      arguments: { snapshot_id: "child" },
    };
    const removed = await client.callTool(args);
    assert.equal(removed.isError, undefined);
    const receipt = removed.structuredContent as Record<string, unknown>;
    assert.equal(receipt.status, "archived");
    assert.equal(receipt.parentSnapshotId, seed.id);
    assert.match(JSON.stringify(removed.content), /open_research/);
    assert.deepEqual(
      (await client.callTool(args)).structuredContent,
      removed.structuredContent,
    );
    assert.equal(
      (
        await client.callTool({
          name: "open_research",
          arguments: { snapshot_id: "child" },
        })
      ).isError,
      true,
    );
    const restored = await client.callTool({
      name: "restore_research",
      arguments: { snapshot_id: "child" },
    });
    assert.equal(restored.isError, undefined);
    assert.match(JSON.stringify(restored.content), /open_research/);
    assert.equal(
      (
        await client.callTool({
          name: "open_research",
          arguments: { snapshot_id: "child" },
        })
      ).isError,
      undefined,
    );
    const rejected = await client.callTool({
      name: "remove_research",
      arguments: { snapshot_id: seed.id },
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /Root tables are preserved/);
  } finally {
    await client.close();
    await server.close();
  }
});
