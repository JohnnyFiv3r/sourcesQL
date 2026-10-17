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
      for (const key of ["result_id", "result_ref", "query", "token"])
        assert.equal(result[key], undefined);
      if (state === "failed") {
        assert.equal(result.run_id, "run_job_result");
        assert.equal(
          (result.error as Record<string, unknown>).code,
          "execution_failed",
        );
      } else {
        assert.equal(result.run_id, undefined);
        assert.equal(result.error, undefined);
      }
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

test("MCP run diagnostics bound entries and replace arbitrary codes, stages and messages", async () => {
  const engine = new JobEngine();
  const originalCall = engine.call.bind(engine);
  engine.call = async <T>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (method !== "run_status") return originalCall<T>(method, params);
    return {
      run_id: params.run_id,
      status: "failed",
      errors: [
        {
          code: "provider_timeout",
          stage: "semantic",
          safe_message: "PRIVATE-PROVIDER-BODY",
          token: "PRIVATE-KEY",
        },
        {
          code: "PRIVATE-ERROR-CODE",
          stage: "PRIVATE-PROMPT",
          message: "PRIVATE-RAW-MESSAGE",
        },
        { code: "__proto__", stage: {} },
        ...Array.from({ length: 20 }, () => ({
          code: "invalid_output",
          stage: "semantic",
        })),
      ],
      query: "PRIVATE-SQL",
      provider_events: [{ raw: "PRIVATE-EVENT" }],
    } as T;
  };
  const session = await connect(engine);
  try {
    const response = await session.client.callTool({
      name: "sourcesql_run_status",
      arguments: { run_id: "run_failed" },
    });
    assert.notEqual(response.isError, true);
    const result = response.structuredContent as Record<string, any>;
    assert.equal(result.errors.length, 8);
    assert.equal(result.errors_truncated, true);
    assert.equal(result.errors[0].code, "provider_timeout");
    assert.equal(result.errors[0].stage, "semantic");
    assert.match(result.errors[0].message, /may be unknown/);
    assert.equal(result.errors[1].code, "execution_failed");
    assert.equal(result.errors[1].stage, undefined);
    assert.equal(result.errors[2].code, "execution_failed");
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE-|__proto__/);
    assert.equal(engine.dispatches, 0);
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
      /Query execution completed and the result is stored/,
    );
    assert.match(
      JSON.stringify(ready.content),
      /This response does not render a component/,
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
    for (const name of ["sourcesql_query", "sourcesql_explain"]) {
      const refused = await session.client.callTool({
        name,
        arguments: args(),
      });
      assert.equal(refused.isError, true);
    }
    assert.equal(engine.queryCalls, 0);
    assert.equal(
      engine.calls.filter((call) => call.method === "explain").length,
      0,
    );
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

test("hosted explain materializes the authorized corrected input before validation and preserves its request ID", async () => {
  class ValidationEngine extends MaterializationEngine {
    validations: Record<string, unknown>[] = [];
    override async call<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      if (method !== "explain") return super.call<T>(method, params);
      this.validations.push(params);
      return {
        job_id: "job_validation",
        request_id: params.request_id,
        operation: "explain",
        status: "completed",
        preflight: { external_calls: 0, input_pins: params.inputs },
      } as T;
    }
  }
  const engine = new ValidationEngine();
  const session = await connect(engine);
  try {
    const snapshot = resultSnapshot(engine.result(), {
      result_id: "wq_job_result",
      snapshot_id: "validation-effective-parent",
      title: "Corrected source",
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
    const { request_id: omitted, ...withoutId } = input;
    assert.equal(
      (
        await session.client.callTool({
          name: "sourcesql_explain",
          arguments: withoutId,
        })
      ).isError,
      true,
    );
    assert.equal(engine.materializationDispatches, 0);
    const pending = await session.client.callTool({
      name: "sourcesql_explain",
      arguments: input,
    });
    assert.notEqual(pending.isError, true, JSON.stringify(pending.content));
    assert.equal(
      (pending.structuredContent as Record<string, unknown>).job_id,
      engine.materializationId,
    );
    assert.match(
      JSON.stringify(pending.content),
      /repeat the original sourcesql_explain/,
    );
    assert.match(JSON.stringify(pending.content), new RegExp(input.request_id));
    assert.match(
      JSON.stringify(pending.content),
      /validation has not been submitted/,
    );
    assert.equal(engine.validations.length, 0);
    assert.equal(engine.materializationDispatches, 1);
    engine.ready = true;
    const completed = await session.client.callTool({
      name: "sourcesql_explain",
      arguments: input,
    });
    assert.notEqual(completed.isError, true, JSON.stringify(completed.content));
    assert.equal(engine.validations.length, 1);
    assert.equal(engine.validations[0].request_id, omitted);
    assert.deepEqual(engine.validations[0].inputs, {
      parent: {
        result_id: "wq_materialized",
        view: "effective",
        amendment_revision: 1,
      },
    });
    assert.deepEqual(engine.table?.rows, [{ value: "corrected" }]);
    assert.equal(
      (completed.structuredContent as Record<string, unknown>).result_id,
      undefined,
    );
    assert.equal(
      (completed.structuredContent as Record<string, unknown>).operation,
      "explain",
    );
    assert.equal(engine.queryCalls, 0);
    assert.equal((await session.store.open(snapshot.id)).revision, 1);
  } finally {
    await session.close();
  }
});

test("query schema forwards explicit continuation and bounded research requirements", async () => {
  const engine = new JobEngine();
  const session = await connect(engine);
  try {
    const requirements = {
      key_columns: ["value"],
      fields: ["value"],
      minimum_rows: 0,
    };
    const response = await session.client.callTool({
      name: "sourcesql_query",
      arguments: {
        ...args(),
        continuation_of: "run_previous",
        research_requirements: requirements,
      },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    const query = engine.calls.find((call) => call.method === "query")!;
    assert.equal(query.params.continuation_of, "run_previous");
    assert.deepEqual(query.params.research_requirements, requirements);
    const invalid = await session.client.callTool({
      name: "sourcesql_query",
      arguments: {
        ...args(),
        research_requirements: { key_columns: [], fields: ["value"] },
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal(engine.queryCalls, 1);
  } finally {
    await session.close();
  }
});

test("explicit run continuation preserves its new request ID and refuses unsettled work", async () => {
  class ResumeEngine extends JobEngine {
    settled = false;
    resumes: Record<string, unknown>[] = [];
    override async call<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      if (method === "run_status")
        return {
          run_id: params.run_id,
          status: "failed",
          settlement_status: this.settled ? "settled" : "pending",
          resume_request: { query: "PRIVATE-RESUME-SQL" },
          checkpoints: {
            stages: [
              {
                stage_key: "stage_one",
                status: "completed",
                error_code: null,
                value: "PRIVATE-STAGE-PAYLOAD",
              },
            ],
            total: 1,
            omitted: 0,
          },
        } as T;
      if (method === "resume_run") {
        this.resumes.push(params);
        return {
          job_id: "job_continued",
          operation: "query",
          request_id: params.request_id,
          status: "queued",
        } as T;
      }
      return super.call<T>(method, params);
    }
  }
  const engine = new ResumeEngine(),
    session = await connect(engine);
  try {
    const request = { run_id: "run_failed", request_id: randomUUID() };
    const refused = await session.client.callTool({
      name: "sourcesql_resume_run",
      arguments: request,
    });
    assert.equal(refused.isError, true);
    assert.equal(engine.resumes.length, 0);
    engine.settled = true;
    const inspected = await session.client.callTool({
      name: "sourcesql_run_status",
      arguments: { run_id: request.run_id },
    });
    const summary = inspected.structuredContent as Record<string, any>;
    assert.deepEqual(summary.checkpoints, {
      stages: [
        { stage_key: "stage_one", status: "completed", error_code: null },
      ],
      total: 1,
      omitted: 0,
    });
    assert.doesNotMatch(JSON.stringify(inspected), /PRIVATE-/);
    const continued = await session.client.callTool({
      name: "sourcesql_resume_run",
      arguments: request,
    });
    assert.notEqual(continued.isError, true, JSON.stringify(continued.content));
    assert.deepEqual(engine.resumes, [request]);
    assert.equal(
      (continued.structuredContent as Record<string, unknown>).request_id,
      request.request_id,
    );
    assert.equal(
      (continued.structuredContent as Record<string, unknown>).job_id,
      "job_continued",
    );
    const tool = (await session.client.listTools()).tools.find(
      (tool) => tool.name === "sourcesql_resume_run",
    )!;
    assert.match(tool.description!, /Inspect sourcesql_run_status first/);
    assert.match(tool.description!, /Do not widen limits or retry an uncertain effect/);
  } finally {
    await session.close();
  }
});

test("evidence inspection exposes safe page diagnostics while receipt internals remain private", async () => {
  const engine = new JobEngine();
  const original = engine.call.bind(engine);
  engine.call = async <T>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (method !== "read_result") return original<T>(method, params);
    return {
      ...engine.result(),
      receipt: {
        status: "partial",
        resume_request: { query: "PRIVATE-RESUME-SQL" },
        provider_events: [
          {
            kind: "embedding",
            status: "failed",
            raw: "PRIVATE-HTTP-BODY",
            failure: { message: "PRIVATE-FAILURE" },
          },
        ],
      },
      cell_diagnostics: [
        {
          diagnostic_id: "d_one",
          row_id: "row_1",
          column_key: "value",
          value_path: [],
          operator: "SEM_EXTRACT",
          status: "not_stated",
          reason: "not_stated_in_inspected_evidence",
          source_version_id: null,
          inspected_windows: [],
          input_omitted_characters: 0,
          raw: "PRIVATE-DIAGNOSTIC",
        },
        {
          diagnostic_id: "d_other_page",
          row_id: "row_2",
          column_key: "value",
          value_path: [],
          operator: "SEM_EXTRACT",
          status: "unknown",
          reason: "unknown",
        },
      ],
      research_quality: {
        goal_status: "partial",
        required_cells: 1,
        unresolved_cells: 1,
        row_shortfall: 0,
        gaps: [{ row_id: "row_1", column_key: "value", status: "not_stated" }],
        gaps_total: 1,
        gaps_omitted: 0,
        complete: false,
        scope: "declared_cells_and_minimum_rows",
        factual_truth_verified: false,
        raw: "PRIVATE-QUALITY",
      },
    } as T;
  };
  const session = await connect(engine);
  try {
    const response = await session.client.callTool({
      name: "sourcesql_inspect_evidence",
      arguments: { result_id: "wq_job_result" },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    const result = response.structuredContent as Record<string, any>;
    assert.equal(result.cell_diagnostics.length, 1);
    assert.equal(result.cell_diagnostics[0].status, "not_stated");
    assert.equal(result.cell_diagnostics[0].row_id, "row_1");
    assert.equal(result.research_quality.goal_status, "partial");
    assert.deepEqual(result.receipt.provider_events, [
      { kind: "embedding", status: "failed" },
    ]);
    assert.equal(result.receipt.resume_request, undefined);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE-/);
  } finally {
    await session.close();
  }
});

test("run continuation applies anonymous profile and private-disclosure checks before effects", async () => {
  for (const access of [
    {
      mode: "fixture-anonymous",
      principal: "anonymous",
      allowPrivateDisclosure: false,
    },
    { mode: "protected", principal: "owner", allowPrivateDisclosure: false },
  ] as const) {
    const engine = new JobEngine();
    let effects = 0;
    const original = engine.call.bind(engine);
    engine.call = async <T>(
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      if (method === "run_status")
        return {
          run_id: params.run_id,
          status: "failed",
          settlement_status: "settled",
          data_classification:
            access.mode === "protected"
              ? "private_derived"
              : "synthetic_fixture",
          resume_request: { profile: "not-a-fixture" },
        } as T;
      if (method === "resume_run") {
        effects++;
        throw new Error("Must not dispatch");
      }
      return original<T>(method, params);
    };
    const session = await connect(engine, access);
    try {
      const response = await session.client.callTool({
        name: "sourcesql_resume_run",
        arguments: { run_id: "run_failed", request_id: randomUUID() },
      });
      assert.equal(response.isError, true);
      assert.equal(effects, 0);
    } finally {
      await session.close();
    }
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

test("open_research renders a saved capacity notice without searching, resuming, or importing a table", async () => {
  class CapacityEngine extends JobEngine {
    receipt(jobId: string, requestId: string) {
      return {
        ...super.receipt(jobId, requestId),
        can_resume: false,
        capacity: {
          resource: "flight_compute",
          reason: "operator_limit",
          period: "day",
          allowance: "configured",
          resets_at: "2026-10-17T00:00:00Z",
          limit: 1200,
          used: 1200,
          unit: "seconds",
        },
        dispatch_blocked: {
          code: "budget_exhausted",
          message: "Configured application capacity is exhausted",
        },
        request_json: "private query text must remain absent from the widget",
      };
    }
  }
  const engine = new CapacityEngine();
  const session = await connect(engine, {
    mode: "protected",
    principal: "owner-a",
    allowPrivateDisclosure: false,
  });
  try {
    const submitted = await session.client.callTool({
      name: "sourcesql_query",
      arguments: args(),
    });
    const receipt = submitted.structuredContent as Record<string, unknown>;
    const before = engine.calls.length;
    const opened = await session.client.callTool({
      name: "open_research",
      arguments: { job_id: receipt.job_id },
    });
    assert.equal(opened.isError, undefined);
    const view = opened.structuredContent as {
      kind: string;
      job: Record<string, unknown>;
    };
    assert.equal(view.kind, "research_job_status");
    assert.equal(view.job.job_id, receipt.job_id);
    assert.equal(view.job.request_id, receipt.request_id);
    assert.deepEqual(view.job.capacity, receipt.capacity);
    assert.equal(view.job.can_resume, false);
    assert.equal(view.job.result_id, undefined);
    assert.equal(view.job.pending, true);
    assert.deepEqual(
      engine.calls.slice(before).map((call) => call.method),
      ["job_status"],
    );
    assert.equal(engine.queryCalls, 1);
    assert.equal(engine.dispatches, 1);
    assert.doesNotMatch(JSON.stringify(opened), /private query text/);
    const invalid = await session.client.callTool({
      name: "open_research",
      arguments: { job_id: receipt.job_id, snapshot_id: "unrelated-table" },
    });
    assert.equal(invalid.isError, true);
    engine.state = "completed";
    engine.privateResult = true;
    const hidden = await session.client.callTool({
      name: "open_research",
      arguments: { job_id: receipt.job_id },
    });
    assert.equal(hidden.isError, true);
    assert.equal(hidden.structuredContent, undefined);
    assert.doesNotMatch(JSON.stringify(hidden), /wq_job_result|synthetic/);
  } finally {
    await session.close();
  }
});
