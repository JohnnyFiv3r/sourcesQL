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
  BackendError,
  type SqlClient,
} from "../server/motherduck.js";
import {
  exaConfiguration,
  exaFingerprint,
  type HostedExaPolicy,
} from "../server/hosted-exa.js";
import {
  hostedSearchConfiguration,
  hostedSearchFingerprint,
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
      dailySeconds: options.dailySeconds ?? 600,
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

test("runtime allowance is reserved at dispatch intent and stays held after uncertain submission", async () => {
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
    assert.equal(reserve.rows[0].seconds, "120");
    h.runs[0].status = "RUN_STATUS_FAILED";
    await engine.call("job_status", { job_id: first.job_id });
    await assert.rejects(engine.call("start_job", { job_id: second.job_id }), {
      code: "budget_exhausted",
    });
    assert.equal(h.submissions, 1);
    assert.equal(
      (await engine.call<Row>("job_status", { job_id: second.job_id })).status,
      "queued",
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
    assert.equal(await providerReserve(engine), "50000");
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
    assert.equal(await providerReserve(submitter), "50000");
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
    assert.equal(await providerReserve(submitter), "50000");
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

test("Exa reserves nothing for queued or unreviewed secret binding, then reserves at dispatch intent", async () => {
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
    assert.equal(await providerReserve(submitter), "50000");
    const after = (
      await submitter.connection((client) =>
        client.query(
          `SELECT dispatch_intent_at,provider_cost_reserved_microusd FROM ${submitter.table("jobs")} WHERE id=$1::UUID`,
          [queued.job_id],
        ),
      )
    ).rows[0];
    assert.ok(after.dispatch_intent_at);
    assert.equal(Number(after.provider_cost_reserved_microusd), 50_000);
  } finally {
    await h.close();
  }
});

test("Exa request replay does not duplicate dispatch or release an uncertain provider reserve", async () => {
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
    assert.equal(await providerReserve(engine), "50000");
    await assert.rejects(
      engine.call("query", { ...request, query: "SELECT 2 AS value" }),
      { code: "idempotency_conflict" },
    );
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(engine), "50000");
  } finally {
    await h.close();
  }
});

test("daily Exa reserve exhaustion refuses a second Flight before md_run_flight", async () => {
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
    h.runs[0].status = "RUN_STATUS_FAILED";
    await engine.call("job_status", { job_id: first.job_id });
    await assert.rejects(engine.call("start_job", { job_id: second.job_id }), {
      code: "budget_exhausted",
    });
    assert.equal(h.submissions, 1);
    assert.equal(await providerReserve(engine), "50000");
    const saved = (
      await engine.connection((client) =>
        client.query(
          `SELECT status,dispatch_intent_at,provider_cost_reserved_microusd FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [second.job_id],
        ),
      )
    ).rows[0];
    assert.equal(saved.status, "queued");
    assert.equal(saved.dispatch_intent_at, null);
    assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
    const runtime = (
      await engine.connection((client) =>
        client.query(
          `SELECT CAST(sum(reserved_seconds) AS VARCHAR) AS seconds FROM ${engine.table("flight_allowances")}`,
        ),
      )
    ).rows[0];
    assert.equal(
      runtime.seconds,
      "120",
      "Failed second reservation transaction must not consume runtime",
    );
  } finally {
    await h.close();
  }
});

function searchPolicy(
  provider: "brave" | "serper",
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
  h.flightSecrets = [policy.secretName];
}

for (const provider of ["brave", "serper"] as const) {
  const providerQuery = () => ({ ...liveQuery(), profile: provider });

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
      assert.equal(selected.cost_reporting, "unavailable");
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
        provider === "brave" ? "serper" : "brave",
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
      assert.equal(await providerReserve(submitter), "50000");
      const saved = (
        await submitter.connection((client) =>
          client.query(
            `SELECT dispatch_intent_at,provider_cost_reserved_microusd FROM ${submitter.table("jobs")} WHERE id=$1::UUID`,
            [queued.job_id],
          ),
        )
      ).rows[0];
      assert.ok(saved.dispatch_intent_at);
      assert.equal(Number(saved.provider_cost_reserved_microusd), 50_000);
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

  test(`${provider} lost-response replay preserves the reservation without duplicate Flight submission`, async () => {
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
      assert.equal(await providerReserve(engine), "5000");
      const replay = await h
        .engine("owner-a", { search: policy, allowSubmission: true })
        .call<Row>("query", { ...request, source_mode: "allow_excerpt" });
      assert.equal(replay.job_id, first.job_id);
      await engine.call("job_status", { job_id: first.job_id });
      assert.equal(h.submissions, 1);
      assert.equal(await providerReserve(engine), "5000");
      await assert.rejects(
        engine.call("query", { ...request, query: "SELECT 2 AS value" }),
        { code: "idempotency_conflict" },
      );
      assert.equal(h.submissions, 1);
    } finally {
      await h.close();
    }
  });

  test(`${provider} exhausted daily estimate refuses a second Flight without consuming execution allowance`, async () => {
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
      h.runs[0].status = "RUN_STATUS_FAILED";
      await engine.call("job_status", { job_id: first.job_id });
      await assert.rejects(
        engine.call("start_job", { job_id: second.job_id }),
        { code: "budget_exhausted" },
      );
      assert.equal(h.submissions, 1);
      assert.equal(await providerReserve(engine), "50000");
      const saved = (
        await engine.connection((client) =>
          client.query(
            `SELECT status,dispatch_intent_at,provider_cost_reserved_microusd FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
            [second.job_id],
          ),
        )
      ).rows[0];
      assert.equal(saved.status, "queued");
      assert.equal(saved.dispatch_intent_at, null);
      assert.equal(Number(saved.provider_cost_reserved_microusd), 0);
      const runtime = (
        await engine.connection((client) =>
          client.query(
            `SELECT CAST(sum(reserved_seconds) AS VARCHAR) AS seconds FROM ${engine.table("flight_allowances")}`,
          ),
        )
      ).rows[0];
      assert.equal(runtime.seconds, "120");
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
    for (const provider of ["brave", "serper"] as const) {
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

test("an exhausted automatic start preserves one queued handle across replay and cancellation without changing limits", async () => {
  const h = await harness();
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
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

test("an exhausted provider allowance returns the queued handle and rolls back execution reservation", async () => {
  const h = await harness();
  try {
    const policy = searchPolicy("brave", { dailyCostMicrousd: 50_000 });
    configureSearch(h, policy);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
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
    assert.equal(direct.error.message, "Research execution failed safely");
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

test("MCP returns the blocked queued receipt and same-ID resume guidance rather than an error", async () => {
  const h = await harness();
  const client = new Client({ name: "budget-boundary-test", version: "1" });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    configureExa(h);
    const engine = h.engine("owner-a", {
      allowSubmission: true,
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
