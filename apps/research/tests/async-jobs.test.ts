import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  type ResearchEngine,
  type EngineResult,
  resultSnapshot,
  resolveResult,
} from "../server/engine.js";
import { type AccessPolicy } from "../server/access.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const seed = snapshotSchema.parse(sample);
class JobEngine implements ResearchEngine {
  state = "queued";
  cancellationRequested = false;
  unsettledCancellation = false;
  dispatches = 0;
  reads = 0;
  queryCalls = 0;
  privateResult = false;
  profileMode = "fixture";
  calls: { method: string; params: Record<string, unknown> }[] = [];
  jobs = new Map<string, { jobId: string; payload: string }>();
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "capabilities")
      return {
        execution_mode: "async_jobs",
        profiles: [{ name: "fixture", mode: this.profileMode }],
      } as T;
    if (method === "read_result") {
      this.reads++;
      return this.result() as T;
    }
    if (method === "query") {
      this.queryCalls++;
      if (typeof params.request_id !== "string")
        throw new Error("Hosted execution requires request_id");
      let job = this.jobs.get(params.request_id);
      const payload = JSON.stringify(params);
      if (job && job.payload !== payload)
        throw new Error("Request ID already has a different query");
      if (!job) {
        job = { jobId: `job_${randomUUID()}`, payload };
        this.jobs.set(params.request_id, job);
        this.dispatches++;
      }
      return this.receipt(job.jobId, params.request_id) as T;
    }
    const found = [...this.jobs.entries()].find(
      ([, job]) => job.jobId === params.job_id,
    );
    if (!found) throw new Error("Authorized job not found");
    if (method === "cancel_job") this.cancellationRequested = true;
    if (["job_status", "cancel_job", "start_job"].includes(method))
      return this.receipt(found[1].jobId, found[0]) as T;
    throw new Error("Unexpected test engine method");
  }
  result(): EngineResult {
    return {
      result_id: "wq_job_result",
      run_id: "run_job_result",
      columns: [
        {
          key: "value",
          label: "Value",
          logical_type: "VARCHAR",
          nullable: false,
        },
      ],
      rows: [{ value: "synthetic" }],
      row_ids: ["row_1"],
      row_count: 1,
      content_sha256: "a".repeat(64),
      data_classification: this.privateResult
        ? "private_local"
        : "synthetic_fixture",
      evidence: [],
      source_versions: [],
      receipt: { status: "completed", finished_at: "2026-10-14T01:02:03Z" },
      next_offset: null,
    };
  }
  receipt(jobId: string, requestId: string) {
    return {
      job_id: jobId,
      request_id: requestId,
      status: this.state,
      cancellation_requested: this.cancellationRequested,
      pending: this.state === "cancelled" && this.unsettledCancellation,
      // A buggy engine must not cause pending or terminal failures to disclose a result.
      result_id: "wq_job_result",
      run_id: "run_job_result",
      result_ref: {
        result_id: "wq_job_result",
        snapshot_id: "do-not-invent",
        title: "private",
      },
      query: "private query",
      token: "synthetic-secret",
      error: "raw diagnostic",
    };
  }
}
async function connect(engine: ResearchEngine, access?: AccessPolicy) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-async-app-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<html>Synthetic app</html>");
  const store = new ResearchStore(join(directory, "data"), seed, (snapshot) =>
    resolveResult(engine, {
      result_id: snapshot.dataRef!.resultId,
      snapshot_id: snapshot.id,
      title: snapshot.title,
    }),
  );
  const server = createServer(store, htmlPath, { engine, access });
  const client = new Client({ name: "async-app-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    store,
    async close() {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const args = (requestId = randomUUID()) => ({
  query: "SELECT 1 AS value",
  request_id: requestId,
});

class MaterializationEngine extends JobEngine {
  ready = false;
  materializationDispatches = 0;
  materializationId = `job_${randomUUID()}`;
  materializationRequestId = randomUUID();
  payload?: string;
  table?: Record<string, unknown>;
  foreignResultId = "wq_foreign";
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (["import_table", "import"].includes(method)) {
      this.calls.push({ method, params });
      const payload = JSON.stringify(params);
      if (this.payload && this.payload !== payload)
        throw new Error("Materialization payload changed");
      if (!this.payload) {
        this.payload = payload;
        this.table = method === "import_table" ? params : undefined;
        this.materializationDispatches++;
      }
      if (!this.ready) return this.materializationReceipt() as T;
      return {
        ...this.materialized(),
        result_mapping: { [this.foreignResultId]: "wq_materialized" },
      } as T;
    }
    if (method === "read_result" && params.result_id === this.foreignResultId)
      throw new Error("Foreign result is not stored here");
    if (method === "read_result" && params.result_id === "wq_materialized") {
      if (!this.ready) throw new Error("Materialization is not completed");
      return this.materialized() as T;
    }
    if (method === "job_status" && params.job_id === this.materializationId)
      return this.materializationReceipt() as T;
    return super.call<T>(method, params);
  }
  materialized(): EngineResult {
    return {
      ...this.result(),
      result_id: "wq_materialized",
      run_id: "run_materialized",
      rows: this.table
        ? (this.table.rows as EngineResult["rows"])
        : this.result().rows,
    };
  }
  materializationReceipt() {
    return {
      job_id: this.materializationId,
      request_id: this.materializationRequestId,
      status: this.ready ? "completed" : "running",
      pending: !this.ready,
      ...(this.ready
        ? { result_id: "wq_materialized", run_id: "run_materialized" }
        : {}),
    };
  }
}

test("pending MCP job handles are bounded and never manufacture result references", async () => {
  const engine = new JobEngine();
  const session = await connect(engine);
  try {
    for (const state of [
      "queued",
      "dispatching",
      "running",
      "submission_unknown",
      "failed",
      "cancelled",
    ]) {
      engine.state = state;
      const response = await session.client.callTool({
        name: "sourcesql_query",
        arguments: args(),
      });
      assert.equal(response.isError, undefined);
      const result = response.structuredContent as Record<string, unknown>;
      assert.equal(result.status, state);
      assert.equal(result.pending, !["failed", "cancelled"].includes(state));
      for (const key of [
        "result_id",
        "run_id",
        "result_ref",
        "query",
        "token",
        "error",
      ])
        assert.equal(result[key], undefined);
      assert.doesNotMatch(
        JSON.stringify(response),
        /synthetic-secret|private query|do-not-invent|raw diagnostic/,
      );
      if (state === "submission_unknown")
        assert.match(
          JSON.stringify(response.content),
          /Do not submit a new request ID/,
        );
    }
    assert.equal(
      engine.reads,
      0,
      "Incomplete jobs must not resolve unpublished data",
    );
  } finally {
    await session.close();
  }
});

test("identical MCP retries and status polling keep the original job and request identity", async () => {
  const engine = new JobEngine();
  const session = await connect(engine);
  try {
    const input = args();
    const first = await session.client.callTool({
      name: "sourcesql_query",
      arguments: input,
    });
    const again = await session.client.callTool({
      name: "sourcesql_query",
      arguments: input,
    });
    assert.deepEqual(again.structuredContent, first.structuredContent);
    assert.equal(engine.dispatches, 1);
    const jobId = (first.structuredContent as Record<string, unknown>).job_id;
    engine.state = "submission_unknown";
    const polled = await session.client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: jobId },
    });
    assert.equal(
      (polled.structuredContent as Record<string, unknown>).job_id,
      jobId,
    );
    assert.equal(
      (polled.structuredContent as Record<string, unknown>).request_id,
      input.request_id,
    );
    assert.equal(engine.dispatches, 1);
    const conflicting = await session.client.callTool({
      name: "sourcesql_query",
      arguments: { ...input, query: "SELECT 2 AS value" },
    });
    assert.equal(conflicting.isError, true);
    assert.match(JSON.stringify(conflicting.content), /different query/);
    assert.equal(engine.dispatches, 1);
  } finally {
    await session.close();
  }
});

