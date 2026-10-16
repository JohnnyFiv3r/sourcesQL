import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  resultSnapshot,
  resolveResult,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  snapshotSchema,
  sourcesForSelection,
  type ResearchView,
} from "../src/schema.js";
import { sourceLinksForValue } from "../src/presentation.js";

const reference = {
  result_id: "wq_cells",
  snapshot_id: "saved_cells",
  title: "Cited campus facts",
};
function canonicalResult(): EngineResult {
  const result: EngineResult = {
    result_id: reference.result_id,
    run_id: "run_cells",
    row_ids: ["row_a", "row_b"],
    row_count: 2,
    columns: [
      "project",
      "capacity",
      "operating",
      "source_date",
      "source_url",
    ].map((key) => ({
      key,
      label: key,
      logical_type: "VARCHAR",
      nullable: true,
    })),
    rows: [
      {
        project: "Aurora Campus",
        capacity: "500 MW",
        operating: null,
        source_date: "2026-10-01",
        source_url: "https://output.example/unverified",
      },
      {
        project: "Birch Campus",
        capacity: null,
        operating: null,
        source_date: null,
        source_url: "https://source.example/a",
      },
    ],
    content_sha256: "a".repeat(64),
    data_classification: "public_web",
    next_offset: null,
    receipt: { status: "completed", finished_at: "2026-10-16T10:00:00Z" },
    source_versions: [
      {
        source_version_id: "src_a",
        url: "https://source.example/a",
        retrieved_at: "2026-10-16T09:00:00Z",
      },
      {
        source_version_id: "src_b",
        url: "https://utility.example/b",
        retrieved_at: "2026-10-16T09:01:00Z",
      },
      {
        source_version_id: "src_input",
        url: "https://input.example/uncertain",
        retrieved_at: "2026-10-16T09:02:00Z",
      },
    ],
    evidence: [
      {
        evidence_id: "e_project",
        row_id: "row_a",
        column_key: "project",
        source_version_id: "src_a",
        status: "supported_text",
        support: [{ quote: "Aurora Campus" }],
      },
      {
        evidence_id: "e_capacity_a",
        row_id: "row_a",
        column_key: "capacity",
        source_version_id: "src_a",
        status: "supported_text",
        support: [{ quote: "500 MW", start: 30, end: 36 }],
      },
      {
        evidence_id: "e_capacity_b",
        row_id: "row_a",
        column_key: "capacity",
        source_version_id: "src_b",
        status: "supported_text",
        support: [{ quote: "500 MW", start: 41, end: 47 }],
      },
      {
        evidence_id: "e_date",
        row_id: "row_a",
        column_key: "source_date",
        source_version_id: "src_a",
        status: "supported_text",
        support: [{ quote: "Published October 1, 2026" }],
      },
      {
        evidence_id: "e_unknown",
        row_id: "row_a",
        column_key: "operating",
        source_version_id: "src_b",
        status: "not_stated",
        support: [],
      },
      {
        evidence_id: "e_input",
        source_version_id: "src_input",
        lineage_level: "input_set",
        support: [{ quote: "A source included in the input set." }],
      },
    ],
  };
  result.evidence.push(structuredClone(result.evidence[1]));
  return result;
}

test("canonical cell records retain multiple source identities without borrowing other cells' sources", () => {
  const result = canonicalResult(),
    before = structuredClone(result);
  const snapshot = snapshotSchema.parse(resultSnapshot(result, reference));
  const [row, unknown] = snapshot.rows;
  assert.deepEqual(row.cellSources?.project, [
    { url: "https://source.example/a" },
  ]);
  assert.deepEqual(row.cellSources?.capacity, [
    { url: "https://source.example/a" },
    { url: "https://utility.example/b" },
  ]);
  assert.deepEqual(
    row.evidence.capacity,
    ["500 MW", "500 MW"],
    "Repeated records dedupe, while the same quote from distinct sources keeps both identities",
  );
  assert.deepEqual(sourcesForSelection(row, "project"), [
    { url: "https://source.example/a" },
  ]);
  assert.deepEqual(sourcesForSelection(row, "operating"), []);
  assert.deepEqual(sourcesForSelection(row, "source_url"), []);
  assert.equal(row.sourceUrl, null);
  assert.deepEqual(row.sources, [
    { url: "https://source.example/a" },
    { url: "https://utility.example/b" },
  ]);
  assert.deepEqual(sourcesForSelection(row), row.sources);
  assert.equal(row.evidence.operating, undefined);
  assert.match(row.verificationNote, /Direct textual support/);
  assert.ok(row.evidenceRefs?.includes("e_capacity_a"));
  assert.ok(row.evidenceRefs?.includes("e_capacity_b"));
  assert.equal(new Set(row.evidenceRefs).size, row.evidenceRefs?.length);
  assert.deepEqual(unknown.cellSources, {});
  assert.equal(unknown.sourceUrl, null);
  assert.equal(unknown.sources, undefined);
  assert.deepEqual(unknown.evidence, {});
  assert.equal(
    unknown.values.source_date,
    null,
    "Retrieval dates never become source-date facts",
  );
  assert.match(
    unknown.verificationNote,
    /Input-set lineage; no direct cell attribution/,
  );
  assert.deepEqual(sourcesForSelection(unknown, "project"), []);
  assert.deepEqual(
    sourceLinksForValue([], row.values.source_url),
    [{ url: "https://output.example/unverified", label: "Selected URL" }],
    "Opening an output URL remains explicitly labelled navigation",
  );
  assert.deepEqual(result, before);
});

