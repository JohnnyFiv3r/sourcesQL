import test from "node:test";
import assert from "node:assert/strict";
import type { EngineResult } from "../server/engine.js";
import {
  DEFAULT_PUBLIC_RESULT_BYTES,
  resultEvidencePage,
  resultRecordChunk,
  resultRowPage,
} from "../server/result-page.js";

type Row = Record<string, unknown>;
function fixture(): EngineResult & { offset: number } {
  return {
    result_id: "wq_large_retained_result",
    run_id: "run_retained_result",
    content_sha256: "a".repeat(64),
    data_classification: "public_web",
    offset: 0,
    columns: [
      { key: "count", label: "Count", logical_type: "BIGINT", nullable: false },
      {
        key: "price",
        label: "Price",
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
        price: "12345678901234567890123456.123456789012",
        unknown: null,
        detail: { name: "Café 🦆", flags: [true, false] },
      },
    ],
    row_ids: ["row_precise"],
    row_count: 1,
    next_offset: null,
    evidence: [
      {
        evidence_id: "ev_precise",
        row_id: "row_precise",
        column_key: "count",
        source_version_id: "src_0",
        support: [{ quote: "9007199254740993001" }],
      },
    ],
    source_versions: Array.from({ length: 377 }, (_, index) => ({
      source_version_id: `src_${index}`,
      url: `https://source.example/${index}`,
      content: "Published source text. Café 🦆 ".repeat(400),
      retrieved_at: "2026-10-19T10:00:00Z",
    })),
    receipt: { status: "completed", calls: 377 },
    research_quality: {
      goalStatus: "not_evaluated",
      requiredCells: 0,
      unresolvedCells: 0,
      rowShortfall: 0,
      gaps: [],
      gapsTotal: 0,
      gapsOmitted: 0,
      complete: false,
      scope: "declared_cells_and_minimum_rows",
      factualTruthVerified: false,
    },
  };
}
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function assemble(
  result: EngineResult,
  collection: "rows" | "source_versions" | "evidence",
  record_index: number,
  maxBytes = 8192,
) {
  let offset = 0,
    encoded = "";
  do {
    const chunk = resultRecordChunk(result, {
      collection,
      record_index,
      chunk_offset: offset,
      chunk_limit: 32768,
      maxBytes,
    });
    assert.ok(size(chunk) <= maxBytes);
    const text = chunk.json_chunk as string;
    assert.ok(!/[\uDC00-\uDFFF]/.test(text[0] ?? ""));
    assert.ok(!/[\uD800-\uDBFF]/.test(text.at(-1) ?? ""));
    encoded += text;
    if (chunk.next_chunk_offset === null) break;
    assert.ok(Number(chunk.next_chunk_offset) > offset);
    offset = Number(chunk.next_chunk_offset);
  } while (true);
  return JSON.parse(encoded);
}

test("hundreds of large retained sources cannot inflate a typed row page", () => {
  const result = fixture(),
    before = structuredClone(result);
  assert.ok(size(result) > 4 * 1024 * 1024);
  const page = resultRowPage(result, { offset: 0, limit: 1 });
  assert.ok(size(page) < DEFAULT_PUBLIC_RESULT_BYTES);
  for (const field of [
    "columns",
    "rows",
    "row_ids",
    "receipt",
    "research_quality",
  ] as const)
    assert.deepEqual(page[field], result[field]);
  assert.deepEqual(page.evidence, []);
  assert.deepEqual(page.source_versions, []);
  assert.deepEqual(page.source_page, {
    offset: 0,
    returned: 0,
    total: 377,
    next_offset: 0,
  });
  assert.equal((page.evidence_page as Row).total, 1);
  assert.equal(page.next_offset, null);
  assert.deepEqual(result, before);
});

