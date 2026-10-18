import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  resultSnapshot,
  boundedPreview,
  resolveResult,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import {
  queryFeedbackSchema,
  type QueryFeedback,
} from "../src/query-feedback.js";
import { encodeResearchView, decodeResearchView } from "../src/view-wire.js";
import sample from "../fixtures/water-procurement.json";

const feedback: QueryFeedback = {
  schema_version: 1,
  advisory: true,
  query_sha256: "a".repeat(64),
  parameters_sha256: "b".repeat(64),
  input_pins_sha256: "c".repeat(64),
  description_status: "available",
  description: {
    summary: "Return source titles and URLs, limited to two rows.",
    steps: [
      {
        scope: "main",
        kind: "projection",
        text: "Return title and url",
        sql: "title AS source_title, url AS source_url",
      },
    ],
    omitted_steps: 0,
  },
  intent_status: "provided",
  answer_intent: {
    row_unit: "One entity",
    fields: [{ key: "entity", meaning: "Entity name" }],
  },
  output_columns: ["source_title", "source_url"],
  missing_intended_fields: ["entity"],
  result_observations: {
    row_count: 2,
    null_cells: [
      { key: "source_title", count: 0 },
      { key: "source_url", count: 0 },
    ],
  },
};

function result(queryFeedback: unknown = feedback): EngineResult {
  return {
    result_id: "wq_feedback",
    run_id: "run_feedback",
    row_count: 2,
    row_ids: ["row_one", "row_two"],
    columns: ["source_title", "source_url"].map((key) => ({
      key,
      label: key,
      logical_type: "VARCHAR",
      nullable: false,
    })),
    rows: [
      { source_title: "First source", source_url: "https://example.com/one" },
      { source_title: "Second source", source_url: "https://example.com/two" },
    ],
    content_sha256: "d".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    query_feedback: queryFeedback,
    receipt: {
      status: "completed",
      finished_at: "2026-10-18T12:00:00Z",
      query_feedback: queryFeedback,
    },
    next_offset: null,
  };
}

function view(queryFeedback: unknown = feedback): ResearchView {
  const snapshot = snapshotSchema.parse(
    resultSnapshot(result(queryFeedback), {
      result_id: "wq_feedback",
      snapshot_id: "saved_feedback",
      title: "Saved source catalog",
    }),
  );
  return {
    snapshot,
    displayTitle: snapshot.title,
    amendments: [],
    revision: 0,
    snapshots: [],
    requests: [],
  };
}

test("advisory mismatch round-trips outside strict legacy snapshots and preserves all rows", () => {
  const original = view();
  const wire = structuredClone(encodeResearchView(original));
  assert.equal(Object.hasOwn(wire.snapshot, "queryFeedback"), false);
  assert.deepEqual(wire.queryFeedbackV1?.feedback, feedback);
  assert.deepEqual(decodeResearchView(wire), original);
  assert.equal(decodeResearchView(wire).snapshot.rows.length, 2);
  const { queryFeedbackV1: ignored, ...legacy } = wire;
  assert.ok(ignored);
  assert.deepEqual(
    snapshotSchema.parse(legacy.snapshot).rows,
    original.snapshot.rows,
  );
});

test("invalid or foreign advisory metadata never prevents valid saved cells opening", () => {
  const wire = encodeResearchView(view());
  for (const metadata of [
    { snapshotId: "other_table", feedback },
    {
      snapshotId: wire.snapshot.id,
      feedback: { ...feedback, advisory: false },
    },
    {
      snapshotId: wire.snapshot.id,
      feedback: { ...feedback, schema_version: 99 },
    },
    {
      snapshotId: wire.snapshot.id,
      feedback: { ...feedback, missing_intended_fields: [] },
    },
  ]) {
    const decoded = decodeResearchView({ ...wire, queryFeedbackV1: metadata });
    assert.equal(decoded.snapshot.rows.length, 2);
    assert.equal(decoded.snapshot.queryFeedback, undefined);
  }
  assert.equal(view({ malformed: true }).snapshot.queryFeedback, undefined);
});

test("feedback schema accepts missing requested columns but rejects contradictory observations", () => {
  assert.equal(queryFeedbackSchema.safeParse(feedback).success, true);
  assert.equal(
    queryFeedbackSchema.safeParse({
      ...feedback,
      result_observations: {
        row_count: 2,
        null_cells: [{ key: "source_title", count: 3 }],
      },
    }).success,
    false,
  );
});