test("unsupported, null, field-only and empty-support records cannot become direct cell citations", () => {
  const result = canonicalResult();
  result.evidence = [
    {
      evidence_id: "e_empty",
      row_id: "row_a",
      column_key: "project",
      source_version_id: "src_a",
      support: [],
    },
    {
      evidence_id: "e_unknown",
      row_id: "row_a",
      column_key: "capacity",
      source_version_id: "src_a",
      status: "unknown",
      support: [{ quote: "Not established." }],
    },
    {
      evidence_id: "e_null",
      row_id: "row_a",
      column_key: "operating",
      source_version_id: "src_a",
      status: "supported_text",
      support: [{ quote: "A nearby number." }],
    },
    {
      evidence_id: "e_field",
      row_id: "row_a",
      field: "project",
      source_version_id: "src_a",
      support: [
        { quote: "Legacy field naming alone does not prove a projection." },
      ],
    },
  ];
  const snapshot = snapshotSchema.parse(resultSnapshot(result, reference));
  assert.deepEqual(snapshot.rows[0].cellSources, {});
  assert.deepEqual(snapshot.rows[0].evidence, {});
  assert.equal(snapshot.rows[0].sourceUrl, null);
  assert.doesNotMatch(
    snapshot.rows[0].verificationNote,
    /Direct textual support/,
  );
  assert.deepEqual(sourcesForSelection(snapshot.rows[0], "capacity"), []);
});

test("explicit support source IDs resolve to their own versions rather than a record URL shortcut", () => {
  const result = canonicalResult();
  result.evidence = [
    {
      evidence_id: "e_spans",
      row_id: "row_a",
      column_key: "capacity",
      source_version_id: "src_a",
      support: [
        { quote: "Reported by the utility.", source_version_id: "src_b" },
        {
          quote: "Unresolved source version.",
          source_version_id: "src_missing",
          url: "https://unproved.example/",
        },
      ],
    },
  ];
  const row = snapshotSchema.parse(resultSnapshot(result, reference)).rows[0];
  assert.deepEqual(row.cellSources?.capacity, [
    { url: "https://utility.example/b" },
  ]);
  assert.deepEqual(row.sources, [{ url: "https://utility.example/b" }]);
  assert.equal(row.sourceUrl, "https://utility.example/b");
});

test("complete cell-source maps keep unknown selections empty while legacy row-source fallback survives", () => {
  const legacy = {
    id: "legacy",
    values: { project: "Legacy" },
    sourceUrl: "https://legacy.example/",
    evidence: {},
    verificationNote: "Legacy row source",
  };
  assert.deepEqual(sourcesForSelection(legacy, "project"), [
    { url: "https://legacy.example/" },
  ]);
  assert.deepEqual(
    sourcesForSelection({ ...legacy, cellSources: {} }, "project"),
    [],
  );
  assert.deepEqual(sourcesForSelection({ ...legacy, cellSources: {} }), [
    { url: "https://legacy.example/" },
  ]);
});

test("MCP evidence inspection and saved presentation preserve canonical cells without new research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-cell-evidence-"));
  const result = canonicalResult(),
    calls: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      assert.equal(method, "read_result");
      return structuredClone(result) as T;
    },
  };
  const store = new ResearchStore(
    directory,
    resultSnapshot(result, reference),
    (snapshot) =>
      resolveResult(engine, {
        result_id: snapshot.dataRef!.resultId,
        snapshot_id: snapshot.id,
        title: snapshot.title,
      }),
  );
  const server = createServer(
    store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    {
      engine,
      access: {
        mode: "protected",
        principal: "evidence-owner",
        allowPrivateDisclosure: false,
      },
    },
  );
  const client = new Client({
    name: "canonical-cell-evidence-test",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const response = await client.callTool({
      name: "sourcesql_inspect_evidence",
      arguments: {
        result_id: result.result_id,
        offset: 0,
        limit: 2,
      },
    });
    assert.notEqual(response.isError, true);
    const inspected = response.structuredContent as Record<string, unknown>;
    assert.deepEqual(inspected.evidence, result.evidence);
    assert.deepEqual(inspected.source_versions, result.source_versions);
    assert.deepEqual(calls, ["read_result"]);
    const opened = await client.callTool({
      name: "open_research",
      arguments: { result_ref: reference },
    });
    assert.notEqual(opened.isError, true, JSON.stringify(opened.content));
    const view = opened.structuredContent as ResearchView;
    assert.deepEqual(view.snapshot.rows[0].cellSources?.capacity, [
      { url: "https://source.example/a" },
      { url: "https://utility.example/b" },
    ]);
    assert.deepEqual(
      sourcesForSelection(view.snapshot.rows[0], "operating"),
      [],
    );
    assert.equal(view.snapshot.rows[0].values.source_date, "2026-10-01");
    assert.equal(view.snapshot.rows[1].values.source_date, null);
    assert.ok(
      calls.length > 1 && calls.every((method) => method === "read_result"),
    );
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
