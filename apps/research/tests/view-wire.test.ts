import test from "node:test";
import assert from "node:assert/strict";
import { resultSnapshot, type EngineResult } from "../server/engine.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import { encodeResearchView, decodeResearchView } from "../src/view-wire.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import sample from "../fixtures/water-procurement.json";

function diagnosticView(): ResearchView {
  const result: EngineResult = {
    result_id: "wq_wire",
    run_id: "run_wire",
    row_count: 1,
    row_ids: ["row_known"],
    columns: [
      {
        key: "capacity",
        label: "Capacity",
        logical_type: "INTEGER",
        nullable: true,
      },
    ],
    rows: [{ capacity: null }],
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    source_versions: [],
    evidence: [],
    receipt: { status: "completed", finished_at: "2026-10-17T12:00:00Z" },
    next_offset: null,
  };
  const snapshot = snapshotSchema.parse(
    resultSnapshot(result, {
      result_id: result.result_id,
      snapshot_id: "saved_wire",
      title: "Saved research",
    }),
  );
  snapshot.researchQuality = {
    goalStatus: "partial",
    requiredCells: 1,
    unresolvedCells: 1,
    rowShortfall: 0,
    gaps: [{ rowId: "row_known", columnKey: "capacity", status: "not_stated" }],
    gapsTotal: 1,
    gapsOmitted: 0,
    complete: false,
    scope: "declared_cells_and_minimum_rows",
    factualTruthVerified: false,
  };
  snapshot.rows[0].cellDiagnostics = { capacity: [{ status: "not_stated" }] };
  return {
    snapshot,
    displayTitle: snapshot.title,
    amendments: [],
    revision: 0,
    snapshots: [],
    requests: [],
  };
}

test("published snapshot v2 wire stays compatible while quality and cell diagnostics round-trip unchanged", () => {
  const view = diagnosticView(),
    before = structuredClone(view);
  const wire = structuredClone(encodeResearchView(view));
  assert.equal(Object.hasOwn(wire.snapshot, "researchQuality"), false);
  assert.equal(Object.hasOwn(wire.snapshot.rows[0], "cellDiagnostics"), false);
  assert.equal(wire.snapshot.rows[0].values.capacity, null);
  assert.deepEqual(
    wire.presentationV1?.researchQuality,
    view.snapshot.researchQuality,
  );
  assert.deepEqual(wire.presentationV1?.rows[0], {
    rowId: "row_known",
    cellDiagnostics: view.snapshot.rows[0].cellDiagnostics,
  });
  assert.deepEqual(decodeResearchView(wire), view);
  assert.deepEqual(
    view,
    before,
    "Wire projection must not mutate canonical stored data",
  );
});

test("undefined additions are omitted before structured cloning, not assigned undefined", () => {
  const view = diagnosticView();
  view.snapshot.researchQuality = undefined;
  view.snapshot.rows[0].cellDiagnostics = undefined;
  const wire = structuredClone(encodeResearchView(view));
  assert.equal(Object.hasOwn(wire.snapshot, "researchQuality"), false);
  assert.equal(Object.hasOwn(wire.snapshot.rows[0], "cellDiagnostics"), false);
  assert.equal(Object.hasOwn(wire, "presentationV1"), false);
  assert.equal(Object.hasOwn(view.snapshot, "researchQuality"), true);
});

test("display metadata cannot attach to a different table, row or column or claim verified truth", () => {
  const original = encodeResearchView(diagnosticView());
  for (const mutate of [
    (wire: typeof original) => {
      wire.presentationV1!.snapshotId = "another_table";
    },
    (wire: typeof original) => {
      wire.presentationV1!.rows[0].rowId = "another_row";
    },
    (wire: typeof original) => {
      wire.presentationV1!.rows.push(wire.presentationV1!.rows[0]);
    },
    (wire: typeof original) => {
      wire.presentationV1!.rows[0].cellDiagnostics = {
        other_column: [{ status: "not_stated" }],
      };
    },
    (wire: typeof original) => {
      (wire.presentationV1!.researchQuality as any).factualTruthVerified = true;
    },
  ]) {
    const wire = structuredClone(original);
    mutate(wire);
    assert.throws(
      () => decodeResearchView(wire),
      /could not be displayed safely/,
    );
  }
});

test("strict snapshot import and display validation still reject unknown core fields", () => {
  const view = diagnosticView();
  const invalid = { ...view.snapshot, arbitrary_core_field: "not admitted" };
  assert.equal(snapshotSchema.safeParse(invalid).success, false);
  assert.throws(
    () => decodeResearchView({ ...view, snapshot: invalid }),
    /could not be displayed safely/,
  );
  assert.doesNotThrow(
    () => decodeResearchView(view),
    "Current full snapshots remain readable",
  );
});

test("MCP view paths preserve metadata and require an explicit saved identity when default selection is ambiguous", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-view-wire-"));
  const seed = snapshotSchema.parse(sample);
  const canonical = diagnosticView();
  const store = new ResearchStore(directory, seed, async (snapshot) => {
    assert.equal(snapshot.id, canonical.snapshot.id);
    assert.deepEqual(snapshot.dataRef, canonical.snapshot.dataRef);
    return structuredClone(canonical.snapshot);
  });
  const server = createServer(store, join(process.cwd(), "dist/research.html"));
  const client = new Client({ name: "legacy-view-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const initial = await client.callTool({
      name: "open_research",
      arguments: {},
    });
    assert.equal(initial.isError, undefined);
    assert.equal((initial.structuredContent as any).snapshot.id, seed.id);
    await store.import(canonical.snapshot);
    const ambiguous = await client.callTool({
      name: "open_research",
      arguments: {},
    });
    assert.equal(ambiguous.isError, true);
    assert.equal(ambiguous.structuredContent, undefined);
    assert.match(
      JSON.stringify(ambiguous.content),
      /explicitly with snapshot_id/,
    );
    for (const name of ["open_research", "research_status", "research_page"]) {
      const response = await client.callTool({
        name,
        arguments: { snapshot_id: canonical.snapshot.id },
      });
      assert.equal(response.isError, undefined);
      const wire = response.structuredContent as any;
      assert.equal(Object.hasOwn(wire.snapshot, "researchQuality"), false);
      assert.equal(
        Object.hasOwn(wire.snapshot.rows[0], "cellDiagnostics"),
        false,
      );
      const decoded = decodeResearchView(wire);
      assert.equal(decoded.snapshot.id, canonical.snapshot.id);
      assert.deepEqual(
        decoded.snapshot.researchQuality,
        canonical.snapshot.researchQuality,
      );
      assert.deepEqual(
        decoded.snapshot.rows[0].cellDiagnostics,
        canonical.snapshot.rows[0].cellDiagnostics,
      );
    }
    assert.deepEqual(
      (await store.open(canonical.snapshot.id)).snapshot,
      canonical.snapshot,
    );
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