test("byte-limited row pages advance by exactly the intact rows returned", () => {
  const result = fixture();
  const rows = Array.from({ length: 17 }, (_, i) => ({
    ...result.rows[0],
    detail: { name: `${i}:` + "é🦆".repeat(400), flags: [true, false] },
  }));
  const ids = rows.map((_, i) => `row_${i}`);
  let offset = 0;
  const received: EngineResult["rows"] = [],
    receivedIds: string[] = [];
  while (offset < rows.length) {
    const page = resultRowPage(
      {
        ...result,
        rows: rows.slice(offset),
        row_ids: ids.slice(offset),
        row_count: rows.length,
        offset,
        next_offset: null,
      },
      { offset, limit: 100, maxBytes: 8192 },
    );
    assert.ok(size(page) <= 8192);
    const returned = page.rows as EngineResult["rows"];
    assert.ok(returned.length > 0 && returned.length < rows.length);
    received.push(...returned);
    receivedIds.push(...(page.row_ids as string[]));
    assert.equal(
      page.next_offset,
      received.length < rows.length ? received.length : null,
    );
    if (page.next_offset === null) break;
    offset = Number(page.next_offset);
  }
  assert.deepEqual(received, rows);
  assert.deepEqual(receivedIds, ids);
});

test("a single oversized row reports its exact index and remains recoverable as JSON chunks", () => {
  const result = fixture();
  result.offset = 205;
  result.row_count = 206;
  result.rows[0].detail = {
    name: 'é🦆\\"\n'.repeat(3000),
    flags: [false, true],
  };
  const page = resultRowPage(result, { offset: 205, limit: 1, maxBytes: 8192 });
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.row_ids, []);
  assert.equal(page.next_offset, 205);
  assert.equal((page.row_page as Row).oversized_record_index, 205);
  assert.deepEqual(assemble(result, "rows", 205), result.rows[0]);
});

test("source pagination visits every retained source without repeating global bodies in row responses", () => {
  const result = fixture(),
    before = structuredClone(result);
  let sourceOffset = 0;
  const sources: Row[] = [];
  do {
    const page = resultEvidencePage(result, {
      source_offset: sourceOffset,
      source_limit: 100,
    });
    assert.ok(size(page) <= DEFAULT_PUBLIC_RESULT_BYTES);
    assert.deepEqual(page.evidence, result.evidence);
    const values = page.source_versions as Row[];
    assert.ok(values.length > 0 && values.length < 100);
    assert.deepEqual(
      values,
      result.source_versions.slice(sourceOffset, sourceOffset + values.length),
    );
    sources.push(...values);
    const pagination = page.source_page as Row;
    assert.equal(pagination.total, 377);
    assert.equal(
      pagination.next_offset,
      sources.length < 377 ? sources.length : null,
    );
    if (pagination.next_offset === null) break;
    sourceOffset = Number(pagination.next_offset);
  } while (true);
  assert.deepEqual(sources, result.source_versions);
  assert.deepEqual(result, before);
});

test("evidence scopes to selected rows and input-set lineage and has independent continuation", () => {
  const result = fixture();
  result.source_versions = result.source_versions
    .slice(0, 2)
    .map((s) => ({ ...s, content: "brief" }));
  result.evidence = [
    {
      evidence_id: "unrelated",
      row_id: "another_row",
      support: [{ quote: "Do not borrow me" }],
    },
    ...Array.from({ length: 6 }, (_, i) => ({
      evidence_id: `ev_${i}`,
      row_id: "row_precise",
      support: [{ quote: "Observed" }],
    })),
    { evidence_id: "input_set", lineage_level: "input_set" },
  ];
  const first = resultEvidencePage(result, {
    evidence_limit: 3,
    source_limit: 1,
  });
  assert.deepEqual(
    (first.evidence as Row[]).map((e) => e.evidence_id),
    ["ev_0", "ev_1", "ev_2"],
  );
  assert.equal((first.evidence_page as Row).next_offset, 3);
  assert.equal((first.evidence_page as Row).total, 7);
  assert.equal((first.source_page as Row).next_offset, 1);
  const last = resultEvidencePage(result, {
    evidence_offset: 6,
    evidence_limit: 3,
    source_offset: 1,
  });
  assert.deepEqual(
    (last.evidence as Row[]).map((e) => e.evidence_id),
    ["input_set"],
  );
  assert.equal((last.evidence_page as Row).next_offset, null);
  assert.equal((last.source_page as Row).next_offset, null);
});

