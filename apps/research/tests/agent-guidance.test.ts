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
  SOURCESQL_EXTRACTION_BATCH_GUIDANCE,
  SOURCESQL_RECOVERY_GUIDANCE,
  SOURCESQL_QUERY_DESCRIPTION,
  SOURCESQL_OPEN_RESEARCH_DESCRIPTION,
  SOURCESQL_QUERY_PARAMETER_DESCRIPTIONS,
  SOURCESQL_PRESENTATION_GUIDANCE,
  SOURCESQL_SEARCH_EXAMPLE,
  SOURCESQL_SEARCH_GUIDANCE,
  SOURCESQL_SEMANTIC_WORKFLOW_GUIDANCE,
  SOURCESQL_SERVER_INSTRUCTIONS,
} from "../server/agent-guidance.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

async function discover(
  options: { engine?: boolean; capabilities?: object } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-agent-guidance-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const calls: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "capabilities" && options.capabilities)
        return options.capabilities as T;
      throw new Error("Discovery must not execute provider or engine work");
    },
  };
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine: options.engine === false ? undefined : engine },
  );
  const client = new Client({ name: "guidance-wire-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const capabilities = options.capabilities
      ? await client.callTool({ name: "sourcesql_capabilities", arguments: {} })
      : undefined;
    return {
      instructions: client.getInstructions(),
      tools: JSON.parse(JSON.stringify(tools)) as typeof tools,
      calls,
      capabilities,
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
  assert.ok(instructions.startsWith("sourcesQL researches the web with SQL"));
  assert.match(
    instructions,
    /Use sourcesql_query and its configured search provider for discovery requested through sourcesQL/,
  );
  const toolMap = instructions.slice(
    instructions.indexOf("Research tool map:"),
    instructions.indexOf("Choose capabilities before execution."),
  );
  assert.match(
    toolMap,
    /sourcesql_capabilities.*sourcesql_explain.*sourcesql_query.*sourcesql_job_status.*open_research/s,
  );
  assert.ok(
    instructions.indexOf("Choose capabilities before execution.") <
      instructions.indexOf("For explicit manual updates"),
  );
  assert.ok(
    instructions.indexOf("Present only the final curated result") <
      instructions.indexOf("For continuity"),
  );
  assert.match(
    instructions,
    /Review controls are available on the affected cells.*full review is opened on demand/s,
  );
  assert.match(
    instructions,
    /Accept\/Keep choices remain adjustable until publication/,
  );
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

test("MCP wire keeps semantic shortlisting dynamic and embedding scoring optional", async () => {
  const wire = await discover();
  const instructions = wire.instructions!;
  assert.ok(instructions.includes(SOURCESQL_SEMANTIC_WORKFLOW_GUIDANCE));
  assert.match(
    instructions,
    /SEM_MATCH\(content, predicate\) as the LLM semantic filter/,
  );
  assert.match(
    instructions,
    /SEM_MATCH returns true, false or SQL NULL; it does not require an embedding adapter/,
  );
  assert.match(
    instructions,
    /SEM_SCORE is optional embedding relevance for ORDER BY/,
  );
  assert.match(
    instructions,
    /criterion is more specific than the original searches/,
  );
  assert.match(instructions, /Do not require scoring before matching/);
  assert.match(
    instructions,
    /a semantic model alone does not enable SEM_SCORE/,
  );
  assert.match(instructions, /Use SEM_NORM after extraction/);
  assert.match(instructions, /normalization labels are not global entity IDs/);
  assert.match(
    instructions,
    /Filters, ranking criteria and thresholds belong in the host-authored SQL/,
  );
  assert.match(instructions, /absent metadata is not evidence of irrelevance/);
  assert.match(
    instructions,
    /WHERE SEM_MATCH\(\.\.\.\) drops both false and NULL/,
  );
  assert.match(
    instructions,
    /retain its NULL rows separately for bounded follow-up/,
  );
  assert.doesNotMatch(
    instructions,
    /first deduplicate and filter search metadata/,
  );
  const query = wire.tools.find((tool) => tool.name === "sourcesql_query")!;
  assert.match(query.description!, /Use SEM_MATCH to shortlist semantically/);
  assert.match(query.description!, /Optional SEM_SCORE/);
  assert.deepEqual(wire.calls, []);
});

test("MCP initialize bounds extraction batches while retaining complete saved-source coverage", async () => {
  const wire = await discover();
  const instructions = wire.instructions!;
  assert.ok(instructions.includes(SOURCESQL_EXTRACTION_BATCH_GUIDANCE));
  assert.match(
    instructions,
    /hard maximum of 8 extracted items per source invocation/,
  );
  assert.match(instructions, /stricter configured limit/);
  assert.match(instructions, /explicit bounded entity set/);
  assert.match(instructions, /evidence-preserving source windows/);
  assert.match(instructions, /view:"sources" and the exact saved result_id/);
  assert.match(instructions, /Track completed, pending and unresolved/);
  assert.match(
    instructions,
    /Preserve the full requested coverage across batches/,
  );
  assert.match(instructions, /do not silently keep the first eight items/);
  assert.match(instructions, /Do not invent a max_items SQL argument/);
  assert.match(instructions, /does not authorize extra provider work/);
  assert.deepEqual(wire.calls, []);
});

test("MCP wire plans per-field evidence and bounded saved-source partial research", async () => {
  const wire = await discover();
  const instructions = wire.instructions!;
  assert.match(
    instructions,
    /multiple facts, use separate named SEM_EXTRACT fields with evidence := 'per_field'/,
  );
  assert.match(instructions, /rather than a scalar paragraph/);
  assert.match(instructions, /ordinarily missing fact as SQL NULL/);
  assert.match(
    instructions,
    /failed semantic processing is unavailable evidence/,
  );
  assert.match(instructions, /batches of 2 to 4 source documents/);
  assert.match(instructions, /LIMIT in the candidate CTE before SEM_EXTRACT/);
  assert.match(instructions, /not only in the outer final SELECT/);
  assert.match(instructions, /Reuse the original input.sources relation/);
  assert.match(
    instructions,
    /same source identity, content version, field definition, evidence options and model/,
  );
  assert.match(
    instructions,
    /semantic failure does not justify repeating discovery/,
  );
  assert.match(
    instructions,
    /user accepts gaps, explicitly pass partial_policy: 'retain_partial'/,
  );
  assert.match(
    instructions,
    /Reserve partial_policy: 'strict' for a user-requested all-or-nothing result/,
  );
  assert.match(
    instructions,
    /preserve that status.*rather than claiming complete coverage/,
  );
  assert.match(
    instructions,
    /Distinct content versions can differ in date, entity or scope/,
  );
  assert.match(
    instructions,
    /Do not blindly collapse distinct content versions/,
  );
  assert.match(
    instructions,
    /existing approved budget permits, perform one bounded sourcesQL follow-up using that entity and field/,
  );
  assert.match(
    instructions,
    /keep unrelated rows and fields unchanged.*leave the cell unknown/,
  );
  const query = wire.tools.find((tool) => tool.name === "sourcesql_query")!;
  const properties = query.inputSchema.properties as Record<
    string,
    { enum?: string[] }
  >;
  assert.deepEqual(properties.partial_policy.enum, [
    "strict",
    "retain_partial",
  ]);
  assert.deepEqual(wire.calls, []);
});

test("MCP initialize preserves failure identity and requires approved fallback or uncertain-work recovery", async () => {
  const wire = await discover();
  const instructions = wire.instructions!;
  assert.ok(instructions.includes(SOURCESQL_RECOVERY_GUIDANCE));
  assert.match(
    instructions,
    /Do not fall back to ChatGPT web search.*unless the user explicitly approves/,
  );
  assert.match(
    instructions,
    /including after validation errors, timeouts, provider failures or capacity blocks/,
  );
  assert.match(
    instructions,
    /Distinguish invalid_output.*from a timeout or provider failure/,
  );
  assert.match(instructions, /timeout does not prove invalid output/);
  assert.match(instructions, /Preserve completed result_id handles/);
  assert.match(instructions, /open_research with that exact job_id/);
  assert.match(
    instructions,
    /no job handle.*without fabricating a widget or identifier/,
  );
  assert.match(instructions, /correct.*using saved input.sources/);
  assert.match(
    instructions,
    /remote_outcome_unknown or submission_unknown, do not automatically replay/,
  );
  assert.match(instructions, /stop for explicit recovery authorization/);
  assert.deepEqual(wire.calls, []);
});

test("tools/list describes research capabilities, inputs and side effects concisely while initialize retains planning", async () => {
  const wire = await discover();
  const query = wire.tools.find((tool) => tool.name === "sourcesql_query")!;
  const capabilities = wire.tools.find(
    (tool) => tool.name === "sourcesql_capabilities",
  )!;
  const open = wire.tools.find((tool) => tool.name === "open_research")!;
  assert.equal(query.description, SOURCESQL_QUERY_DESCRIPTION);
  assert.equal(capabilities.description, SOURCESQL_CAPABILITIES_DESCRIPTION);
  assert.equal(open.description, SOURCESQL_OPEN_RESEARCH_DESCRIPTION);
  for (const [tool, maximum] of [
    [query, 1800],
    [capabilities, 650],
    [open, 1200],
  ] as const) {
    assert.ok(
      tool.description!.length <= maximum,
      `${tool.name} description exceeds ${maximum} characters`,
    );
    assert.ok(!tool.description!.includes(SOURCESQL_SEARCH_GUIDANCE));
    assert.ok(!tool.description!.includes(SOURCESQL_PRESENTATION_GUIDANCE));
  }
  assert.match(
    query.description!,
    /WEB_SEARCH searches the configured provider/,
  );
  assert.match(query.description!, /stores immutable results and receipts/);
  assert.match(query.description!, /may return a durable job/);
  assert.match(
    query.description!,
    /same request_id recover a lost submission response/,
  );
  assert.match(
    capabilities.description!,
    /Performs no search, fetch or model call/,
  );
  assert.match(capabilities.description!, /Profile capabilities determine/);
  assert.match(open.description!, /Render a final curated research table/);
  assert.match(
    open.description!,
    /Reopening saved results performs no search or model work/,
  );
  assert.match(open.description!, /host display can fail independently/);
  for (const name of [
    "sourcesql_capabilities",
    "sourcesql_explain",
    "sourcesql_query",
    "sourcesql_job_status",
    "sourcesql_read_result",
    "sourcesql_inspect_evidence",
    "open_research",
  ])
    assert.ok(
      wire.tools.some((tool) => tool.name === name),
      name,
    );
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

test("capabilities returns actual configured profiles without dispatch and engine tools are omitted when no engine exists", async () => {
  const advertised = {
    profiles: [
      {
        name: "personal-auto",
        mode: "live",
        provider: "exa",
        operators: ["WEB_SEARCH"],
        search_types: ["auto"],
        limits: { max_search_queries: 6 },
      },
    ],
  };
  const configured = await discover({ capabilities: advertised });
  assert.deepEqual(configured.calls, ["capabilities"]);
  assert.deepEqual(configured.capabilities?.structuredContent, advertised);
  const withoutEngine = await discover({ engine: false });
  for (const name of [
    "sourcesql_capabilities",
    "sourcesql_explain",
    "sourcesql_query",
  ])
    assert.ok(!withoutEngine.tools.some((tool) => tool.name === name), name);
  assert.ok(withoutEngine.tools.some((tool) => tool.name === "open_research"));
  assert.deepEqual(withoutEngine.calls, []);
});
