import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore, type ResearchState } from "../server/store.js";
import {
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
function fixture(id: string, value: string): EngineResult {
  return {
    result_id: id,
    run_id: `run_${id}`,
    columns: [
      { key: "value", label: "Value", logical_type: "VARCHAR", nullable: true },
    ],
    rows: [{ value }],
    row_ids: ["row_a"],
    row_count: 1,
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    receipt: { status: "completed", finished_at: "2026-10-18T00:00:00Z" },
    next_offset: null,
  };
}
function state() {
  const snapshots = ["A", "B"].map((id) =>
    resultSnapshot(fixture(`wq_${id}`, id), {
      result_id: `wq_${id}`,
      snapshot_id: id,
      title: id,
    }),
  );
  return {
    snapshots,
    amendments: [
      {
        snapshot_id: "A",
        row_id: "row_a",
        field: "value",
        value: "B",
        expected_revision: 0,
        mutation_id: randomUUID(),
        createdAt: "2026-10-18T00:00:00Z",
        originalValue: "A",
        revision: 1,
        sourceSnapshotId: "B",
      },
    ],
  } satisfies ResearchState;
}
test("all MCP promotion routes retain the accepted refresh parent and use one payload", async () => {
  const stored = state(),
    calls: { method: string; params: Record<string, unknown> }[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "read_result")
        return fixture(String(params.result_id), "A") as T;
      if (method === "import_table") return fixture("wq_promoted", "B") as T;
      if (method === "query")
        return { result_id: "wq_promoted", status: "completed" } as T;
      if (method === "explain") return { valid: true } as T;
      return { profiles: [{ name: "fixture", mode: "fixture" }] } as T;
    },
  };
  const store = new ResearchStore(
    "/unused",
    stored.snapshots[0],
    undefined,
    3000,
    {
      backend: {
        async read() {
          return { state: structuredClone(stored), version: "1" };
        },
        async write() {
          throw Error("Unexpected mutation");
        },
      },
    },
  );
  const server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      { engine },
    ),
    client = new Client({ name: "promotion-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const name of [
      "sourcesql_query",
      "sourcesql_explain",
      "sourcesql_materialize_research",
    ]) {
      const response = await client.callTool({
        name,
        arguments:
          name === "sourcesql_materialize_research"
            ? { snapshot_id: "A", expected_revision: 1 }
            : {
                query: "SELECT * FROM input.t",
                inputs: {
                  t: {
                    result_id: "wq_A",
                    view: "effective",
                    amendment_revision: 1,
                  },
                },
              },
      });
      assert.equal(
        response.isError,
        undefined,
        JSON.stringify(response.content),
      );
    }
    const payloads = calls
      .filter((c) => c.method === "import_table")
      .map((c) => c.params);
    assert.equal(payloads.length, 3);
    assert.deepEqual(payloads[0].parents, [
      { result_id: "wq_A", view: "original", amendment_revision: null },
      { result_id: "wq_B", view: "original", amendment_revision: null },
    ]);
    assert.deepEqual(payloads[0], payloads[1]);
    assert.deepEqual(payloads[0], payloads[2]);
    assert.deepEqual(payloads[0].rows, [{ value: "B" }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("local MCP replay compares Python-native captured identity before any new import", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const { PythonEngine } = await import("../server/engine.js");
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-native-promotion-"));
  const native = new PythonEngine(undefined, {
    ...process.env,
    SOURCESQL_DATA_DIR: dir,
    SOURCESQL_PRINCIPAL: "materialization-fixture",
  });
  let imports = 0;
  const engine: ResearchEngine = {
    guardLegacyRequest: (args, prepared) =>
      native.guardLegacyRequest(args, prepared),
    call<T>(method: string, params: Record<string, unknown> = {}) {
      if (method === "import_table") imports++;
      return native.call<T>(method, params);
    },
  };
  const results: EngineResult[] = [];
  for (const value of ["A", "B", "C"])
    results.push(
      await native.call<EngineResult>("import_table", {
        columns: [{ key: "value", logical_type: "VARCHAR", nullable: true }],
        rows: [{ value }],
        row_ids: ["row_a"],
        data_classification: "synthetic_fixture",
      }),
    );
  const stored = state();
  stored.snapshots = results.map((result, i) =>
    resultSnapshot(result, {
      result_id: result.result_id,
      snapshot_id: ["A", "B", "C"][i],
      title: ["A", "B", "C"][i],
    }),
  );
  const store = new ResearchStore(
    "/unused",
    stored.snapshots[0],
    undefined,
    3000,
    {
      backend: {
        async read() {
          return { state: structuredClone(stored), version: "1" };
        },
        async write() {
          throw Error("Unexpected mutation");
        },
      },
    },
  );
  const server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      { engine },
    ),
    client = new Client({ name: "native-replay", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const args = {
      request_id: randomUUID(),
      query: "SELECT * FROM input.t",
      inputs: {
        t: {
          result_id: results[0].result_id,
          view: "effective",
          amendment_revision: 1,
        },
      },
    };
    const first = await client.callTool({
      name: "sourcesql_query",
      arguments: args,
    });
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.equal(imports, 1);
    const replay = await client.callTool({
      name: "sourcesql_query",
      arguments: args,
    });
    assert.equal(replay.isError, undefined, JSON.stringify(replay.content));
    assert.equal(imports, 1);
    assert.equal(
      (replay.structuredContent as EngineResult).result_id,
      (first.structuredContent as EngineResult).result_id,
    );
    stored.amendments.push({
      ...stored.amendments[0],
      snapshot_id: "B",
      sourceSnapshotId: "C",
      mutation_id: randomUUID(),
      originalValue: "B",
      value: "C",
    });
    const changed = await client.callTool({
      name: "sourcesql_query",
      arguments: args,
    });
    assert.equal(changed.isError, true);
    assert.match(JSON.stringify(changed.content), /idempotency_conflict/);
    assert.equal(imports, 1);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
