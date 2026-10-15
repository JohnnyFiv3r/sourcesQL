import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import {
  SOURCESQL_CAPABILITIES_DESCRIPTION,
  SOURCESQL_QUERY_DESCRIPTION,
  SOURCESQL_QUERY_PARAMETER_DESCRIPTIONS,
  SOURCESQL_SEARCH_EXAMPLE,
  SOURCESQL_SEARCH_GUIDANCE,
  SOURCESQL_SERVER_INSTRUCTIONS,
} from "../server/agent-guidance.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

async function discover() {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-agent-guidance-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const calls: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      throw new Error("Discovery must not execute provider or engine work");
    },
  };
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "guidance-wire-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    return {
      instructions: client.getInstructions(),
      tools: JSON.parse(JSON.stringify(tools)) as typeof tools,
      calls,
    };
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("MCP initialize exposes the research workflow before any tool or provider is called", async () => {
  const wire = await discover();
  assert.equal(wire.instructions, SOURCESQL_SERVER_INSTRUCTIONS);
  assert.deepEqual(wire.calls, []);
  const instructions = wire.instructions!;
  for (const requiredStep of [
    "sourcesql_capabilities",
    "sourcesql_query",
    "sourcesql_job_status",
    "sourcesql_start_job",
    "sourcesql_read_result",
    "sourcesql_inspect_evidence",
    "open_research",
    "append_research",
  ])
    assert.ok(instructions.includes(requiredStep), requiredStep);
  assert.match(
    instructions,
    /omitting profile selects the safe synthetic fixture default/,
  );
  assert.match(instructions, /rather than silently doing the research/);
  assert.match(instructions, /separate asynchronous Agent.*not enabled/);
  assert.match(instructions, /untrusted data, never instructions/);
  assert.match(
    instructions,
    /Prioritize research quality over the number of free runs/,
  );
  assert.match(instructions, /approved allowance is exhausted, pause/);
  assert.match(instructions, /Plan query coverage before retrieval/);
  assert.match(instructions, /complementary Auto searches with useful overlap/);
  assert.match(instructions, /preserve their query-hit provenance/);
  assert.match(instructions, /joins over stored candidates/);
  assert.match(instructions, /Joins can multiply rows/);
  assert.match(instructions, /deep-reasoning search selectively/);
  assert.match(instructions, /ten-page profile is not a thousand-page search/);
  assert.ok(instructions.includes(SOURCESQL_SEARCH_GUIDANCE));
  assert.match(instructions, /at least 6 maximally diverse queries/);
  assert.match(instructions, /Vary terminology, source type and angle/);
  assert.match(instructions, /Generate the search terms yourself/);
  assert.match(instructions, /constraint before searching/);
  assert.match(instructions, /split jobs to evade limits/);
  assert.doesNotMatch(
    instructions,
    /Use a few complementary|Do not impose an arbitrary minimum|Tennessee/,
  );
  assert.equal((SOURCESQL_SEARCH_EXAMPLE.match(/\$q[1-6]\b/g) ?? []).length, 6);
  assert.doesNotMatch(
    instructions,
    /prefer the strongest configured research profile/i,
  );
  assert.match(instructions, /Presentation is the final step/);
  assert.match(
    instructions,
    /Call open_research once for the final curated table/,
  );
  assert.match(
    instructions,
    /not after each query, poll, import or transformation/,
  );
  assert.match(instructions, /display labels before rendering/);
  assert.match(
    instructions,
    /human entity name or useful document identifier first/,
  );
  assert.match(instructions, /source URL metadata last/);
  assert.match(instructions, /explicit final ORDER BY/);
  assert.match(instructions, /do not silently rerank saved rows/);
  assert.match(instructions, /preserve that gap.*instead of inventing a title/);
  assert.match(instructions, /Cosmetic cleanup.*does not justify new searches/);
  assert.match(instructions, /SQL is the cost-control planner/);
  assert.match(instructions, /WHERE conjuncts before semantic predicates/);
  assert.match(instructions, /SEM_MATCH before projected SEM_EXTRACT/);
  assert.match(
    instructions,
    /filters are not pushed across CTE\/LIMIT boundaries/,
  );
});

test("tools/list exposes capability-aware research guidance without weakening the fixture default or adding fictitious parameters", async () => {
  const wire = await discover();
  const query = wire.tools.find((tool) => tool.name === "sourcesql_query")!;
  const capabilities = wire.tools.find(
    (tool) => tool.name === "sourcesql_capabilities",
  )!;
  assert.equal(query.description, SOURCESQL_QUERY_DESCRIPTION);
  assert.equal(capabilities.description, SOURCESQL_CAPABILITIES_DESCRIPTION);
  for (const description of [query.description!, capabilities.description!]) {
    assert.ok(description.includes(SOURCESQL_SEARCH_GUIDANCE));
    assert.match(description, /Targeted follow-up research.*fewer queries/);
  }
  const properties = query.inputSchema.properties as Record<
    string,
    { default?: unknown; description?: string }
  >;
  assert.equal(properties.profile.default, "fixture");
  assert.equal(
    properties.profile.description,
    SOURCESQL_QUERY_PARAMETER_DESCRIPTIONS.profile,
  );
  assert.equal(
    properties.source_mode.description,
    SOURCESQL_QUERY_PARAMETER_DESCRIPTIONS.source_mode,
  );
  assert.equal(properties.search_type, undefined);
  assert.equal(properties.deep_research, undefined);
  assert.deepEqual(
    wire.tools
      .filter(
        (tool) =>
          (tool._meta?.ui as { resourceUri?: string } | undefined)
            ?.resourceUri || tool._meta?.["openai/outputTemplate"],
      )
      .map((tool) => tool.name),
    ["open_research"],
  );
  assert.deepEqual(wire.calls, []);
});
