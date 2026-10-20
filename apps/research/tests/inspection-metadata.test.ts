import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readInspectionMetadata } from "../server/inspection-metadata.js";
import type { InspectionSqlClient } from "../server/inspection-records.js";

type Row = Record<string, unknown>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const python =
  process.env.SOURCESQL_TEST_PYTHON ??
  join(root, "local/python312/venv/bin/python");
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const script = `import duckdb,json,sys
request=json.load(sys.stdin)
connection=duckdb.connect()
connection.execute('CREATE TABLE results(id VARCHAR, metadata VARCHAR)')
connection.execute('INSERT INTO results VALUES(?,?)',['saved_result',json.dumps(request['metadata'],ensure_ascii=False,separators=(',',':'))])
cursor=connection.execute(request['sql'],request['values'])
keys=[item[0] for item in cursor.description]
print(json.dumps([dict(zip(keys,row)) for row in cursor.fetchall()],ensure_ascii=False,separators=(',',':')))
`;
function fixture(metadata: Row) {
  const trace: { sql: string; values: unknown[]; rows: Row[] }[] = [];
  const client: InspectionSqlClient = {
    async query(sql, values = []) {
      // Provider fixture bodies stay on stdin rather than process arguments.
      const child = await new Promise<string>((resolve, reject) => {
        const process = execFile(
          python,
          ["-c", script],
          { maxBuffer: 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        process.stdin!.end(JSON.stringify({ metadata, sql, values }));
      });
      const rows = JSON.parse(child) as Row[];
      trace.push({ sql, values, rows });
      return { rows };
    },
  };
  return { client, trace };
}

test("bounded metadata preserves fitting public fields and strips bulk arrays and private controls in SQL", async () => {
  const control = "PRIVATE_RESUME_CONTROL_".repeat(10000);
  const published = {
    result_id: "saved_result",
    run_id: "run_saved",
    content_sha256: "a".repeat(64),
    provenance: {
      materialization_contract: "sourcesql.app-effective.v2",
      amendment_revision: 7,
    },
    research_requirements: { required_columns: ["value"] },
    source_bindings: [{ alias: "saved", result_id: "parent" }],
    cell_diagnostics: [{ row_id: "row_1", status: "unknown" }],
    created_at: "2026-10-19T10:00:00Z",
    profile_revision: "revision_7",
    query_sha256: "b".repeat(64),
    receipt: { status: "completed", resume_request: { control } },
    latest_receipt: { status: "completed", resume_request: { control } },
    foreign_receipt: { status: "completed", resume_request: { control } },
    resume_request: { control },
    source_versions: [{ content: control }],
    evidence: [{ support: [{ quote: control }] }],
    operator_outcomes: [{ content: control }],
    row_ids: ["row_1"],
    columns: [{ key: "value", logical_type: "VARCHAR" }],
  };
  const database = fixture(published);
  const result = await readInspectionMetadata(
    database.client,
    '"results"',
    "saved_result",
    8192,
  );
  const expected = { ...published } as Row;
  for (const key of [
    "resume_request",
    "source_versions",
    "evidence",
    "operator_outcomes",
    "row_ids",
    "columns",
  ])
    delete expected[key];
  for (const key of ["receipt", "latest_receipt", "foreign_receipt"])
    expected[key] = { status: "completed" };
  assert.deepEqual(result.metadata, expected);
  assert.deepEqual(result.omissions, []);
  assert.equal(database.trace.length, 2);
  for (const query of database.trace)
    assert.ok(!JSON.stringify(query.rows).includes("PRIVATE_RESUME_CONTROL"));
  assert.ok(size(result) <= 8192);
});

test("oversized optional metadata is omitted before transfer while provenance and identities survive", async () => {
  const published = {
    result_id: "saved_result",
    provenance: { amendment_revision: 7 },
    receipt: {
      status: "completed",
      events: [{ content: "LARGE_PROVIDER_PAYLOAD_".repeat(10000) }],
    },
    source_bindings: [{ content: "LARGE_PROVIDER_PAYLOAD_".repeat(10000) }],
    created_at: "2026-10-19T10:00:00Z",
  };
  const database = fixture(published);
  const result = await readInspectionMetadata(
    database.client,
    "results",
    "saved_result",
    4096,
  );
  assert.deepEqual(result.metadata, {
    result_id: published.result_id,
    provenance: published.provenance,
    created_at: published.created_at,
  });
  assert.deepEqual(result.omissions, [
    { field: "source_bindings", bytes: size(published.source_bindings) },
    { field: "receipt", bytes: size(published.receipt) },
  ]);
  for (const query of database.trace) {
    assert.ok(size(query.rows) <= 4096);
    assert.ok(!JSON.stringify(query.rows).includes("LARGE_PROVIDER_PAYLOAD"));
  }
  assert.ok(size(result) <= 4096);
});

test("metadata that fits exactly needs no conservative omission reserve", async () => {
  const published = { provenance: { note: "" } };
  published.provenance.note = "x".repeat(
    4096 - size({ metadata: published, omissions: [] }),
  );
  const database = fixture(published);
  const result = await readInspectionMetadata(
    database.client,
    "results",
    "saved_result",
    4096,
  );
  assert.deepEqual(result.metadata, published);
  assert.deepEqual(result.omissions, []);
  assert.equal(size(result), 4096);
});
