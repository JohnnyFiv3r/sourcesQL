import { WORKER_FEATURE_CONTRACTS } from "../server/feature-contracts.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import {
  MotherDuckEngine,
  MotherDuckStateBackend,
  createMotherDuckBackend,
  BackendError,
  type SqlClient,
} from "../server/motherduck.js";
import {
  exaConfiguration,
  exaFingerprint,
  type HostedExaPolicy,
} from "../server/hosted-exa.js";
import {
  HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS,
  hostedSearchConfiguration,
  hostedSearchFingerprint,
  hostedSearchOperators,
  type HostedSearchPolicy,
} from "../server/hosted-search.js";
import { ResearchStore } from "../server/store.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { snapshotSchema, effectiveValue } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

type Row = Record<string, any>;
const seed = snapshotSchema.parse(sample);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const python =
  process.env.SOURCESQL_TEST_PYTHON ??
  process.env.SOURCESQL_PYTHON ??
  join(root, "local/python312/venv/bin/python");
const flightId = "0a111111-1111-4111-a111-111111111111";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const reviewedSourceHash = digest("synthetic reviewed Flight source");
const reviewedRequirementsHash = digest("synthetic pinned Flight dependencies");
const query = (requestId: string = randomUUID()) => ({
  request_id: requestId,
  query: "SELECT 1 AS value",
  profile: "fixture",
});

class LocalSqlServer {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<
    string,
    { resolve: (rows: Row[]) => void; reject: (error: Error) => void }
  >();
  ready: Promise<void>;
  constructor(directory: string) {
    this.child = spawn(
      python,
      [
        fileURLToPath(
          new URL("./helpers/motherduck-sql-server.py", import.meta.url),
        ),
        join(directory, "storage.duckdb"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: directory,
          TMPDIR: directory,
          PYTHONDONTWRITEBYTECODE: "1",
          OPENBLAS_NUM_THREADS: "1",
          OMP_NUM_THREADS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(new Error("Local DuckDB test server unavailable"));
      }, 10000);
      this.child.on("error", reject);
      const lines = createInterface({ input: this.child.stdout });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error)
          waiter.reject(
            Object.assign(new Error(message.error.message), {
              code: message.error.code,
              sqlErrorType: message.error.type,
            }),
          );
        else waiter.resolve(message.rows);
      });
      this.child.stderr.on("data", () => {});
      this.child.on("close", () => {
        clearTimeout(deadline);
        reject(new Error("Local DuckDB test server closed"));
        for (const waiter of this.pending.values())
          waiter.reject(new Error("Local DuckDB test server closed"));
        this.pending.clear();
      });
    });
  }
  async request(
    connectionId: string,
    operation: string,
    sql?: string,
    values?: unknown[],
  ): Promise<Row[]> {
    await this.ready;
    const id = randomUUID();
    const result = new Promise<Row[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(
      JSON.stringify({
        id,
        connection_id: connectionId,
        operation,
        sql,
        values,
      }) + "\n",
    );
    return result;
  }
  async close() {
    const closed = new Promise<void>((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.stdin.end();
    await closed;
  }
}
class Harness {
  sql: LocalSqlServer;
  runs: Row[] = [];
  submissions = 0;
  inspections = 0;
  cancellations = 0;
  definitionsRead = 0;
  flightVersion = 7;
  scheduleCron: string | null = null;
  definitionPatch: Row = {};
  flightConfig: Row = {};
  flightSecrets: string[] = [];
  statements: string[] = [];
  returnedRows: Row[][] = [];
  runAckPatch: Row = {};
  resultLookups = new Map<string, number>();
  loseSubmissionResponse = false;
  loseCommitResponse = false;
  loseCancellationResponse = false;
  runNumber = "9007199254740993";
  constructor(public directory: string) {
    this.sql = new LocalSqlServer(directory);
  }
  engine(
    principal = "owner-a",
    options: {
      allowSubmission?: boolean;
      dailySeconds?: number;
      monthlySeconds?: number;
      monthlyProviderCostMicrousd?: number;
      usageMode?: "provider_managed" | "operator_reserved";
      exa?: HostedExaPolicy;
      search?: HostedSearchPolicy;
    } = {},
  ) {
    const namespace = digest(principal),
      schema = "sourcesql_" + namespace.slice(0, 32);
    return new MotherDuckEngine({
      database: "synthetic",
      host: "pg.us-east-1-aws.motherduck.com",
      token: "synthetic-unused-token",
      flightId,
      principal,
      allowSubmission: options.allowSubmission ?? false,
      dailySeconds: options.dailySeconds,
      monthlySeconds: options.monthlySeconds,
      monthlyProviderCostMicrousd: options.monthlyProviderCostMicrousd,
      usageMode: options.usageMode ?? "provider_managed",
      sourceSha256: reviewedSourceHash,
      requirementsSha256: reviewedRequirementsHash,
      exa: options.exa,
      search: options.search,
      clientFactory: () => this.client(namespace, schema),
    });
  }
  client(namespace: string, schema: string): SqlClient {
    const connectionId = randomUUID();
    return {
      connect: async () => {
        await this.sql.request(connectionId, "connect");
      },
      end: async () => {
        await this.sql.request(connectionId, "end");
      },
      query: async (sql, values = []) => {
        this.statements.push(sql);
        if (sql.includes("md_get_flight(")) {
          this.definitionsRead++;
          return {
            rows: [
              {
                current_version: this.flightVersion,
                schedule_cron: this.scheduleCron,
              },
            ],
          };
        }
        if (sql.includes("md_get_flight_version(")) {
          this.definitionsRead++;
          return {
            rows: [
              {
                instance_type: "F4",
                max_runtime_sec: 120,
                contracts_literal: JSON.stringify(
                  JSON.stringify(WORKER_FEATURE_CONTRACTS),
                ),
                source_hash: reviewedSourceHash,
                requirements_hash: reviewedRequirementsHash,
                secrets_json: JSON.stringify(this.flightSecrets),
                config_json: JSON.stringify({
                  JOB_ID: "",
                  NAMESPACE: namespace,
                  STORAGE_SCHEMA: schema,
                  DATABASE: "synthetic",
                  ...this.flightConfig,
                }),
                ...this.definitionPatch,
              },
            ],
          };
        }
        if (sql.includes("md_run_flight(")) {
          this.submissions++;
          const jobId = sql.match(/'JOB_ID':\s*'([a-f0-9-]+)'/)?.[1];
          assert.ok(jobId);
          const run = {
            run_id: randomUUID(),
            flight_id: flightId,
            flight_version: this.flightVersion,
            run_number: this.runNumber,
            status: "RUN_STATUS_RUNNING",
            exit_code: null,
            config_json: JSON.stringify({
              JOB_ID: jobId,
              NAMESPACE: namespace,
              STORAGE_SCHEMA: schema,
              DATABASE: "synthetic",
              ...this.flightConfig,
            }),
            ...this.runAckPatch,
          };
          this.runs.push(run);
          if (this.loseSubmissionResponse)
            throw Object.assign(
              new Error("Synthetic lost submission response"),
              { code: "08006" },
            );
          return { rows: [run] };
        }
        if (
          sql.includes("md_list_flight_runs(") ||
          sql.includes("md_get_flight_run(")
        ) {
          this.inspections++;
          return {
            rows: this.runs.filter(
              (run) => JSON.parse(run.config_json).NAMESPACE === namespace,
            ),
          };
        }
        if (sql.includes("md_cancel_flight_run(")) {
          this.cancellations++;
          if (this.loseCancellationResponse)
            throw Object.assign(
              new Error("Synthetic lost cancellation response"),
              { code: "08006" },
            );
          return { rows: [] };
        }
        if (
          /^\s*SELECT\b/i.test(sql) &&
          sql.includes(`FROM "${schema}"."results" WHERE id=`) &&
          typeof values[0] === "string"
        )
          this.resultLookups.set(
            values[0],
            (this.resultLookups.get(values[0]) ?? 0) + 1,
          );
        const rows = await this.sql.request(connectionId, "query", sql, values);
        this.returnedRows.push(rows);
        if (sql === "COMMIT" && this.loseCommitResponse) {
          this.loseCommitResponse = false;
          throw Object.assign(new Error("Synthetic lost commit response"), {
            code: "08006",
          });
        }
        return { rows };
      },
    };
  }
  async close() {
    await this.sql.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}
async function harness() {
  const value = new Harness(
    await mkdtemp(join(tmpdir(), "sourcesql-native-md-")),
  );
  await value.sql.ready;
  return value;
}
async function publish(
  engine: MotherDuckEngine,
  id: string,
  options: {
    classification?: string;
    parents?: Row[];
    jobId?: string;
    output?: Row;
    rows?: Row[];
    partial?: boolean;
  } = {},
) {
  const columns = [
    { key: "value", label: "Value", logical_type: "BIGINT", nullable: false },
  ];
  const rows = options.rows ?? [{ value: "9007199254740993" }];
  const payload = JSON.stringify({ columns, rows }),
    hash = digest(payload),
    runId = "run_" + randomUUID().replaceAll("-", "");
  const receipt = {
    run_id: runId,
    request_id: randomUUID(),
    status: options.partial ? "partial" : "completed",
    result_id: id,
    finished_at: "2026-10-14T16:00:00Z",
    receipt_revision: 1,
    parents: options.parents ?? [],
    data_classification: options.classification ?? "synthetic_fixture",
  };
  const metadata = {
    result_id: id,
    run_id: runId,
    content_sha256: hash,
    columns,
    row_count: rows.length,
    row_ids: rows.map((_, index) => "row_" + index),
    parents: options.parents ?? [],
    data_classification: options.classification ?? "synthetic_fixture",
    receipt,
  };
  await engine.transaction(true, async (client) => {
    await client.query(
      `INSERT INTO ${engine.table("runs")} VALUES($1,$2,$3,$4)`,
      [
        runId,
        receipt.request_id,
        digest(receipt.request_id),
        JSON.stringify(receipt),
      ],
    );
    await client.query(
      `INSERT INTO ${engine.table("results")} VALUES($1,$2,$3,0,$4,$4,$2)`,
      [id, hash, JSON.stringify(metadata), payload],
    );
    if (options.jobId)
      await client.query(
        `UPDATE ${engine.table("jobs")} SET status='completed',result_id=$1,engine_run_id=$2,output_json=$3 WHERE id=$4::UUID`,
        [
          id,
          runId,
          options.output ? JSON.stringify(options.output) : null,
          options.jobId,
        ],
      );
  });
  return metadata;
}

test("native SQL storage reopens typed BIGINT pages in new connections and isolates principals", async () => {
  const h = await harness();
  try {
    const owner = h.engine(),
      other = h.engine("owner-b");
    await owner.initialize();
    await other.initialize();
    await publish(owner, "wq_persisted", {
      rows: Array.from({ length: 205 }, (_, index) => ({
        value: String(9007199254740993n + BigInt(index)),
      })),
    });
    const reopened = h.engine();
    const page = await reopened.readResult({
      result_id: "wq_persisted",
      offset: 200,
      limit: 3,
    });
    assert.equal(page.row_count, 205);
    assert.deepEqual(
      page.rows.map((row) => row.value),
      ["9007199254741193", "9007199254741194", "9007199254741195"],
    );
    assert.equal(page.next_offset, 203);
    assert.equal(page.receipt.status, "completed");
    await assert.rejects(other.readResult({ result_id: "wq_persisted" }), {
      code: "unauthorized",
    });
    const ownedJob = await owner.call<Row>("query", query());
    await assert.rejects(
      other.call("job_status", { job_id: ownedJob.job_id }),
      { code: "not_found" },
    );
    await assert.rejects(
      other.call("cancel_job", { job_id: ownedJob.job_id }),
      { code: "not_found" },
    );
    await assert.rejects(
      owner.call("query", { ...query(), namespace: other.namespace }),
      { code: "invalid_request" },
    );
    await assert.rejects(
      reopened.readResult({
        result_id: "wq_persisted",
        columns: ["not_a_column"],
      }),
      { code: "invalid_request" },
    );
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("native SQL durable app state CAS retains history and recovers a lost correction commit", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const backend = new MotherDuckStateBackend(engine);
    const store = () =>
      new ResearchStore("/unused", seed, undefined, 3000, {
        backend: new MotherDuckStateBackend(h.engine()),
      });
    const amendment = {
      snapshot_id: seed.id,
      row_id: seed.rows[0].id,
      field: "closes_at",
      value: null,
      expected_revision: 0,
      mutation_id: randomUUID(),
    };
    h.loseCommitResponse = true;
    await assert.rejects(store().amend(amendment), {
      code: "storage_unavailable",
    });
    const recovered = await store().amend(amendment);
    assert.equal(recovered.revision, 1);
    assert.equal(
      effectiveValue(recovered, recovered.snapshot.rows[0], "closes_at"),
      null,
    );
    assert.equal((await backend.read()).version, "1");
    await assert.rejects(
      backend.write({ snapshots: [seed], amendments: [] }, "0"),
      { code: "revision_conflict" },
    );
    await store().rename({
      snapshot_id: seed.id,
      expected_title: seed.title,
      title: "Durable title",
    });
    const history = await engine.connection((client) =>
      client.query(
        `SELECT CAST(revision AS VARCHAR) AS revision,state_json FROM ${engine.table("app_state_history")} ORDER BY revision`,
      ),
    );
    assert.deepEqual(
      history.rows.map((row) => row.revision),
      ["1", "2"],
    );
    assert.equal(JSON.parse(history.rows[0].state_json).titles, undefined);
    assert.equal(
      JSON.parse(history.rows[1].state_json).titles[seed.id],
      "Durable title",
    );
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("concurrent native SQL request writers recover one durable identity without duplicate Flight submission", async () => {
  const h = await harness();
  try {
    const first = h.engine("owner-a", { allowSubmission: true }),
      second = h.engine("owner-a", { allowSubmission: true });
    await first.initialize();
    const request = query();
    const outcomes = await Promise.allSettled([
      first.call<Row>("query", request),
      second.call<Row>("query", request),
    ]);
    assert.ok(outcomes.some((outcome) => outcome.status === "fulfilled"));
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        assert.equal(outcome.reason.code, "storage_conflict");
    const retry = await second.call<Row>("query", {
      profile: "fixture",
      query: request.query,
      request_id: request.request_id,
    });
    const accepted = outcomes.find(
      (outcome) => outcome.status === "fulfilled",
    ) as PromiseFulfilledResult<Row>;
    assert.equal(retry.job_id, accepted.value.job_id);
    assert.equal(h.submissions, 1);
    await assert.rejects(
      second.call("query", { ...request, query: "SELECT 2 AS value" }),
      { code: "idempotency_conflict" },
    );
    const jobs = await first.connection((client) =>
      client.query(
        `SELECT count(*)::INTEGER AS count FROM ${first.table("jobs")}`,
      ),
    );
    assert.equal(jobs.rows[0].count, 1);
  } finally {
    await h.close();
  }
});

test("concurrent durable corrections accept one revision without overwriting its history", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const inputs = [null, "2026-10-08 15:00:00"].map((value) => ({
      snapshot_id: seed.id,
      row_id: seed.rows[0].id,
      field: "closes_at",
      value,
      expected_revision: 0,
      mutation_id: randomUUID(),
    }));
    const store = () =>
      new ResearchStore("/unused", seed, undefined, 3000, {
        backend: new MotherDuckStateBackend(h.engine()),
      });
    const outcomes = await Promise.allSettled(
      inputs.map((input) => store().amend(input)),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const reopened = await store().open();
    assert.equal(reopened.amendments.length, 1);
    assert.equal(reopened.revision, 1);
    const winner = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    assert.equal(
      effectiveValue(reopened, reopened.snapshot.rows[0], "closes_at"),
      inputs[winner].value,
    );
    await assert.rejects(store().amend(inputs[1 - winner]), /changed.*Reload/i);
    const history = await engine.connection((client) =>
      client.query(
        `SELECT count(*)::INTEGER AS count FROM ${engine.table("app_state_history")}`,
      ),
    );
    assert.equal(history.rows[0].count, 1);
  } finally {
    await h.close();
  }
});

test("lost submission response recovers exact UBIGINT run identity without dispatching again", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    h.loseSubmissionResponse = true;
    const request = query();
    const submitted = await engine.call<Row>("query", request);
    assert.equal(submitted.status, "submission_unknown");
    const reopened = h.engine("owner-a", { allowSubmission: true });
    const inspected = await reopened.call<Row>("job_status", {
      job_id: submitted.job_id,
    });
    assert.equal(inspected.status, "submission_unknown");
    const row = (
      await reopened.connection((client) =>
        client.query(
          `SELECT CAST(flight_run_number AS VARCHAR) AS number FROM ${reopened.table("jobs")} WHERE id=$1::UUID`,
          [submitted.job_id],
        ),
      )
    ).rows[0];
    assert.equal(row.number, "9007199254740993");
    await reopened.call("query", request);
    await reopened.call("start_job", { job_id: submitted.job_id });
    await reopened.call("job_status", { job_id: submitted.job_id });
    assert.equal(h.submissions, 1);
    assert.ok(h.inspections >= 2);
  } finally {
    await h.close();
  }
});

test("queued cancellation is durable and refuses later dispatch", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const queued = await engine.call<Row>("query", query());
    assert.equal(queued.status, "queued");
    const cancelled = await engine.call<Row>("cancel_job", {
      job_id: queued.job_id,
    });
    assert.equal(cancelled.status, "cancelled");
    const submitter = h.engine("owner-a", { allowSubmission: true });
    assert.equal(
      (await submitter.call<Row>("start_job", { job_id: queued.job_id }))
        .status,
      "cancelled",
    );
    assert.equal(h.submissions, 0);
    const rows = (
      await engine.connection((client) =>
        client.query(
          `SELECT count(*)::INTEGER AS count FROM ${engine.table("flight_allowances")}`,
        ),
      )
    ).rows;
    assert.equal(rows[0].count, 0);
  } finally {
    await h.close();
  }
});

test("ambiguous platform recovery stays unknown and retains the single active slot", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    h.loseSubmissionResponse = true;
    const first = await engine.call<Row>("query", query());
    h.runs.push({
      ...h.runs[0],
      run_id: randomUUID(),
      run_number: "9007199254740994",
    });
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: first.job_id })).status,
      "submission_unknown",
    );
    const stored = (
      await engine.connection((client) =>
        client.query(
          `SELECT CAST(flight_run_number AS VARCHAR) AS number FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [first.job_id],
        ),
      )
    ).rows[0];
    assert.equal(
      stored.number,
      null,
      "Multiple run matches must not pick the first",
    );
    const next = await engine.call<Row>("query", query());
    assert.equal(next.status, "queued");
    assert.equal(h.submissions, 1);
  } finally {
    await h.close();
  }
});

test("known running status polls leave the durable writer revision unchanged", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const submitted = await engine.call<Row>("query", query());
    const revision = async () =>
      (
        await engine.connection((client) =>
          client.query(
            `SELECT CAST(revision AS VARCHAR) AS revision FROM ${engine.table("control")} WHERE id=1`,
          ),
        )
      ).rows[0].revision;
    const before = await revision();
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: submitted.job_id }))
        .status,
      submitted.status,
    );
    assert.equal(
      (await h.engine().call<Row>("job_status", { job_id: submitted.job_id }))
        .status,
      submitted.status,
    );
    assert.equal(
      await revision(),
      before,
      "Read-only known-running polls must not conflict with concurrent app writers",
    );
    assert.equal(h.submissions, 1);
    h.runs[0].status = "RUN_STATUS_SUCCEEDED";
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: submitted.job_id }))
        .status,
      "failed",
      "A stopped Flight without durable output is reconciled, never fabricated as completed",
    );
    const settled = await revision();
    assert.ok(BigInt(settled) > BigInt(before));
    await engine.call("job_status", { job_id: submitted.job_id });
    assert.equal(
      await revision(),
      settled,
      "A settled status is not rewritten on subsequent reads",
    );
  } finally {
    await h.close();
  }
});

test("uncertain submission retains the active slot without accumulating runtime reservations", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      dailySeconds: 120,
    });
    await engine.initialize();
    h.loseSubmissionResponse = true;
    const first = await engine.call<Row>("query", query());
    const second = await engine.call<Row>("query", query());
    assert.equal(first.status, "submission_unknown");
    assert.equal(second.status, "queued");
    assert.equal(h.submissions, 1);
    const reserve = await engine.connection((client) =>
      client.query(
        `SELECT CAST(reserved_seconds AS VARCHAR) AS seconds FROM ${engine.table("flight_allowances")}`,
      ),
    );
    assert.deepEqual(reserve.rows, []);
    h.runs[0].status = "RUN_STATUS_FAILED";
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: first.job_id })).status,
      "failed",
    );
    h.loseSubmissionResponse = false;
    await engine.call("start_job", { job_id: second.job_id });
    assert.equal(h.submissions, 2);
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: second.job_id })).status,
      "dispatching",
    );
  } finally {
    await h.close();
  }
});

test("uncertain running cancellation keeps the active slot until platform stop is observed", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const first = await engine.call<Row>("query", query());
    h.loseCancellationResponse = true;
    const cancelled = await engine.call<Row>("cancel_job", {
      job_id: first.job_id,
    });
    assert.equal(cancelled.cancellation_requested, true);
    assert.equal(
      cancelled.pending,
      true,
      "Unacknowledged cancellation must retain execution ownership",
    );
    const second = await engine.call<Row>("query", query());
    assert.equal(second.status, "queued");
    assert.equal(
      h.submissions,
      1,
      "A still-running cancelled Flight must retain the single active slot",
    );
    h.runs[0].status = "RUN_STATUS_CANCELLED";
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: first.job_id })).status,
      "cancelled",
    );
    assert.equal(
      h.submissions,
      1,
      "Status inspection must not dispatch the queued job",
    );
    await engine.call("start_job", { job_id: second.job_id });
    assert.equal(h.submissions, 2);
  } finally {
    await h.close();
  }
});

test("changed Flight definition is refused before dispatch intent or allowance reservation", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const correctConfig = {
      JOB_ID: "",
      NAMESPACE: engine.namespace,
      STORAGE_SCHEMA: engine.schema,
      DATABASE: "synthetic",
    };
    const patches = [
      { instance_type: "F16" },
      { max_runtime_sec: 121 },
      { source_hash: "f".repeat(64) },
      { requirements_hash: "f".repeat(64) },
      {
        config_json: JSON.stringify({
          ...correctConfig,
          NAMESPACE: "f".repeat(64),
        }),
      },
      {
        config_json: JSON.stringify({
          ...correctConfig,
          STORAGE_SCHEMA: "another_schema",
        }),
      },
      {
        config_json: JSON.stringify({
          ...correctConfig,
          DATABASE: "another_database",
        }),
      },
      { config_json: JSON.stringify({ ...correctConfig, JOB_ID: undefined }) },
    ];
    for (const patch of patches) {
      h.definitionPatch = patch;
      await assert.rejects(engine.call("query", query()), {
        code: "unsupported_capability",
      });
    }
    h.definitionPatch = {};
    h.scheduleCron = "* * * * *";
    await assert.rejects(engine.call("query", query()), {
      code: "unsupported_capability",
    });
    const intents = (
      await engine.connection((client) =>
        client.query(
          `SELECT count(*)::INTEGER AS count FROM ${engine.table("jobs")} WHERE dispatch_intent_at IS NOT NULL`,
        ),
      )
    ).rows;
    const reserve = (
      await engine.connection((client) =>
        client.query(
          `SELECT count(*)::INTEGER AS count FROM ${engine.table("flight_allowances")}`,
        ),
      )
    ).rows;
    assert.equal(intents[0].count, 0);
    assert.equal(reserve[0].count, 0);
    assert.equal(h.submissions, 0);
    assert.ok(h.definitionsRead > 0);
  } finally {
    await h.close();
  }
});

test("published results reopen immediately while the finishing Flight retains execution capacity", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const first = await engine.call<Row>("query", query());
    await publish(engine, "wq_published", { jobId: first.job_id });
    const ready = await engine.call<Row>("job_status", {
      job_id: first.job_id,
    });
    assert.equal(ready.status, "completed");
    assert.equal(
      ready.pending,
      false,
      "Stored results are ready before the platform finishes cleanup",
    );
    assert.equal(
      (await h.engine().readResult({ result_id: ready.result_id })).rows[0]
        .value,
      "9007199254740993",
    );
    const second = await engine.call<Row>("query", query());
    assert.equal(second.status, "queued");
    assert.equal(h.submissions, 1);
    h.runs[0].status = "RUN_STATUS_SUCCEEDED";
    await engine.call("job_status", { job_id: first.job_id });
    assert.equal(
      h.submissions,
      1,
      "Reconciliation does not run the queued job",
    );
    await engine.call("start_job", { job_id: second.job_id });
    assert.equal(h.submissions, 2);
  } finally {
    await h.close();
  }
});

test("lost-response recovery refuses a run with changed reviewed owner context", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    h.loseSubmissionResponse = true;
    const first = await engine.call<Row>("query", query());
    const original = JSON.parse(h.runs[0].config_json);
    for (const patch of [
      { STORAGE_SCHEMA: "other_schema" },
      { DATABASE: "other_database" },
    ]) {
      h.runs[0].config_json = JSON.stringify({ ...original, ...patch });
      await assert.rejects(
        engine.call("job_status", { job_id: first.job_id }),
        { code: "unauthorized" },
      );
    }
    h.runs[0].config_json = JSON.stringify(original);
    h.runs[0].flight_version++;
    await assert.rejects(engine.call("job_status", { job_id: first.job_id }), {
      code: "unauthorized",
    });
    assert.equal(h.submissions, 1);
  } finally {
    await h.close();
  }
});

test("a known mismatched Flight run is cancelled and retains capacity until settled", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    h.runAckPatch = { flight_version: h.flightVersion + 1 };
    h.loseCancellationResponse = true;
    const failed = await engine.call<Row>("query", query());
    assert.equal(failed.status, "failed");
    assert.equal(failed.result_id, undefined);
    assert.equal(
      h.cancellations,
      1,
      "A known run from an unreviewed version receives cancellation",
    );
    const stored = (
      await engine.connection((client) =>
        client.query(
          `SELECT flight_invalid,flight_settled FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [failed.job_id],
        ),
      )
    ).rows[0];
    assert.equal(stored.flight_invalid, true);
    assert.equal(stored.flight_settled, false);
    h.runAckPatch = {};
    const queued = await engine.call<Row>("query", query());
    assert.equal(queued.status, "queued");
    assert.equal(h.submissions, 1);
    h.runs[0].status = "RUN_STATUS_CANCELLED";
    await engine.call("job_status", { job_id: failed.job_id });
    assert.equal(h.submissions, 1);
    await engine.call("start_job", { job_id: queued.job_id });
    assert.equal(h.submissions, 2);
  } finally {
    await h.close();
  }
});

