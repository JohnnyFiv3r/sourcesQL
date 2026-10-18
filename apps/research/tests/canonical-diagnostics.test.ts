import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createResearchApplication } from "../server/app.js";
import {
  resolveResult,
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import { effectiveValue, snapshotSchema } from "../src/schema.js";
import { decodeResearchView } from "../src/view-wire.js";

const reference = {
  result_id: "wq_canonical_diagnostics",
  snapshot_id: "canonical_diagnostics",
  title: "Canonical diagnostic fixture",
};
function engineResult(field = "value"): EngineResult {
  return {
    result_id: reference.result_id,
    run_id: "run_canonical_diagnostics",
    row_ids: ["row_supported", "row_unknown"],
    row_count: 2,
    columns: ["entity", field].map((key) => ({
      key,
      label: key,
      logical_type: "VARCHAR",
      nullable: true,
    })),
    rows: [
      { entity: "Aurora", [field]: "planned" },
      { entity: "Birch", [field]: null },
    ],
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [
      {
        evidence_id: "e_supported",
        row_id: "row_supported",
        column_key: field,
        source_version_id: "src_fixture",
        status: "supported_text",
        support: [{ quote: "Aurora is planned." }],
      },
    ],
    source_versions: [
      { source_version_id: "src_fixture", url: "https://example.com/fixture" },
    ],
    cell_diagnostics: [
      {
        row_id: "row_supported",
        column_key: field,
        status: "supported_text",
        diagnostic_id: "d_supported",
        source_version_id: "src_fixture",
        value_path: [],
      },
      {
        row_id: "row_unknown",
        column_key: field,
        status: "not_stated",
        diagnostic_id: "d_unknown",
        source_version_id: "src_fixture",
        value_path: [],
      },
    ],
    receipt: { status: "completed", finished_at: "2026-10-17T12:00:00Z" },
    next_offset: null,
  };
}

test("canonical diagnostic rows survive schema and JSON boundaries exactly", () => {
  const canonical = resultSnapshot(engineResult(), reference);
  assert.deepEqual(snapshotSchema.parse(canonical).rows, canonical.rows);
  assert.deepEqual(JSON.parse(JSON.stringify(canonical.rows)), canonical.rows);
  assert.deepEqual(canonical.rows[1].cellDiagnostics?.value, [
    {
      status: "not_stated",
      diagnosticId: "d_unknown",
      sourceVersionId: "src_fixture",
      valuePath: [],
    },
  ]);
});

test("valid Object.prototype column aliases retain their own evidence and sources across JSON boundaries", () => {
  for (const field of [
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    const canonical = resultSnapshot(engineResult(field), reference);
    const row = canonical.rows[0];
    assert.equal(Object.getPrototypeOf(row.evidence), Object.prototype);
    assert.equal(Object.getPrototypeOf(row.cellSources), Object.prototype);
    assert.deepEqual(row.evidence[field], ["Aurora is planned."]);
    assert.deepEqual(row.cellSources?.[field], [
      { url: "https://example.com/fixture" },
    ]);
    assert.equal(Object.hasOwn(row.evidence, field), true);
    assert.equal(Object.hasOwn(row.cellSources!, field), true);
    assert.equal(Object.hasOwn(canonical.rows[1].evidence, field), false);
    assert.equal(Object.hasOwn(canonical.rows[1].cellSources!, field), false);
    assert.deepEqual(snapshotSchema.parse(canonical).rows, canonical.rows);
    assert.deepEqual(
      JSON.parse(JSON.stringify(canonical.rows)),
      canonical.rows,
    );
  }
});

test("real app MCP opens diagnostic-bearing results, reopens saved rows and rejects changed previews", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sourcesql-canonical-diagnostics-"),
  );
  const raw = engineResult();
  const engine: ResearchEngine = {
    async call<T>(method: string) {
      assert.equal(method, "read_result");
      return structuredClone(raw) as T;
    },
  };
  const options = {
    environment: { RESEARCH_DATA_DIR: directory },
    backend: { engine },
  };
  const app = await createResearchApplication(options);
  const server = app.makeServer();
  const client = new Client({
    name: "canonical-diagnostic-test",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const opened = await client.callTool({
      name: "open_research",
      arguments: { result_ref: reference },
    });
    assert.equal(opened.isError, undefined, JSON.stringify(opened.content));
    const saved = await (
      await createResearchApplication(options)
    ).store.open(reference.snapshot_id);
    assert.equal(saved.snapshot.rows[1].values.value, null);
    assert.deepEqual(saved.snapshot.rows[1].cellDiagnostics?.value, [
      {
        status: "not_stated",
        diagnosticId: "d_unknown",
        sourceVersionId: "src_fixture",
        valuePath: [],
      },
    ]);
    const canonical = await resolveResult(engine, reference);
    for (const change of ["diagnostic", "value", "citation"] as const) {
      const tampered = structuredClone(canonical);
      tampered.id = "tampered_" + change;
      if (change === "diagnostic")
        tampered.rows[1].cellDiagnostics!.value[0].status = "failed";
      else if (change === "value") tampered.rows[0].values.value = "operating";
      else
        tampered.rows[0].cellSources = {
          value: [{ url: "https://example.com/injected" }],
        };
      const rejected = await client.callTool({
        name: "open_research",
        arguments: { snapshot: tampered },
      });
      assert.equal(rejected.isError, true, change);
      assert.match(
        JSON.stringify(rejected.content),
        /preview does not match canonical engine data/,
      );
    }
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual fixture extraction with toString alias opens, corrects and exports/imports with canonical citations", async () => {
  const alias = String("toString");
  const directory = await mkdtemp(
    join(tmpdir(), "sourcesql-canonical-alias-roundtrip-"),
  );
  const connections: {
    client: Client;
    server: ReturnType<
      Awaited<ReturnType<typeof createResearchApplication>>["makeServer"]
    >;
  }[] = [];
  const create = async (name: string) => {
    const app = await createResearchApplication({
      environment: {
        ...process.env,
        RESEARCH_DATA_DIR: join(directory, name + "-app"),
        SOURCESQL_DATA_DIR: join(directory, name + "-engine"),
        SOURCESQL_ALLOW_PRIVATE: "0",
      },
    });
    const server = app.makeServer();
    const client = new Client({
      name: "canonical-alias-" + name,
      version: "1",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    connections.push({ client, server });
    return { app, client };
  };
  const call = async (
    client: Client,
    name: string,
    arguments_: Record<string, unknown>,
  ) => {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return response.structuredContent as Record<string, unknown>;
  };
  try {
    const origin = await create("origin");
    const result = await call(origin.client, "sourcesql_query", {
      query:
        "SELECT SEM_EXTRACT(content,'project name explicitly stated') AS \"toString\" FROM WEB_SEARCH('fictional Aurora Birch campuses') WHERE SEM_MATCH(content,'describes a specific data-center campus')",
      profile: "fixture",
      request_id: randomUUID(),
    });
    const opened = decodeResearchView(
      await call(origin.client, "open_research", {
        result_ref: {
          result_id: result.result_id,
          snapshot_id: "alias_roundtrip",
          title: "Quoted alias fixture",
        },
      }),
    );
    const row = opened.snapshot.rows.find(
      (item) => item.values[alias] === "Aurora Campus",
    )!;
    assert.ok(row);
    assert.ok(row.evidence[alias].length > 0);
    assert.ok(row.cellSources?.[alias].length);
    assert.equal(row.cellDiagnostics?.[alias][0].status, "supported_text");
    const corrected = decodeResearchView(
      await call(origin.client, "amend_observation", {
        snapshot_id: opened.snapshot.id,
        row_id: row.id,
        field: "toString",
        value: "Reviewed Aurora Campus",
        expected_revision: opened.revision,
        mutation_id: randomUUID(),
      }),
    );
    assert.equal(
      effectiveValue(
        corrected,
        corrected.snapshot.rows.find((item) => item.id === row.id)!,
        "toString",
      ),
      "Reviewed Aurora Campus",
    );
    assert.equal(
      corrected.snapshot.rows.find((item) => item.id === row.id)!.values[alias],
      "Aurora Campus",
    );
    const bundle = JSON.parse(
      JSON.stringify(
        await call(origin.client, "export_research", {
          snapshot_id: opened.snapshot.id,
        }),
      ),
    );
    const target = await create("target");
    await call(target.client, "import_research_bundle", { bundle });
    const restored = await target.app.store.open(opened.snapshot.id);
    const restoredRow = restored.snapshot.rows.find(
      (item) => item.id === row.id,
    )!;
    assert.equal(restored.revision, 1);
    assert.equal(
      effectiveValue(restored, restoredRow, "toString"),
      "Reviewed Aurora Campus",
    );
    assert.equal(restoredRow.values[alias], "Aurora Campus");
    assert.deepEqual(restoredRow.evidence[alias], row.evidence[alias]);
    assert.deepEqual(
      restoredRow.cellSources?.[alias],
      row.cellSources?.[alias],
    );
    assert.deepEqual(
      restoredRow.cellDiagnostics?.[alias],
      row.cellDiagnostics?.[alias],
    );
    await call(target.client, "open_research", {
      snapshot_id: opened.snapshot.id,
    });
    for (const field of [
      "value",
      "evidence",
      "source",
      "diagnostic",
    ] as const) {
      const tampered = structuredClone(restored.snapshot);
      tampered.id = "alias_tampered_" + field;
      const changed = tampered.rows.find((item) => item.id === row.id)!;
      if (field === "value") changed.values[alias] = "Operating Aurora Campus";
      else if (field === "evidence")
        changed.evidence[alias] = ["Invented support"];
      else if (field === "source")
        changed.cellSources![alias] = [{ url: "https://example.com/injected" }];
      else changed.cellDiagnostics![alias][0].status = "failed";
      const rejected = await target.client.callTool({
        name: "open_research",
        arguments: { snapshot: tampered },
      });
      assert.equal(rejected.isError, true, field);
      assert.match(
        JSON.stringify(rejected.content),
        /preview does not match canonical engine data/,
      );
    }
  } finally {
    for (const { client, server } of connections.reverse()) {
      await client.close();
      await server.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
