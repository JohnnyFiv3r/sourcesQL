import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { PythonEngine, resultSnapshot } from "../server/engine.js";
import type { EngineResult } from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import { authorizeSnapshot } from "../server/access.js";
import { buildMaterializationPayload } from "../server/materialization.js";
import { leadIntakeText } from "../server/agent-guidance.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import { testEnv } from "./python.js";

type Text = { type: string; text?: string };
const textOf = (result: { content?: unknown }) =>
  (result.content as Text[]).map((part) => part.text ?? "").join(" ");

async function connect(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-lead-intake-"));
  const engine = new PythonEngine(undefined, {
    ...testEnv(),
    SOURCESQL_DATA_DIR: join(dir, "engine"),
    SOURCESQL_PRINCIPAL: "lead-owner",
  });
  const server = createServer(
    new ResearchStore(join(dir, "app"), snapshotSchema.parse(sample)),
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    { engine },
  );
  const client = new Client({ name: "lead-intake-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { client, engine };
}

const lead = (n: number) => ({
  url: `https://site${n}.example/page`,
  title: `Page ${n}`,
  query: "campus plans",
  rank: n + 1,
});

test("add_research_leads replies with counts, refusals and the host-asserted sentence", async (t) => {
  const { client } = await connect(t);
  const first = await client.callTool({
    name: "add_research_leads",
    arguments: {
      request_id: randomUUID(),
      title: "Campus search",
      leads: [
        lead(1),
        lead(2),
        { url: "ftp://x.example/file", title: "ftp" },
        { url: "https://dated.example/", title: "d", date: "02/01/2026" },
      ],
    },
  });
  assert.notEqual(first.isError, true, textOf(first));
  const reply = first.structuredContent as {
    lead_set_id: string;
    result_id: string;
    revision: number;
  };
  assert.equal(reply.revision, 1);
  const text = textOf(first);
  assert.match(text, /^Stored 3 leads in lead set [0-9a-f-]{36}, revision 1, /);
  assert.match(
    text,
    /3 are new, 0 were already present; their queries and ranks were kept\./,
  );
  assert.match(text, /1 row was refused: row 3: not an http or https URL\./);
  assert.match(text, /1 date was not in YYYY-MM-DD form and was left out\./);
  assert.match(
    text,
    /The lead set now has 3 leads, 0 fetched, 0 failed, 3 pending\./,
  );
  assert.match(
    text,
    /These leads are host-asserted: sourcesQL has not fetched or checked them\./,
  );
  assert.match(text, new RegExp(`leads view of result_id ${reply.result_id}`));

  const second = await client.callTool({
    name: "add_research_leads",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: reply.lead_set_id,
      leads: [lead(2), lead(9)],
    },
  });
  assert.match(textOf(second), /1 is new, 1 was already present;/);
  assert.match(textOf(second), /revision 2/);
});

test("a missing or over-long field refuses only its own row, through the MCP schema", async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: "add_research_leads",
    arguments: {
      request_id: randomUUID(),
      leads: [
        lead(1),
        { title: "no url" },
        { url: "https://x.example/" + "a".repeat(2100), title: "long" },
        { url: "https://notitle.example/" },
        { url: "https://rank.example/", title: "rank", rank: 1.5 },
        { url: "https://query.example/", title: "q", query: "q".repeat(400) },
      ],
    },
  });
  assert.notEqual(result.isError, true, textOf(result));
  const reply = result.structuredContent as {
    stored: number;
    refused: { index: number; reason: string }[];
  };
  assert.equal(reply.stored, 1);
  assert.deepEqual(reply.refused, [
    { index: 1, reason: "missing URL" },
    { index: 2, reason: "URL is longer than 2048 characters" },
    { index: 3, reason: "missing title" },
    { index: 4, reason: "rank must be a whole number from 1 to 1000" },
    { index: 5, reason: "query is longer than 300 characters" },
  ]);
});

test("add_research_leads names the engine's own refusal for too many rows", async (t) => {
  const { client } = await connect(t);
  const result = await client.callTool({
    name: "add_research_leads",
    arguments: {
      request_id: randomUUID(),
      leads: Array.from({ length: 151 }, (_, n) => lead(n)),
    },
  });
  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    "invalid_request: Too many leads in one call: 151. Send at most 150 per call and call again with the same lead_set_id.",
  );
});

test("the refused-row list stops at ten and counts the rest", () => {
  const text = leadIntakeText({
    lead_set_id: "set",
    revision: 1,
    result_id: "wq_x",
    stored: 0,
    new: 0,
    already_present: 0,
    refused: Array.from({ length: 12 }, (_, index) => ({
      index,
      reason: "missing URL",
    })),
    dates_left_out: 0,
    totals: { leads: 0, fetched: 0, failed: 0, pending: 0 },
  });
  assert.match(text, /12 rows were refused: row 1: missing URL;/);
  assert.match(text, /row 10: missing URL, and 2 more\./);
  assert.ok(!text.includes("row 11"));
});

