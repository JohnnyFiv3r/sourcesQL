import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import {
  resultSnapshot,
  resolveResult,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import { type ResearchCheckpoint } from "../server/checkpoints.js";
import { snapshotSchema, type Snapshot } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
const legacySeed = snapshotSchema.parse(sample);
function result(
  id = "wq_checkpoint",
  classification: EngineResult["data_classification"] = "synthetic_fixture",
): EngineResult {
  return {
    result_id: id,
    run_id: `run_${id}`,
    columns: [
      { key: "name", label: "Name", logical_type: "VARCHAR", nullable: false },
    ],
    rows: [{ name: "Synthetic entity" }],
    row_ids: ["canonical_row"],
    row_count: 1,
    content_sha256: "a".repeat(64),
    data_classification: classification,
    evidence: [
      {
        row_id: "canonical_row",
        column_key: "name",
        source_version_id: "src_original",
      },
    ],
    source_versions: [
      {
        source_version_id: "src_original",
        content_sha256: "b".repeat(64),
        retrieved_at: "2026-10-15T08:00:00Z",
        content: "Retained synthetic evidence",
      },
    ],
    receipt: { status: "completed", finished_at: "2026-10-15T09:00:00Z" },
    next_offset: null,
    query: "SELECT $name AS name",
    parameters: { name: "Synthetic entity" },
  };
}
class ReadOnlyEngine implements ResearchEngine {
  readonly calls: string[] = [];
  readonly results = new Map<string, EngineResult>();
  readonly denied = new Set<string>();
  readonly jobs = new Map<string, Record<string, unknown>>();
  constructor(initial: EngineResult[] = []) {
    for (const value of initial) this.results.set(value.result_id, value);
  }
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push(method);
    if (method === "read_result") {
      const id = String(params.result_id),
        value = this.results.get(id);
      if (!value || this.denied.has(id)) throw new Error("Result unavailable");
      const offset = Number(params.offset ?? 0),
        limit = Number(params.limit ?? 100);
      return {
        ...structuredClone(value),
        rows: value.rows.slice(offset, offset + limit),
        row_ids: value.row_ids.slice(offset, offset + limit),
        next_offset: offset + limit < value.row_count ? offset + limit : null,
      } as T;
    }
    if (method === "job_status") {
      const value = this.jobs.get(String(params.job_id));
      if (!value) throw new Error("Job unavailable");
      return structuredClone(value) as T;
    }
    if (method === "export")
      return {
        retained: structuredClone(this.results.get(String(params.result_id))),
      } as T;
    if (method === "import") {
      const foreign = (params.bundle as { retained: EngineResult }).retained;
      const local = {
        ...structuredClone(foreign),
        result_id: `${foreign.result_id}_restored`,
        run_id: "run_restored",
        receipt: { ...foreign.receipt, finished_at: "2026-10-15T10:00:00Z" },
      };
      this.results.set(local.result_id, local);
      return {
        ...local,
        result_mapping: { [foreign.result_id]: local.result_id },
      } as T;
    }
    throw new Error(`Unexpected execution: ${method}`);
  }
}
async function setup(
  context: { after(callback: () => Promise<void>): void },
  options: {
    engine?: ReadOnlyEngine;
    seed?: Snapshot;
    allowPrivate?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-checkpoint-mcp-")),
    engine = options.engine ?? new ReadOnlyEngine([result()]);
  const seed =
    options.seed ??
    resultSnapshot(result(), {
      result_id: "wq_checkpoint",
      snapshot_id: "saved_fixture",
      title: "Checkpoint fixture",
    });
  const store = new ResearchStore(directory, seed, (snapshot) =>
    resolveResult(engine, {
      result_id: snapshot.dataRef!.resultId,
      snapshot_id: snapshot.id,
      title: snapshot.title,
    }).then((resolved) => ({
      ...resolved,
      parentSnapshotId: snapshot.parentSnapshotId,
    })),
  );
  const server = createServer(
    store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    {
      engine,
      access: {
        mode: "protected",
        principal: "checkpoint-test",
        allowPrivateDisclosure: options.allowPrivate ?? true,
      },
    },
  );
  const client = new Client({ name: "checkpoint-mcp-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  context.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { client, engine, store, seed };
}
function saveArgs(snapshotId = "saved_fixture") {
  return {
    checkpoint_id: randomUUID(),
    snapshot_id: snapshotId,
    expected_revision: 0,
    question: "Private continuation question marker",
    scope: "Continue the saved entity",
    row_ids: ["canonical_row"],
    fields: ["name"],
  };
}
function content(response: unknown) {
  return response as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}
async function save(client: Client, args = saveArgs()) {
  const response = content(
    await client.callTool({
      name: "save_research_checkpoint",
      arguments: args,
    }),
  );
  assert.equal(response.isError, undefined, JSON.stringify(response));
  return content(response).structuredContent!.checkpoint as ResearchCheckpoint;
}
function noExecution(engine: ReadOnlyEngine, allowTransfer = false) {
  assert.ok(
    engine.calls.every((method) =>
      (allowTransfer
        ? ["read_result", "job_status", "export", "import"]
        : ["read_result", "job_status"]
      ).includes(method),
    ),
    engine.calls.join(","),
  );
}

test("MCP save derives canonical SQL, labels planned SQL, and never executes during resume", async (context) => {
  const { client, engine } = await setup(context);
  const saved = await save(client);
  assert.equal(saved.query?.provenance, "saved_result");
  assert.equal(saved.query?.query, result().query);
  assert.deepEqual(saved.query?.parameters, result().parameters);
  const planned = await client.callTool({
    name: "save_research_checkpoint",
    arguments: {
      ...saveArgs(),
      query: { query: "SELECT 7 AS name", parameters: {} },
    },
  });
  assert.equal(
    (content(planned).structuredContent!.checkpoint as ResearchCheckpoint).query
      ?.provenance,
    "planned",
  );
  const resumed = content(
    await client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: saved.id },
    }),
  );
  assert.equal(resumed.isError, undefined);
  assert.equal(resumed.structuredContent!.status, "ready");
  noExecution(engine);
});
test("MCP same-ID recovery preserves the checkpoint and changed arguments are refused", async (context) => {
  const { client } = await setup(context),
    args = saveArgs(),
    first = await save(client, args);
  assert.deepEqual(await save(client, args), first);
  const changed = await client.callTool({
    name: "save_research_checkpoint",
    arguments: { ...args, question: "A different research question" },
  });
  assert.equal(changed.isError, true);
});
test("new corrections block continuation with a stale revision rather than replacing the saved scope", async (context) => {
  const { client, store, engine } = await setup(context),
    saved = await save(client);
  await store.amend({
    snapshot_id: "saved_fixture",
    row_id: "canonical_row",
    field: "name",
    value: "A newer correction",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const response = content(
    await client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: saved.id },
    }),
  );
  assert.equal(response.structuredContent!.status, "blocked");
  assert.deepEqual(response.structuredContent!.blockers, [
    { code: "stale_revision", reference: "saved_fixture" },
  ]);
  noExecution(engine);
});
test("revoked dependencies and private access denial disclose no continuation question or SQL", async (context) => {
  const h = await setup(context),
    saved = await save(h.client);
  h.engine.denied.add("wq_checkpoint");
  const revoked = await h.client.callTool({
    name: "resume_research_checkpoint",
    arguments: { checkpoint_id: saved.id },
  });
  assert.equal(revoked.isError, true);
  assert.ok(!JSON.stringify(revoked).includes(saved.question));
  assert.ok(!JSON.stringify(revoked).includes(saved.query!.query));
  const secret = result("wq_private", "private_local"),
    engine = new ReadOnlyEngine([secret]);
  const privateHost = await setup(context, {
    engine,
    seed: resultSnapshot(secret, {
      result_id: secret.result_id,
      snapshot_id: "private_fixture",
      title: "private marker",
    }),
    allowPrivate: false,
  });
  const refused = await privateHost.client.callTool({
    name: "save_research_checkpoint",
    arguments: saveArgs("private_fixture"),
  });
  assert.equal(refused.isError, true);
  assert.ok(!JSON.stringify(refused).includes("private marker"));
  assert.ok(!JSON.stringify(refused).includes("Synthetic entity"));
  noExecution(engine);
});
test("compact import reports missing data and retains pending IDs as foreign without polling or execution", async (context) => {
  const source = await setup(context),
    jobId = randomUUID(),
    requestId = randomUUID();
  const response = await source.client.callTool({
    name: "save_research_checkpoint",
    arguments: {
      ...saveArgs(),
      pending: [{ kind: "job", id: jobId, request_id: requestId }],
    },
  });
  const saved = content(response).structuredContent!
    .checkpoint as ResearchCheckpoint;
  const target = await setup(context, {
    engine: new ReadOnlyEngine(),
    seed: legacySeed,
  });
  const imported = content(
    await target.client.callTool({
      name: "import_research_checkpoint",
      arguments: { checkpoint: saved },
    }),
  );
  assert.equal(imported.isError, undefined);
  assert.equal(imported.structuredContent!.status, "blocked");
  assert.deepEqual(imported.structuredContent!.blockers, [
    { code: "missing", reference: "saved_fixture" },
    { code: "foreign_pending", reference: jobId },
  ]);
  assert.deepEqual(
    (await target.store.readCheckpoint(saved.id)).checkpoint.pending,
    saved.pending,
  );
  assert.deepEqual(target.engine.calls, []);
  await assert.rejects(target.store.open("saved_fixture"), /not found/);
});
test("same-namespace uncertain jobs are inspected with their original identities without resubmission", async (context) => {
  const { client, engine } = await setup(context),
    jobId = randomUUID(),
    requestId = randomUUID();
  engine.jobs.set(jobId, {
    job_id: jobId,
    request_id: requestId,
    status: "submission_unknown",
  });
  const response = await client.callTool({
    name: "save_research_checkpoint",
    arguments: {
      ...saveArgs(),
      pending: [{ kind: "job", id: jobId, request_id: requestId }],
    },
  });
  const saved = content(response).structuredContent!
    .checkpoint as ResearchCheckpoint;
  const resumed = content(
    await client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: saved.id },
    }),
  );
  assert.equal(resumed.structuredContent!.status, "ready");
  assert.equal(
    engine.calls.filter((method) => method === "job_status").length,
    1,
  );
  noExecution(engine);
  engine.jobs.set(jobId, {
    job_id: jobId,
    request_id: randomUUID(),
    status: "running",
  });
  const conflict = content(
    await client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: saved.id },
    }),
  );
  assert.deepEqual(conflict.structuredContent!.blockers, [
    { code: "inaccessible_pending", reference: jobId },
  ]);
});
test("complete bundle remaps engine results and capture pins while remote pending work remains foreign", async (context) => {
  const source = await setup(context),
    jobId = randomUUID();
  const response = await source.client.callTool({
    name: "save_research_checkpoint",
    arguments: { ...saveArgs(), pending: [{ kind: "job", id: jobId }] },
  });
  const saved = content(response).structuredContent!
    .checkpoint as ResearchCheckpoint;
  const exported = await source.client.callTool({
    name: "export_research",
    arguments: { snapshot_id: "saved_fixture" },
  });
  assert.equal(exported.isError, undefined);
  const target = await setup(context, {
    engine: new ReadOnlyEngine(),
    seed: legacySeed,
  });
  const imported = await target.client.callTool({
    name: "import_research_bundle",
    arguments: { bundle: exported.structuredContent },
  });
  assert.equal(imported.isError, undefined, JSON.stringify(imported));
  const restored = (await target.store.readCheckpoint(saved.id)).checkpoint;
  assert.equal(
    restored.dependencies[0].result.resultId,
    "wq_checkpoint_restored",
  );
  assert.equal(restored.dependencies[0].result.runId, "run_restored");
  assert.equal(restored.dependencies[0].capturedAt, "2026-10-15T10:00:00Z");
  const resumed = content(
    await target.client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: saved.id },
    }),
  );
  assert.deepEqual(resumed.structuredContent!.blockers, [
    { code: "foreign_pending", reference: jobId },
  ]);
  assert.ok(!target.engine.calls.includes("job_status"));
  noExecution(target.engine, true);
});
