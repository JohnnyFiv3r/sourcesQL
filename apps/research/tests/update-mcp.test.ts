import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../server/mcp.js";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import {
  resolveResult,
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import {
  effectiveValue,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";
import type { AccessPolicy } from "../server/access.js";
import type { UpdateChange } from "../server/updates.js";

const columns: EngineResult["columns"] = [
  {
    key: "issuer",
    label: "Organization",
    logical_type: "VARCHAR",
    nullable: false,
  },
  {
    key: "capacity",
    label: "Planned Capacity (MW)",
    logical_type: "INTEGER",
    nullable: true,
  },
];
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function engineResult(
  resultId: string,
  rows: EngineResult["rows"],
  rowIds: string[],
  at = "2026-10-14T00:00:00Z",
): EngineResult {
  return {
    result_id: resultId,
    run_id: `run_${resultId}`,
    columns: structuredClone(columns),
    rows,
    row_ids: rowIds,
    row_count: rows.length,
    content_sha256: digest({ columns, rows, rowIds }),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    receipt: {
      status: "completed",
      finished_at: at,
      corpus_coverage: "bounded_fixture",
    },
    next_offset: null,
  };
}
/** Controlled engine metadata exercises the real MCP/store boundary, not SQL or provider behavior. */
class Engine implements ResearchEngine {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  results = new Map<string, EngineResult>();
  nextClassification: Snapshot["dataClassification"] = "synthetic_fixture";
  constructor(includeBaseline = true) {
    if (includeBaseline)
      this.results.set(
        "wq_baseline",
        engineResult(
          "wq_baseline",
          [
            { issuer: "Acme", capacity: 100 },
            { issuer: "Beta", capacity: 200 },
          ],
          ["row_a", "row_b"],
        ),
      );
  }
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params: structuredClone(params) });
    let output: unknown;
    if (method === "capabilities")
      output = {
        execution_mode: "synchronous",
        profiles: [{ name: "fixture", mode: "fixture" }],
      };
    else if (method === "read_result") {
      const result = this.results.get(String(params.result_id));
      if (!result) throw new Error("Result is not available to this engine");
      const offset = Number(params.offset ?? 0),
        limit = Number(params.limit ?? 100);
      output = {
        ...structuredClone(result),
        rows: result.rows.slice(offset, offset + limit),
        row_ids: result.row_ids.slice(offset, offset + limit),
        next_offset: offset + limit < result.row_count ? offset + limit : null,
      };
    } else if (method === "import_table") {
      const result = engineResult(
        `wq_effective_${this.calls.filter((c) => c.method === method).length}`,
        params.rows as EngineResult["rows"],
        params.row_ids as string[],
        new Date().toISOString(),
      );
      result.columns = structuredClone(
        params.columns as EngineResult["columns"],
      );
      result.data_classification =
        params.data_classification as EngineResult["data_classification"];
      this.results.set(result.result_id, result);
      output = result;
    } else if (method === "query") {
      const discovery = String(params.query).includes("WEB_SEARCH"),
        at = new Date().toISOString(),
        suffix = discovery ? "discovery" : "existing";
      const content = discovery
        ? "Gamma planned capacity is 300 MW."
        : "Acme planned capacity is 120 MW.";
      const rowId = discovery ? "row_c" : "row_a",
        sourceId = `src_${suffix}`,
        quote = discovery ? "300 MW" : content;
      const result = engineResult(
        `wq_${suffix}`,
        [
          {
            issuer: discovery ? "Gamma" : "Acme",
            capacity: discovery ? 300 : 120,
          },
        ],
        [rowId],
        at,
      );
      result.data_classification = this.nextClassification;
      result.source_versions = [
        {
          source_version_id: sourceId,
          url: `https://example.com/${suffix}`,
          content,
          content_sha256: createHash("sha256").update(content).digest("hex"),
          retrieved_at: at,
          content_basis: "document",
          title: discovery ? "Gamma" : "Acme",
        },
      ];
      result.evidence = [
        {
          evidence_id: `e_${suffix}_capacity`,
          row_id: rowId,
          column_key: "capacity",
          field: "capacity",
          source_version_id: sourceId,
          status: "supported_text",
          support: [{ quote }],
        },
        ...(discovery
          ? [
              {
                evidence_id: "e_discovery_issuer",
                row_id: rowId,
                column_key: "issuer",
                field: "issuer",
                source_version_id: sourceId,
                status: "supported_text",
                support: [{ quote: "Gamma" }],
              },
            ]
          : []),
      ];
      this.results.set(result.result_id, result);
      output = result;
    } else if (method === "export") {
      const result = this.results.get(String(params.result_id));
      if (!result) throw new Error("Unknown export result");
      output = { fixtureFormat: 1, result: structuredClone(result) };
    } else if (method === "import") {
      const foreign = structuredClone(
          (params.bundle as { result: EngineResult }).result,
        ),
        oldId = foreign.result_id;
      const localId = `wq_restore_${digest(oldId).slice(0, 28)}`,
        at = new Date().toISOString();
      const existing = this.results.get(localId);
      if (existing)
        output = { ...existing, result_mapping: { [oldId]: localId } };
      else {
        foreign.result_id = localId;
        foreign.run_id = `run_${localId}`;
        foreign.receipt = {
          ...foreign.receipt,
          finished_at: at,
          warnings: ["Imported retained data without provider work"],
        };
        this.results.set(localId, foreign);
        output = { ...foreign, result_mapping: { [oldId]: localId } };
      }
    } else throw new Error(`Unexpected engine method: ${method}`);
    return structuredClone(output) as T;
  }
}
class Backend implements ResearchStateBackend {
  state?: ResearchState;
  writes = 0;
  async read() {
    return { state: structuredClone(this.state), version: String(this.writes) };
  }
  async write(state: ResearchState, expected: string) {
    assert.equal(expected, String(this.writes));
    this.state = structuredClone(state);
    this.writes++;
  }
}
type UpdateResponse = {
  request: { id: string; status: string };
  changes: UpdateChange[];
  proposal_snapshot_id?: string;
  published_snapshot_id?: string;
  base_revision: number;
  decisions: Record<string, "accept" | "keep">;
  view?: ResearchView;
};
async function connect(
  t: { after(fn: () => Promise<void>): unknown },
  engine = new Engine(),
  backend = new Backend(),
  access?: AccessPolicy,
) {
  const base =
    engine.results.get("wq_baseline") ??
    engineResult("wq_seed", [{ issuer: "Seed", capacity: 1 }], ["seed"]);
  if (!engine.results.has(base.result_id))
    engine.results.set(base.result_id, base);
  const seed = resultSnapshot(base, {
    result_id: base.result_id,
    snapshot_id: base.result_id === "wq_baseline" ? "baseline" : "seed",
    title: "Synthetic organizations",
  });
  const store = new ResearchStore(
    "/not-used",
    seed,
    async (snapshot) => ({
      ...(await resolveResult(engine, {
        result_id: snapshot.dataRef!.resultId,
        snapshot_id: snapshot.id,
        title: snapshot.title,
      })),
      parentSnapshotId: snapshot.parentSnapshotId,
    }),
    3000,
    { backend },
  );
  const server = createServer(
    store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    { engine, access },
  );
  const client = new Client({ name: "manual-update-mcp-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result;
  };
  return { engine, backend, store, server, client, call };
}
async function runCheck(t: { after(fn: () => Promise<void>): unknown }) {
  const f = await connect(t);
  await f.call("amend_observation", {
    snapshot_id: "baseline",
    row_id: "row_a",
    field: "capacity",
    value: 110,
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const input = {
    request_id: randomUUID(),
    snapshot_id: "baseline",
    expected_revision: 1,
    existing: { row_ids: ["row_a"], fields: ["capacity"] },
    discovery: {
      question: "Find additional organizations with planned capacity",
      identity_fields: ["issuer"],
    },
  };
  const started = await f.call("check_research_updates", input);
  assert.equal(
    (started.structuredContent as unknown as UpdateResponse).request.status,
    "pending",
  );
  const queried = await f.call("sourcesql_query", {
    request_id: randomUUID(),
    query:
      "SELECT issuer, CAST($capacity AS INTEGER) AS capacity, $row_id AS canonical_row_id FROM input.baseline WHERE issuer = $issuer",
    parameters: { issuer: "Acme", capacity: 120, row_id: "row_a" },
    row_id_column: "canonical_row_id",
    inputs: {
      baseline: {
        result_id: "wq_baseline",
        view: "effective",
        amendment_revision: 1,
      },
    },
  });
  const existing = queried.structuredContent as unknown as EngineResult;
  Object.assign(
    existing,
    (
      await f.call("sourcesql_inspect_evidence", {
        result_id: existing.result_id,
      })
    ).structuredContent,
  );
  const found = await f.call("sourcesql_query", {
    request_id: randomUUID(),
    query:
      "SELECT title AS issuer, 300 AS capacity FROM WEB_SEARCH('synthetic organization discovery')",
  });
  const discovery = found.structuredContent as unknown as EngineResult;
  Object.assign(
    discovery,
    (
      await f.call("sourcesql_inspect_evidence", {
        result_id: discovery.result_id,
      })
    ).structuredContent,
  );
  const append = {
    request_id: input.request_id,
    existing_result_ref: {
      result_id: existing.result_id,
      snapshot_id: "existing-proposals",
      title: "Existing findings",
    },
    discovery_result_ref: {
      result_id: discovery.result_id,
      snapshot_id: "discovery-proposals",
      title: "New candidates",
    },
    assessments: [
      {
        row_id: "row_a",
        field: "capacity",
        status: "verified",
        note: "New source reports 120 MW",
        observed_at: existing.source_versions[0].retrieved_at,
        source_version_ids: [existing.source_versions[0].source_version_id],
      },
    ],
    discovery_observations: [
      {
        row_id: "row_c",
        observed_at: discovery.source_versions[0].retrieved_at,
        source_version_ids: [discovery.source_versions[0].source_version_id],
      },
    ],
  };
  const completed = await f.call("append_research_updates", append),
    update = completed.structuredContent as unknown as UpdateResponse;
  return { ...f, input, append, existing, discovery, update };
}
async function publish(t: { after(fn: () => Promise<void>): unknown }) {
  const f = await runCheck(t),
    count = f.engine.calls.filter((c) =>
      ["query", "import_table"].includes(c.method),
    ).length;
  for (const change of f.update.changes)
    await f.call("review_research_update", {
      request_id: f.input.request_id,
      change_id: change.id,
      decision: "accept",
      expected_revision: 1,
      mutation_id: randomUUID(),
    });
  const publication = {
    request_id: f.input.request_id,
    snapshot_id: "accepted-successor",
    expected_revision: 1,
    mutation_id: randomUUID(),
  };
  const published = await f.call("publish_research_update", publication);
  assert.equal(
    f.engine.calls.filter((c) => ["query", "import_table"].includes(c.method))
      .length,
    count,
    "Review and publication must not dispatch queries or Python materialization",
  );
  return { ...f, publication, published };
}

test("MCP manual lifecycle stays headless until final proposal open, reviews explicitly, and publishes without queries", async (t) => {
  const f = await runCheck(t),
    tools = (await f.client.listTools()).tools;
  assert.equal(
    tools.find((tool) => tool.name === "append_research_updates")!._meta?.ui,
    undefined,
  );
  assert.equal(
    tools.find((tool) => tool.name === "check_research_updates")!._meta?.ui,
    undefined,
  );
  assert.equal(f.update.request.status, "completed");
  assert.deepEqual(
    f.update.changes.map((change) => change.kind),
    ["changed_claim", "addition"],
  );
  assert.equal(f.update.changes[0].previous, 110);
  const effective = f.engine.calls.find(
    (call) => call.method === "import_table",
  )!;
  assert.equal(
    (effective.params.rows as Record<string, unknown>[])[0].capacity,
    110,
  );
  assert.equal(
    (effective.params.provenance as Record<string, unknown>).amendment_revision,
    1,
  );
  const opened = await f.call("open_research", {
    snapshot_id: f.update.proposal_snapshot_id,
  });
  const proposal = opened.structuredContent as unknown as ResearchView;
  assert.equal(proposal.update?.changes.length, 2);
  assert.equal(proposal.update?.publishedSnapshotId, undefined);
  const original = await f.store.open("baseline");
  assert.equal(
    effectiveValue(original, original.snapshot.rows[0], "capacity"),
    110,
  );
  const before = f.engine.calls.filter((c) =>
    ["query", "import_table"].includes(c.method),
  ).length;
  const decisions = f.update.changes.map((change) => ({
    request_id: f.input.request_id,
    change_id: change.id,
    decision: "accept",
    expected_revision: 1,
    mutation_id: randomUUID(),
  }));
  for (const decision of decisions) {
    await f.call("review_research_update", decision);
    await f.call("review_research_update", decision);
  }
  const publication = {
    request_id: f.input.request_id,
    snapshot_id: "accepted-successor",
    expected_revision: 1,
    mutation_id: randomUUID(),
  };
  await f.call("publish_research_update", publication);
  await f.call("publish_research_update", publication);
  const final = (
    await f.call("open_research", { snapshot_id: "accepted-successor" })
  ).structuredContent as unknown as ResearchView;
  assert.deepEqual(
    final.snapshot.rows.map((row) => [row.id, row.values.capacity]),
    [
      ["row_a", 120],
      ["row_b", 200],
      ["row_c", 300],
    ],
  );
  assert.equal(final.snapshot.origin?.engine, "imported");
  assert.equal(
    f.engine.calls.filter((c) => ["query", "import_table"].includes(c.method))
      .length,
    before,
  );
  assert.equal(
    (await f.store.readUpdate(f.input.request_id)).reviewMutations?.length,
    2,
  );
  const reopened = await connect(t, f.engine, f.backend);
  const saved = (
    await reopened.call("get_research_update", {
      request_id: f.input.request_id,
    })
  ).structuredContent as unknown as UpdateResponse;
  assert.equal(saved.published_snapshot_id, "accepted-successor");
});

test("MCP completion uses canonical metadata, rejects host hashes and forged observations, and retries exact results", async (t) => {
  const f = await runCheck(t),
    before = f.backend.writes;
  const replay = await f.call("append_research_updates", f.append);
  assert.deepEqual(
    (replay.structuredContent as unknown as UpdateResponse).changes,
    f.update.changes,
  );
  assert.equal(f.backend.writes, before);
  const reads = f.engine.calls.length;
  const forged = await f.client.callTool({
    name: "append_research_updates",
    arguments: {
      ...f.append,
      existing_result_ref: {
        ...f.append.existing_result_ref,
        content_sha256: "0".repeat(64),
      },
    },
  });
  assert.equal(forged.isError, true);
  assert.equal(f.engine.calls.length, reads);
  const changed = await f.client.callTool({
    name: "append_research_updates",
    arguments: {
      ...f.append,
      assessments: [
        { ...f.append.assessments[0], observed_at: "2030-01-01T00:00:00Z" },
      ],
    },
  });
  assert.equal(changed.isError, true);
  assert.equal(f.backend.writes, before);
  assert.equal(
    f.update.changes[0].evidence[0].contentSha256,
    f.existing.source_versions[0].content_sha256,
  );
});

test("private baselines and private/public proposals are refused by the active MCP policy before an app write", async (t) => {
  for (const mode of ["fixture-anonymous", "protected"] as const) {
    const engine = new Engine();
    engine.results.get("wq_baseline")!.data_classification = "private_local";
    const f = await connect(t, engine, new Backend(), {
      mode,
      principal: "fixture-owner",
      allowPrivateDisclosure: false,
    });
    const denied = await f.client.callTool({
      name: "check_research_updates",
      arguments: {
        request_id: randomUUID(),
        snapshot_id: "baseline",
        expected_revision: 0,
        existing: { row_ids: ["row_a"], fields: ["capacity"] },
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(f.backend.writes, 0);
  }
  for (const [mode, classification] of [
    ["fixture-anonymous", "private_derived"],
    ["protected", "private_derived"],
    ["fixture-anonymous", "public_web"],
  ] as const) {
    const f = await connect(t, new Engine(), new Backend(), {
      mode,
      principal: "fixture-owner",
      allowPrivateDisclosure: false,
    });
    const requestId = randomUUID();
    await f.call("check_research_updates", {
      request_id: requestId,
      snapshot_id: "baseline",
      expected_revision: 0,
      existing: { row_ids: ["row_a"], fields: ["capacity"] },
    });
    f.engine.nextClassification = classification;
    const result = await f.engine.call<EngineResult>("query", {
        query: "SELECT synthetic existing findings",
      }),
      before = f.backend.writes;
    const denied = await f.client.callTool({
      name: "append_research_updates",
      arguments: {
        request_id: requestId,
        existing_result_ref: {
          result_id: result.result_id,
          snapshot_id: "denied-proposal",
          title: "Denied proposal",
        },
        assessments: [
          {
            row_id: "row_a",
            field: "capacity",
            status: "verified",
            note: "Canonical source",
            observed_at: result.source_versions[0].retrieved_at,
            source_version_ids: [result.source_versions[0].source_version_id],
          },
        ],
        discovery_observations: [],
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(f.backend.writes, before);
    assert.equal((await f.store.readUpdate(requestId)).status, "pending");
    assert.equal(f.backend.state?.snapshots.length, 1);
  }
});

test("portable MCP import remaps every engine dependency and retains reviewed updates without provider queries", async (t) => {
  const f = await publish(t),
    exported = await f.call("export_research", {
      snapshot_id: "accepted-successor",
    }),
    bundle = exported.structuredContent as Record<string, unknown>;
  const target = await connect(t, new Engine(false));
  const restored = await target.call("import_research_bundle", { bundle });
  assert.equal(
    (restored.structuredContent as unknown as ResearchView).snapshot.id,
    "accepted-successor",
  );
  const update = await target.store.readUpdate(f.input.request_id);
  assert.notEqual(update.baselineSnapshot.origin?.resultId, "wq_baseline");
  assert.notEqual(
    update.completion?.existing_snapshot?.origin?.resultId,
    "wq_existing",
  );
  assert.notEqual(
    update.completion?.discovery_snapshot?.origin?.resultId,
    "wq_discovery",
  );
  assert.equal(
    update.changes![0].evidence[0].resultId,
    update.completion!.existing_snapshot!.origin!.resultId,
  );
  assert.equal(
    update.changes![1].evidence[0].resultId,
    update.completion!.discovery_snapshot!.origin!.resultId,
  );
  assert.equal(update.publishedSnapshotId, "accepted-successor");
  assert.equal(update.reviewMutations?.length, 2);
  assert.equal((await target.store.open("baseline")).amendments.length, 1);
  assert.equal(
    target.engine.calls.some((call) => call.method === "query"),
    false,
  );
  await target.call("import_research_bundle", { bundle });
  assert.equal(target.backend.state?.updates?.length, 1);
});
