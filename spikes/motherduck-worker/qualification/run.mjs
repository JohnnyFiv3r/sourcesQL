// Operator-only qualification: one F4/120s run per reviewed installer revision.
// The initial failed installer run is retained; neither revision retries dispatch.
// Credentials remain in process memory; receipts omit raw logs and SQL errors.
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const revision = process.argv[3] ?? "initial";
const artifactPaths = {
  initial: "motherduck-flight-install-failure/",
  installer: "motherduck-flight-unix-control-failure/",
  unix: "motherduck-flight/",
};
const artifact = new URL("artifacts/worker-qualification/"
  + (artifactPaths[revision] ?? "invalid-revision/"), root);
const ledgerFile = new URL("operator-receipt.json", artifact);
const database = "sourcesql_probe_20261014";
const host = "pg.us-east-1-aws.motherduck.com";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const columns = `CAST(run_id AS VARCHAR) AS run_id,
  CAST(flight_id AS VARCHAR) AS flight_id, flight_version,
  CAST(run_number AS VARCHAR) AS run_number, status, exit_code,
  CAST(config AS JSON)::VARCHAR AS config_json,
  CAST(created_at AS VARCHAR) AS created_at,
  CAST(started_at AS VARCHAR) AS started_at,
  CAST(ended_at AS VARCHAR) AS ended_at`;
let client, ledger;