test("oversized source and evidence records expose stable retained-array indexes and lossless Unicode chunks", () => {
  const result = fixture();
  result.source_versions = [
    { source_version_id: "src_oversized", content: 'é🦆\\"\n'.repeat(12000) },
  ];
  result.evidence = [
    { evidence_id: "ev_other", row_id: "other" },
    {
      evidence_id: "ev_large",
      row_id: "row_precise",
      support: [{ quote: "Untrusted source. 🦆".repeat(12000) }],
    },
  ];
  const page = resultEvidencePage(result, { maxBytes: 8192 });
  assert.deepEqual(page.source_versions, []);
  assert.deepEqual(page.evidence, []);
  assert.equal((page.source_page as Row).oversized_record_index, 0);
  assert.equal((page.evidence_page as Row).oversized_record_index, 1);
  assert.equal((page.source_page as Row).next_offset, 0);
  assert.deepEqual(
    assemble(result, "source_versions", 0),
    result.source_versions[0],
  );
  assert.deepEqual(assemble(result, "evidence", 1), result.evidence[1]);
});

test("small source and evidence fixtures keep their complete object shapes", () => {
  const result = fixture();
  result.source_versions = result.source_versions
    .slice(0, 3)
    .map((s) => ({ ...s, content: "short content" }));
  const page = resultEvidencePage(result);
  assert.deepEqual(page.evidence, result.evidence);
  assert.deepEqual(page.source_versions, result.source_versions);
  assert.equal((page.evidence_page as Row).next_offset, null);
  assert.equal((page.source_page as Row).next_offset, null);
  assert.deepEqual(
    resultEvidencePage(result, { source_offset: 3 }).source_versions,
    [],
  );
});

test("large receipt arrays are explicitly omitted while private resume controls never become chunks", () => {
  const result = fixture();
  result.receipt = {
    status: "completed",
    resume_request: { private: "never expose" },
    events: Array.from({ length: 100 }, () => ({ value: "x".repeat(2000) })),
  };
  const before = structuredClone(result);
  const page = resultRowPage(result, { maxBytes: 8192 });
  assert.deepEqual(page.receipt, { status: "completed" });
  assert.deepEqual(page.metadata_omitted, [
    { field: "receipt.events", bytes: size(result.receipt.events) },
  ]);
  assert.equal((page.metadata_inspection as Row).tool, "sourcesql_run_status");
  assert.ok(!JSON.stringify(page).includes("never expose"));
  assert.deepEqual(result, before);
});

test("invalid page and Unicode chunk boundaries are refused without changing records", () => {
  const result = fixture();
  assert.throws(() => resultRowPage({ ...result, row_ids: [] }), /identities/);
  assert.throws(() => resultRowPage(result, { offset: -1 }), /offset/);
  assert.throws(
    () => resultEvidencePage(result, { source_offset: -1 }),
    /offset/,
  );
  assert.throws(
    () =>
      resultRecordChunk(result, {
        collection: "source_versions",
        record_index: 377,
      }),
    /outside/,
  );
  const serialized = JSON.stringify(result.source_versions[0]);
  const split = serialized.indexOf("🦆") + 1;
  assert.throws(
    () =>
      resultRecordChunk(result, {
        collection: "source_versions",
        record_index: 0,
        chunk_offset: split,
      }),
    /boundary/,
  );
  assert.throws(
    () =>
      resultRecordChunk(result, {
        collection: "source_versions",
        record_index: 0,
        chunk_limit: 0,
      }),
    /boundary/,
  );
});