test("uppercase UUIDs recover the same request and rotated Flight configuration cannot dispatch queued work", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const requestId = "ABCDEFAB-ABCD-4BCD-ABCD-ABCDEFABCDEF";
    const first = await engine.call<Row>("query", query(requestId));
    const second = await engine.call<Row>(
      "query",
      query(requestId.toLowerCase()),
    );
    assert.equal(first.job_id, second.job_id);
    assert.equal(first.request_id, requestId.toLowerCase());
    assert.equal(
      (
        await engine.call<Row>("job_status", {
          job_id: first.job_id.toUpperCase(),
        })
      ).job_id,
      first.job_id,
    );
    const rotated = new MotherDuckEngine({
      ...engine.options,
      flightId: randomUUID(),
      allowSubmission: true,
    });
    await assert.rejects(
      rotated.call("start_job", { job_id: first.job_id.toUpperCase() }),
      { code: "unsupported_capability" },
    );
    assert.equal(h.definitionsRead, 0);
    assert.equal(h.submissions, 0);
    const normalized = new MotherDuckEngine({
      ...engine.options,
      flightId: flightId.toUpperCase(),
    });
    assert.equal(normalized.options.flightId, flightId);
    assert.equal(
      (
        await normalized.call<Row>("cancel_job", {
          job_id: first.job_id.toUpperCase(),
        })
      ).status,
      "cancelled",
    );
  } finally {
    await h.close();
  }
});

test("retained result tampering and revoked/private ancestors block reads, exports and completed handles", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const parent = await publish(engine, "wq_parent");
    const queued = await engine.call<Row>("query", query());
    await publish(engine, "wq_child", {
      parents: [
        { result_id: parent.result_id, content_sha256: parent.content_sha256 },
      ],
      jobId: queued.job_id,
      partial: true,
    });
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: queued.job_id })).status,
      "completed",
    );
    assert.equal(
      (await engine.readResult({ result_id: "wq_child" })).receipt.status,
      "partial",
    );
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET wire_payload='tampered' WHERE id='wq_child'`,
      ),
    );
    await assert.rejects(engine.readResult({ result_id: "wq_child" }), {
      code: "evidence_invalid",
    });
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET wire_payload=payload WHERE id='wq_child'`,
      ),
    );
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET revoked=1 WHERE id='wq_parent'`,
      ),
    );
    await assert.rejects(engine.call("export", { result_id: "wq_child" }), {
      code: "unauthorized",
    });
    await assert.rejects(engine.call("job_status", { job_id: queued.job_id }), {
      code: "unauthorized",
    });
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET revoked=0,metadata=json_merge_patch(metadata::JSON,'{"data_classification":"private_local"}')::VARCHAR WHERE id='wq_parent'`,
      ),
    );
    await assert.rejects(engine.readResult({ result_id: "wq_child" }), {
      code: "unauthorized",
    });
  } finally {
    await h.close();
  }
});

test("shared dependency DAGs load each ancestor once per read and still reject cycles or later revocation", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const a = await publish(engine, "wq_shared_a"),
      b = await publish(engine, "wq_shared_b");
    const pin = (entry: Row) => ({
      result_id: entry.result_id,
      content_sha256: entry.content_sha256,
    });
    const left = await publish(engine, "wq_shared_left", {
      parents: [pin(a), pin(b)],
    });
    const right = await publish(engine, "wq_shared_right", {
      parents: [pin(b), pin(a)],
    });
    const top = await publish(engine, "wq_shared_root", {
      parents: [pin(left), pin(right), pin(a)],
    });
    h.resultLookups.clear();
    assert.equal(
      (await engine.readResult({ result_id: top.result_id })).rows.length,
      1,
    );
    assert.deepEqual(
      [...h.resultLookups.keys()].sort(),
      [a, b, left, right, top].map((entry) => entry.result_id).sort(),
    );
    assert.ok(
      [...h.resultLookups.values()].every((count) => count === 1),
      "Shared ancestors are authorized once within this actual SQL read transaction",
    );
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET revoked=1 WHERE id=$1`,
        [a.result_id],
      ),
    );
    await assert.rejects(engine.readResult({ result_id: top.result_id }), {
      code: "unauthorized",
    });
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET revoked=0,metadata=json_merge_patch(metadata::JSON,$1::JSON)::VARCHAR WHERE id=$2`,
        [JSON.stringify({ parents: [pin(top)] }), a.result_id],
      ),
    );
    await assert.rejects(engine.readResult({ result_id: top.result_id }), {
      code: "evidence_invalid",
    });
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("provider-free imports deduplicate reordered payloads and resolve completed canonical identities", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const table = {
      rows: [{ value: "9007199254740993" }],
      columns: [{ key: "value", logical_type: "BIGINT", nullable: false }],
      data_classification: "synthetic_fixture",
    };
    const first = await engine.call<Row>("import_table", table);
    const reordered = await engine.call<Row>("import_table", {
      columns: table.columns,
      data_classification: table.data_classification,
      rows: table.rows,
    });
    assert.equal(first.job_id, reordered.job_id);
    assert.equal(first.status, "queued");
    await publish(engine, "wq_table", { jobId: first.job_id });
    const ready = await h.engine().call<Row>("import_table", table);
    assert.equal(ready.result_id, "wq_table");
    assert.equal(ready.rows[0].value, "9007199254740993");
    const bundle = { bundle: { format: "synthetic-test-only", values: ["a"] } };
    const pendingBundle = await engine.call<Row>("import", bundle);
    await publish(engine, "wq_bundle", {
      jobId: pendingBundle.job_id,
      output: { result_mapping: { wq_foreign: "wq_bundle" } },
    });
    const restored = await engine.call<Row>("import", bundle);
    assert.deepEqual(restored.result_mapping, { wq_foreign: "wq_bundle" });
    assert.equal(restored.result_id, "wq_bundle");
    const jobs = (
      await engine.connection((client) =>
        client.query(
          `SELECT count(*)::INTEGER AS count FROM ${engine.table("jobs")}`,
        ),
      )
    ).rows;
    assert.equal(jobs[0].count, 2);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

const exaPolicy = (dailyCostMicrousd = 1_000_000): HostedExaPolicy => ({
  approvedCostMicrousd: 50_000,
  dailyCostMicrousd,
  secretName: "sourcesql_exa",
  policyVersion: "exa-research.v2",
});
const liveQuery = (requestId = randomUUID()) => ({
  ...query(requestId),
  profile: "exa",
  query: "SELECT title,url FROM WEB_SEARCH('public research')",
});

test("existing Auto Flight keeps its exact v1 policy and limits without enabling deeper profiles", async () => {
  const h = await harness();
  try {
    const { policyVersion: _, ...legacy } = exaPolicy();
    // This descriptor digest is the preexisting Flight contract, independent of
    // the new three-profile v2 descriptor and its optional environment marker.
    assert.equal(
      exaFingerprint(legacy),
      "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004",
    );
    h.flightConfig = {
      SOURCESQL_ALLOW_LIVE_EXA: "1",
      SOURCESQL_EXA_APPROVED_COST_MICROUSD: "50000",
      SOURCESQL_EXA_SECRET_NAME: "sourcesql_exa",
    };
    h.flightSecrets = ["sourcesql_exa"];
    const engine = h.engine("owner-a", { exa: legacy, allowSubmission: true });
    await engine.initialize();
    const capabilities = await engine.call<Row>("capabilities");
    const live = capabilities.profiles.filter((p: Row) => p.mode === "live");
    assert.deepEqual(
      live.map((p: Row) => [p.name, p.search_type]),
      [["exa", "auto"]],
    );
    assert.equal(live[0].search_limits.dispatch_deadline_seconds, 60);
    for (const profile of ["exa_deep", "exa_deep_reasoning"])
      await assert.rejects(engine.call("query", { ...liveQuery(), profile }), {
        code: "invalid_request",
      });
    await assert.rejects(
      engine.call("query", {
        ...liveQuery(),
        budgets: { dispatch_deadline_seconds: 61 },
      }),
      { code: "invalid_request" },
    );
    const request = liveQuery();
    const submitted = await engine.call<Row>("query", request);
    const replayed = await engine.call<Row>("query", request);
    assert.equal(submitted.job_id, replayed.job_id);
    const saved = (
      await engine.connection((client) =>
        client.query(
          `SELECT request_json,provider_policy_sha256 FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [submitted.job_id],
        ),
      )
    ).rows[0];
    assert.equal(saved.provider_policy_sha256, exaFingerprint(legacy));
    assert.equal(
      JSON.parse(saved.request_json).budgets.dispatch_deadline_seconds,
      60,
    );
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(engine), "0");
    assert.throws(() =>
      h.engine("other-owner", { exa: { ...legacy, policyVersion: "unknown" } }),
    );
  } finally {
    await h.close();
  }
});

test("v2 query cannot dispatch through a v1 or unrecognized Flight policy marker", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const queuedEngine = h.engine("owner-a", { exa: exaPolicy() });
    await queuedEngine.initialize();
    const queued = await queuedEngine.call<Row>("query", liveQuery());
    const submitter = h.engine("owner-a", {
      exa: exaPolicy(),
      allowSubmission: true,
    });
    for (const version of [undefined, "exa-search.v1", "unknown"]) {
      if (version === undefined)
        delete h.flightConfig.SOURCESQL_EXA_POLICY_VERSION;
      else h.flightConfig.SOURCESQL_EXA_POLICY_VERSION = version;
      await assert.rejects(
        submitter.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(submitter), "0");
    }
  } finally {
    await h.close();
  }
});

test("configured Exa research profiles bind exact modes and durable approval without changing fixture defaults", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { exa: exaPolicy() });
    await engine.initialize();
    const capabilities = await engine.call<Row>("capabilities");
    assert.equal(capabilities.default_profile, "fixture");
    assert.equal(capabilities.recommended_research_profile, "exa");
    const modes = {
      exa: "auto",
      exa_deep: "deep",
      exa_deep_reasoning: "deep-reasoning",
    };
    for (const [profile, mode] of Object.entries(modes)) {
      const advertised = capabilities.profiles.find(
        (p: Row) => p.name === profile,
      );
      assert.equal(advertised.search_type, mode);
      assert.deepEqual(advertised.operators, ["WEB_SEARCH"]);
      assert.equal(advertised.research_agent_configured, false);
      assert.equal(advertised.search_limits.dispatch_deadline_seconds, 100);
      assert.equal(advertised.search_limits.max_cost_microusd, 50_000);
      const request = { ...liveQuery(), profile };
      const job = await engine.call<Row>("query", request);
      const saved = (
        await engine.connection((client) =>
          client.query(
            `SELECT request_json,provider_policy_sha256 FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [job.job_id],
          ),
        )
      ).rows[0];
      assert.equal(JSON.parse(saved.request_json).profile, profile);
      assert.equal(saved.provider_policy_sha256, exaFingerprint(exaPolicy()));
      await assert.rejects(
        engine.call("query", {
          ...request,
          profile: profile === "exa" ? "exa_deep_reasoning" : "exa",
        }),
      );
    }
    await assert.rejects(
      engine.call("query", { ...liveQuery(), profile: "exa_broad" }),
      { code: "invalid_request" },
    );
    await assert.rejects(
      engine.call("query", { ...liveQuery(), search_type: "auto" }),
      { code: "invalid_request" },
    );
    assert.equal(h.submissions, 0);
    assert.equal(await providerReserve(engine), "0");
  } finally {
    await h.close();
  }
});
function configureExa(h: Harness) {
  h.flightConfig = {
    SOURCESQL_ALLOW_LIVE_EXA: "1",
    SOURCESQL_EXA_APPROVED_COST_MICROUSD: "50000",
    SOURCESQL_EXA_SECRET_NAME: "sourcesql_exa",
    SOURCESQL_EXA_POLICY_VERSION: "exa-research.v2",
  };
  h.flightSecrets = ["sourcesql_exa"];
}

