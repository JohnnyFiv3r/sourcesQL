import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { MotherDuckEngine } from "../server/motherduck.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

// MCP boundary check only: no provider execution or semantic-quality claim.
test("MCP defaults to retained partial work and forwards an explicit strict choice unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-query-policy-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Fixture</html>");
  const received: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      calls.push(method);
      if (method === "capabilities")
        return { profiles: [{ name: "fixture", mode: "fixture" }] } as T;
      if (method === "query") {
        received.push(params);
        return { status: "partial", unresolved: ["semantic_failed"] } as T;
      }
      throw new Error("Unexpected engine work");
    },
  };
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "partial-policy-wire-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const query = tools.find((tool) => tool.name === "sourcesql_query")!;
    const properties = query.inputSchema.properties as Record<
      string,
      { default?: unknown }
    >;
    assert.equal(properties.partial_policy.default, "retain_partial");
    for (const partial_policy of [undefined, "strict", "retain_partial"]) {
      const result = await client.callTool({
        name: "sourcesql_query",
        arguments: {
          query: "SELECT 1 AS value",
          ...(partial_policy ? { partial_policy } : {}),
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        status: "partial",
        unresolved: ["semantic_failed"],
      });
    }
    assert.deepEqual(
      received.map((request) => request.partial_policy),
      ["retain_partial", "strict", "retain_partial"],
    );
    assert.deepEqual(calls, [
      "capabilities",
      "query",
      "capabilities",
      "query",
      "capabilities",
      "query",
    ]);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native hosted tool discovery omits local-only explain without touching the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-native-tools-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Fixture</html>");
  const engine = new MotherDuckEngine({
    database: "sourcesql",
    host: "pg.us-east-1-aws.motherduck.com",
    token: "synthetic-token",
    principal: "synthetic-owner",
    flightId: "4252d0f1-fa38-495a-b305-a897fcb859a3",
    clientFactory() {
      throw new Error("Tool discovery must not open a database connection");
    },
  });
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "native-tools-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    assert.equal(
      tools.some((tool) => tool.name === "sourcesql_explain"),
      false,
    );
    for (const name of [
      "sourcesql_capabilities",
      "sourcesql_query",
      "sourcesql_job_status",
      "open_research",
    ])
      assert.ok(
        tools.some((tool) => tool.name === name),
        name,
      );
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