test("advisory metadata never crowds a valid large row out of the app window", () => {
  const columns = Array.from({ length: 25 }, (_, index) => ({
    key: `field_${index}`,
    label: `Field ${index}`,
    logicalType: "VARCHAR",
    nullable: false,
  }));
  const snapshot = {
    ...view().snapshot,
    columns,
    rowCount: 1,
    rows: [
      {
        id: "large_row",
        values: Object.fromEntries(
          columns.map((column) => [column.key, "x".repeat(7600)]),
        ),
        sourceUrl: null,
        evidence: {},
        verificationNote: "",
      },
    ],
  };
  const largeFeedback = {
    ...feedback,
    description: {
      summary: "Large but bounded advisory description",
      steps: Array.from({ length: 10 }, (_, index) => ({
        scope: "main",
        kind: "projection",
        text: `Expression ${index}: ` + "d".repeat(900),
        sql: "s".repeat(900),
      })),
      omitted_steps: 0,
    },
  };
  snapshot.queryFeedback = queryFeedbackSchema.parse(largeFeedback);
  assert.doesNotThrow(() =>
    boundedPreview({ ...snapshot, queryFeedback: undefined }),
  );
  const preview = boundedPreview(snapshot);
  assert.equal(preview.rows.length, 1);
  assert.deepEqual(preview.rows[0].values, snapshot.rows[0].values);
  assert.equal(preview.queryFeedback, undefined);
  assert.deepEqual(
    snapshot.queryFeedback,
    largeFeedback,
    "Canonical feedback must stay retained",
  );
});

test("MCP forwards independent intent and returns mismatch feedback without extra execution or receipt duplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-feedback-wire-"));
  const html = join(directory, "research.html");
  await writeFile(html, "<!doctype html><html>Fixture widget</html>");
  const calls: string[] = [];
  const received: Record<string, unknown>[] = [];
  const engine: ResearchEngine = {
    async call<T>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      calls.push(method);
      if (method === "capabilities")
        return { profiles: [{ name: "fixture", mode: "fixture" }] } as T;
      if (method === "query") received.push(params);
      if (["query", "read_result"].includes(method)) return result() as T;
      throw new Error("Unexpected backend work");
    },
  };
  const server = createServer(
    new ResearchStore(
      join(directory, "unused"),
      snapshotSchema.parse(sample),
      async (snapshot) =>
        resolveResult(engine, {
          result_id: snapshot.dataRef!.resultId,
          snapshot_id: snapshot.id,
          title: snapshot.title,
        }),
    ),
    html,
    { engine },
  );
  const client = new Client({ name: "feedback-wire-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    assert.ok(
      tools.find((tool) => tool.name === "sourcesql_query")?.inputSchema
        .properties?.answer_intent,
    );
    const response = await client.callTool({
      name: "sourcesql_query",
      arguments: {
        query:
          "SELECT title AS source_title, url AS source_url FROM WEB_SEARCH('fixture') LIMIT 2",
        answer_intent: feedback.answer_intent,
      },
    });
    assert.equal(response.isError, undefined);
    const content = response.structuredContent as Record<string, unknown>;
    assert.deepEqual(content.query_feedback, feedback);
    assert.equal(
      Object.hasOwn(content.receipt as object, "query_feedback"),
      false,
    );
    assert.deepEqual(received[0].answer_intent, feedback.answer_intent);
    assert.deepEqual(calls, ["capabilities", "query", "read_result"]);
    const inspected = await client.callTool({
      name: "sourcesql_inspect_evidence",
      arguments: { result_id: "wq_feedback" },
    });
    assert.deepEqual(
      (inspected.structuredContent as Record<string, unknown>).query_feedback,
      feedback,
    );
    const opened = await client.callTool({
      name: "open_research",
      arguments: {
        result_ref: {
          result_id: "wq_feedback",
          snapshot_id: "saved_feedback",
          title: "Saved source catalog",
        },
      },
    });
    assert.equal(opened.isError, undefined, JSON.stringify(opened));
    const decoded = decodeResearchView(opened.structuredContent);
    assert.deepEqual(decoded.snapshot.queryFeedback, feedback);
    assert.equal(decoded.snapshot.rows.length, 2);
    assert.ok(
      calls.every((method) =>
        ["capabilities", "query", "read_result"].includes(method),
      ),
    );
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