const exaResearchPolicy = (model: boolean): HostedExaPolicy => ({
  ...exaPolicy(10_000_000),
  policyVersion: "exa-research.v3",
  ...(model
    ? { model: { name: "gpt-4.1-mini", secretName: "sourcesql_openai" } }
    : {}),
});

function configureResearchExa(h: Harness, policy: HostedExaPolicy) {
  configureExa(h);
  Object.assign(h.flightConfig, exaConfiguration(policy));
  h.flightSecrets = [
    policy.secretName,
    ...(policy.model ? [policy.model.secretName] : []),
    ...(policy.embedding ? [policy.embedding.secretName] : []),
  ];
}

for (const model of [false, true]) {
  test(`v3 ${model ? "model" : "no-model"} capabilities and durable normalized budgets match effective grants`, async () => {
    const h = await harness();
    try {
      const policy = exaResearchPolicy(model);
      configureResearchExa(h, policy);
      const engine = h.engine("owner-a", { exa: policy });
      await engine.initialize();
      const capabilities = await engine.call<Row>("capabilities");
      assert.equal(capabilities.default_profile, "fixture");
      const live = capabilities.profiles.filter(
        (entry: Row) => entry.mode === "live",
      );
      assert.equal(live.length, 3);
      for (const entry of live) {
        assert.deepEqual(entry.operators, [
          "WEB_SEARCH",
          "WEB_FETCH",
          ...(model
            ? ["SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"]
            : []),
        ]);
        assert.equal(entry.model_configured, model);
        assert.equal(entry.model_name, model ? "gpt-4.1-mini" : null);
        assert.equal(entry.embedding_configured, false);
        assert.equal(entry.research_agent_configured, false);
        assert.match(
          entry.fetched_text_coverage,
          /completeness is not established/,
        );
        assert.equal(entry.search_limits.max_search_queries, 32);
        assert.equal(entry.search_limits.max_search_requests, 48);
        assert.equal(entry.search_limits.max_candidates, 2500);
        assert.equal(entry.search_limits.max_fetches, 40);
        assert.equal(
          entry.search_limits.max_semantic_documents,
          model ? 40 : 0,
        );
        assert.equal(entry.search_limits.max_model_requests, model ? 96 : 0);
        assert.equal(entry.search_limits.max_input_tokens, model ? 200_000 : 0);
        assert.equal(entry.search_limits.max_output_tokens, model ? 16_000 : 0);
      }
      const request = {
        ...liveQuery(),
        source_mode: "require_document",
        budgets: {
          max_candidates: 1200,
          max_fetches: 6,
          max_semantic_documents: model ? 6 : 0,
          max_model_requests: model ? 12 : 0,
          max_cost_microusd: 40_000,
          dispatch_deadline_seconds: 80,
        },
      };
      const job = await engine.call<Row>("query", request);
      const saved = (
        await engine.connection((client) =>
          client.query(
            `SELECT request_json,provider_policy_sha256,provider_cost_reserved_microusd FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [job.job_id],
          ),
        )
      ).rows[0];
      const normalized = JSON.parse(saved.request_json);
      assert.equal(normalized.source_mode, "require_document");
      assert.deepEqual(normalized.budgets, {
        dispatch_deadline_seconds: 80,
        max_candidates: 1200,
        max_concurrency: 4,
        max_fetches: 6,
        max_input_tokens: model ? 200_000 : 0,
        max_model_requests: model ? 12 : 0,
        max_output_bytes: 4_194_304,
        max_output_rows: 1000,
        max_output_tokens: model ? 16_000 : 0,
        max_search_queries: 32,
        max_search_requests: 48,
        max_semantic_documents: model ? 6 : 0,
        max_cost_microusd: 40_000,
      });
      assert.equal(saved.provider_policy_sha256, exaFingerprint(policy));
      assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
      const defaultJob = await engine.call<Row>("query", liveQuery());
      const defaults = (
        await engine.connection((client) =>
          client.query(
            `SELECT request_json FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [defaultJob.job_id],
          ),
        )
      ).rows[0];
      assert.equal(
        JSON.parse(defaults.request_json).source_mode,
        "allow_excerpt",
      );
      await assert.rejects(
        engine.call("query", { ...liveQuery(), source_mode: "guess" }),
        { code: "unsupported_capability" },
      );
      for (const budgets of [
        { max_candidates: 2501 },
        { max_search_queries: 33 },
        { max_search_requests: 49 },
        { max_cost_microusd: 50_001 },
        ...(!model
          ? [{ max_model_requests: 1 }, { max_semantic_documents: 1 }]
          : []),
      ])
        await assert.rejects(
          engine.call("query", { ...liveQuery(), budgets }),
          { code: "invalid_request" },
        );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(engine), "0");
    } finally {
      await h.close();
    }
  });
}

test("v3 embedding capability and Flight attestation stay bound to the configured model and secret", async () => {
  const h = await harness();
  try {
    const policy: HostedExaPolicy = {
      ...exaResearchPolicy(false),
      embedding: {
        name: "text-embedding-3-small",
        secretName: "sourcesql_openai",
      },
    };
    configureResearchExa(h, policy);
    const queue = h.engine("owner-a", { exa: policy });
    await queue.initialize();
    const caps = await queue.call<Row>("capabilities");
    for (const profile of caps.profiles.filter((p: Row) => p.mode === "live")) {
      assert.deepEqual(profile.operators, [
        "WEB_SEARCH",
        "WEB_FETCH",
        "SEM_SCORE",
      ]);
      assert.equal(profile.embedding_configured, true);
      assert.equal(profile.embedding_model, "text-embedding-3-small");
      assert.equal(profile.embedding_input_max_tokens, 8192);
      assert.equal(profile.embedding_input_max_utf8_bytes, undefined);
      assert.equal(profile.embedding_batch_max_tokens, 300_000);
      assert.equal(profile.embedding_token_encoding, "cl100k_base");
      assert.equal(profile.score_basis, "cosine_similarity");
      assert.equal(profile.search_limits.max_semantic_documents, 0);
      assert.equal(profile.search_limits.max_model_requests, 96);
    }
    const queued = await queue.call<Row>("query", liveQuery());
    const submitter = h.engine("owner-a", {
      exa: policy,
      allowSubmission: true,
    });
    const expected = { ...h.flightConfig };
    for (const change of [
      { SOURCESQL_OPENAI_EMBEDDING_MODEL: "text-embedding-3-large" },
      { SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME: "other_openai" },
      { SOURCESQL_OPENAI_EMBEDDING_MODEL: undefined },
    ]) {
      h.flightConfig = { ...expected, ...change };
      await assert.rejects(
        submitter.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(submitter), "0");
    }
    h.flightConfig = expected;
    h.flightSecrets = [policy.secretName];
    await assert.rejects(
      submitter.call("start_job", { job_id: queued.job_id }),
      { code: "unsupported_capability" },
    );
    assert.equal(h.submissions, 0);
    assert.equal(await providerReserve(submitter), "0");
    configureResearchExa(h, policy);
    await submitter.call("start_job", { job_id: queued.job_id });
    assert.equal(h.submissions, 1);
  } finally {
    await h.close();
  }
});

test("v3 model Flight drift and missing secret refuse before reservation, then exact binding dispatches once", async () => {
  const h = await harness();
  try {
    const policy = exaResearchPolicy(true);
    configureResearchExa(h, policy);
    const queue = h.engine("owner-a", { exa: policy });
    await queue.initialize();
    const request = liveQuery();
    const queued = await queue.call<Row>("query", request);
    const submitter = h.engine("owner-a", {
      exa: policy,
      allowSubmission: true,
    });
    const expected = { ...h.flightConfig };
    for (const change of [
      { SOURCESQL_OPENAI_MODEL: "gpt-4.1" },
      { SOURCESQL_OPENAI_SECRET_NAME: "other_openai" },
      { SOURCESQL_OPENAI_MODEL: undefined },
      { SOURCESQL_OPENAI_SECRET_NAME: undefined },
      { SOURCESQL_EXA_SECRET_NAME: "other_exa" },
      { SOURCESQL_EXA_POLICY_VERSION: "exa-research.v2" },
    ]) {
      h.flightConfig = { ...expected, ...change };
      await assert.rejects(
        submitter.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(submitter), "0");
    }
    h.flightConfig = expected;
    h.flightSecrets = [policy.secretName];
    await assert.rejects(
      submitter.call("start_job", { job_id: queued.job_id }),
      { code: "unsupported_capability" },
    );
    assert.equal(h.submissions, 0);
    assert.equal(await providerReserve(submitter), "0");
    const before = (
      await submitter.connection((client) =>
        client.query(
          `SELECT dispatch_intent_at FROM ${submitter.table("jobs")} WHERE id=$1::UUID`,
          [queued.job_id],
        ),
      )
    ).rows[0];
    assert.equal(before.dispatch_intent_at, null);
    h.flightSecrets = [policy.secretName, policy.model!.secretName];
    await submitter.call("start_job", { job_id: queued.job_id });
    const replay = await submitter.call<Row>("query", request);
    assert.equal(replay.job_id, queued.job_id);
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(submitter), "0");
    assert.equal(h.runs.length, 1);
  } finally {
    await h.close();
  }
});

test("v3 no-model policy refuses unexpected model configuration before native dispatch", async () => {
  const h = await harness();
  try {
    const policy = exaResearchPolicy(false);
    configureResearchExa(h, policy);
    const queue = h.engine("owner-a", { exa: policy });
    await queue.initialize();
    const queued = await queue.call<Row>("query", liveQuery());
    const submitter = h.engine("owner-a", {
      exa: policy,
      allowSubmission: true,
    });
    const expected = { ...h.flightConfig };
    for (const extra of [
      { SOURCESQL_OPENAI_MODEL: "gpt-4.1-mini" },
      { SOURCESQL_OPENAI_EMBEDDING_MODEL: "text-embedding-3-small" },
      { SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME: "sourcesql_openai" },
      { SOURCESQL_OPENAI_SECRET_NAME: "sourcesql_openai" },
      {
        SOURCESQL_OPENAI_MODEL: "gpt-4.1-mini",
        SOURCESQL_OPENAI_SECRET_NAME: "sourcesql_openai",
      },
    ]) {
      h.flightConfig = { ...expected, ...extra };
      await assert.rejects(
        submitter.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(submitter), "0");
    }
    h.flightConfig = expected;
    await submitter.call("start_job", { job_id: queued.job_id });
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(submitter), "0");
  } finally {
    await h.close();
  }
});

async function providerReserve(engine: MotherDuckEngine) {
  return (
    await engine.connection((client) =>
      client.query(
        `SELECT CAST(coalesce(sum(reserved_microusd),0) AS VARCHAR) AS reserved FROM ${engine.table("provider_allowances")}`,
      ),
    )
  ).rows[0].reserved;
}

test("Exa is opt-in and normalized budgets cannot expand the operator grant", async () => {
  const h = await harness();
  try {
    const fixture = h.engine();
    await fixture.initialize();
    await assert.rejects(fixture.call("query", liveQuery()), {
      code: "invalid_request",
    });
    const enabled = h.engine("owner-a", { exa: exaPolicy() });
    const queued = await enabled.call<Row>("query", liveQuery());
    const saved = (
      await enabled.connection((client) =>
        client.query(
          `SELECT request_json,provider_policy_sha256,provider_cost_reserved_microusd FROM ${enabled.table("jobs")} WHERE id=$1::UUID`,
          [queued.job_id],
        ),
      )
    ).rows[0];
    const normalized = JSON.parse(saved.request_json);
    assert.equal(normalized.source_mode, "allow_excerpt");
    assert.deepEqual(normalized.budgets, {
      max_search_queries: 2,
      max_search_requests: 2,
      max_candidates: 10,
      max_fetches: 0,
      max_semantic_documents: 0,
      max_model_requests: 0,
      max_concurrency: 1,
      dispatch_deadline_seconds: 100,
      max_output_rows: 100,
      max_output_bytes: 1_048_576,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_cost_microusd: 50_000,
    });
    assert.equal(
      saved.provider_policy_sha256,
      "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901",
    );
    assert.equal(saved.provider_policy_sha256, exaFingerprint(exaPolicy()));
    for (const budgets of [
      { max_cost_microusd: 50_001 },
      { max_search_requests: 3 },
      { dispatch_deadline_seconds: 101 },
      { max_fetches: 1 },
      { max_model_requests: 1 },
      { max_input_tokens: 1 },
    ]) {
      await assert.rejects(enabled.call("query", { ...liveQuery(), budgets }), {
        code: "invalid_request",
      });
    }
    await assert.rejects(
      enabled.call("query", {
        ...liveQuery(),
        source_mode: "require_document",
      }),
      { code: "unsupported_capability" },
    );
    assert.equal(await providerReserve(enabled), "0");
    assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("Exa preserves policy and secret admission without accumulating provider reservations", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const queuedEngine = h.engine("owner-a", { exa: exaPolicy() });
    await queuedEngine.initialize();
    const queued = await queuedEngine.call<Row>("query", liveQuery());
    assert.equal(queued.status, "queued");
    assert.equal(await providerReserve(queuedEngine), "0");
    await assert.rejects(
      queuedEngine.call("start_job", { job_id: queued.job_id }),
      { code: "unsupported_capability" },
    );
    const submitter = h.engine("owner-a", {
      allowSubmission: true,
      exa: exaPolicy(),
    });
    h.flightSecrets = [];
    await assert.rejects(
      submitter.call("start_job", { job_id: queued.job_id }),
      { code: "unsupported_capability" },
    );
    assert.equal(await providerReserve(submitter), "0");
    const before = (
      await submitter.connection((client) =>
        client.query(
          `SELECT dispatch_intent_at FROM ${submitter.table("jobs")} WHERE id=$1::UUID`,
          [queued.job_id],
        ),
      )
    ).rows[0];
    assert.equal(before.dispatch_intent_at, null);
    assert.equal(h.submissions, 0);
    h.flightSecrets = ["sourcesql_exa"];
    await submitter.call("start_job", { job_id: queued.job_id });
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(submitter), "0");
    const after = (
      await submitter.connection((client) =>
        client.query(
          `SELECT dispatch_intent_at,provider_cost_reserved_microusd FROM ${submitter.table("jobs")} WHERE id=$1::UUID`,
          [queued.job_id],
        ),
      )
    ).rows[0];
    assert.ok(after.dispatch_intent_at);
    assert.equal(Number(after.provider_cost_reserved_microusd), 0);
  } finally {
    await h.close();
  }
});

