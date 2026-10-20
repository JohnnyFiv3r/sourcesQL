import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";

type Row = Record<string, unknown>;
const RESPONSE_BYTES = 4 * 1024 * 1024;
const encodedSize = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function retainedResult(): EngineResult & { offset: number } {
  return {
    result_id: "wq_many_sources",
    run_id: "run_many_sources",
    content_sha256: "a".repeat(64),
    offset: 0,
    columns: [
      { key: "count", label: "Count", logical_type: "BIGINT", nullable: false },
      {
        key: "amount",
        label: "Amount",
        logical_type: "DECIMAL(38,12)",
        nullable: false,
      },
      {
        key: "unknown",
        label: "Unknown",
        logical_type: "VARCHAR",
        nullable: true,
      },
      {
        key: "detail",
        label: "Detail",
        logical_type: "STRUCT(name VARCHAR, flags BOOLEAN[])",
        nullable: false,
      },
    ],
    rows: [
      {
        count: "9007199254740993001",
        amount: "12345678901234567890123456.123456789012",
        unknown: null,
        detail: { name: "Café 🦆", flags: [true, false] },
      },
    ],
    row_ids: ["row_typed"],
    row_count: 1,
    next_offset: null,
    data_classification: "public_web",
    evidence: [
      {
        evidence_id: "ev_count",
        row_id: "row_typed",
        column_key: "count",
        source_version_id: "src_0",
        status: "supported_text",
        support: [{ quote: "9007199254740993001" }],
      },
    ],
    source_versions: Array.from({ length: 377 }, (_, i) => ({
      source_version_id: `src_${i}`,
      url: `https://source.example/${i}`,
      content: `Version ${i}: ` + "é🦆".repeat(1400),
      retrieved_at: "2026-10-19T10:00:00Z",
    })),
    receipt: { status: "completed", finished_at: "2026-10-19T10:01:00Z" },
    research_quality: {
      goal_status: "not_evaluated",
      required_cells: 0,
      unresolved_cells: 0,
      row_shortfall: 0,
      gaps: [],
      gaps_total: 0,
      gaps_omitted: 0,
      complete: false,
      scope: "declared_cells_and_minimum_rows",
      factual_truth_verified: false,
    },
  };
}
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-bounded-read-"));
  const result = retainedResult();
  // One record is too large even when a source page contains no other records.
  result.source_versions[376].content = 'Untrusted "quoted" \\ \n é🦆 '.repeat(
    40000,
  );
  const seed = resultSnapshot(result, {
    result_id: result.result_id,
    snapshot_id: "saved_bounded",
    title: "Typed evidence fixture",
  });
  const store = new ResearchStore(join(directory, "store"), seed);
  const calls: { method: string; params: Row }[] = [];
  const control = { revoked: false };
  const engine: ResearchEngine = {
    async call<T>(method: string, params: Row = {}): Promise<T> {
      calls.push({ method, params: structuredClone(params) });
      assert.equal(
        method,
        "read_result",
        "result inspection must never start provider work or a Flight",
      );
      assert.equal(params.result_id, result.result_id);
      if (control.revoked) throw new Error("Revoked result access denied");
      const offset = Number(params.offset ?? 0),
        limit = Number(params.limit ?? 100);
      const columns =
        params.columns === undefined
          ? result.columns
          : result.columns.filter((c) =>
              (params.columns as string[]).includes(c.key),
            );
      return structuredClone({
        ...result,
        columns,
        rows: result.rows
          .slice(offset, offset + limit)
          .map((row) =>
            Object.fromEntries(columns.map((c) => [c.key, row[c.key]])),
          ),
        row_ids: result.row_ids.slice(offset, offset + limit),
        offset,
        next_offset: offset + limit < result.row_count ? offset + limit : null,
      }) as T;
    },
  };
  const html = join(directory, "research.html");
  await writeFile(html, "<html><body>Synthetic local fixture</body></html>");
  const server = createServer(store, html, {
    engine,
    responseByteLimit: RESPONSE_BYTES,
    access: {
      mode: "protected",
      principal: "bounded-read-owner",
      allowPrivateDisclosure: false,
    },
  });
  const client = new Client({ name: "bounded-read-boundary", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    result,
    calls,
    control,
    client,
    close: async () => {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("public MCP row read succeeds under 4 MiB with 377 large retained sources and exact typed values", async () => {
  const app = await harness();
  try {
    const oldResponse = {
      content: [{ type: "text", text: JSON.stringify(app.result) }],
      structuredContent: app.result,
    };
    assert.ok(
      encodedSize(oldResponse) > RESPONSE_BYTES,
      "fixture must reproduce the old hosted failure",
    );
    const response = await app.client.callTool({
      name: "sourcesql_read_result",
      arguments: { result_id: app.result.result_id, limit: 1 },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    assert.ok(encodedSize(response) < RESPONSE_BYTES);
    const page = response.structuredContent as Row;
    assert.deepEqual(page.rows, app.result.rows);
    assert.deepEqual(page.columns, app.result.columns);
    assert.deepEqual(page.row_ids, app.result.row_ids);
    assert.equal(page.row_count, 1);
    assert.equal(page.next_offset, null);
    assert.equal((page.source_page as Row).total, 377);
    assert.equal((page.evidence_page as Row).total, 1);
    assert.deepEqual(page.source_versions, []);
    assert.deepEqual(page.research_quality, app.result.research_quality);
    assert.equal(app.calls.length, 1);
    const projected = await app.client.callTool({
      name: "sourcesql_read_result",
      arguments: {
        result_id: app.result.result_id,
        limit: 1,
        columns: ["count", "unknown"],
      },
    });
    assert.notEqual(projected.isError, true);
    assert.deepEqual((projected.structuredContent as Row).rows, [
      { count: "9007199254740993001", unknown: null },
    ]);
  } finally {
    await app.close();
  }
});

test("MCP source pages and oversized-source chunks reconstruct every retained body without new work", async () => {
  const app = await harness();
  try {
    const sources: Row[] = [];
    let sourceOffset = 0,
      usedChunk = false;
    while (sourceOffset < app.result.source_versions.length) {
      const response = await app.client.callTool({
        name: "sourcesql_inspect_evidence",
        arguments: {
          result_id: app.result.result_id,
          limit: 1,
          evidence_limit: 0,
          source_offset: sourceOffset,
          source_limit: 100,
        },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      assert.ok(encodedSize(response) < RESPONSE_BYTES);
      const page = response.structuredContent as Row,
        pagination = page.source_page as Row;
      assert.equal(pagination.total, 377);
      const batch = page.source_versions as Row[];
      assert.deepEqual(
        batch,
        app.result.source_versions.slice(
          sourceOffset,
          sourceOffset + batch.length,
        ),
      );
      sources.push(...batch);
      if (batch.length) {
        if (pagination.next_offset === null) break;
        assert.equal(pagination.next_offset, sourceOffset + batch.length);
        sourceOffset = Number(pagination.next_offset);
        continue;
      }
      assert.equal(pagination.oversized_record_index, sourceOffset);
      assert.equal(pagination.next_offset, sourceOffset);
      let chunkOffset = 0,
        encoded = "";
      do {
        const chunkResponse = await app.client.callTool({
          name: "sourcesql_inspect_evidence",
          arguments: {
            result_id: app.result.result_id,
            collection: "source_versions",
            record_index: sourceOffset,
            chunk_offset: chunkOffset,
            chunk_limit: 131072,
          },
        });
        assert.notEqual(
          chunkResponse.isError,
          true,
          JSON.stringify(chunkResponse.content),
        );
        assert.ok(encodedSize(chunkResponse) < RESPONSE_BYTES);
        const chunk = chunkResponse.structuredContent as Row;
        assert.equal(chunk.collection, "source_versions");
        assert.equal(chunk.record_index, sourceOffset);
        assert.equal(chunk.offset_unit, "utf16_code_units");
        const text = chunk.json_chunk as string;
        assert.ok(!/[\uDC00-\uDFFF]/.test(text[0] ?? ""));
        assert.ok(!/[\uD800-\uDBFF]/.test(text.at(-1) ?? ""));
        encoded += text;
        if (chunk.next_chunk_offset === null) break;
        assert.ok(Number(chunk.next_chunk_offset) > chunkOffset);
        chunkOffset = Number(chunk.next_chunk_offset);
      } while (true);
      sources.push(JSON.parse(encoded));
      sourceOffset++;
      usedChunk = true;
    }
    assert.equal(usedChunk, true);
    assert.deepEqual(sources, app.result.source_versions);
    assert.ok(app.calls.length > 2);
    assert.ok(app.calls.every((call) => call.method === "read_result"));
  } finally {
    await app.close();
  }
});

test("MCP chunk inspection rechecks private host disclosure even after an earlier public read", async () => {
  const app = await harness();
  try {
    const first = await app.client.callTool({
      name: "sourcesql_read_result",
      arguments: { result_id: app.result.result_id, limit: 1 },
    });
    assert.notEqual(first.isError, true);
    app.result.data_classification = "private_derived";
    app.result.rows[0].unknown = "PRIVATE_ROW_MARKER";
    app.result.source_versions[0].content = "PRIVATE_SOURCE_MARKER";
    for (const args of [
      { collection: "rows", record_index: 0 },
      { collection: "source_versions", record_index: 0 },
      { collection: "evidence", record_index: 0 },
    ]) {
      const response = await app.client.callTool({
        name: "sourcesql_inspect_evidence",
        arguments: { result_id: app.result.result_id, ...args },
      });
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent, undefined);
      assert.match(JSON.stringify(response.content), /Private host disclosure/);
      assert.ok(!JSON.stringify(response).includes("PRIVATE_ROW_MARKER"));
      assert.ok(!JSON.stringify(response).includes("PRIVATE_SOURCE_MARKER"));
    }
    assert.equal(app.calls.length, 4);
  } finally {
    await app.close();
  }
});

test("MCP chunk continuation cannot bypass a newly revoked canonical result", async () => {
  const app = await harness();
  try {
    const first = await app.client.callTool({
      name: "sourcesql_inspect_evidence",
      arguments: {
        result_id: app.result.result_id,
        collection: "source_versions",
        record_index: 376,
        chunk_limit: 100,
      },
    });
    assert.notEqual(first.isError, true);
    const nextOffset = (first.structuredContent as Row).next_chunk_offset;
    assert.equal(typeof nextOffset, "number");
    app.control.revoked = true;
    const second = await app.client.callTool({
      name: "sourcesql_inspect_evidence",
      arguments: {
        result_id: app.result.result_id,
        collection: "source_versions",
        record_index: 376,
        chunk_offset: nextOffset,
      },
    });
    assert.equal(second.isError, true);
    assert.equal(second.structuredContent, undefined);
    assert.match(
      JSON.stringify(second.content),
      /Revoked result access denied/,
    );
    assert.ok(!JSON.stringify(second).includes("json_chunk"));
    assert.equal(app.calls.length, 2);
  } finally {
    await app.close();
  }
});