function save() {
  mkdirSync(artifact, { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
}
function decode(row) {
  const { config_json, ...run } = row;
  if (!uuid.test(run.run_id) || !uuid.test(run.flight_id)
      || !/^[1-9][0-9]{0,19}$/.test(run.run_number)) throw new Error("Invalid run identity");
  const config = JSON.parse(config_json);
  if (run.flight_id !== ledger.flight_id || config.REQUEST_ID !== ledger.request_id
      || config.DATABASE !== database) throw new Error("Uncorrelated run");
  // Only the two fixed, nonsecret config values enter receipts.
  return { ...run, config: { REQUEST_ID: config.REQUEST_ID, DATABASE: database } };
}
async function connect() {
  const credential = JSON.parse(readFileSync(`${homedir()}/.motherduck/credentials.json`, "utf8"));
  if (typeof credential.motherduck_token !== "string") throw new Error("Missing local credential");
  client = new Client({ host, port: 5432, database, user: "user",
    password: credential.motherduck_token, ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000, query_timeout: 30000 });
  await client.connect();
}
async function recoveredRun() {
  if (ledger.run) {
    const rows = (await client.query(`SELECT ${columns} FROM md_get_flight_run(
      flight_id := '${ledger.flight_id}'::UUID,
      run_number := ${ledger.run.run_number}::UBIGINT)`)).rows;
    if (rows.length !== 1) throw new Error("Missing exact run");
    return decode(rows[0]);
  }
  const rows = (await client.query(`SELECT ${columns} FROM md_list_flight_runs(
    flight_id := '${ledger.flight_id}'::UUID, "LIMIT" := 20)`)).rows;
  const matches = rows.filter((row) => JSON.parse(row.config_json).REQUEST_ID === ledger.request_id);
  if (matches.length !== 1) throw new Error("Uncertain outcome; never resubmit");
  return decode(matches[0]);
}

try {
  const action = process.argv[2];
  if (!["initial", "installer", "unix"].includes(revision)
      || !["create", "submit", "status", "read", "logs"].includes(action)) {
    throw new Error("Choose a fixed qualification operation");
  }
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", artifact), "utf8"));
  const source = readFileSync(new URL("flight.py", artifact), "utf8");
  const requirements = readFileSync(new URL("requirements.txt", artifact), "utf8");
  if (hash(source) !== manifest.flight_source_sha256
      || hash(requirements) !== manifest.requirements_sha256
      || Buffer.byteLength(source) > 200000 || Buffer.byteLength(requirements) > 20000
      || manifest.expected_tests !== 235 || manifest.expected_linux_tests !== 44
      || manifest.expected_macos_skips !== 4
      || Object.keys(manifest.versions).length !== (revision === "initial" ? 36 : 37)
      || (revision !== "initial" && manifest.versions.installer !== "0.7.0")) {
    throw new Error("Unreviewed qualification bundle");
  }
  try { ledger = JSON.parse(readFileSync(ledgerFile, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (action === "create") {
    if (ledger) throw new Error("Creation already attempted; inspect instead");
    ledger = { schema: "sourcesql.worker-flight-operator.v1", request_id: randomUUID(),
      created_at: new Date().toISOString(), database, host, revision, instance_type: "F4",
      max_runtime_sec: 120, scheduled: false, max_submission_attempts: 1,
      submission_attempts: 0, provider_calls: 0, automatic_retry: false,
      source_sha256: manifest.flight_source_sha256,
      wheel_sha256: manifest.wheel_sha256, creation_attempted: true };
    save();
    await connect();
    const rows = (await client.query(`SELECT CAST(flight_id AS VARCHAR) AS flight_id,
      flight_name, current_version FROM md_create_flight(
      name := 'sourcesql_worker_qualification_20261014_${revision}', source_code := ${literal(source)},
      requirements_txt := ${literal(requirements)},
      config := MAP {'REQUEST_ID': 'unsubmitted', 'DATABASE': '${database}'},
      instance_type := 'F4', max_runtime_sec := 120)`)).rows;
    if (rows.length !== 1 || !uuid.test(rows[0].flight_id)) throw new Error("Invalid creation result");
    Object.assign(ledger, rows[0]);
    save();
    console.log(JSON.stringify({ created: true, flight_id: ledger.flight_id,
      request_id: ledger.request_id, instance_type: "F4", max_runtime_sec: 120, scheduled: false }));
  } else {
    if (!ledger || !uuid.test(ledger.flight_id) || !uuid.test(ledger.request_id)
        || ledger.source_sha256 !== manifest.flight_source_sha256) throw new Error("Missing reviewed ledger");
    await connect();
    if (action === "submit") {
      if (ledger.submission_attempts !== 0) throw new Error("Submission already attempted; recover instead");
      ledger.submission_attempts = 1;
      ledger.dispatch_intent_at = new Date().toISOString();
      ledger.dispatch_outcome = "uncertain";
      save();
      const rows = (await client.query(`SELECT ${columns} FROM md_run_flight(
        flight_id := '${ledger.flight_id}'::UUID,
        config := MAP {'REQUEST_ID': '${ledger.request_id}'})`)).rows;
      if (rows.length !== 1) throw new Error("Unexpected submission result");
      ledger.run = decode(rows[0]);
      ledger.dispatch_outcome = "acknowledged";
      save();
      console.log(JSON.stringify({ submitted: true, run: ledger.run, automatic_retry: false }));
    } else if (action === "status") {
      ledger.run = await recoveredRun();
      save();
      console.log(JSON.stringify({ run: ledger.run, submission_attempts: ledger.submission_attempts }));
    } else if (action === "read") {
      // New process/connection reads the completed report without starting Python.
      const rows = (await client.query(`SELECT report_json FROM sourcesql_worker_qualification
        WHERE request_id = $1::UUID`, [ledger.request_id])).rows;
      if (rows.length !== 1) throw new Error("Report not persisted");
      const report = JSON.parse(rows[0].report_json);
      if (report.request_id !== ledger.request_id
          || report.schema !== "sourcesql.worker-qualification.v1"
          || report.bundle_manifest.wheel_sha256 !== manifest.wheel_sha256) throw new Error("Uncorrelated report");
      writeFileSync(new URL("motherduck-report.json", artifact), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      ledger.stored_report_read_at = new Date().toISOString();
      ledger.qualification_passed = report.passed;
      save();
      console.log(JSON.stringify({ passed: report.passed, persisted: report.persisted,
        phase: report.phase, error_type: report.error_type,
        python: report.runtime.python, architecture: report.runtime.architecture,
        kernel: report.runtime.kernel, uid: report.runtime.uid,
        landlock_abi: report.runtime.landlock_abi,
        pytest: report.pytest, engine_fixture: report.engine_fixture,
        source_sha256: manifest.flight_source_sha256, provider_calls: report.provider_calls }));
    } else {
      const run = await recoveredRun();
      const rows = (await client.query(`SELECT * FROM md_get_flight_logs(
        flight_id := '${ledger.flight_id}'::UUID, run_number := ${run.run_number}::UBIGINT,
        "LIMIT" := 100, "ORDER" := 'desc')`)).rows;
      const reports = [];
      for (const row of rows) for (const value of Object.values(row)) {
        if (typeof value !== "string" || !value.startsWith('{"schema": "sourcesql.worker-qualification.v1"')) continue;
        try {
          const report = JSON.parse(value.trim());
          if (report.request_id === ledger.request_id) reports.push(report);
        } catch { /* Raw logs are never printed or saved. */ }
      }
      for (const report of reports) {
        writeFileSync(new URL("motherduck-log-report.json", artifact), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      }
      console.log(JSON.stringify({ log_rows: rows.length, structured_reports: reports.length,
        report_summaries: reports.map((report) => ({ passed: report.passed, phase: report.phase,
          error_type: report.error_type, persistence_error_type: report.persistence_error_type,
          landlock_abi: report.runtime.landlock_abi, python: report.runtime.python })) }));
    }
  }
} catch (error) {
  // No remote error message, SQL/source body, traceback or credentials escape.
  console.error(JSON.stringify({ operation: process.argv[2], error_type: error.name,
    operation_failed: true, automatic_retry: false,
    inspect_local_receipt: fileURLToPath(ledgerFile) }));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