test("Exa request replay does not duplicate dispatch or create provider reservations", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      exa: exaPolicy(),
    });
    await engine.initialize();
    h.loseSubmissionResponse = true;
    const request = liveQuery();
    const first = await engine.call<Row>("query", request);
    assert.equal(first.status, "submission_unknown");
    const replay = await h
      .engine("owner-a", { allowSubmission: true, exa: exaPolicy() })
      .call<Row>("query", {
        ...request,
        source_mode: "allow_excerpt",
      });
    assert.equal(replay.job_id, first.job_id);
    await engine.call("job_status", { job_id: first.job_id });
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(engine), "0");
    await assert.rejects(
      engine.call("query", { ...request, query: "SELECT 2 AS value" }),
      { code: "idempotency_conflict" },
    );
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(engine), "0");
  } finally {
    await h.close();
  }
});

test("legacy daily Exa metadata permits a sequential Flight after the active Flight has stopped", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      exa: exaPolicy(50_000),
    });
    await engine.initialize();
    const first = await engine.call<Row>("query", liveQuery());
    const second = await engine.call<Row>("query", liveQuery());
    assert.equal(second.status, "queued");
    assert.equal(
      h.submissions,
      1,
      "The second job must wait for the active Flight",
    );
    h.runs[0].status = "RUN_STATUS_FAILED";
    const stopped = await engine.call<Row>("job_status", {
      job_id: first.job_id,
    });
    assert.equal(
      stopped.status,
      "failed",
      "The first Flight is terminal before the next dispatch",
    );
    await engine.call("start_job", { job_id: second.job_id });
    assert.equal(
      h.submissions,
      2,
      "Only the stopped Flight frees the single active slot",
    );
    await engine.call("job_status", { job_id: second.job_id });
    assert.equal(await providerReserve(engine), "0");
    const saved = (
      await engine.connection((client) =>
        client.query(
          `SELECT status,dispatch_intent_at,provider_cost_reserved_microusd FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [second.job_id],
        ),
      )
    ).rows[0];
    assert.equal(saved.status, "dispatching");
    assert.ok(saved.dispatch_intent_at);
    assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
    const runtime = (
      await engine.connection((client) =>
        client.query(
          `SELECT CAST(coalesce(sum(reserved_seconds),0) AS VARCHAR) AS seconds FROM ${engine.table("flight_allowances")}`,
        ),
      )
    ).rows[0];
    assert.equal(
      runtime.seconds,
      "0",
      "New dispatches must not accumulate obsolete runtime holds",
    );
  } finally {
    await h.close();
  }
});

function searchPolicy(
  provider: HostedSearchPolicy["provider"],
  overrides: Partial<HostedSearchPolicy> = {},
): HostedSearchPolicy {
  return {
    provider,
    secretName: `sourcesql_${provider}`,
    approvedCostMicrousd: 50_000,
    dailyCostMicrousd: 1_000_000,
    requestCostMicrousd: 5_000,
    ...overrides,
  };
}

function configureSearch(h: Harness, policy: HostedSearchPolicy) {
  h.flightConfig = hostedSearchConfiguration(policy);
  h.flightSecrets = [
    policy.secretName,
    ...(policy.model ? [policy.model.secretName] : []),
    ...(policy.embedding ? [policy.embedding.secretName] : []),
  ];
}

for (const provider of ["brave", "serper", "deepseek"] as const) {
  const providerQuery = () => ({ ...liveQuery(), profile: provider });

  test(`${provider} malformed research environment returns a structured configuration error before database access`, async () => {
    const prefix = `SOURCESQL_${provider.toUpperCase()}`;
    const environment = {
      [`SOURCESQL_ALLOW_LIVE_${provider.toUpperCase()}`]: "1",
      [`${prefix}_POLICY_VERSION`]:
        HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[provider],
      [`${prefix}_SECRET_NAME`]: `sourcesql_${provider}`,
      [`${prefix}_APPROVED_COST_MICROUSD`]: "50000",
      [`${prefix}_REQUEST_COST_MICROUSD`]: "5000",
    };
    for (const change of [
      { [`${prefix}_POLICY_VERSION`]: "unknown.v1" },
      { SOURCESQL_OPENAI_MODEL: "gpt-4.1-mini" },
      { SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME: "sourcesql_openai" },
      { SOURCESQL_OPENAI_REASONING_EFFORT: "low" },
    ])
      await assert.rejects(
        createMotherDuckBackend({ ...environment, ...change }, "owner-a"),
        { code: "invalid_request" },
      );
  });

  test(`${provider} search-only factory ignores leftover OpenAI settings for implicit and explicit v1`, async (context) => {
    context.mock.method(
      MotherDuckEngine.prototype,
      "initialize",
      async () => {},
    );
    const prefix = `SOURCESQL_${provider.toUpperCase()}`;
    for (const version of [undefined, `${provider}-search.v1`]) {
      const { engine } = await createMotherDuckBackend(
        {
          MOTHERDUCK_DB: "synthetic",
          MOTHERDUCK_HOST: "pg.us-east-1-aws.motherduck.com",
          MOTHERDUCK_TOKEN: "synthetic-unused-token",
          SOURCESQL_FLIGHT_ID: flightId,
          [`SOURCESQL_ALLOW_LIVE_${provider.toUpperCase()}`]: "1",
          [`${prefix}_POLICY_VERSION`]: version,
          [`${prefix}_SECRET_NAME`]: `sourcesql_${provider}`,
          [`${prefix}_APPROVED_COST_MICROUSD`]: "50000",
          [`${prefix}_REQUEST_COST_MICROUSD`]: "5000",
          SOURCESQL_OPENAI_MODEL: "unrelated leftover",
          SOURCESQL_OPENAI_SECRET_NAME: "not-a-valid-secret!",
          SOURCESQL_OPENAI_EMBEDDING_MODEL: "not-an-embedding",
          SOURCESQL_OPENAI_REASONING_EFFORT: "unrelated",
        },
        "owner-a",
      );
      const caps = await engine.call<Row>("capabilities");
      assert.deepEqual(caps.profiles[1].operators, ["WEB_SEARCH"]);
      assert.equal(caps.profiles[1].model_configured, false);
      assert.equal(caps.profiles[1].embedding_configured, false);
    }
  });

  for (const configured of ["model", "embedding", "both"] as const) {
    test(`${provider} research with ${configured} advertises and queues only configured semantic capabilities`, async () => {
      const h = await harness();
      try {
        const model = configured !== "embedding";
        const embedding = configured !== "model";
        const policy = searchPolicy(provider, {
          policyVersion: HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[provider],
          ...(model
            ? {
                model: {
                  name: "gpt-4.1-mini",
                  secretName: "sourcesql_openai",
                  reasoningEffort: "low",
                },
              }
            : {}),
          ...(embedding
            ? {
                embedding: {
                  name: "text-embedding-3-small",
                  secretName: "sourcesql_openai",
                },
              }
            : {}),
        });
        configureSearch(h, policy);
        const engine = h.engine("owner-a", { search: policy });
        await engine.initialize();
        const caps = await engine.call<Row>("capabilities");
        assert.deepEqual(
          caps.profiles.map((p: Row) => p.name),
          ["fixture", provider],
        );
        assert.ok(
          !caps.limitations.some((text: string) => /search-only/.test(text)),
        );
        assert.match(caps.limitations[0], /text support/);
        const selected = caps.profiles[1];
        assert.deepEqual(selected.operators, hostedSearchOperators(policy));
        assert.equal(selected.model_configured, model);
        assert.equal(selected.model_name, model ? "gpt-4.1-mini" : null);
        assert.equal(selected.embedding_configured, embedding);
        assert.equal(
          selected.embedding_model,
          embedding ? "text-embedding-3-small" : null,
        );
        assert.equal(
          selected.score_basis,
          embedding ? "cosine_similarity" : null,
        );
        assert.equal(
          selected.embedding_token_encoding,
          embedding ? "cl100k_base" : null,
        );
        assert.match(
          selected.fetched_text_coverage,
          provider === "deepseek"
            ? /Retained provider Markdown/
            : /Public HTML\/text/,
        );
        if (provider === "deepseek") {
          assert.deepEqual(selected.fetch_modes, ["cache_preferred"]);
          assert.equal(selected.provider_ranking_is_sem_score, false);
          assert.equal(selected.search_query_max_characters, 128);
          assert.equal(selected.search_per_query_max_results, 50);
        }
        assert.equal(
          selected.search_limits.max_fetches,
          provider === "deepseek" ? 10 : 40,
        );
        assert.equal(
          selected.search_limits.max_semantic_documents,
          model ? 40 : 0,
        );
        assert.equal(selected.search_limits.max_model_requests, 96);
        assert.equal(selected.search_limits.max_input_tokens, 200_000);
        assert.equal(
          selected.search_limits.max_output_tokens,
          model ? 16_000 : 0,
        );
        assert.equal(selected.search_limits.dispatch_deadline_seconds, 100);
        assert.equal(selected.live_qualified, false);
        const queued = await engine.call<Row>("query", {
          ...providerQuery(),
          source_mode:
            provider === "deepseek" ? "allow_excerpt" : "require_document",
          budgets: {
            max_search_requests: 3,
            max_search_queries: 3,
            max_fetches: 2,
            max_model_requests: 4,
          },
        });
        const saved = (
          await engine.connection((client) =>
            client.query(
              `SELECT request_json,provider_policy_sha256 FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
              [queued.job_id],
            ),
          )
        ).rows[0];
        const request = JSON.parse(saved.request_json);
        assert.equal(
          request.source_mode,
          provider === "deepseek" ? "allow_excerpt" : "require_document",
        );
        if (provider === "deepseek")
          await assert.rejects(
            engine.call("query", {
              ...providerQuery(),
              source_mode: "require_document",
            }),
            { code: "unsupported_capability" },
          );
        assert.equal(request.budgets.max_search_requests, 3);
        assert.equal(request.budgets.max_model_requests, 4);
        assert.equal(
          saved.provider_policy_sha256,
          hostedSearchFingerprint(policy),
        );
        const semanticOnly = await engine.call<Row>("query", {
          ...providerQuery(),
          query: "SELECT 1 AS retained_processing_control",
          budgets: {
            max_search_requests: 0,
            max_search_queries: 0,
            max_fetches: 0,
            max_cost_microusd: 1_000,
          },
        });
        assert.equal(semanticOnly.status, "queued");
        await assert.rejects(
          engine.call("query", { ...providerQuery(), source_mode: "guess" }),
          { code: "unsupported_capability" },
        );
        for (const budgets of [
          { max_fetches: 41 },
          { max_model_requests: 97 },
          { max_search_requests: 49 },
          ...(!model
            ? [{ max_semantic_documents: 1 }, { max_output_tokens: 1 }]
            : []),
        ])
          await assert.rejects(
            engine.call("query", { ...providerQuery(), budgets }),
            { code: "invalid_request" },
          );
        assert.equal(h.submissions, 0);
      } finally {
        await h.close();
      }
    });
  }

  test(`${provider} research attests exact model, embedding, effort, policy and secret bindings before dispatch`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider, {
        policyVersion: HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[provider],
        model: {
          name: "gpt-4.1-mini",
          secretName: "sourcesql_openai",
          reasoningEffort: "low",
        },
        embedding: {
          name: "text-embedding-3-small",
          secretName: "sourcesql_openai",
        },
      });
      configureSearch(h, policy);
      const queue = h.engine("owner-a", { search: policy });
      await queue.initialize();
      const queued = await queue.call<Row>("query", providerQuery());
      const engine = h.engine("owner-a", {
        search: policy,
        allowSubmission: true,
      });
      const expected = { ...h.flightConfig };
      for (const change of [
        { SOURCESQL_OPENAI_MODEL: "another-model" },
        { SOURCESQL_OPENAI_SECRET_NAME: "other_openai" },
        { SOURCESQL_OPENAI_REASONING_EFFORT: "high" },
        { SOURCESQL_OPENAI_EMBEDDING_MODEL: "text-embedding-3-large" },
        { SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME: "other_openai" },
        {
          [`SOURCESQL_${provider.toUpperCase()}_POLICY_VERSION`]: `${provider}-search.v1`,
        },
      ]) {
        h.flightConfig = { ...expected, ...change };
        await assert.rejects(
          engine.call("start_job", { job_id: queued.job_id }),
          { code: "unsupported_capability" },
        );
        assert.equal(h.submissions, 0);
      }
      h.flightConfig = expected;
      h.flightSecrets = [policy.secretName];
      await assert.rejects(
        engine.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(h.submissions, 0);
      h.flightSecrets = [policy.secretName, "sourcesql_openai"];
      await engine.call("start_job", { job_id: queued.job_id });
      assert.equal(h.submissions, 1);
      assert.equal(await providerReserve(engine), "0");
    } finally {
      await h.close();
    }
  });

  test(`${provider} search-only Flight ignores unrelated model settings without enabling semantic work`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider);
      configureSearch(h, policy);
      const queue = h.engine("owner-a", { search: policy });
      await queue.initialize();
      const queued = await queue.call<Row>("query", providerQuery());
      const engine = h.engine("owner-a", {
        search: policy,
        allowSubmission: true,
      });
      h.flightConfig.SOURCESQL_OPENAI_MODEL = "gpt-4.1-mini";
      h.flightConfig.SOURCESQL_OPENAI_SECRET_NAME = "sourcesql_openai";
      h.flightSecrets.push("sourcesql_openai");
      const caps = await engine.call<Row>("capabilities");
      assert.deepEqual(caps.profiles[1].operators, ["WEB_SEARCH"]);
      assert.equal(caps.profiles[1].model_configured, false);
      assert.equal(caps.profiles[1].embedding_configured, false);
      await engine.call("start_job", { job_id: queued.job_id });
      assert.equal(h.submissions, 1);
    } finally {
      await h.close();
    }
  });

  test(`${provider} capabilities expose only the selected live search profile and leave fixture jobs unchanged`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider);
      const engine = h.engine("owner-a", { search: policy });
      await engine.initialize();
      const capabilities = await engine.call<Row>("capabilities");
      assert.equal(capabilities.default_profile, "fixture");
      assert.equal(capabilities.recommended_research_profile, provider);
      assert.deepEqual(
        capabilities.profiles.map((p: Row) => p.name),
        ["fixture", provider],
      );
      const selected = capabilities.profiles[1];
      assert.equal(selected.provider, provider);
      assert.equal(selected.mode, "live");
      assert.equal(selected.live_qualified, false);
      assert.equal(selected.source_mode, "allow_excerpt");
      assert.deepEqual(selected.operators, ["WEB_SEARCH"]);
      assert.equal(selected.model_configured, false);
      assert.equal(selected.embedding_configured, false);
      assert.equal(
        selected.cost_reporting,
        provider === "deepseek"
          ? "published_rate_estimate_not_billing"
          : "unavailable",
      );
      assert.equal(selected.search_limits.max_search_requests, 2);
      assert.equal(selected.search_limits.max_search_queries, 2);
      assert.equal(selected.search_limits.max_candidates, 10);
      assert.equal(selected.search_limits.dispatch_deadline_seconds, 60);
      const fixture = await engine.call<Row>("query", query());
      const saved = (
        await engine.connection((client) =>
          client.query(
            `SELECT request_json,provider_policy_sha256 FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [fixture.job_id],
          ),
        )
      ).rows[0];
      assert.equal(JSON.parse(saved.request_json).profile, "fixture");
      assert.equal(saved.provider_policy_sha256, null);
      for (const profile of [
        "exa",
        "exa_deep",
        "exa_deep_reasoning",
        ...["brave", "serper", "deepseek"].filter((name) => name !== provider),
      ])
        await assert.rejects(
          engine.call("query", { ...providerQuery(), profile }),
          { code: "invalid_request" },
        );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(engine), "0");
    } finally {
      await h.close();
    }
  });

  test(`${provider} jobs bind the exact public policy and bound attempts by the request cost estimate`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider);
      const engine = h.engine("owner-a", { search: policy });
      await engine.initialize();
      const queued = await engine.call<Row>("query", {
        ...providerQuery(),
        budgets: { max_cost_microusd: 5_000 },
      });
      const saved = (
        await engine.connection((client) =>
          client.query(
            `SELECT request_json,provider_policy_sha256,provider_cost_reserved_microusd FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [queued.job_id],
          ),
        )
      ).rows[0];
      const normalized = JSON.parse(saved.request_json);
      assert.equal(
        saved.provider_policy_sha256,
        hostedSearchFingerprint(policy),
      );
      assert.equal(normalized.profile, provider);
      assert.equal(normalized.source_mode, "allow_excerpt");
      assert.equal(normalized.budgets.max_search_requests, 1);
      assert.equal(normalized.budgets.max_search_queries, 1);
      assert.equal(normalized.budgets.max_candidates, 10);
      assert.equal(normalized.budgets.dispatch_deadline_seconds, 60);
      assert.equal(normalized.budgets.max_cost_microusd, 5_000);
      for (const field of [
        "max_fetches",
        "max_model_requests",
        "max_semantic_documents",
        "max_input_tokens",
        "max_output_tokens",
      ])
        assert.equal(normalized.budgets[field], 0);
      for (const budgets of [
        { max_cost_microusd: 4_999 },
        { max_cost_microusd: 50_001 },
        { max_search_requests: 3 },
        { max_candidates: 11 },
        { dispatch_deadline_seconds: 61 },
        { max_fetches: 1 },
        { max_model_requests: 1 },
      ])
        await assert.rejects(
          engine.call("query", { ...providerQuery(), budgets }),
          { code: "invalid_request" },
        );
      await assert.rejects(
        engine.call("query", {
          ...providerQuery(),
          source_mode: "require_document",
        }),
        { code: "unsupported_capability" },
      );
      assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
      assert.equal(await providerReserve(engine), "0");
      assert.equal(h.submissions, 0);
    } finally {
      await h.close();
    }
  });

  test(`${provider} Flight secret and every policy configuration field must match before reserving or dispatching`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider);
      configureSearch(h, policy);
      const queuedEngine = h.engine("owner-a", { search: policy });
      await queuedEngine.initialize();
      const queued = await queuedEngine.call<Row>("query", providerQuery());
      const submitter = h.engine("owner-a", {
        search: policy,
        allowSubmission: true,
      });
      const expected = { ...h.flightConfig };
      for (const key of Object.keys(expected)) {
        h.flightConfig = {
          ...expected,
          [key]: key.includes("SECRET_NAME") ? "other_secret" : "unreviewed",
        };
        await assert.rejects(
          submitter.call("start_job", { job_id: queued.job_id }),
          { code: "unsupported_capability" },
        );
        assert.equal(h.submissions, 0);
        assert.equal(await providerReserve(submitter), "0");
      }
      h.flightConfig = expected;
      h.flightSecrets = [];
      await assert.rejects(
        submitter.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(await providerReserve(submitter), "0");
      h.flightSecrets = [policy.secretName];
      await submitter.call("start_job", { job_id: queued.job_id });
      assert.equal(h.submissions, 1);
      assert.equal(await providerReserve(submitter), "0");
      const saved = (
        await submitter.connection((client) =>
          client.query(
            `SELECT dispatch_intent_at,provider_cost_reserved_microusd FROM ${submitter.table("jobs")} WHERE id=$1::UUID`,
            [queued.job_id],
          ),
        )
      ).rows[0];
      assert.ok(saved.dispatch_intent_at);
      assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
    } finally {
      await h.close();
    }
  });

  test(`${provider} changed queued policy cannot dispatch under a newly configured grant`, async () => {
    const h = await harness();
    try {
      const original = searchPolicy(provider);
      const changed = searchPolicy(provider, { requestCostMicrousd: 5_001 });
      const queuedEngine = h.engine("owner-a", { search: original });
      await queuedEngine.initialize();
      const queued = await queuedEngine.call<Row>("query", providerQuery());
      configureSearch(h, changed);
      const submitter = h.engine("owner-a", {
        search: changed,
        allowSubmission: true,
      });
      await assert.rejects(
        submitter.call("start_job", { job_id: queued.job_id }),
        { code: "unsupported_capability" },
      );
      assert.equal(h.submissions, 0);
      assert.equal(await providerReserve(submitter), "0");
    } finally {
      await h.close();
    }
  });

  test(`${provider} lost-response replay avoids duplicate Flight submission and accumulated reservations`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider);
      configureSearch(h, policy);
      const engine = h.engine("owner-a", {
        search: policy,
        allowSubmission: true,
      });
      await engine.initialize();
      h.loseSubmissionResponse = true;
      const request = {
        ...providerQuery(),
        budgets: { max_cost_microusd: 5_000 },
      };
      const first = await engine.call<Row>("query", request);
      assert.equal(first.status, "submission_unknown");
      assert.equal(await providerReserve(engine), "0");
      const replay = await h
        .engine("owner-a", { search: policy, allowSubmission: true })
        .call<Row>("query", { ...request, source_mode: "allow_excerpt" });
      assert.equal(replay.job_id, first.job_id);
      await engine.call("job_status", { job_id: first.job_id });
      assert.equal(h.submissions, 1);
      assert.equal(await providerReserve(engine), "0");
      await assert.rejects(
        engine.call("query", { ...request, query: "SELECT 2 AS value" }),
        { code: "idempotency_conflict" },
      );
      assert.equal(h.submissions, 1);
    } finally {
      await h.close();
    }
  });

  test(`${provider} legacy daily metadata permits sequential Flights while preserving one active Flight`, async () => {
    const h = await harness();
    try {
      const policy = searchPolicy(provider, { dailyCostMicrousd: 50_000 });
      configureSearch(h, policy);
      const engine = h.engine("owner-a", {
        search: policy,
        allowSubmission: true,
      });
      await engine.initialize();
      const first = await engine.call<Row>("query", providerQuery());
      const second = await engine.call<Row>("query", providerQuery());
      assert.equal(second.status, "queued");
      assert.equal(
        h.submissions,
        1,
        "The second job must wait for the active Flight",
      );
      h.runs[0].status = "RUN_STATUS_FAILED";
      const stopped = await engine.call<Row>("job_status", {
        job_id: first.job_id,
      });
      assert.equal(
        stopped.status,
        "failed",
        "The first Flight is terminal before the next dispatch",
      );
      await engine.call("start_job", { job_id: second.job_id });
      assert.equal(
        h.submissions,
        2,
        "Only the stopped Flight frees the single active slot",
      );
      await engine.call("job_status", { job_id: second.job_id });
      assert.equal(await providerReserve(engine), "0");
      const saved = (
        await engine.connection((client) =>
          client.query(
            `SELECT status,dispatch_intent_at,provider_cost_reserved_microusd FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [second.job_id],
          ),
        )
      ).rows[0];
      assert.equal(saved.status, "dispatching");
      assert.ok(saved.dispatch_intent_at);
      assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
      const runtime = (
        await engine.connection((client) =>
          client.query(
            `SELECT CAST(coalesce(sum(reserved_seconds),0) AS VARCHAR) AS seconds FROM ${engine.table("flight_allowances")}`,
          ),
        )
      ).rows[0];
      assert.equal(runtime.seconds, "0");
    } finally {
      await h.close();
    }
  });
}

test("hosted search providers stay opt-in and mixed Exa plus search configuration fails closed", async () => {
  const h = await harness();
  try {
    const fixture = h.engine();
    await fixture.initialize();
    const capabilities = await fixture.call<Row>("capabilities");
    assert.deepEqual(
      capabilities.profiles.map((p: Row) => p.name),
      ["fixture"],
    );
    for (const provider of ["brave", "serper", "deepseek"] as const) {
      await assert.rejects(
        fixture.call("query", { ...liveQuery(), profile: provider }),
        { code: "invalid_request" },
      );
      assert.throws(() =>
        h.engine("owner-a", {
          exa: exaPolicy(),
          search: searchPolicy(provider),
        }),
      );
    }
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

async function reserveRuntimeDay(engine: MotherDuckEngine, seconds: number) {
  await engine.connection((client) =>
    client.query(
      `INSERT INTO ${engine.table("flight_allowances")} VALUES($1,$2::BIGINT)`,
      [new Date().toISOString().slice(0, 10), seconds],
    ),
  );
}

async function runtimeReserve(engine: MotherDuckEngine) {
  return (
    await engine.connection((client) =>
      client.query(
        `SELECT CAST(coalesce(sum(reserved_seconds),0) AS VARCHAR) AS seconds FROM ${engine.table("flight_allowances")}`,
      ),
    )
  ).rows[0].seconds;
}

test("operator-reserved compatibility: an exhausted automatic start preserves one queued handle across replay and cancellation without changing limits", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      exa: exaPolicy(),
    });
    await engine.initialize();
    await reserveRuntimeDay(engine, 600);
    const request = liveQuery();
    const first = await engine.call<Row>("query", request);
    assert.equal(first.status, "queued");
    assert.equal(first.pending, true);
    assert.equal(first.request_id, request.request_id);
    assert.deepEqual(first.capacity, {
      resource: "flight_compute",
      reason: "operator_limit",
      period: "day",
      allowance: "configured",
      resets_at: new Date(
        Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z") +
          86400000,
      ).toISOString(),
      limit: 600,
      used: 600,
      unit: "seconds",
      services: ["motherduck"],
    });
    assert.equal(first.can_resume, false);
    assert.deepEqual(first.dispatch_blocked, {
      code: "budget_exhausted",
      message: "Daily Flight execution reserve is exhausted",
      capacity: first.capacity,
    });
    const status = await engine.call<Row>("job_status", {
      job_id: first.job_id,
    });
    assert.deepEqual(status.capacity, first.capacity);
    assert.equal(status.can_resume, false);
    const replay = await engine.call<Row>("query", request);
    assert.equal(replay.job_id, first.job_id);
    assert.deepEqual(replay.dispatch_blocked, first.dispatch_blocked);
    await assert.rejects(engine.call("start_job", { job_id: first.job_id }), {
      code: "budget_exhausted",
    });
    const saved = (
      await engine.connection((client) =>
        client.query(
          `SELECT count(*)::INTEGER AS count,max(dispatch_intent_at) AS intent,CAST(sum(provider_cost_reserved_microusd) AS VARCHAR) AS reserved FROM ${engine.table("jobs")}`,
        ),
      )
    ).rows[0];
    assert.equal(saved.count, 1);
    assert.equal(saved.intent, null);
    assert.equal(saved.reserved, "0");
    const caps = await engine.call<Row>("capabilities");
    assert.equal(caps.daily_execution_reserve_seconds, 600);
    assert.equal(caps.max_flight_runtime_seconds, 120);
    assert.equal(
      caps.profiles.find((p: Row) => p.name === "exa").search_limits
        .max_cost_microusd,
      50_000,
    );
    assert.equal(await runtimeReserve(engine), "600");
    assert.equal(await providerReserve(engine), "0");
    assert.equal(h.submissions, 0);
    const cancelled = await engine.call<Row>("cancel_job", {
      job_id: first.job_id,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.pending, false);
    const cancelledReplay = await engine.call<Row>("query", request);
    assert.equal(cancelledReplay.job_id, first.job_id);
    assert.equal(cancelledReplay.status, "cancelled");
    assert.equal(cancelledReplay.dispatch_blocked, undefined);
    assert.equal(h.submissions, 0);
    assert.equal(await runtimeReserve(engine), "600");
  } finally {
    await h.close();
  }
});

test("operator-reserved compatibility: an exhausted provider allowance returns the queued handle and rolls back execution reservation", async () => {
  const h = await harness();
  try {
    const policy = searchPolicy("brave", { dailyCostMicrousd: 50_000 });
    configureSearch(h, policy);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      search: policy,
    });
    await engine.initialize();
    await engine.connection((client) =>
      client.query(
        `INSERT INTO ${engine.table("provider_allowances")} VALUES($1,50000)`,
        [new Date().toISOString().slice(0, 10)],
      ),
    );
    const request = { ...liveQuery(), profile: "brave" };
    const first = await engine.call<Row>("query", request);
    assert.equal(first.status, "queued");
    assert.equal(first.capacity.resource, "search_model_budget");
    assert.equal(first.capacity.allowance, "configured");
    assert.equal(first.can_resume, false);
    assert.deepEqual(first.dispatch_blocked, {
      code: "budget_exhausted",
      message: "Daily provider reserve is exhausted",
      capacity: first.capacity,
    });
    assert.equal(
      (await engine.call<Row>("query", request)).job_id,
      first.job_id,
    );
    assert.equal(await runtimeReserve(engine), "0");
    assert.equal(await providerReserve(engine), "50000");
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("MCP reopens an admission-failed job with its safe code and no result or extra dispatch", async () => {
  const h = await harness();
  const client = new Client({ name: "admission-failure-test", version: "1" });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const original = h.engine("owner-a", { allowSubmission: true });
    await original.initialize();
    const submitted = await original.call<Row>("query", {
      ...query(),
      query: "SELECT random() AS private_column_marker",
    });
    assert.equal(h.submissions, 1);
    // A Flight can fail admission in explain before any engine run is created.
    await original.connection((connection) =>
      connection.query(
        `UPDATE ${original.table("jobs")} SET status='failed',error_code='unsupported_query',error_message=$1 WHERE id=$2::UUID`,
        ["PRIVATE-RAW-EXCEPTION-MUST-NOT-REACH-THE-HOST", submitted.job_id],
      ),
    );
    h.runs[0].status = "RUN_STATUS_FAILED";
    h.runs[0].exit_code = 1;
    const reopened = h.engine("owner-a", { allowSubmission: true });
    const store = new ResearchStore(h.directory, seed, undefined, 3000, {
      backend: new MotherDuckStateBackend(reopened),
    });
    server = createServer(
      store,
      join(root, "apps/research/dist/research.html"),
      {
        engine: reopened,
        access: {
          mode: "protected",
          principal: "owner-a",
          allowPrivateDisclosure: false,
        },
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    for (let inspection = 0; inspection < 2; inspection++) {
      const result = await client.callTool({
        name: "sourcesql_job_status",
        arguments: { job_id: submitted.job_id },
      });
      assert.notEqual(result.isError, true);
      const receipt = result.structuredContent as Row;
      assert.equal(receipt.status, "failed");
      assert.equal(receipt.pending, false);
      assert.equal(receipt.error_code, "unsupported_query");
      assert.equal(receipt.job_id, submitted.job_id);
      assert.equal(receipt.result_id, undefined);
      assert.equal(receipt.run_id, undefined);
      assert.ok(!JSON.stringify(result).includes("PRIVATE-RAW-EXCEPTION"));
    }
    const direct = await reopened.call<Row>("job_status", {
      job_id: submitted.job_id,
    });
    assert.equal(direct.error.code, "unsupported_query");
    assert.match(direct.error.message, /query is not supported/i);
    assert.equal(h.submissions, 1);
    for (const table of ["results", "runs"]) {
      const rows = (
        await reopened.connection((connection) =>
          connection.query(
            `SELECT CAST(count(*) AS VARCHAR) AS count FROM ${reopened.table(table)}`,
          ),
        )
      ).rows;
      assert.equal(rows[0].count, "0");
    }
  } finally {
    await client.close();
    await server?.close();
    await h.close();
  }
});

test("operator-reserved compatibility: MCP returns the blocked queued receipt and same-ID resume guidance rather than an error", async () => {
  const h = await harness();
  const client = new Client({ name: "budget-boundary-test", version: "1" });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      exa: exaPolicy(),
    });
    await engine.initialize();
    await reserveRuntimeDay(engine, 600);
    const store = new ResearchStore(h.directory, seed, undefined, 3000, {
      backend: new MotherDuckStateBackend(engine),
    });
    server = createServer(
      store,
      join(root, "apps/research/dist/research.html"),
      {
        engine,
        access: {
          mode: "protected",
          principal: "owner-a",
          allowPrivateDisclosure: false,
        },
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const request = liveQuery();
    const result = await client.callTool({
      name: "sourcesql_query",
      arguments: request,
    });
    assert.notEqual(result.isError, true);
    const queued = result.structuredContent as Row;
    assert.equal(queued.status, "queued");
    assert.equal(queued.request_id, request.request_id);
    assert.equal(queued.dispatch_blocked.code, "budget_exhausted");
    const guidance = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    assert.ok(guidance.includes(queued.job_id));
    assert.match(guidance, /No Flight was submitted for this attempt/);
    assert.match(guidance, /same job_id and request_id/);
    assert.match(guidance, /allowance/);
    assert.match(guidance, /open_research\(\{job_id:/);
    assert.match(guidance, /no result is available/);
    const replay = await client.callTool({
      name: "sourcesql_query",
      arguments: request,
    });
    assert.notEqual(replay.isError, true);
    assert.equal((replay.structuredContent as Row).job_id, queued.job_id);
    assert.deepEqual(
      (replay.structuredContent as Row).dispatch_blocked,
      queued.dispatch_blocked,
    );
    const cancelled = await client.callTool({
      name: "sourcesql_cancel_job",
      arguments: { job_id: queued.job_id },
    });
    assert.notEqual(cancelled.isError, true);
    assert.equal((cancelled.structuredContent as Row).status, "cancelled");
    assert.equal((cancelled.structuredContent as Row).pending, false);
    assert.equal(h.submissions, 0);
    assert.equal(await runtimeReserve(engine), "600");
    assert.equal(await providerReserve(engine), "0");
  } finally {
    await client.close();
    await server?.close();
    await h.close();
  }
});

test("automatic start does not turn unexpected, authorization or configuration errors into budget receipts", async (context) => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    for (const error of [
      new Error("Unexpected controlled failure"),
      Object.assign(new Error("Budget-shaped uncontrolled failure"), {
        code: "budget_exhausted",
      }),
      new BackendError("unauthorized", "Controlled authorization refusal"),
      new BackendError(
        "unsupported_capability",
        "Controlled configuration refusal",
      ),
    ]) {
      const mock = context.mock.method(engine, "startJob", async () => {
        throw error;
      });
      try {
        await assert.rejects(
          engine.call("query", query()),
          (observed) => observed === error,
        );
      } finally {
        mock.mock.restore();
      }
    }
    assert.equal(h.submissions, 0);
    assert.equal(await runtimeReserve(engine), "0");
  } finally {
    await h.close();
  }
});

test("a budget error after a dispatch marker or reservation is never described as an undispatched queue block", async (context) => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    for (const mutation of [
      "status='dispatching'",
      "dispatch_intent_at='controlled-dispatch-marker'",
      "flight_run_id='11111111-1111-4111-a111-111111111111'::UUID",
      "provider_cost_reserved_microusd=1",
    ]) {
      const error = new BackendError(
        "budget_exhausted",
        "Controlled post-dispatch refusal",
      );
      const mock = context.mock.method(
        engine,
        "startJob",
        async (id: string) => {
          await engine.connection((client) =>
            client.query(
              `UPDATE ${engine.table("jobs")} SET ${mutation} WHERE id=$1::UUID`,
              [id],
            ),
          );
          throw error;
        },
      );
      try {
        await assert.rejects(
          engine.call("query", query()),
          (observed) => observed === error,
        );
      } finally {
        mock.mock.restore();
      }
    }
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("hosted worker version stays unknown without an explicit reviewed version pin", async () => {
  const base = {
    database: "synthetic",
    host: "pg.us-east-1-aws.motherduck.com",
    token: "synthetic-unused-token",
    flightId,
    principal: "owner-a",
    clientFactory: () => {
      throw new Error("Capabilities must not connect");
    },
  };
  const unknown = await new MotherDuckEngine(base).call<Row>("capabilities");
  assert.equal(unknown.engine_version, null);
  assert.equal(unknown.engine_version_source, "unknown");
  const pinned = {
    ...base,
    engineVersion: "0.2.2",
    sourceSha256: reviewedSourceHash,
    requirementsSha256: reviewedRequirementsHash,
  };
  const caps = await new MotherDuckEngine(pinned).call<Row>("capabilities");
  assert.equal(caps.engine_version, "0.2.2");
  assert.equal(caps.engine_version_source, "configured_flight_pin");
  for (const override of [
    { engineVersion: "unmeasured" },
    { sourceSha256: undefined },
    { requirementsSha256: undefined },
  ])
    assert.throws(() => new MotherDuckEngine({ ...pinned, ...override }), {
      code: "invalid_request",
    });
});

function monthWindow() {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10),
    previous: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 10),
    next: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString(),
  };
}
test("operator-reserved compatibility: monthly Flight reservations carry existing work forward, exclude other months and survive reopening", async () => {
  const h = await harness();
  try {
    const legacy = h.engine();
    await legacy.initialize();
    const window = monthWindow();
    for (const [day, seconds] of [
      [window.start, 120],
      [window.previous, 9999],
      [window.next.slice(0, 10), 9999],
    ])
      await legacy.connection((c) =>
        c.query(
          `INSERT INTO ${legacy.table("flight_allowances")} VALUES($1,$2::BIGINT)`,
          [day, seconds],
        ),
      );
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      monthlySeconds: 240,
    });
    const caps = await engine.call<Row>("capabilities");
    assert.equal(caps.daily_execution_reserve_seconds, null);
    assert.equal(caps.monthly_execution_reserve_seconds, 240);
    const first = await engine.call<Row>("query", query());
    assert.equal(h.submissions, 1);
    h.runs[0].status = "RUN_STATUS_FAILED";
    await engine.call("job_status", { job_id: first.job_id });
    const request = query();
    const blocked = await engine.call<Row>("query", request);
    assert.equal(blocked.status, "queued");
    assert.deepEqual(blocked.capacity, {
      resource: "flight_compute",
      reason: "operator_limit",
      allowance: "configured",
      period: "month",
      resets_at: window.next,
      services: ["motherduck"],
      limit: 240,
      used: 240,
      unit: "seconds",
    });
    const reopened = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      monthlySeconds: 240,
    });
    assert.deepEqual(
      (await reopened.call<Row>("job_status", { job_id: blocked.job_id }))
        .capacity,
      blocked.capacity,
    );
    assert.equal(
      (await reopened.call<Row>("query", request)).job_id,
      blocked.job_id,
    );
    await assert.rejects(
      reopened.call("start_job", { job_id: blocked.job_id }),
      { code: "budget_exhausted" },
    );
    assert.equal(h.submissions, 1);
    assert.equal(await runtimeReserve(engine), String(240 + 9999 + 9999));
  } finally {
    await h.close();
  }
});
test("operator-reserved compatibility: monthly search/model reservations refuse before charging Flight or provider rows", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      exa: exaPolicy(),
      monthlySeconds: 18000,
      monthlyProviderCostMicrousd: 100000,
    });
    await engine.initialize();
    const window = monthWindow();
    for (const [day, cost] of [
      [window.start, 50000],
      [window.previous, 999999],
      [window.next.slice(0, 10), 999999],
    ])
      await engine.connection((c) =>
        c.query(
          `INSERT INTO ${engine.table("provider_allowances")} VALUES($1,$2::BIGINT)`,
          [day, cost],
        ),
      );
    const first = await engine.call<Row>("query", liveQuery());
    h.runs[0].status = "RUN_STATUS_FAILED";
    await engine.call("job_status", { job_id: first.job_id });
    const request = liveQuery();
    const blocked = await engine.call<Row>("query", request);
    assert.equal(blocked.status, "queued");
    assert.equal(blocked.capacity.resource, "search_model_budget");
    assert.equal(blocked.capacity.period, "month");
    assert.equal(blocked.capacity.used, 100000);
    assert.equal(blocked.capacity.resets_at, window.next);
    assert.deepEqual(blocked.capacity.services, ["exa"]);
    assert.equal(blocked.can_resume, false);
    assert.equal(
      (await engine.call<Row>("query", request)).job_id,
      blocked.job_id,
    );
    assert.equal(h.submissions, 1);
    assert.equal(await runtimeReserve(engine), "120");
    assert.equal(
      await providerReserve(engine),
      String(100000 + 999999 + 999999),
    );
  } finally {
    await h.close();
  }
});
test("operator-reserved compatibility: monthly-only jobs can use more than the legacy daily default while a zero monthly cap stays closed", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      monthlySeconds: 1800,
    });
    await engine.initialize();
    await reserveRuntimeDay(engine, 600);
    await engine.call("query", query());
    assert.equal(h.submissions, 1);
    assert.equal(await runtimeReserve(engine), "720");
    const closed = h.engine("owner-b", {
      allowSubmission: true,
      usageMode: "operator_reserved",
      monthlySeconds: 0,
      monthlyProviderCostMicrousd: 0,
    });
    await closed.initialize();
    const blocked = await closed.call<Row>("query", query());
    assert.equal(blocked.capacity.period, "month");
    assert.equal(blocked.capacity.limit, 0);
    assert.equal(blocked.can_resume, false);
    assert.equal(h.submissions, 1);
    for (const bad of [-1, NaN, Infinity, 1.5, 2678401])
      assert.throws(() => h.engine("invalid", { monthlySeconds: bad }));
    for (const bad of [-1, NaN, Infinity, 1.5, 1000000001])
      assert.throws(() =>
        h.engine("invalid", { monthlyProviderCostMicrousd: bad }),
      );
  } finally {
    await h.close();
  }
});

test("provider-managed dispatch ignores historical reservations while retaining finite jobs and one active Flight", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      usageMode: "provider_managed",
      allowSubmission: true,
      dailySeconds: 0,
      monthlySeconds: 0,
      monthlyProviderCostMicrousd: 0,
      exa: exaPolicy(50_000),
    });
    await engine.initialize();
    await reserveRuntimeDay(engine, 99999);
    await engine.connection((client) =>
      client.query(
        `INSERT INTO ${engine.table("provider_allowances")} VALUES($1,99999999)`,
        [new Date().toISOString().slice(0, 10)],
      ),
    );
    const caps = await engine.call<Row>("capabilities");
    assert.equal(caps.usage_mode, "provider_managed");
    assert.equal(caps.daily_execution_reserve_seconds, null);
    assert.equal(caps.monthly_execution_reserve_seconds, null);
    assert.equal(caps.monthly_provider_reserve_microusd, null);
    assert.equal(caps.max_flight_runtime_seconds, 120);
    await assert.rejects(
      engine.call("query", {
        ...liveQuery(),
        budgets: { max_cost_microusd: 50_001 },
      }),
      { code: "invalid_request" },
    );
    const request = liveQuery();
    const first = await engine.call<Row>("query", request);
    assert.equal(first.capacity, undefined);
    assert.equal(
      (await engine.call<Row>("query", request)).job_id,
      first.job_id,
    );
    const second = await engine.call<Row>("query", liveQuery());
    assert.equal(second.status, "queued");
    assert.equal(
      h.submissions,
      1,
      "Historical quotas do not relax the single active Flight constraint",
    );
    h.runs[0].status = "RUN_STATUS_FAILED";
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: first.job_id })).status,
      "failed",
    );
    await engine.call("start_job", { job_id: second.job_id });
    assert.equal(
      h.submissions,
      2,
      "The second Flight starts only after the first is terminal",
    );
    assert.equal(await runtimeReserve(engine), "99999");
    assert.equal(await providerReserve(engine), "99999999");
    const report = await engine.call<Row>("usage_report");
    assert.deepEqual(
      report.providers,
      [],
      "Historical reservation ceilings are not provider costs",
    );
    assert.equal(report.motherduck.observed_flight_seconds, 0);
    assert.equal(
      report.unobserved_flight_jobs,
      2,
      "Unmeasured dispatched jobs remain visible rather than being reported as free",
    );
    assert.equal(report.motherduck.account_billed_cost_microusd, null);
  } finally {
    await h.close();
  }
});

test("usage reports include failed and cancelled provider work, deduplicate request IDs and isolate owner/job scope", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { exa: exaPolicy() });
    const other = h.engine("owner-b");
    await engine.initialize();
    await other.initialize();
    const window = {
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    };
    const shared = {
      provider: "exa",
      kind: "search",
      status: "completed",
      request_id: "exa-shared",
      usage: { estimated_cost_microusd: 42000, cost_microusd: null },
    };
    const receipts = [
      {
        run_id: "usage-completed",
        started_at: "2026-10-18T10:00:00.000Z",
        status: "completed",
        provider_events: [shared],
      },
      {
        run_id: "usage-failed",
        started_at: "2026-10-18T11:00:00.000Z",
        status: "failed",
        provider_events: [
          shared,
          {
            provider: "openai_embeddings",
            kind: "embedding",
            status: "completed",
            request_id: "openai-1",
            usage: { cost_microusd: 150, input_tokens: 12 },
          },
        ],
      },
      {
        run_id: "usage-cancelled",
        started_at: "2026-10-18T12:00:00.000Z",
        status: "cancelled",
        provider_events: [
          {
            provider: "exa",
            kind: "fetch",
            status: "remote_outcome_unknown",
            request_id: "exa-uncertain",
            usage: {},
          },
        ],
      },
      {
        run_id: "usage-outside",
        started_at: "2026-09-30T12:00:00.000Z",
        status: "completed",
        provider_events: [{ ...shared, request_id: "outside" }],
      },
    ];
    for (const receipt of receipts) {
      const requestId = randomUUID();
      await engine.connection((client) =>
        client.query(
          `INSERT INTO ${engine.table("runs")} VALUES($1,$2,$3,$4)`,
          [
            receipt.run_id,
            requestId,
            digest(requestId),
            JSON.stringify({
              ...receipt,
              query: "PRIVATE-QUERY",
              source_text: "PRIVATE-SOURCE",
            }),
          ],
        ),
      );
    }
    const report = await engine.call<Row>("usage_report", window);
    const exa = report.providers.find((entry: Row) => entry.service === "exa");
    assert.equal(exa.requests, 2);
    assert.equal(exa.estimated_cost_microusd, 42000);
    assert.equal(exa.reported_cost_microusd, null);
    assert.equal(exa.reported_cost_requests, 0);
    assert.equal(exa.estimated_cost_requests, 1);
    assert.equal(exa.cost_unavailable_requests, 1);
    assert.equal(exa.uncertain_requests, 1);
    const openai = report.providers.find(
      (entry: Row) => entry.service === "openai",
    );
    assert.equal(openai.reported_cost_microusd, 150);
    assert.equal(openai.input_tokens, 12);
    assert.ok(!JSON.stringify(report).includes("PRIVATE-"));
    assert.deepEqual(
      (await other.call<Row>("usage_report", window)).providers,
      [],
    );
    const savedSql = await engine.call<Row>("query", {
      ...query(),
      profile: "exa",
    });
    const saved = await publish(engine, "saved-data-no-provider", {
      jobId: savedSql.job_id,
    });
    await engine.connection((client) =>
      client.query(
        `UPDATE ${engine.table("runs")} SET receipt=$1 WHERE id=$2`,
        [
          JSON.stringify({
            ...saved.receipt,
            started_at: "2026-10-18T13:00:00.000Z",
            provider_events: [],
          }),
          saved.run_id,
        ],
      ),
    );
    const localSqlReport = await engine.call<Row>("usage_report", {
      ...window,
      job_id: savedSql.job_id,
    });
    assert.deepEqual(
      localSqlReport.providers,
      [],
      "Saved-data SQL must not inherit the configured Exa per-job ceiling as cost",
    );
    assert.equal(localSqlReport.job_id, savedSql.job_id);
    await assert.rejects(
      other.call("usage_report", { ...window, job_id: savedSql.job_id }),
      { code: "not_found" },
    );
    for (const bad of [
      { start: "invalid" },
      { end: window.start, start: window.end },
      { start: "2024-01-01T00:00:00Z", end: window.end },
      { query: "private" },
    ])
      await assert.rejects(engine.call("usage_report", bad), {
        code: "invalid_request",
      });
    assert.equal(
      h.submissions,
      0,
      "Cost reports and queued saved SQL make no native Flight calls",
    );
  } finally {
    await h.close();
  }
});

test("terminal Flight observations meter runtime once across failures, cancellations, polling and reopening", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const started = new Date().toISOString();
    const window = {
      start: new Date(Date.parse(started) - 60000).toISOString(),
      end: new Date(Date.parse(started) + 60000).toISOString(),
    };
    h.runAckPatch = {
      started_at: started,
      ended_at: new Date(Date.parse(started) + 12400).toISOString(),
      elapsed_seconds: 12.4,
    };
    const first = await engine.call<Row>("query", query());
    assert.equal(
      (await engine.call<Row>("usage_report", window)).motherduck
        .observed_flights,
      0,
      "Running Flight time is not a settled measurement",
    );
    h.runs[0].status = "RUN_STATUS_FAILED";
    await engine.call("job_status", { job_id: first.job_id });
    await engine.call("job_status", { job_id: first.job_id });
    h.runAckPatch = {
      started_at: started,
      ended_at: new Date(Date.parse(started) + 4100).toISOString(),
      elapsed_seconds: 4.1,
    };
    const second = await engine.call<Row>("query", query());
    h.runs[1].status = "RUN_STATUS_CANCELLED";
    await engine.call("job_status", { job_id: second.job_id });
    const reopened = h.engine();
    const report = await reopened.call<Row>("usage_report", window);
    assert.equal(report.motherduck.observed_flights, 2);
    assert.equal(report.motherduck.observed_flight_seconds, 18);
    assert.equal(report.motherduck.estimated_flight_cost_microusd, 750);
    assert.equal(report.motherduck.sql_compute_cost_microusd, null);
    assert.equal(report.motherduck.storage_cost_microusd, null);
    assert.equal(report.motherduck.account_billed_cost_microusd, null);
    assert.equal(report.unobserved_flight_jobs, 0);
    assert.equal(
      (
        await reopened.call<Row>("usage_report", {
          ...window,
          job_id: first.job_id,
        })
      ).motherduck.observed_flight_seconds,
      13,
    );
    const other = h.engine("owner-b");
    await other.initialize();
    assert.equal(
      (await other.call<Row>("usage_report", window)).motherduck
        .observed_flights,
      0,
    );
    assert.equal(await runtimeReserve(engine), "0");
    assert.equal(h.submissions, 2);
  } finally {
    await h.close();
  }
});

test("usage notices observe Flights once and summarize month/day from one owner-scoped snapshot", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-18T12:00:00Z"),
  });
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    await engine.call("query", query());
    // An in-progress native run stays unobserved, so repeating metadata reads
    // cannot be hidden by a first pass that happened to settle all the runs.
    assert.equal(h.runs[0].status, "RUN_STATUS_RUNNING");
    for (const [date, cost] of [
      ["2026-10-17", 6_000_000],
      ["2026-10-18", 5_000_000],
    ] as const) {
      const runId = randomUUID();
      await engine.connection((client) =>
        client.query(
          `INSERT INTO ${engine.table("runs")} VALUES($1,$2,$3,$4)`,
          [
            runId,
            randomUUID(),
            digest(runId),
            JSON.stringify({
              started_at: `${date}T10:00:00.000Z`,
              provider_events: [
                {
                  provider: "exa",
                  kind: "search",
                  status: "completed",
                  request_id: runId,
                  usage: { estimated_cost_microusd: cost },
                },
              ],
            }),
          ],
        ),
      );
    }
    for (const date of ["2026-10-17", "2026-10-18"]) {
      for (let index = 0; index < 16; index++) {
        await engine.connection((client) =>
          client.query(
            `INSERT INTO ${engine.table("usage_flights")} VALUES($1,$2::UUID,$3,$4,120,'F4')`,
            [
              randomUUID(),
              randomUUID(),
              `${date}T10:00:00.000Z`,
              `${date}T10:02:00.000Z`,
            ],
          ),
        );
      }
    }
    h.statements.length = 0;
    h.inspections = 0;
    const notices = await engine.call<Row[]>("usage_notices");
    assert.equal(
      h.inspections,
      1,
      "One advisory response observes native metadata once",
    );
    assert.equal(
      h.statements.filter((sql) => sql.includes("SELECT id AS run_id")).length,
      1,
    );
    assert.equal(
      h.statements.filter((sql) =>
        sql.includes("SELECT run_id,CAST(job_id AS VARCHAR)"),
      ).length,
      1,
    );
    assert.equal(
      h.statements.filter((sql) => sql === "BEGIN TRANSACTION").length,
      1,
      "Monthly/day totals and dismissals use the same read transaction",
    );
    assert.deepEqual(
      notices.map(({ service, used, period }) => ({ service, used, period })),
      [
        { service: "exa", used: 11_000_000, period: "month" },
        { service: "motherduck", used: 1920, period: "day" },
      ],
    );
    assert.equal(notices[0].period_start, "2026-10-01T00:00:00.000Z");
    assert.equal(notices[1].period_start, "2026-10-18T00:00:00.000Z");
    h.inspections = 0;
    h.runs[0].config_json = "invalid native metadata";
    assert.deepEqual(
      await engine.call("usage_notices"),
      notices,
      "Optional observation failure preserves the retained metering snapshot",
    );
    assert.equal(h.inspections, 1, "Failed observations are not retried");
    const other = h.engine("owner-b");
    await other.initialize();
    assert.deepEqual(await other.call("usage_notices"), []);
    assert.equal(h.submissions, 1, "Notices never submit or replay research");
    assert.equal(h.cancellations, 0);
  } finally {
    await h.close();
  }
});

test("usage notice dismissal persists by owner and provider period across gateway reopening", async () => {
  const h = await harness();
  try {
    const owner = h.engine("owner-a"),
      other = h.engine("owner-b");
    await owner.initialize();
    await other.initialize();
    const receipt = {
      run_id: "exa-reference-crossing",
      started_at: new Date().toISOString(),
      status: "completed",
      provider_events: [
        {
          provider: "exa",
          kind: "search",
          status: "completed",
          request_id: "reference-crossing",
          usage: { estimated_cost_microusd: 10_007_000 },
        },
      ],
    };
    for (const engine of [owner, other]) {
      const requestId = randomUUID();
      await engine.connection((client) =>
        client.query(
          `INSERT INTO ${engine.table("runs")} VALUES($1,$2,$3,$4)`,
          [
            receipt.run_id,
            requestId,
            digest(requestId),
            JSON.stringify(receipt),
          ],
        ),
      );
    }
    const notices = await owner.call<Row[]>("usage_notices");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].service, "exa");
    assert.equal(notices[0].blocking, false);
    assert.equal(notices[0].used, 10_007_000);
    assert.deepEqual(await other.call("usage_notices"), notices);
    for (let attempt = 0; attempt < 2; attempt++)
      assert.deepEqual(
        await owner.call("dismiss_usage_notice", { notice_id: notices[0].id }),
        { dismissed: true },
      );
    const reopened = h.engine("owner-a");
    assert.deepEqual(await reopened.call("usage_notices"), []);
    assert.deepEqual(
      await other.call("usage_notices"),
      notices,
      "The same notice identity remains visible in another owner's namespace",
    );
    const rows = await reopened.connection((client) =>
      client.query(
        `SELECT id,dismissed_at FROM ${reopened.table("usage_notice_dismissals")}`,
      ),
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].id, notices[0].id);
    assert.ok(Number.isFinite(Date.parse(rows.rows[0].dismissed_at)));
    for (const args of [
      { notice_id: "invalid" },
      { notice_id: notices[0].id, extra: "invalid" },
    ])
      await assert.rejects(owner.call("dismiss_usage_notice", args), {
        code: "invalid_request",
      });
    const legacy = h.engine("owner-a", { usageMode: "operator_reserved" });
    const report = await legacy.call<Row>("usage_report");
    assert.equal(report.usage_mode, "operator_reserved");
    assert.equal(
      report.providers[0].estimated_cost_microusd,
      10_007_000,
      "Dismissal never changes metered usage",
    );
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

for (const nativeStatus of ["RUN_STATUS_SUCCEEDED", "SUCCEEDED"])
  test(`usage reports backfill late terminal Flights (${nativeStatus}) without changing jobs and reject mismatched observations`, async () => {
    const h = await harness();
    try {
      const engine = h.engine("owner-a", { allowSubmission: true });
      await engine.initialize();
      const started = new Date().toISOString();
      const window = {
        start: new Date(Date.parse(started) - 60000).toISOString(),
        end: new Date(Date.parse(started) + 60000).toISOString(),
      };
      h.runAckPatch = {
        started_at: started,
        ended_at: new Date(Date.parse(started) + 12400).toISOString(),
        elapsed_seconds: 12.4,
      };
      const job = await engine.call<Row>("query", query());
      await publish(engine, "late-finished-research", { jobId: job.job_id });
      assert.equal(
        (await engine.call<Row>("job_status", { job_id: job.job_id })).status,
        "completed",
      );
      const persistedJob = async () =>
        (
          await engine.connection((client) =>
            client.query(
              `SELECT status,flight_settled,updated_at,engine_run_id,result_id FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
              [job.job_id],
            ),
          )
        ).rows[0];
      const before = await persistedJob();
      assert.equal(
        before.flight_settled,
        false,
        "The app can finish before the native Flight cleanup",
      );
      h.runs[0].status = nativeStatus;
      const original = h.runs[0].config_json;
      h.runs[0].config_json = JSON.stringify({
        ...JSON.parse(original),
        JOB_ID: randomUUID(),
      });
      const wrongJob = await engine.call<Row>("usage_report", window);
      assert.equal(wrongJob.motherduck.observed_flights, 0);
      assert.equal(wrongJob.unobserved_flight_jobs, 1);
      h.runs[0].config_json = original;
      h.runs[0].flight_version++;
      assert.equal(
        (await engine.call<Row>("usage_report", window)).motherduck
          .observed_flights,
        0,
        "Unreviewed Flight versions cannot contribute trusted observations",
      );
      h.runs[0].flight_version--;
      const reopened = h.engine();
      const report = await reopened.call<Row>("usage_report", window);
      assert.equal(report.motherduck.observed_flights, 1);
      assert.equal(report.motherduck.observed_flight_seconds, 13);
      assert.equal(report.motherduck.estimated_flight_cost_microusd, 542);
      assert.equal(report.unobserved_flight_jobs, 0);
      assert.deepEqual(
        (await reopened.call<Row>("usage_report", window)).motherduck,
        report.motherduck,
      );
      assert.deepEqual(
        await persistedJob(),
        before,
        "Cost inspection neither changes execution settlement nor rewrites job status",
      );
      assert.equal(h.submissions, 1, "No Flight starts during cost reporting");
      assert.equal(h.cancellations, 0);
    } finally {
      await h.close();
    }
  });