test("completed job polling authorizes the stored result before exposing its handle", async () => {
  const engine = new JobEngine();
  const session = await connect(engine, {
    mode: "protected",
    principal: "local-owner",
    allowPrivateDisclosure: false,
  });
  try {
    const first = await session.client.callTool({
      name: "sourcesql_query",
      arguments: args(),
    });
    const jobId = (first.structuredContent as Record<string, unknown>).job_id;
    engine.state = "completed";
    const ready = await session.client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: jobId },
    });
    assert.equal(ready.isError, undefined);
    assert.match(
      JSON.stringify(ready.content),
      /Presentation is the final step/,
    );
    assert.match(
      JSON.stringify(ready.content),
      /not after each query, poll, import or transformation/,
    );
    assert.doesNotMatch(
      JSON.stringify(ready.content),
      /Stored result is ready\. Use open_research/,
    );

    assert.equal(
      (ready.structuredContent as Record<string, unknown>).pending,
      false,
    );
    assert.equal(
      (ready.structuredContent as Record<string, unknown>).result_id,
      "wq_job_result",
    );
    assert.equal(
      (ready.structuredContent as Record<string, unknown>).result_ref,
      undefined,
    );
    engine.privateResult = true;
    const refused = await session.client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: jobId },
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent, undefined);
    assert.doesNotMatch(
      JSON.stringify(refused),
      /wq_job_result|private query|synthetic-secret/,
    );
    assert.equal(engine.dispatches, 1);
  } finally {
    await session.close();
  }
});

