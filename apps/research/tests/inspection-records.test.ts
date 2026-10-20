import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  readInspectionChunk,
  readInspectionRecords,
  type InspectionSqlClient,
} from "../server/inspection-records.js";

type Row = Record<string, unknown>;
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function sqlFixture(metadata: Row, rows: Row[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-inspection-"));
  const child = spawn(
    process.env.SOURCESQL_TEST_PYTHON ??
      join(root, "local/python312/venv/bin/python"),
    [
      fileURLToPath(
        new URL("./helpers/motherduck-sql-server.py", import.meta.url),
      ),
      join(directory, "records.duckdb"),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map<
    number,
    { resolve(value: Row[]): void; reject(error: Error): void }
  >();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Local inspection SQL unavailable"));
    }, 10000);
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      for (const waiter of pending.values())
        waiter.reject(new Error("Local inspection SQL closed"));
      pending.clear();
    });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.ready) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error)
        waiter.reject(
          new Error(`${message.error.type}: ${message.error.message}`),
        );
      else waiter.resolve(message.rows);
    });
  });
  child.stderr.on("data", () => {});
  const trace: { sql: string; values: unknown[]; rows: Row[] }[] = [];
  async function request(
    operation: string,
    sql?: string,
    values: unknown[] = [],
  ) {
    await ready;
    const id = ++sequence;
    const result = new Promise<Row[]>((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    child.stdin.write(
      JSON.stringify({
        id,
        connection_id: "inspection",
        operation,
        sql,
        values,
      }) + "\n",
    );
    return result;
  }
  const client: InspectionSqlClient = {
    async query(sql, values = []) {
      const rows = await request("query", sql, values);
      trace.push({ sql, values, rows });
      return { rows };
    },
  };
  await request("connect");
  await client.query(
    "CREATE TABLE results(id VARCHAR, metadata VARCHAR, wire_payload VARCHAR)",
  );
  await client.query("INSERT INTO results VALUES($1,$2,$3)", [
    "saved_result",
    JSON.stringify(metadata),
    JSON.stringify({ rows }),
  ]);
  trace.length = 0;
  return {
    client,
    trace,
    async close() {
      await request("end");
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      child.stdin.end();
      await closed;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("producer paging transfers no oversized body and chunk reconstruction stays bounded and lossless", async () => {
  const source = { id: "large", content: 'Café 🦆 \\ \"\n'.repeat(1500) };
  const fixture = await sqlFixture({
    source_versions: [source, { id: "small", content: "brief" }],
  });
  try {
    const first = await readInspectionRecords(
      fixture.client,
      '"results"',
      "saved_result",
      {
        collection: "source_versions",
        offset: 0,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(first.values, []);
    assert.deepEqual(first.indexes, []);
    assert.equal(first.page.next_offset, null);
    assert.equal(first.page.complete, false);
    assert.equal(first.page.chunk_required?.record_index, 0);
    assert.equal(first.page.chunk_required?.next_offset_after_chunk, 1);
    assert.equal(
      fixture.trace.length,
      1,
      "oversized-page planning must not request its body",
    );
    assert.ok(size(fixture.trace[0].rows) < 4096);
    assert.ok(!JSON.stringify(fixture.trace[0].rows).includes("Café"));
    let serialized = "",
      offset = 0;
    do {
      const chunk = await readInspectionChunk(
        fixture.client,
        "results",
        "saved_result",
        {
          collection: "source_versions",
          record_index: 0,
          chunk_offset: offset,
          chunk_limit: 131072,
          maxBytes: 4096,
        },
      );
      assert.equal(chunk.offset_unit, "unicode_code_points");
      assert.ok(size(chunk) <= 4096);
      assert.ok(!/[\uDC00-\uDFFF]/.test(chunk.json_chunk[0] ?? ""));
      assert.ok(!/[\uD800-\uDBFF]/.test(chunk.json_chunk.at(-1) ?? ""));
      serialized += chunk.json_chunk;
      if (chunk.next_chunk_offset === null) break;
      assert.ok(chunk.next_chunk_offset > offset);
      offset = chunk.next_chunk_offset;
    } while (true);
    assert.deepEqual(JSON.parse(serialized), source);
    for (const request of fixture.trace)
      assert.ok(
        size(request.rows) <= 4096,
        "SQL must project bounded descriptors or substrings",
      );
    const next = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "source_versions",
        offset: 1,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(next.values, [{ id: "small", content: "brief" }]);
    assert.deepEqual(next.indexes, [1]);
    assert.equal(next.page.total, 2);
    assert.equal(next.page.next_offset, null);
  } finally {
    await fixture.close();
  }
});

test("producer evidence scope preserves global record indexes and logical pagination", async () => {
  const evidence = [
    { id: "other", row_id: "another" },
    { id: "first", row_id: "selected" },
    { id: "input_set", row_id: null },
    { id: "other_again", row_id: "another" },
    { id: "last", row_id: "selected" },
  ];
  const diagnostics = [
    { row_id: "another", status: "unknown" },
    { row_id: "selected", status: "unknown" },
  ];
  const fixture = await sqlFixture({
    evidence,
    cell_diagnostics: diagnostics,
    source_versions: [],
  });
  try {
    const page = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "evidence",
        rowIds: ["selected"],
        offset: 1,
        limit: 1,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(page.values, [evidence[2]]);
    assert.deepEqual(page.indexes, [2]);
    assert.deepEqual(page.page, {
      offset: 1,
      returned: 1,
      total: 3,
      next_offset: 2,
    });
    const last = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "evidence",
        rowIds: ["selected"],
        offset: 2,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(last.values, [evidence[4]]);
    assert.deepEqual(last.indexes, [4]);
    assert.equal(last.page.next_offset, null);
    const selected = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "cell_diagnostics",
        rowIds: ["selected"],
        offset: 0,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(selected.values, [diagnostics[1]]);
    assert.deepEqual(selected.indexes, [1]);
    const omittedScope = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "cell_diagnostics",
        offset: 0,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.equal(omittedScope.page.total, 0);
    const beyond = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "evidence",
        rowIds: ["selected"],
        offset: 3,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(beyond.values, []);
    assert.equal(beyond.page.total, 3);
    assert.equal(beyond.page.next_offset, null);
  } finally {
    await fixture.close();
  }
});

test("wire rows preserve typed values, IDs and bound SQL identities", async () => {
  const rows = [
    {
      precise: "9007199254740993001",
      amount: "1.234567890123",
      optional: null,
      nested: { name: "Café 🦆", flags: [true, false] },
    },
  ];
  const fixture = await sqlFixture({ row_ids: ["row_precise"] }, rows);
  try {
    const page = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "rows",
        offset: 0,
        limit: 100,
        maxBytes: 4096,
      },
    );
    assert.deepEqual(page.values, rows);
    assert.deepEqual(page.indexes, [0]);
    const chunk = await readInspectionChunk(
      fixture.client,
      "results",
      "saved_result",
      { collection: "rows", record_index: 0, maxBytes: 4096 },
    );
    assert.equal(chunk.row_id, "row_precise");
    assert.deepEqual(JSON.parse(chunk.json_chunk), rows[0]);
    await assert.rejects(
      readInspectionRecords(
        fixture.client,
        "results; DROP TABLE results",
        "saved_result",
        { collection: "rows", offset: 0, limit: 1, maxBytes: 4096 },
      ),
      /identifier/,
    );
    const hostile = "saved_result' OR TRUE --";
    const absent = await readInspectionRecords(
      fixture.client,
      "results",
      hostile,
      { collection: "rows", offset: 0, limit: 1, maxBytes: 4096 },
    );
    assert.deepEqual(absent.values, []);
    assert.ok(!fixture.trace.at(-1)!.sql.includes(hostile));
    assert.equal(fixture.trace.at(-1)!.values[0], hostile);
    await assert.rejects(
      readInspectionChunk(fixture.client, "results", "saved_result", {
        collection: "rows",
        record_index: 1,
        maxBytes: 4096,
      }),
      /unavailable/,
    );
  } finally {
    await fixture.close();
  }
});

test("selected columns are projected before row length and body transfer", async () => {
  const fixture = await sqlFixture({}, [
    {
      value: "9007199254740993001",
      unknown: null,
      unselected: "PRIVATE_UNREQUESTED_".repeat(30000),
    },
  ]);
  try {
    const page = await readInspectionRecords(
      fixture.client,
      "results",
      "saved_result",
      {
        collection: "rows",
        offset: 0,
        limit: 1,
        columns: ["value", "unknown"],
        maxBytes: 4096,
      },
    );
    assert.deepEqual(page.values, [
      { value: "9007199254740993001", unknown: null },
    ]);
    assert.equal(page.page.returned, 1);
    assert.ok(!JSON.stringify(fixture.trace).includes("PRIVATE_UNREQUESTED_"));
  } finally {
    await fixture.close();
  }
});
