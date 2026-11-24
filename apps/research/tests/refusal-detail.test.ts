import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { PythonEngine } from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import { testEnv } from "./python.js";

// Each refusal reaches the agent as `code: sentence. detail. next step.` through
// the real engine bridge and the MCP error path.
const SENTENCE =
  "Call sourcesql_capabilities to see the supported operators and constructs.";
const cases: {
  name: string;
  args: Record<string, unknown>;
  expected: string;
}[] = [
  {
    name: "a parse error names the position",
    args: { query: "SELEC 1" },
    expected:
      "invalid_query: SQL could not be parsed in the installed dialect. Line 1, column 7: Unexpected token. Fix the SQL at that position and run it again.",
  },
  {
    name: "an unknown column is named",
    args: { query: "SELECT nope FROM (SELECT 1 AS a) t" },
    expected:
      "invalid_query: Column is unknown or ambiguous; use an explicit relation alias. Column name: nope. Check the column names of the relations in FROM, or qualify it as alias.column.",
  },
  {
    name: "an unbound parameter is named",
    args: { query: "SELECT $missing AS n" },
    expected:
      "invalid_query: A query parameter has no binding. Parameter name: missing. Pass a value for missing in parameters, with the same name as in the SQL but without the dollar sign.",
  },
  {
    name: "an unknown profile lists the valid ones",
    args: { query: "SELECT 1 AS n", profile: "live" },
    expected:
      "unsupported_capability: Profile unavailable. Requested profile: live. Available profiles: fixture. Choose one of these, or omit profile to use the default.",
  },
  {
    name: "a budget over its ceiling names the key and maximum",
    args: { query: "SELECT 1 AS n", budgets: { max_fetches: 99 } },
    expected:
      "invalid_request: Requested budget exceeds the supported ceiling. Budget key max_fetches is at most 40; you sent 99. Lower it to 40 or less.",
  },
  {
    name: "an exhausted allowance names the counter and limit",
    args: {
      query:
        "SELECT url FROM WEB_FETCH('https://aurora.example/project','https://aurora.example/other')",
      budgets: { max_fetches: 1 },
    },
    expected:
      "budget_exhausted: Work allowance exhausted. The max_fetches allowance of 1 was used up. Narrow the query, or ask the user to approve a higher limit.",
  },
  {
    name: "an unsupported construct points at capabilities",
    args: { query: "SELECT * FROM read_csv('x')" },
    expected: `unsupported_query: Unsupported SQL construct: ReadCSV. ${SENTENCE}`,
  },
];

test("common refusals tell the agent what to change, through the real engine and MCP error path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-refusal-detail-"));
  const engine = new PythonEngine(undefined, {
    ...testEnv(),
    SOURCESQL_DATA_DIR: join(dir, "engine"),
    SOURCESQL_PRINCIPAL: "refusal-owner",
  });
  const server = createServer(
    new ResearchStore(join(dir, "app"), snapshotSchema.parse(sample)),
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    { engine },
  );
  const client = new Client({ name: "refusal-detail-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const { name, args, expected } of cases) {
      const result = await client.callTool({
        name: "sourcesql_query",
        arguments: { request_id: randomUUID(), ...args },
      });
      assert.equal(result.isError, true, name);
      const text = (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? "")
        .join(" ");
      assert.equal(text, expected, name);
    }
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