test("cancellation remains pending until a terminal receipt and does not close app research", async () => {
  const engine = new JobEngine();
  const session = await connect(engine);
  try {
    const researchId = randomUUID();
    await session.store.beginResearch(
      {
        request_id: researchId,
        snapshot_id: seed.id,
        row_id: seed.rows[0].id,
        question: "Synthetic follow-up",
      },
      "expand",
    );
    const first = await session.client.callTool({
      name: "sourcesql_query",
      arguments: args(),
    });
    const jobId = (first.structuredContent as Record<string, unknown>).job_id;
    engine.state = "running";
    const cancel = await session.client.callTool({
      name: "sourcesql_cancel_job",
      arguments: { job_id: jobId },
    });
    assert.equal(
      (cancel.structuredContent as Record<string, unknown>).pending,
      true,
    );
    assert.equal(
      (cancel.structuredContent as Record<string, unknown>)
        .cancellation_requested,
      true,
    );
    assert.equal(
      (cancel.structuredContent as Record<string, unknown>).result_id,
      undefined,
    );
    engine.state = "cancelled";
    engine.unsettledCancellation = true;
    const unsettled = await session.client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: jobId },
    });
    assert.equal(
      (unsettled.structuredContent as Record<string, unknown>).status,
      "cancelled",
    );
    assert.equal(
      (unsettled.structuredContent as Record<string, unknown>).pending,
      true,
    );
    assert.equal(
      (unsettled.structuredContent as Record<string, unknown>).result_id,
      undefined,
    );
    assert.match(
      JSON.stringify(unsettled.content),
      /result publication is blocked.*Platform stop is not confirmed/,
    );
    engine.unsettledCancellation = false;
    const finished = await session.client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: jobId },
    });
    assert.equal(
      (finished.structuredContent as Record<string, unknown>).pending,
      false,
    );
    assert.equal(
      (finished.structuredContent as Record<string, unknown>).result_id,
      undefined,
    );
    assert.equal(
      (await session.store.researchContext(researchId)).request.status,
      "pending",
    );
    assert.equal(engine.reads, 0);
  } finally {
    await session.close();
  }
});

test("anonymous mode blocks live job dispatch and job discovery exposes exact schemas", async () => {
  const engine = new JobEngine();
  engine.profileMode = "live";
  const session = await connect(engine, {
    mode: "fixture-anonymous",
    principal: "fixture-anonymous",
    allowPrivateDisclosure: false,
  });
  try {
    const refused = await session.client.callTool({
      name: "sourcesql_query",
      arguments: args(),
    });
    assert.equal(refused.isError, true);
    assert.equal(engine.queryCalls, 0);
    const { tools } = await session.client.listTools();
    for (const name of [
      "sourcesql_job_status",
      "sourcesql_cancel_job",
      "sourcesql_start_job",
    ]) {
      const tool = tools.find((entry) => entry.name === name)!;
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["job_id"]);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.match(tool.description!, /same.*ID|same job/i);
    }
  } finally {
    await session.close();
  }
});