test("failed hosted model jobs reopen with distinct safe errors and never redispatch", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const job = await engine.call<Row>("query", query());
    h.runs[0].status = "RUN_STATUS_FAILED";
    h.runs[0].exit_code = 1;
    for (const [code, message] of [
      ["provider_timeout", "timed out"],
      ["provider_connection_error", "connection failed"],
      ["provider_http_error", "provider rejected"],
      ["invalid_output", "output failed validation"],
      ["evidence_invalid", "evidence failed validation"],
      ["PRIVATE-UNKNOWN-CODE", "execution failed safely"],
      ["__proto__", "execution failed safely"],
    ]) {
      await engine.connection((connection) =>
        connection.query(
          `UPDATE ${engine.table("jobs")} SET status='failed',error_code=$1,error_message=$2 WHERE id=$3::UUID`,
          [code, "PRIVATE-RAW-PROVIDER-BODY", job.job_id],
        ),
      );
      const view = await engine.call<Row>("job_status", { job_id: job.job_id });
      assert.equal(view.status, "failed");
      assert.equal(
        view.error.code,
        ["PRIVATE-UNKNOWN-CODE", "__proto__"].includes(code)
          ? "execution_failed"
          : code,
      );
      assert.ok(view.error.message.toLowerCase().includes(message));
      assert.ok(!JSON.stringify(view).includes("PRIVATE-RAW"));
      assert.equal(view.result_id, undefined);
      assert.equal(h.submissions, 1);
    }
  } finally {
    await h.close();
  }
});