test("the add_research_leads tool entry stays within 4 KB and uses no $ref", async (t) => {
  const { client } = await connect(t);
  const tool = (await client.listTools()).tools.find(
    (entry) => entry.name === "add_research_leads",
  )!;
  const size = JSON.stringify(tool).length;
  assert.ok(size <= 4096, `tool entry is ${size} characters`);
  assert.ok(!JSON.stringify(tool).includes("$ref"));
});

test("a lead-set result becomes a host_reported snapshot and a view-bound query keeps the class", async (t) => {
  const { client, engine } = await connect(t);
  const added = await client.callTool({
    name: "add_research_leads",
    arguments: { request_id: randomUUID(), leads: [lead(1), lead(2)] },
  });
  const { result_id } = added.structuredContent as { result_id: string };
  const page = await engine.call<EngineResult>("read_result", { result_id });
  const snapshot = resultSnapshot(page, {
    result_id,
    snapshot_id: "lead-snapshot",
    title: "Leads",
  });
  assert.equal(snapshot.dataClassification, "host_reported");
  assert.equal(snapshot.rows.length, 2);
  const queried = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: "SELECT url FROM input.l WHERE host_rank <= 2",
      inputs: { l: { result_id, view: "leads", amendment_revision: null } },
    },
  });
  assert.notEqual(queried.isError, true, textOf(queried));
  assert.equal(
    (queried.structuredContent as { data_classification?: string })
      .data_classification,
    "host_reported",
  );
  const hits = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: "SELECT count(*) AS n FROM input.h",
      inputs: { h: { result_id, view: "hits", amendment_revision: null } },
    },
  });
  assert.notEqual(hits.isError, true, textOf(hits));
});

test("anonymous fixture mode refuses host_reported snapshots with the existing text", () => {
  const snapshot = snapshotSchema.parse({
    schemaVersion: 2,
    id: "host-reported",
    title: "Leads",
    origin: { engine: "sourcesql", resultId: "wq_x", runId: "run_x" },
    capturedAt: "2026-11-24T00:00:00.000Z",
    capturePrecision: "instant",
    captureBasis: "run_completed_at",
    rowCount: 1,
    dataClassification: "host_reported",
    coverage: { planComplete: true, corpusComplete: "unknown", notes: [] },
    columns: [
      { key: "url", label: "URL", logicalType: "VARCHAR", nullable: false },
    ],
    rows: [
      {
        id: "lead_1",
        values: { url: "https://a.example/" },
        sourceUrl: null,
        evidence: {},
        verificationNote: "",
      },
    ],
  });
  assert.throws(
    () =>
      authorizeSnapshot(snapshot, {
        mode: "fixture-anonymous",
        principal: "anon",
        allowPrivateDisclosure: false,
      }),
    /Anonymous fixture mode accepts synthetic fixture data only/,
  );
  assert.doesNotThrow(() =>
    authorizeSnapshot(snapshot, {
      mode: "protected",
      principal: "owner",
      allowPrivateDisclosure: false,
    }),
  );
});

test("an effective table built on host_reported data is not sent to the engine as host_reported", () => {
  const snapshot = snapshotSchema.parse({
    schemaVersion: 2,
    id: "host-reported",
    title: "Leads",
    origin: { engine: "sourcesql", resultId: "wq_x", runId: "run_x" },
    capturedAt: "2026-11-24T00:00:00.000Z",
    capturePrecision: "instant",
    captureBasis: "run_completed_at",
    rowCount: 1,
    dataClassification: "host_reported",
    dataRef: { resultId: "wq_x", contentSha256: "a".repeat(64) },
    coverage: { planComplete: true, corpusComplete: "unknown", notes: [] },
    columns: [
      { key: "url", label: "URL", logicalType: "VARCHAR", nullable: false },
    ],
    rows: [
      {
        id: "lead_1",
        values: { url: "https://a.example/" },
        sourceUrl: null,
        evidence: {},
        verificationNote: "",
      },
    ],
  });
  const payload = buildMaterializationPayload({
    root: {
      snapshot,
      amendments: [],
      revision: 0,
      displayTitle: "Leads",
      dataClassification: "host_reported",
    } as never,
    dependencies: [],
  } as never);
  assert.equal(payload.data_classification, "public_web");
  assert.deepEqual(
    payload.parents.map((parent) => parent.result_id),
    ["wq_x"],
  );
});