test("pending effective-input materialization does not submit research; identical query ID resumes after completion", async () => {
  const engine = new MaterializationEngine();
  const session = await connect(engine);
  try {
    const snapshot = resultSnapshot(engine.result(), {
      result_id: "wq_job_result",
      snapshot_id: "effective-parent",
      title: "Effective source",
    });
    await session.store.import(snapshot);
    await session.store.amend({
      snapshot_id: snapshot.id,
      row_id: "row_1",
      field: "value",
      value: "corrected",
      mutation_id: randomUUID(),
      expected_revision: 0,
    });
    const input = {
      ...args(),
      query: "SELECT value FROM INPUT('parent')",
      inputs: {
        parent: {
          result_id: "wq_job_result",
          view: "effective",
          amendment_revision: 1,
        },
      },
    };
    const noRequestId = { ...input } as Record<string, unknown>;
    delete noRequestId.request_id;
    const admission = await session.client.callTool({
      name: "sourcesql_query",
      arguments: noRequestId,
    });
    assert.equal(admission.isError, true);
    assert.equal(
      engine.materializationDispatches,
      0,
      "A missing query UUID is refused before any dependency Flight",
    );
    const before = await session.store.open(snapshot.id);
    const first = await session.client.callTool({
      name: "sourcesql_query",
      arguments: input,
    });
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.equal(
      (first.structuredContent as Record<string, unknown>).job_id,
      engine.materializationId,
    );
    assert.equal(
      (first.structuredContent as Record<string, unknown>).pending,
      true,
    );
    assert.match(JSON.stringify(first.content), new RegExp(input.request_id));
    assert.match(
      JSON.stringify(first.content),
      /research query has not been submitted/,
    );
    assert.equal(engine.queryCalls, 0);
    assert.deepEqual(await session.store.open(snapshot.id), before);
    const retryPending = await session.client.callTool({
      name: "sourcesql_query",
      arguments: input,
    });
    assert.deepEqual(retryPending.structuredContent, first.structuredContent);
    assert.equal(engine.materializationDispatches, 1);
    engine.ready = true;
    const polled = await session.client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: engine.materializationId },
    });
    assert.equal(
      (polled.structuredContent as Record<string, unknown>).status,
      "completed",
    );
    const resumed = await session.client.callTool({
      name: "sourcesql_query",
      arguments: input,
    });
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed.content));
    assert.equal(engine.materializationDispatches, 1);
    assert.equal(engine.dispatches, 1);
    const dispatched = engine.calls.filter(
      (call) => call.method === "query",
    )[0];
    assert.equal(dispatched.params.request_id, input.request_id);
    assert.deepEqual(dispatched.params.inputs, {
      parent: {
        result_id: "wq_materialized",
        view: "effective",
        amendment_revision: 1,
      },
    });
    await session.client.callTool({
      name: "sourcesql_query",
      arguments: input,
    });
    assert.equal(engine.dispatches, 1);
    assert.deepEqual(await session.store.open(snapshot.id), before);
  } finally {
    await session.close();
  }
});

test("pending bundle materialization preserves app state until the same original bundle resumes", async () => {
  const engine = new MaterializationEngine();
  const session = await connect(engine);
  try {
    const foreign = {
      ...engine.result(),
      result_id: engine.foreignResultId,
      run_id: "run_foreign",
    };
    const snapshot = resultSnapshot(foreign, {
      result_id: foreign.result_id,
      snapshot_id: "imported-root",
      title: "Imported synthetic research",
    });
    const bundle = {
      schemaVersion: 2,
      snapshotId: snapshot.id,
      state: {
        snapshots: [snapshot],
        amendments: [],
        titles: { [snapshot.id]: "Restored title" },
      },
      engineResults: {
        [foreign.result_id]: {
          manifest: { result_id: foreign.result_id },
          rows: foreign.rows,
        },
      },
    };
    const before = await session.store.open();
    const first = await session.client.callTool({
      name: "import_research_bundle",
      arguments: { bundle },
    });
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    assert.equal(
      (first.structuredContent as Record<string, unknown>).job_id,
      engine.materializationId,
    );
    assert.match(JSON.stringify(first.content), /same original bundle/);
    assert.deepEqual(await session.store.open(), before);
    await assert.rejects(session.store.open(snapshot.id), /Snapshot not found/);
    const again = await session.client.callTool({
      name: "import_research_bundle",
      arguments: { bundle },
    });
    assert.deepEqual(again.structuredContent, first.structuredContent);
    assert.equal(engine.materializationDispatches, 1);
    engine.ready = true;
    const restored = await session.client.callTool({
      name: "import_research_bundle",
      arguments: { bundle },
    });
    assert.equal(restored.isError, undefined, JSON.stringify(restored.content));
    const full = await session.store.open(snapshot.id);
    assert.equal(full.displayTitle, "Restored title");
    assert.equal(full.snapshot.origin!.resultId, "wq_materialized");
    assert.deepEqual(
      full.snapshot.rows.map((row) => row.values),
      foreign.rows,
    );
    const completedRetry = await session.client.callTool({
      name: "import_research_bundle",
      arguments: { bundle },
    });
    assert.equal(
      completedRetry.isError,
      undefined,
      JSON.stringify(completedRetry.content),
    );
    assert.equal(engine.materializationDispatches, 1);
    assert.equal(engine.queryCalls, 0);
    assert.equal(
      (await session.store.open()).snapshots.filter(
        (option) => option.id === snapshot.id,
      ).length,
      1,
    );
  } finally {
    await session.close();
  }
});