test("hosted preflight uses canonical Python admission without provider dispatch or a research result", async () => {
  const h = await harness();
  const client = new Client({ name: "preflight-test", version: "1" });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const store = new ResearchStore(h.directory, seed, undefined, 3000, {
      backend: new MotherDuckStateBackend(engine),
    });
    server = createServer(
      store,
      join(root, "apps/research/dist/research.html"),
      { engine },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const request = { ...query(), partial_policy: "strict" };
    const submitted = await client.callTool({
      name: "sourcesql_explain",
      arguments: request,
    });
    assert.notEqual(submitted.isError, true);
    const job = submitted.structuredContent as Row;
    assert.equal(job.operation, "explain");
    assert.equal(job.pending, true);
    assert.equal(job.result_id, undefined);
    const [written] = await h.sql.request(
      randomUUID(),
      "execute_preflight_job",
      undefined,
      [engine.namespace, job.job_id],
    );
    assert.equal(written.status, "completed");
    assert.equal(written.provider_requests, 0);
    h.runs[0].status = "RUN_STATUS_SUCCEEDED";
    h.runs[0].exit_code = 0;
    const done = await client.callTool({
      name: "sourcesql_job_status",
      arguments: { job_id: job.job_id },
    });
    assert.notEqual(done.isError, true);
    const receipt = done.structuredContent as Row;
    assert.equal(receipt.preflight.external_calls, 0);
    assert.equal(receipt.preflight.validation_compute, "on_demand_flight");
    assert.equal(receipt.result_id, undefined);
    assert.equal(receipt.run_id, undefined);
    assert.equal(receipt.pending, false);
    assert.equal(
      (await engine.call<Row>("explain", request)).job_id,
      job.job_id,
    );
    assert.equal(h.submissions, 1);
    assert.equal(await runtimeReserve(engine), "0");
    assert.equal(await providerReserve(engine), "0");
    const invalid = await engine.call<Row>("explain", {
      ...request,
      request_id: randomUUID(),
      query: "SELECT SEM_MATCH(content) FROM WEB_SEARCH('aurora')",
    });
    const [failed] = await h.sql.request(
      randomUUID(),
      "execute_preflight_job",
      undefined,
      [engine.namespace, invalid.job_id],
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.provider_requests, 0);
    h.runs[1].status = "RUN_STATUS_FAILED";
    const refusal = await engine.call<Row>("job_status", {
      job_id: invalid.job_id,
    });
    assert.equal(refusal.error_code, "invalid_query");
    assert.equal(refusal.stage, "admission");
    assert.equal(refusal.provider_dispatch, "not_dispatched");
    assert.equal(refusal.run_id, undefined);
  } finally {
    await client.close();
    await server?.close();
    await h.close();
  }
});

