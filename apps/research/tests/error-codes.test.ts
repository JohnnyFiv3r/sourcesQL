import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import { EngineCallError, type ResearchEngine } from "../server/engine.js";
import { messages } from "../server/execution-errors.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

type Table = {
  codes: Record<string, { summary: string; hosted_visible: boolean }>;
};
const table = JSON.parse(
  await readFile(
    new URL("../../../src/sourcesql/error_codes.json", import.meta.url),
    "utf8",
  ),
) as Table;

test("the hosted-job allowlist is exactly the shared table's hosted-visible codes", () => {
  const hosted = Object.entries(table.codes)
    .filter(([, entry]) => entry.hosted_visible)
    .map(([code]) => code)
    .sort();
  assert.deepEqual(Object.keys(messages).sort(), hosted);
  for (const code of hosted)
    assert.equal(messages[code], table.codes[code].summary, code);
});

async function queryWith(error: Error) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-error-codes-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const engine: ResearchEngine = {
    async call<T>(): Promise<T> {
      throw error;
    },
  };
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "error-code-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({
      name: "sourcesql_query",
      arguments: { query: "SELECT 1 AS value" },
    });
    return result as { isError?: boolean; content: { text: string }[] };
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a local engine error with an unknown code returns the fixed summary, not the engine text", async () => {
  const result = await queryWith(
    new EngineCallError("weird_internal", "/home/u/secret KEY=abc"),
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    `execution_failed: ${messages.execution_failed}`,
  );
});

test("a local engine error with a known code keeps the engine's own message", async () => {
  const result = await queryWith(
    new EngineCallError("invalid_query", "Column is unknown or ambiguous"),
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "invalid_query: Column is unknown or ambiguous",
  );
});
