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
function result(
  id: string,
  classification: EngineResult["data_classification"] = "public_web",
): EngineResult {
  return {
    result_id: id,
    run_id: `run_${id}`,
    columns: [
      { key: "value", label: "Value", logical_type: "VARCHAR", nullable: true },
    ],
    rows: [
      {
        value: classification?.startsWith("private_") ? "PRIVATE_CONTENT" : id,
      },
    ],
    row_ids: ["row_a"],
    row_count: 1,
    content_sha256: "a".repeat(64),
    data_classification: classification,
    evidence: [],
    source_versions: [],
    receipt: { status: "completed", finished_at: "2026-10-18T00:00:00Z" },
    next_offset: null,
  };
}
function state(): ResearchState {
  return {
    snapshots: ["A", "B"].map((id) =>
      resultSnapshot(result(`wq_${id}`), {
        result_id: `wq_${id}`,
        snapshot_id: id,
        title: id,
      }),
    ),
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
  };
}
async function harness(
  options: {
    hosted?: boolean;
    archived?: string;
    canonicalPrivate?: string;
    labelMissing?: boolean;
    privateOriginal?: boolean;
    privateReplay?: boolean;
    allowPrivate?: boolean;
  } = {},
) {
  const stored = state();
  if (options.archived)
    stored.archivedSnapshots = [
      { snapshotId: options.archived, archivedAt: "2026-10-19T00:00:00Z" },
    ];
  if (options.labelMissing)
    for (const s of stored.snapshots) delete s.dataClassification;
  const counts = { lookup: 0, guard: 0, imports: 0, execute: 0, resolved: 0 };
  const reads: { id: string; limit: unknown }[] = [],
    payloads: Record<string, unknown>[] = [];
  const engine: ResearchEngine = {
    ...(options.hosted
      ? {
          async lookupPreparedQuery() {
            counts.lookup++;
            return {
              job_id: randomUUID(),
              operation: "query",
              status: "queued",
              pending: true,
            };
          },
          async prepareQuery() {
            throw Error("Unexpected new preparation");
          },
        }
      : {
          async guardLegacyRequest() {
            counts.guard++;
            return options.privateReplay
              ? (result("wq_prior", "private_derived") as unknown as Record<
                  string,
                  unknown
                >)
              : undefined;
          },
        }),
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      if (method === "capabilities")
        return {
          profiles: [{ name: "fixture", mode: "fixture" }],
          ...(options.hosted ? { execution_mode: "async_jobs" } : {}),
        } as T;
      if (method === "read_result") {
        const id = String(params.result_id);
        reads.push({ id, limit: params.limit });
        return result(
          id,
          id === options.canonicalPrivate ||
            (options.privateOriginal && id === "wq_O") ||
            (options.privateReplay && id === "wq_prior")
            ? "private_derived"
            : "public_web",
        ) as T;
      }
      if (method === "import_table") {
        counts.imports++;
        payloads.push(params);
        return result(
          "wq_imported",
          params.data_classification as EngineResult["data_classification"],
        ) as T;
      }
      if (method === "query" || method === "explain") {
        counts.execute++;
        return (
          method === "query" ? result("wq_output") : { valid: true }
        ) as T;
      }
      throw Error(`Unexpected ${method}`);
    },
  };
  const store = new ResearchStore(
    "/unused",
    stored.snapshots[0],
    async (s) => {
      counts.resolved++;
      return s;
    },
    3000,
    {
      backend: {
        async read() {
          return { state: structuredClone(stored), version: "1" };
        },
        async write() {
          throw Error("Unexpected write");
        },
      },
    },
  );
  const server = createServer(
    store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    {
      engine,
      access: {
        mode: "protected",
        principal: "owner",
        allowPrivateDisclosure: options.allowPrivate ?? false,
      },
    },
  );
  const client = new Client({ name: "materialization-access", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    counts,
    reads,
    payloads,
    async close() {
      await client.close();
      await server.close();
    },
    async invoke(method = "sourcesql_query", original = false) {
      return client.callTool({
        name: method,
        arguments:
          method === "sourcesql_materialize_research"
            ? { snapshot_id: "A", expected_revision: 1 }
            : {
                request_id: randomUUID(),
                query: "SELECT * FROM input.t",
                inputs: {
                  t: {
                    result_id: "wq_A",
                    view: "effective",
                    amendment_revision: 1,
                  },
                  ...(original
                    ? {
                        o: {
                          result_id: "wq_O",
                          view: "original",
                          amendment_revision: null,
                        },
                      }
                    : {}),
                },
              },
      });
    },
  };
}
for (const archived of ["A", "B"])
  for (const method of ["sourcesql_query", "sourcesql_explain"]) {
    test(`hosted ${method} retry denies archived ${archived} before saved-job dispatch`, async () => {
      const h = await harness({ hosted: true, archived });
      try {
        const r = await h.invoke(method);
        assert.equal(r.isError, true);
        assert.equal(h.counts.lookup, 0);
        assert.equal(h.counts.resolved, 0);
        assert.equal(h.counts.imports, 0);
        assert.equal(h.counts.execute, 0);
      } finally {
        await h.close();
      }
    });
  }
test("hosted retry checks pinned original disclosure before saved-job dispatch", async () => {
  const h = await harness({ hosted: true, privateOriginal: true });
  try {
    const r = await h.invoke("sourcesql_query", true);
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Private host disclosure/);
    assert.equal(h.counts.lookup, 0);
  } finally {
    await h.close();
  }
});
test("local replay applies the same authoritative output disclosure check as a fresh query", async () => {
  const h = await harness({ privateReplay: true });
  try {
    const r = await h.invoke();
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Private host disclosure/);
    assert(!JSON.stringify(r).includes("PRIVATE_CONTENT"));
    assert.equal(h.counts.imports, 0);
    assert.equal(h.counts.execute, 0);
  } finally {
    await h.close();
  }
});
for (const method of [
  "sourcesql_query",
  "sourcesql_explain",
  "sourcesql_materialize_research",
])
  for (const labelMissing of [false, true]) {
    test(`${method} denies private canonical contributor despite ${labelMissing ? "missing" : "public"} app label before reading full rows`, async () => {
      const h = await harness({ canonicalPrivate: "wq_B", labelMissing });
      try {
        const r = await h.invoke(method);
        assert.equal(r.isError, true);
        assert.equal(h.counts.resolved, 0);
        assert.equal(h.counts.imports, 0);
        assert.equal(h.counts.execute, 0);
        assert.equal(h.counts.guard, 0);
        if (labelMissing) assert.equal(h.reads.length, 0);
        else assert(h.reads.some((r) => r.id === "wq_B" && r.limit === 1));
      } finally {
        await h.close();
      }
    });
  }
test("authorized canonical private data cannot be promoted with a public app label", async () => {
  const h = await harness({ canonicalPrivate: "wq_B", allowPrivate: true });
  try {
    const r = await h.invoke("sourcesql_materialize_research");
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.equal(h.payloads[0].data_classification, "private_derived");
  } finally {
    await h.close();
  }
});
test("local effective query performs one native identity lookup before any import", async () => {
  const h = await harness();
  try {
    const r = await h.invoke();
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.equal(h.counts.guard, 1);
    assert.equal(h.counts.imports, 1);
    assert.equal(h.counts.execute, 1);
  } finally {
    await h.close();
  }
});