test("completed preflight reauthorizes input pins on status, start and cancel", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    const saved = await publish(engine, "wq_preflight_parent");
    const submitted = await engine.call<Row>("explain", {
      ...query(),
      query: "SELECT value FROM input.saved",
      partial_policy: "strict",
      inputs: { saved: { result_id: saved.result_id, view: "original" } },
    });
    await h.sql.request(randomUUID(), "execute_preflight_job", undefined, [
      engine.namespace,
      submitted.job_id,
    ]);
    h.runs[0].status = "RUN_STATUS_SUCCEEDED";
    h.runs[0].exit_code = 0;
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: submitted.job_id }))
        .preflight.external_calls,
      0,
    );
    await engine.connection((connection) =>
      connection.query(
        `UPDATE ${engine.table("results")} SET revoked=1 WHERE id=$1`,
        [saved.result_id],
      ),
    );
    for (const method of ["job_status", "start_job", "cancel_job"])
      await assert.rejects(engine.call(method, { job_id: submitted.job_id }), {
        code: "unauthorized",
      });
    assert.equal(h.submissions, 1);
  } finally {
    await h.close();
  }
});

for (const [failure, code] of [
  ["timeout", "provider_timeout"],
  ["connection_error", "provider_connection_error"],
  ["http_429", "provider_http_error"],
  ["invalid_output", "invalid_output"],
]) {
  test(`real Python ${failure} survives the job writer, gateway reopening and authorized MCP diagnostics`, async () => {
    const h = await harness();
    const client = new Client({ name: "failed-run-test", version: "1" });
    const otherClient = new Client({ name: "other-owner-test", version: "1" });
    const servers: ReturnType<typeof createServer>[] = [];
    try {
      const original = h.engine("owner-a", { allowSubmission: true });
      await original.initialize();
      const request = {
        ...query(),
        query:
          "SELECT SEM_SCORE(content, 'specific criterion') AS relevance FROM WEB_SEARCH('aurora', per_query_limit := 1)",
        partial_policy: "strict",
      };
      const submitted = await original.call<Row>("query", request);
      const [written] = await h.sql.request(
        randomUUID(),
        "execute_failing_job",
        undefined,
        [original.namespace, submitted.job_id, failure],
      );
      assert.deepEqual(written, {
        status: "failed",
        error_code: code,
        result_id: null,
        provider_requests: 1,
      });
      h.runs[0].status = "RUN_STATUS_FAILED";
      h.runs[0].exit_code = 1;

      const reopened = h.engine("owner-a", { allowSubmission: true });
      const other = h.engine("owner-b", { allowSubmission: true });
      await other.initialize();
      for (const [engine, mcpClient, principal] of [
        [reopened, client, "owner-a"],
        [other, otherClient, "owner-b"],
      ] as const) {
        const store = new ResearchStore(h.directory, seed, undefined, 3000, {
          backend: new MotherDuckStateBackend(engine),
        });
        const server = createServer(
          store,
          join(root, "apps/research/dist/research.html"),
          {
            engine,
            access: {
              mode: "protected",
              principal,
              allowPrivateDisclosure: false,
            },
          },
        );
        servers.push(server);
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), mcpClient.connect(b)]);
      }
      for (let inspection = 0; inspection < 2; inspection++) {
        const response = await client.callTool({
          name: "sourcesql_job_status",
          arguments: { job_id: submitted.job_id },
        });
        assert.notEqual(response.isError, true);
        const job = response.structuredContent as Row;
        assert.equal(job.status, "failed");
        assert.equal(job.pending, false);
        assert.equal(job.error_code, code);
        assert.equal(job.error.code, code);
        assert.equal(job.result_id, undefined);
        assert.equal(typeof job.run_id, "string");
        const runResponse = await client.callTool({
          name: "sourcesql_run_status",
          arguments: { run_id: job.run_id },
        });
        assert.notEqual(runResponse.isError, true);
        const run = runResponse.structuredContent as Row;
        assert.equal(run.status, "failed");
        assert.equal(run.result_id, null);
        assert.equal(run.errors[0].code, code);
        assert.equal(run.errors[0].stage, "semantic");
        assert.equal(run.errors[0].safe_message, undefined);
        assert.doesNotMatch(
          JSON.stringify([response, runResponse]),
          /PRIVATE-|synthetic-not-a-key|specific criterion|SEM_SCORE/,
        );
        for (const [name, args] of [
          ["sourcesql_job_status", { job_id: job.job_id }],
          ["sourcesql_run_status", { run_id: job.run_id }],
        ] as const) {
          const denied = await otherClient.callTool({ name, arguments: args });
          assert.equal(denied.isError, true);
          assert.doesNotMatch(JSON.stringify(denied), new RegExp(code));
        }
      }
      assert.equal(
        (await reopened.call<Row>("query", request)).job_id,
        submitted.job_id,
      );
      await reopened.call("start_job", { job_id: submitted.job_id });
      assert.equal(
        h.submissions,
        1,
        "Inspections, replay and start must not redispatch a terminal job",
      );
      const rows = await reopened.connection((connection) =>
        connection.query(
          `SELECT count(*) AS count FROM ${reopened.table("results")}`,
        ),
      );
      assert.equal(Number(rows.rows[0].count), 0);
    } finally {
      await client.close();
      await otherClient.close();
      for (const server of servers) await server.close();
      await h.close();
    }
  });
}