test("heavy advisory arrays stay explicit and internally consistent without blocking row reads", () => {
  const result = fixture();
  const gaps = Array.from({ length: 256 }, (_, index) => ({
    rowId: `row_${index}`,
    columnKey: "count",
    status: "unknown",
    diagnosticId: "diagnostic_" + "x".repeat(100),
  }));
  result.research_quality = {
    goalStatus: "partial",
    requiredCells: 256,
    unresolvedCells: 256,
    rowShortfall: 0,
    gaps,
    gapsTotal: 256,
    gapsOmitted: 0,
    complete: false,
    scope: "declared_cells_and_minimum_rows",
    factualTruthVerified: false,
  };
  const before = structuredClone(result);
  const page = resultRowPage(result, { maxBytes: 8192 });
  assert.deepEqual(page.rows, result.rows);
  const quality = page.research_quality as Row;
  assert.ok((quality.gaps as Row[]).length < 256);
  assert.equal(
    (quality.gaps as Row[]).length + Number(quality.gapsOmitted),
    256,
  );
  assert.equal(quality.gapsTotal, 256);
  assert.equal(quality.unresolvedCells, 256);
  assert.ok(
    (page.metadata_omitted as Row[]).some(
      (entry) => entry.field === "research_quality.gaps",
    ),
  );
  assert.ok(size(page) <= 8192);
  assert.deepEqual(result, before);
});

test("compact lineage, citation feedback and query identity stay available", () => {
  const result = {
    ...fixture(),
    citation_feedback: { advisory: true, bound_cells: 1 },
    parents: [
      { result_id: "wq_parent", view: "original", amendment_revision: null },
    ],
    lineage_precision: "cell_where_proven",
    replay_level: "values_only",
    bound_evidence_cells: 1,
    query: "SELECT count FROM prior",
    parameters: { exact: "9007199254740993001" },
    job_id: "job_readable",
    status: "completed",
    request_id: "request_readable",
  };
  const page = resultRowPage(result);
  for (const field of [
    "citation_feedback",
    "parents",
    "lineage_precision",
    "replay_level",
    "bound_evidence_cells",
    "query",
    "parameters",
    "job_id",
    "status",
    "request_id",
  ] as const)
    assert.deepEqual(page[field], result[field]);
});

test("oversized optional metadata is explicitly omitted instead of preventing a typed row read", () => {
  const result = {
    ...fixture(),
    citation_feedback: { unbounded_detail: "x".repeat(20000) },
    parameters: { large_value: "x".repeat(20000) },
    query: "SELECT '" + "x".repeat(20000) + "'",
  };
  const before = structuredClone(result);
  const page = resultRowPage(result, { maxBytes: 8192 });
  assert.deepEqual(page.rows, result.rows);
  assert.deepEqual(page.columns, result.columns);
  assert.ok(size(page) <= 8192);
  const fields = (page.metadata_omitted as Row[]).map((entry) => entry.field);
  for (const field of ["citation_feedback", "parameters", "query"]) {
    assert.ok(fields.includes(field));
    assert.equal(Object.hasOwn(page, field), false);
  }
  assert.match(String((page.metadata_inspection as Row).note), /export/);
  assert.deepEqual(result, before);
});

test("engine quality gap compaction preserves canonical snake_case counts", () => {
  const result = fixture();
  result.research_quality = {
    goal_status: "partial",
    required_cells: 256,
    unresolved_cells: 256,
    row_shortfall: 0,
    gaps: Array.from({ length: 256 }, (_, i) => ({
      row_id: `row_${i}`,
      column_key: "count",
      status: "unknown",
      diagnostic_id: "diagnostic_" + "x".repeat(70),
    })),
    gaps_total: 256,
    gaps_omitted: 0,
    complete: false,
    scope: "declared_cells_and_minimum_rows",
    factual_truth_verified: false,
  };
  const page = resultRowPage(result, { maxBytes: 8192 });
  const quality = page.research_quality as Row;
  assert.equal(
    (quality.gaps as Row[]).length + Number(quality.gaps_omitted),
    256,
  );
  assert.equal(quality.gaps_total, 256);
  assert.equal(Object.hasOwn(quality, "gapsOmitted"), false);
});
