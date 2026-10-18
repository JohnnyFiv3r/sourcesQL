/** Bounded remote fixture qualification. --execute and --submit are distinct opt-ins. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MotherDuckEngine,
  MotherDuckStateBackend,
  type SqlClient,
} from "../apps/research/server/motherduck.js";
import {
  parseQualificationOptions,
  loadQualificationConfiguration,
  qualificationPlan,
  assertQualificationReceipt,
  exactFlightRun,
} from "../apps/research/scripts/qualification-options.ts";

const options = parseQualificationOptions("storage", process.argv.slice(2));
const configuration = loadQualificationConfiguration(options);
if (!options.execute) {
  console.log(
    JSON.stringify(qualificationPlan("storage", options, configuration)),
  );
  process.exit(0);
}
const { setup } = configuration;
const directory = dirname(options.output),
  path = options.output,
  action = options.action;
mkdirSync(directory, { recursive: true });
let receipt: any = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : undefined;
if (receipt) assertQualificationReceipt(receipt, configuration.identity);
receipt ??= {
  schema: "sourcesql.hosted-storage-qualification.v2",
  identity: configuration.identity,
  database: setup.database,
  flight_id: setup.flight_id,
  wheel_sha256: setup.wheel_sha256,
  source_sha256: setup.flight_source_sha256,
  requirements_sha256: setup.requirements_sha256,
  effects: qualificationPlan("storage", options, configuration)
    .effects_if_executed,
  provider_calls: 0,
  auto_retries: 0,
  jobs: {},
  checks: {},
  created_at: new Date().toISOString(),
};
const save = () =>
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
const token =
  process.env.MOTHERDUCK_TOKEN ??
  JSON.parse(readFileSync(`${homedir()}/.motherduck/credentials.json`, "utf8"))
    .motherduck_token;
let discardAck = options.discardAck;
const clientFactory = (): SqlClient => {
  const client = new (createRequire(
    new URL("../apps/research/package.json", import.meta.url),
  )("pg").Client)({
    host: setup.host,
    port: 5432,
    database: setup.database,
    user: "user",
    password: token,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  });
  return {
    connect: () => client.connect(),
    end: () => client.end(),
    query: async (sql, values) => {
      const result = await client.query(sql, values);
      if (discardAck && /FROM md_run_flight\(/.test(sql)) {
        discardAck = false;
        receipt.simulated_lost_acknowledgements =
          (receipt.simulated_lost_acknowledgements ?? 0) + 1;
        save();
        throw Error("synthetic_lost_response");
      }
      return result;
    },
  };
};
const engine = new MotherDuckEngine({
  ...configuration.engineOptions,
  token,
  clientFactory,
});
const currentJobs = () => Object.entries(receipt.jobs) as [string, any][];
const storedJob = async (id: string) =>
  engine.transaction(
    false,
    async (client) =>
      (
        await client.query(
          `SELECT CAST(id AS VARCHAR) AS job_id,operation,status,CAST(flight_id AS VARCHAR) AS flight_id,
    CAST(flight_run_id AS VARCHAR) AS flight_run_id,CAST(flight_run_number AS VARCHAR) AS flight_run_number,
    flight_settled,result_id,cancel_requested,dispatch_intent_at FROM ${engine.table("jobs")} WHERE id=$1::UUID`,
          [id],
        )
      ).rows[0],
  );
try {
  await engine.initialize();
  if (["query", "materialize", "derived", "restore"].includes(action)) {
    let entry = receipt.jobs[action];
    if (!entry) {
      entry = receipt.jobs[action] = {
        request_id: randomUUID(),
        attempted_at: new Date().toISOString(),
      };
      save();
    }
    let result: any;
    if (action === "query")
      result = await engine.enqueue({
        request_id: entry.request_id,
        profile: "fixture",
        query: readFileSync(
          fileURLToPath(
            new URL("../examples/01_discovery.sql", import.meta.url),
          ),
          "utf8",
        ),
      });
    if (action === "materialize")
      result = await engine.enqueue(
        {
          columns: [
            { key: "id", logical_type: "BIGINT" },
            {
              key: "planned_mw",
              label: "Planned Capacity (MW)",
              logical_type: "DOUBLE",
            },
          ],
          rows: [{ id: "9007199254740993", planned_mw: 125.5 }],
          data_classification: "synthetic_fixture",
        },
        "import_table",
      );
    if (action === "derived") {
      const parent = receipt.jobs.materialize?.status;
      if (parent?.status !== "completed")
        throw Error("materialize_must_complete");
      result = await engine.enqueue({
        request_id: entry.request_id,
        profile: "fixture",
        query: "SELECT id, planned_mw FROM input.projects",
        inputs: { projects: { result_id: parent.result_id } },
      });
    }
    if (action === "restore") {
      const parent = receipt.jobs.derived?.status;
      if (parent?.status !== "completed") throw Error("derived_must_complete");
      result = await engine.enqueue(
        {
          bundle: await engine.call("export", { result_id: parent.result_id }),
        },
        "import",
      );
    }
    if (result.job_id) entry.submission = result;
    else {
      // A settled import can return a result directly. Resolve only its exact result,
      // never the newest job in a namespace shared with other owner work.
      const operation = action === "materialize" ? "import_table" : "import";
      const jobs = await engine.connection(
        async (client) =>
          (
            await client.query(
              `SELECT CAST(id AS VARCHAR) AS id FROM ${engine.table("jobs")} WHERE operation=$1 AND result_id=$2`,
              [operation, result.result_id],
            )
          ).rows,
      );
      if (jobs.length !== 1) throw Error("exact_import_job_not_unique");
      entry.submission = { job_id: jobs[0].id };
      entry.status = await engine.jobStatus(jobs[0].id);
      entry.output = result;
    }
    save();
    console.log(
      JSON.stringify({
        action,
        result: result.job_id ? result : entry.status,
        receipt: path,
      }),
    );
  } else if (action === "status") {
    if (options.job && !Object.hasOwn(receipt.jobs, options.job))
      throw Error("unknown_receipt_job");
    for (const [name, entry] of currentJobs()) {
      if (options.job && options.job !== name) continue;
      const id = entry.submission?.job_id;
      if (!id) continue;
      entry.status = await engine.jobStatus(id);
      save();
      console.log(JSON.stringify({ action, job: name, result: entry.status }));
    }
  } else if (action === "read") {
    const resultId = receipt.jobs.derived?.status?.result_id;
    if (!resultId) throw Error("complete_the_derived_fixture_first");
    const result: any = await engine.call("read_result", {
      result_id: resultId,
    });
    const state = new MotherDuckStateBackend(engine),
      before = await state.read();
    if (!before.state)
      await state.write(
        {
          snapshots: [],
          amendments: [],
          titles: { qualification: "durable correction history" },
        },
        before.version,
      );
    const current = await state.read();
    let staleRefused = false;
    try {
      await state.write(current.state!, "0");
    } catch (error: any) {
      staleRefused = error.code === "revision_conflict";
    }
    if (!staleRefused) throw Error("stale_write_not_refused");
    const restoredId = receipt.jobs.restore?.status?.result_id;
    if (restoredId) {
      const restored: any = await engine.call("read_result", {
        result_id: restoredId,
      });
      if (
        JSON.stringify(restored.rows) !== JSON.stringify(result.rows) ||
        restored.content_sha256 !== result.content_sha256
      )
        throw Error("restore_values_changed");
      receipt.checks.restore_roundtrip_exact = true;
      receipt.checks.restore_result_id = restoredId;
    }
    if (result.rows[0]?.id !== "9007199254740993")
      throw Error("large_integer_changed");
    const archive = await engine.call("export", { result_id: resultId });
    writeFileSync(
      resolve(directory, "archive.json"),
      JSON.stringify(archive) + "\n",
      { mode: 0o600 },
    );
    const counts = await engine.connection(
      async (client) =>
        (
          await client.query(
            `SELECT (SELECT count(*) FROM ${engine.table("jobs")})::INTEGER AS jobs,
      (SELECT count(*) FROM ${engine.table("results")})::INTEGER AS results,
      (SELECT count(*) FROM ${engine.table("app_state_history")})::INTEGER AS history,
      (SELECT coalesce(sum(reserved_seconds),0) FROM ${engine.table("flight_allowances")})::VARCHAR AS reserved_seconds`,
          )
        ).rows[0],
    );
    receipt.checks = {
      ...receipt.checks,
      bigint_preserved: true,
      fresh_native_read: true,
      stale_write_refused: staleRefused,
      durable_state_revision: current.version,
      row_count: result.row_count,
      rows: result.rows,
      columns: result.columns,
      archive_exported: true,
      ...counts,
    };
    save();
    console.log(JSON.stringify(receipt.checks));
  } else if (action === "logs") {
    for (const [name, entry] of currentJobs()) {
      const id = entry.submission?.job_id;
      if (!id) continue;
      const job = await storedJob(id);
      if (!job?.flight_run_number) continue;
      const run = exactFlightRun(job.flight_run_number);
      const rows = await engine.connection(
        async (client) =>
          (
            await client.query(
              `SELECT * FROM md_get_flight_logs(flight_id := '${setup.flight_id}'::UUID,run_number := ${run}::UBIGINT,"LIMIT" := 100,"ORDER" := 'desc')`,
            )
          ).rows,
      );
      for (const row of rows)
        for (const value of Object.values(row))
          if (
            typeof value === "string" &&
            value.startsWith('{"schema": "sourcesql.hosted-flight-run.v1"')
          ) {
            const report = JSON.parse(value.trim());
            if (report.job_id === id) {
              entry.flight_report = report;
              save();
              console.log(
                JSON.stringify({ job: name, run_number: run, report }),
              );
            }
          }
    }
  } else if (action === "cancel-running") {
    // This dedicated fixture is the only cancellable job; never select arbitrary active work.
    let entry = receipt.jobs.cancellation;
    if (!entry) {
      entry = receipt.jobs.cancellation = { request_id: randomUUID() };
      save();
    }
    const submitted = await engine.enqueue({
      request_id: entry.request_id,
      query: "SELECT CAST(1 AS BIGINT) AS value",
      profile: "fixture",
    });
    entry.submission = submitted;
    save();
    entry.status = await engine.cancelJob(submitted.job_id);
    save();
    console.log(JSON.stringify({ submitted, cancelled: entry.status }));
  } else if (action === "summary") {
    const jobs = [],
      runs = [];
    for (const [, entry] of currentJobs()) {
      const id = entry.submission?.job_id;
      if (!id) continue;
      const job = await storedJob(id);
      jobs.push(job);
      if (!job?.flight_run_number) continue;
      const run = exactFlightRun(job.flight_run_number);
      const details = await engine.connection(
        async (client) =>
          (
            await client.query(
              `SELECT CAST(run_id AS VARCHAR) AS run_id,CAST(flight_id AS VARCHAR) AS flight_id,
          flight_version,CAST(run_number AS VARCHAR) AS run_number,status,exit_code,
          CAST(created_at AS VARCHAR) AS created_at,CAST(started_at AS VARCHAR) AS started_at,
          CAST(ended_at AS VARCHAR) AS ended_at,epoch(ended_at-started_at) AS elapsed_seconds
          FROM md_get_flight_run(flight_id := '${job.flight_id}'::UUID,run_number := ${run}::UBIGINT)`,
            )
          ).rows,
      );
      runs.push(...details);
    }
    receipt.final_jobs = jobs;
    receipt.platform_runs = runs;
    receipt.observed_run_seconds = runs.reduce(
      (n, run) => n + Number(run.elapsed_seconds ?? 0),
      0,
    );
    receipt.completed_at = new Date().toISOString();
    save();
    console.log(
      JSON.stringify({
        jobs: jobs.length,
        runs: runs.length,
        observed_run_seconds: receipt.observed_run_seconds,
        statuses: runs.map((run) => run.status),
        provider_calls: 0,
        receipt: path,
      }),
    );
  }
} catch (error: any) {
  receipt.last_failure = {
    action,
    at: new Date().toISOString(),
    code: error.code ?? error.name,
  };
  save();
  console.error(
    JSON.stringify({
      action,
      failed: true,
      code: error.code ?? error.name,
      receipt: path,
    }),
  );
  process.exitCode = 1;
}
