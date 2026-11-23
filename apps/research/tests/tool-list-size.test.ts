import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const TOTAL_BUDGET = 110000;
const TOOL_BUDGET = 16384;

const JOB_TOOLS = [
  "sourcesql_cancel_job",
  "sourcesql_job_status",
  "sourcesql_start_job",
];
// A local engine runs synchronously and lists no job tools; a hosted one does.
const CONFIGURATIONS = [
  { name: "local", jobs: false, count: 36 },
  { name: "hosted", jobs: true, count: 39 },
] as const;

async function listTools(jobs: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-tool-size-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const engine: ResearchEngine = {
    ...(jobs ? { supportsAsyncJobs: true } : {}),
    async call<T>(): Promise<T> {
      throw new Error("Listing tools must not execute engine work");
    },
  };
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "tool-size-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const { name, jobs, count } of CONFIGURATIONS) {
  test(`the ${name} tool list keeps its names and uses no $ref or $defs`, async () => {
    const tools = await listTools(jobs);
    assert.equal(tools.length, count);
    const listed = tools.map((tool) => tool.name);
    for (const job of JOB_TOOLS) assert.equal(listed.includes(job), jobs, job);
    const text = JSON.stringify(tools);
    assert.ok(!text.includes('"$ref"'), "tool schemas must not use $ref");
    assert.ok(!text.includes('"$defs"'), "tool schemas must not use $defs");
  });
}

test("the advertised tool list stays within the total size budget", async (t) => {
  const tools = await listTools(true);
  const sizes = tools
    .map((tool) => ({ name: tool.name, size: JSON.stringify(tool).length }))
    .sort((x, y) => y.size - x.size);
  // A host receives the whole list as one JSON array, so measure that, not a sum of entries.
  const total = JSON.stringify(tools).length;
  t.diagnostic(`tool list total: ${total} characters`);
  const top = sizes
    .slice(0, 3)
    .map((tool) => `${tool.name} ${tool.size}`)
    .join(", ");
  assert.ok(
    total <= TOTAL_BUDGET,
    `Tool list is ${total} characters, over the budget of ${TOTAL_BUDGET}. Largest tools: ${top}`,
  );
});

test("no tool entry goes over the per-tool size budget", async () => {
  for (const tool of await listTools(true)) {
    const size = JSON.stringify(tool).length;
    assert.ok(
      size <= TOOL_BUDGET,
      `Tool ${tool.name} schema is ${size} characters, over the per-tool budget of ${TOOL_BUDGET}.`,
    );
  }
});