test("DeepSeek fetch-only admission rejects an unfundable job before queuing and advertises affordable fetches", async () => {
  const h = await harness();
  try {
    const policy = searchPolicy("deepseek", {
      policyVersion: "deepseek-research.v1",
      requestCostMicrousd: 750,
    });
    const engine = h.engine("owner-a", { search: policy });
    await engine.initialize();
    await assert.rejects(
      engine.call("query", {
        ...liveQuery(),
        profile: "deepseek",
        budgets: {
          max_search_requests: 0,
          max_search_queries: 0,
          max_fetches: 5,
          max_cost_microusd: 500,
        },
      }),
      (error: any) =>
        error.code === "invalid_request" &&
        /cannot cover one search or native fetch/.test(error.message),
    );
    const count = (
      await engine.connection((client) =>
        client.query(`SELECT count(*) AS count FROM ${engine.table("jobs")}`),
      )
    ).rows[0];
    assert.equal(Number(count.count), 0);
    assert.equal(h.submissions, 0);
    const queued = await engine.call<Row>("query", {
      ...liveQuery(),
      profile: "deepseek",
      budgets: {
        max_search_requests: 0,
        max_search_queries: 0,
        max_fetches: 5,
        max_cost_microusd: 1500,
      },
    });
    const saved = (
      await engine.connection((client) =>
        client.query(
          `SELECT request_json FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [queued.job_id],
        ),
      )
    ).rows[0];
    assert.equal(JSON.parse(saved.request_json).budgets.max_fetches, 2);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

function preparationFixture(requestId = randomUUID()) {
  const args = {
    request_id: requestId,
    query: "SELECT * FROM input.t",
    profile: "fixture",
    inputs: {
      t: { result_id: "wq_input", view: "effective", amendment_revision: 1 },
    },
  };
  const imports = {
    t: {
      snapshot_id: "saved-input",
      amendment_revision: 1,
      payload: {
        columns: [
          {
            key: "value",
            label: "Value",
            logical_type: "BIGINT",
            nullable: false,
          },
        ],
        rows: [{ value: "9007199254740993" }],
        row_ids: ["row_0"],
        data_classification: "synthetic_fixture",
        parents: [
          { result_id: "wq_input", view: "original", amendment_revision: null },
        ],
        provenance: {
          materialization_contract: "sourcesql.app-effective.v2",
          snapshot_id: "saved-input",
          view: "effective",
          amendment_revision: 1,
          dependencies: ["wq_input"],
        },
      },
    },
  };
  return { args, imports };
}
async function preparationRows(engine: MotherDuckEngine) {
  return engine.transaction(
    false,
    async (client) =>
      (
        await client.query(
          `SELECT CAST(id AS VARCHAR) AS id,operation,status FROM ${engine.table("jobs")} ORDER BY created_at,id`,
        )
      ).rows,
  );
}
test("input preparation reserves exact jobs before dispatch and protects the outer UUID", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture();
    const first = await engine.prepareQuery("query", args, imports);
    assert.equal(first.status, "queued");
    assert.equal(first.operation, "import_table");
    const again = await h.engine().prepareQuery("query", args, imports);
    assert.equal(again.job_id, first.job_id);
    assert.equal((await preparationRows(engine)).length, 1);
    await assert.rejects(
      engine.enqueue(args),
      /preparation changed|compatible binding/,
    );
    await assert.rejects(
      engine.prepareQuery("explain", args, imports),
      /preparation changed|compatible binding/,
    );
    await assert.rejects(
      engine.prepareQuery(
        "query",
        { ...args, query: "SELECT 2 AS value" },
        imports,
      ),
      /preparation changed|compatible binding/,
    );
    assert.equal((await preparationRows(engine)).length, 1);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});
test("changed pending context and legacy outer requests refuse before replacement imports", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture();
    await engine.prepareQuery("query", args, imports);
    const changed = structuredClone(imports);
    changed.t.payload.rows[0].value = "123";
    await assert.rejects(
      engine.prepareQuery("query", args, changed),
      /preparation changed|compatible binding/,
    );
    const legacy = preparationFixture();
    await engine.enqueue(legacy.args);
    const before = (await preparationRows(engine)).length;
    await assert.rejects(
      engine.lookupPreparedQuery("query", legacy.args),
      /preparation changed|compatible binding/,
    );
    await assert.rejects(
      engine.prepareQuery("query", legacy.args, legacy.imports),
      /preparation changed|compatible binding/,
    );
    assert.equal((await preparationRows(engine)).length, before);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});
test("prepared completion recovers the downstream job without rematerializing and reauthorizes inputs", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture(),
      first = await engine.prepareQuery("query", args, imports);
    await publish(engine, "wq_promoted", {
      jobId: first.job_id,
      parents: [{ result_id: "wq_input" }],
    });
    const final = await engine.prepareQuery("query", args, imports);
    assert.equal(final.operation, "query");
    assert.equal(final.request_id, args.request_id);
    assert.equal((await preparationRows(engine)).length, 2);
    const recovered = await h
      .engine()
      .lookupPreparedQuery("query", args, imports);
    assert.equal(recovered!.job_id, final.job_id);
    const changed = structuredClone(imports);
    changed.t.payload.rows[0].value = "changed context";
    await assert.rejects(
      h
        .engine("owner-a", { allowSubmission: true })
        .lookupPreparedQuery("query", args, changed),
      /preparation changed|compatible binding/,
    );
    assert.equal(h.submissions, 0);
    assert.equal((await preparationRows(engine)).length, 2);
    await engine.transaction(true, async (client) => {
      await client.query(
        `UPDATE ${engine.table("results")} SET revoked=1 WHERE id='wq_input'`,
      );
    });
    await assert.rejects(
      engine.prepareQuery("query", args, imports),
      /unavailable/,
    );
    await assert.rejects(
      h.engine("owner-a", { allowSubmission: true }).startJob(final.job_id),
      /unavailable/,
    );
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});
test("multiple aliases reserve atomically and rollback the complete import set on binding failure", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture();
    const manyArgs = {
      ...args,
      inputs: { ...args.inputs, second: args.inputs.t },
    };
    const second = structuredClone(imports.t);
    second.payload.rows[0].value = "456";
    const many = { ...imports, second };
    const oldClient = h.client.bind(h);
    let fail = true;
    h.client = (namespace, schema) => {
      const client = oldClient(namespace, schema),
        query = client.query;
      client.query = async (sql, values) => {
        if (
          fail &&
          sql.startsWith("INSERT INTO") &&
          sql.includes("input_preparations")
        )
          throw Error("Synthetic pre-commit failure");
        return query(sql, values);
      };
      return client;
    };
    await assert.rejects(engine.prepareQuery("query", manyArgs, many));
    assert.deepEqual(await preparationRows(engine), []);
    fail = false;
    const pending = await engine.prepareQuery("query", manyArgs, many);
    assert.equal(pending.operation, "import_table");
    assert.equal((await preparationRows(engine)).length, 2);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});
test("lost preparation commit acknowledgement recovers the same bound jobs after restart", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture(),
      oldClient = h.client.bind(h);
    let inject = true;
    h.client = (namespace, schema) => {
      const client = oldClient(namespace, schema),
        query = client.query;
      client.query = async (sql, values) => {
        const result = await query(sql, values);
        if (
          inject &&
          sql.startsWith("INSERT INTO") &&
          sql.includes("input_preparations")
        ) {
          inject = false;
          h.loseCommitResponse = true;
        }
        return result;
      };
      return client;
    };
    await assert.rejects(engine.prepareQuery("query", args, imports));
    const saved = await preparationRows(engine);
    assert.equal(saved.length, 1);
    const recovered = await h.engine().prepareQuery("query", args, imports);
    assert.equal(recovered.job_id, saved[0].id);
    assert.equal((await preparationRows(engine)).length, 1);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("concurrent prepared claims converge on one owner identity and uncertain imports are never replaced", async () => {
  const h = await harness();
  try {
    const engine = h.engine("owner-a", { allowSubmission: true });
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture();
    h.loseSubmissionResponse = true;
    const attempts = await Promise.allSettled([
      engine.prepareQuery("query", args, imports),
      h
        .engine("owner-a", { allowSubmission: true })
        .prepareQuery("query", args, imports),
    ]);
    assert.ok(attempts.some((item) => item.status === "fulfilled"));
    const saved = await preparationRows(engine);
    assert.equal(saved.length, 1);
    assert.equal(h.submissions, 1);
    const replay = await h
      .engine("owner-a", { allowSubmission: true })
      .prepareQuery("query", args, imports);
    assert.equal(replay.job_id, saved[0].id);
    assert.equal(replay.status, "submission_unknown");
    assert.equal(h.submissions, 1);
    const other = h.engine("owner-b");
    await other.initialize();
    assert.equal(await other.lookupPreparedQuery("query", args), undefined);
  } finally {
    await h.close();
  }
});
test("preparation queue exhaustion rolls back every newly reserved alias and binding", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    await engine.transaction(true, async (client) => {
      await client.query(
        `INSERT INTO ${engine.table("jobs")}(id,request_id,operation,request_hash,request_json,status,created_at,updated_at,flight_id,max_runtime_sec) SELECT uuid(),uuid(),'query','synthetic','{}','queued','t','t',$1::UUID,120 FROM range(99)`,
        [flightId],
      );
    });
    const { args, imports } = preparationFixture(),
      second = structuredClone(imports.t);
    second.payload.rows[0].value = "456";
    await assert.rejects(
      engine.prepareQuery(
        "query",
        { ...args, inputs: { ...args.inputs, second: args.inputs.t } },
        { ...imports, second },
      ),
      /queue allowance/,
    );
    assert.equal((await preparationRows(engine)).length, 99);
    const bound = await engine.transaction(
      false,
      async (client) =>
        (
          await client.query(
            `SELECT count(*)::INTEGER AS count FROM ${engine.table("input_preparations")}`,
          )
        ).rows[0].count,
    );
    assert.equal(bound, 0);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("prepared imports advance every distinct pending dependency with one transaction allowance read", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture();
    const manyArgs = {
      ...args,
      inputs: {
        t: args.inputs.t,
        second: args.inputs.t,
        shared: args.inputs.t,
      },
    };
    const second = structuredClone(imports.t);
    second.payload.rows[0].value = "456";
    const many = { ...imports, second, shared: imports.t };
    let totals = 0;
    const oldClient = h.client.bind(h);
    h.client = (namespace, schema) => {
      const client = oldClient(namespace, schema),
        query = client.query;
      client.query = async (sql, values) => {
        if (sql.includes("sum(octet_length(encode(request_json)))")) totals++;
        return query(sql, values);
      };
      return client;
    };
    const advanced: string[] = [];
    // Control remote observation only; reservation and manifest SQL stay native.
    const dispatch = engine as unknown as {
      dispatchReserved(id: string, operation: string): Promise<Row>;
    };
    dispatch.dispatchReserved = async (job_id, operation) => {
      advanced.push(job_id);
      return { job_id, operation, pending: true, status: "queued" };
    };
    const pending = await engine.prepareQuery("query", manyArgs, many);
    assert.equal(pending.operation, "import_table");
    assert.equal(new Set(advanced).size, 2);
    assert.equal(
      advanced.length,
      2,
      "shared aliases must not advance a job twice",
    );
    assert.equal(
      totals,
      1,
      "all aliases and the preparation share one retained-byte snapshot",
    );
    assert.equal((await preparationRows(engine)).length, 2);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("preparation byte refusal rolls back all import reservations and the binding", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    await publish(engine, "wq_input");
    const { args, imports } = preparationFixture();
    let inserts = 0;
    const requestBytes = Buffer.byteLength(JSON.stringify(imports.t.payload));
    const oldClient = h.client.bind(h);
    h.client = (namespace, schema) => {
      const client = oldClient(namespace, schema),
        query = client.query;
      client.query = async (sql, values) => {
        if (sql.startsWith("INSERT INTO") && sql.includes('"jobs"')) inserts++;
        if (
          sql.startsWith("SELECT (SELECT count(*)") &&
          sql.includes("AS bytes")
        )
          return {
            rows: [{ queued: 0, bytes: 100 * 1024 * 1024 - requestBytes }],
          };
        return query(sql, values);
      };
      return client;
    };
    await assert.rejects(
      engine.prepareQuery("query", args, imports),
      /allowance exhausted/,
    );
    assert.equal(
      inserts,
      1,
      "the payload fits; binding bytes must refuse the atomic batch",
    );
    assert.deepEqual(await preparationRows(engine), []);
    const bindings = await engine.transaction(
      false,
      async (c) =>
        (
          await c.query(
            `SELECT count(*) AS count FROM ${engine.table("input_preparations")}`,
          )
        ).rows[0].count,
    );
    assert.equal(Number(bindings), 0);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("citation features require the actual pinned worker declaration before reservation", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const citation = {
      match: { value: 1 },
      column_key: "value",
      source_version_id: "src_one",
      quote: "Exact quotation",
    };
    for (const patch of [
      { contracts_literal: "" },
      { contracts_literal: JSON.stringify(JSON.stringify({})) },
      { source_hash: "f".repeat(64) },
      { requirements_hash: "f".repeat(64) },
    ]) {
      h.definitionPatch = patch;
      const capabilities = await engine.call<Row>("capabilities");
      assert.equal(capabilities.curated_citations, undefined);
      await assert.rejects(
        engine.call("query", { ...query(), citations: [citation] }),
        (error: any) => error.code === "unsupported_capability",
      );
      await assert.rejects(
        engine.call("import_table", {
          columns: [{ key: "value", logical_type: "BIGINT" }],
          rows: [{ value: "1" }],
          row_ids: ["row_0"],
          data_classification: "synthetic_fixture",
          parents: [],
          cell_origins: { encoding: "indexed-cells.v1", cells: [[0, 0, 0]] },
        }),
        (error: any) => error.code === "unsupported_capability",
      );
      assert.equal((await preparationRows(engine)).length, 0);
    }
    h.definitionPatch = {};
    const capabilities = await engine.call<Row>("capabilities");
    assert.deepEqual(
      capabilities.worker_feature_contracts,
      WORKER_FEATURE_CONTRACTS,
    );
    const job = await engine.call<Row>("query", {
      ...query(),
      citations: [citation],
    });
    h.definitionPatch = { contracts_literal: "" };
    await assert.rejects(
      engine.call("start_job", { job_id: job.job_id }),
      (error: any) => error.code === "unsupported_capability",
    );
    assert.equal(h.submissions, 0);
    assert.equal((await preparationRows(engine))[0].status, "queued");
  } finally {
    await h.close();
  }
});

test("malformed hosted citation recipes cannot reserve a job or contact the worker", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    for (const citation of [
      { quote: " \t" },
      { quote: "Exact", start: 0 },
      { quote: "Exact", start: 10, end: 2 },
      { quote: "Exact", match: { value: "x".repeat(8001) } },
    ]) {
      const before = h.statements.length;
      await assert.rejects(
        engine.call("query", {
          ...query(),
          citations: [
            {
              match: { value: 1 },
              column_key: "value",
              source_version_id: "src_one",
              ...citation,
            },
          ],
        }),
        (error: any) => error.code === "invalid_request",
      );
      assert.equal(h.statements.length, before);
    }
    assert.equal((await preparationRows(engine)).length, 0);
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});

test("native hosted inspection projects retained bodies and reauthorizes every dependency", async () => {
  const h = await harness();
  try {
    const engine = h.engine();
    await engine.initialize();
    const parent = await publish(engine, "wq_ancestor");
    const root = await publish(engine, "wq_inspected", {
      parents: [
        {
          result_id: parent.result_id,
          content_sha256: parent.content_sha256,
          view: "original",
          amendment_revision: null,
        },
      ],
    });
    const source = {
      source_version_id: "src_large",
      content: 'Untrusted "quoted" \n é🦆 '.repeat(20000),
    };
    const metadata = {
      ...root,
      provenance: { snapshot_id: "saved", amendment_revision: 4 },
      source_bindings: { src_large: "retained" },
      research_requirements: { fields: ["value"], key_columns: ["value"] },
      created_at: "2026-10-19T00:00:00Z",
      profile_revision: "b".repeat(64),
      query_sha256: "c".repeat(64),
      source_versions: [source],
      evidence: [{ row_id: "row_0", status: "supported_text" }],
      receipt: {
        ...root.receipt,
        resume_request: { private: "CONTROL_NOT_PUBLIC" },
      },
    };
    await engine.transaction(true, (client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET metadata=$1 WHERE id=$2`,
        [JSON.stringify(metadata), root.result_id],
      ),
    );
    h.returnedRows = [];
    const row = await engine.inspectResult({
      result_id: root.result_id,
      mode: "rows",
      limit: 1,
    });
    assert.deepEqual(row.rows, [{ value: "9007199254740993" }]);
    assert.equal(row.source_page.total, 1);
    assert.deepEqual(row.source_versions, []);
    assert.deepEqual(row.provenance, metadata.provenance);
    assert.equal(row.receipt.resume_request, undefined);
    assert.ok(row.latest_receipt);
    const page = await engine.inspectResult({
      result_id: root.result_id,
      mode: "evidence",
      limit: 1,
      max_bytes: 65536,
    });
    assert.equal(page.source_page.next_offset, null);
    assert.equal(page.source_page.chunk_required.record_index, 0);
    let encoded = "",
      offset = 0;
    do {
      const chunk = await engine.inspectResult({
        result_id: root.result_id,
        collection: "source_versions",
        record_index: 0,
        chunk_offset: offset,
        max_bytes: 65536,
      });
      assert.equal(chunk.offset_unit, "unicode_code_points");
      encoded += chunk.json_chunk;
      if (chunk.next_chunk_offset === null) break;
      assert.ok(chunk.next_chunk_offset > offset);
      offset = chunk.next_chunk_offset;
    } while (true);
    assert.deepEqual(JSON.parse(encoded), source);
    assert.ok(
      h.returnedRows.every(
        (rows) => Buffer.byteLength(JSON.stringify(rows)) < 65536,
      ),
    );
    assert.ok(!JSON.stringify(h.returnedRows).includes("CONTROL_NOT_PUBLIC"));
    await engine.transaction(true, (client) =>
      client.query(
        `UPDATE ${engine.table("results")} SET revoked=1 WHERE id=$1`,
        [parent.result_id],
      ),
    );
    for (const params of [
      { mode: "rows" },
      { mode: "evidence" },
      { collection: "source_versions", record_index: 0 },
      { collection: "rows", record_index: 0 },
    ]) {
      await assert.rejects(
        engine.inspectResult({ result_id: root.result_id, ...params }),
        (error: any) => error.code === "unauthorized",
      );
    }
    assert.equal(h.submissions, 0);
  } finally {
    await h.close();
  }
});
