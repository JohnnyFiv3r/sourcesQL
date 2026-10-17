import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultSnapshot, type EngineResult } from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import {
  cellDiagnosticSummary,
  researchGapSummary,
  researchQualitySchema,
  snapshotSchema,
} from "../src/schema.js";

test("declared central omissions stay visibly partial without implying factual verification", () => {
  const quality = researchQualitySchema.parse({
    goalStatus: "partial",
    requiredCells: 4,
    unresolvedCells: 2,
    rowShortfall: 1,
    gaps: [],
    gapsTotal: 0,
    gapsOmitted: 0,
    complete: false,
    scope: "declared_cells_and_minimum_rows",
    factualTruthVerified: false,
  });
  assert.match(
    researchGapSummary(quality)!,
    /1 more row required; 2 required cells are unresolved/,
  );
  assert.match(
    researchGapSummary(quality)!,
    /factual accuracy is not verified/,
  );
  assert.equal(researchGapSummary(), undefined);
  assert.equal(
    researchGapSummary({ ...quality, goalStatus: "not_evaluated" }),
    undefined,
  );
  assert.equal(
    researchGapSummary({ ...quality, goalStatus: "requirements_satisfied" }),
    undefined,
  );
});

const reference = {
  result_id: "wq_diagnostics",
  snapshot_id: "saved_diagnostics",
  title: "Research facts",
};
function result(): EngineResult {
  return {
    result_id: reference.result_id,
    run_id: "run_diagnostics",
    row_ids: ["row_a", "row_b"],
    row_count: 2,
    columns: ["entity", "value"].map((key) => ({
      key,
      label: key,
      logical_type: "VARCHAR",
      nullable: true,
    })),
    rows: [
      { entity: "Aurora", value: null },
      { entity: "Birch", value: null },
    ],
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [
      { source_version_id: "src_a", url: "https://example.com/retained" },
    ],
    receipt: { status: "completed", finished_at: "2026-10-17T12:00:00Z" },
    next_offset: null,
  };
}

test("snapshot diagnostics preserve exact cells and safe references without inventing citations", () => {
  const raw = result();
  raw.cell_diagnostics = [
    {
      row_id: "row_a",
      column_key: "value",
      status: "not_stated",
      diagnostic_id: "d_one",
      source_version_id: "src_a",
      value_path: [],
      reason: "PRIVATE-MODEL-REASON",
      raw: "PRIVATE-HTTP-BODY",
    },
    {
      row_id: "row_b",
      column_key: "value",
      status: "failed",
      diagnostic_id: "d_two",
      message: "PRIVATE-PROVIDER-MESSAGE",
    },
    { row_id: "other_page", column_key: "value", status: "failed" },
    { row_id: "row_a", column_key: "not_a_column", status: "failed" },
  ];
  const snapshot = snapshotSchema.parse(resultSnapshot(raw, reference));
  assert.deepEqual(snapshot.rows[0].cellDiagnostics?.value, [
    {
      status: "not_stated",
      diagnosticId: "d_one",
      sourceVersionId: "src_a",
      valuePath: [],
    },
  ]);
  assert.deepEqual(snapshot.rows[1].cellDiagnostics?.value, [
    { status: "failed", diagnosticId: "d_two" },
  ]);
  assert.match(
    cellDiagnosticSummary(snapshot.rows[0], "value")!,
    /Not stated in the inspected evidence/,
  );
  assert.match(cellDiagnosticSummary(snapshot.rows[1], "value")!, /failed/);
  for (const row of snapshot.rows) {
    assert.deepEqual(row.evidence, {});
    assert.deepEqual(row.cellSources, {});
    assert.equal(row.sourceUrl, null);
    assert.deepEqual(row.evidenceRefs, []);
  }
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /PRIVATE|other_page|not_a_column/,
  );
  const reordered = resultSnapshot(
    {
      ...raw,
      rows: [...raw.rows].reverse(),
      row_ids: [...raw.row_ids].reverse(),
    },
    reference,
  );
  assert.equal(reordered.rows[0].id, "row_b");
  assert.equal(reordered.rows[0].cellDiagnostics?.value[0].status, "failed");
});

test("bounded cell diagnostics retain a later failure among repeated unknown references", () => {
  const raw = result();
  raw.cell_diagnostics = Array.from({ length: 50 }, (_, index) => ({
    row_id: "row_a",
    column_key: "value",
    status: "unknown",
    diagnostic_id: "d_" + index,
  }));
  raw.cell_diagnostics.push({
    row_id: "row_a",
    column_key: "value",
    status: "failed",
    diagnostic_id: "d_failed",
  });
  const snapshot = snapshotSchema.parse(resultSnapshot(raw, reference));
  assert.equal(snapshot.rows[0].cellDiagnostics?.value.length, 32);
  assert.ok(
    snapshot.rows[0].cellDiagnostics?.value.some(
      (entry) => entry.status === "failed",
    ),
  );
  assert.match(
    cellDiagnosticSummary(snapshot.rows[0], "value")!,
    /^Research for this field failed\./,
  );
});

test("permitted SQL aliases cannot collide with diagnostic map object properties", () => {
  const raw = result();
  raw.columns[1].key = "toString";
  raw.rows = raw.rows.map((row) => ({ entity: row.entity, toString: null }));
  raw.cell_diagnostics = [
    { row_id: "row_a", column_key: "toString", status: "not_stated" },
  ];
  const snapshot = snapshotSchema.parse(resultSnapshot(raw, reference));
  const diagnostic = Object.entries(
    snapshot.rows[0].cellDiagnostics ?? {},
  ).find(([field]) => field === "toString")?.[1][0];
  assert.equal(diagnostic?.status, "not_stated");
  assert.match(
    cellDiagnosticSummary(snapshot.rows[0], "toString")!,
    /Not stated/,
  );
  assert.equal(
    cellDiagnosticSummary(snapshot.rows[0], "hasOwnProperty"),
    undefined,
  );
});

test("finite diagnostic states keep unknown, inspection failure and capacity distinct", () => {
  const raw = result();
  for (const [status, expected] of Object.entries({
    unknown: /Not established/,
    uninspected: /not been inspected/,
    not_inspected: /not been inspected/,
    ambiguous: /ambiguous/,
    conflicting: /conflict/,
    evidence_invalid: /Supporting evidence/,
    invalid_output: /extraction/,
    budget_exhausted: /Capacity/,
    provider_timeout: /timed out/,
    provider_connection_error: /connection failed/,
    provider_http_error: /rejected/,
  })) {
    raw.cell_diagnostics = [{ row_id: "row_a", column_key: "value", status }];
    const snapshot = resultSnapshot(raw, reference);
    assert.match(cellDiagnosticSummary(snapshot.rows[0], "value")!, expected);
  }
  raw.cell_diagnostics = [
    {
      row_id: "row_a",
      column_key: "value",
      status: "PRIVATE-STATUS",
      diagnostic_id: "not a safe id",
      value_path: ["PRIVATE PATH"],
    },
  ];
  const unknown = resultSnapshot(raw, reference);
  assert.deepEqual(unknown.rows[0].cellDiagnostics?.value, [
    { status: "unknown" },
  ]);
  assert.doesNotMatch(JSON.stringify(unknown), /PRIVATE|not a safe id/);
});

test("declared research gaps supply cell reasons and remain independent of SQL completion", () => {
  const raw = result();
  raw.research_quality = {
    goal_status: "partial",
    required_cells: 4,
    unresolved_cells: 2,
    row_shortfall: 0,
    gaps: [
      { row_id: "row_a", column_key: "value", status: "uninspected" },
      {
        row_id: "row_b",
        column_key: "value",
        status: "not_stated",
        diagnostic_id: "d_b",
      },
    ],
    gaps_total: 2,
    gaps_omitted: 0,
    complete: false,
    scope: "declared_cells_and_minimum_rows",
    factual_truth_verified: false,
    raw: "PRIVATE-QUALITY",
  };
  const snapshot = snapshotSchema.parse(resultSnapshot(raw, reference));
  assert.equal(
    typeof snapshot.coverage === "object" && snapshot.coverage.planComplete,
    true,
  );
  assert.equal(snapshot.researchQuality?.goalStatus, "partial");
  assert.equal(snapshot.researchQuality?.complete, false);
  assert.equal(snapshot.researchQuality?.factualTruthVerified, false);
  assert.match(
    cellDiagnosticSummary(snapshot.rows[0], "value")!,
    /not been inspected/,
  );
  assert.match(cellDiagnosticSummary(snapshot.rows[1], "value")!, /Not stated/);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

test("fixtures without diagnostics preserve their presentation and contradictory truth claims refuse", () => {
  const snapshot = resultSnapshot(result(), reference);
  assert.equal(snapshot.researchQuality, undefined);
  assert.equal(snapshot.rows[0].cellDiagnostics, undefined);
  assert.equal(cellDiagnosticSummary(snapshot.rows[0], "value"), undefined);
  const changed = {
    ...snapshot,
    researchQuality: {
      goalStatus: "requirements_satisfied",
      requiredCells: 4,
      unresolvedCells: 1,
      rowShortfall: 0,
      gaps: [],
      gapsTotal: 0,
      gapsOmitted: 0,
      complete: true,
      scope: "declared_cells_and_minimum_rows",
      factualTruthVerified: true,
    },
  };
  assert.equal(snapshotSchema.safeParse(changed).success, false);
  const injected = structuredClone(snapshot);
  injected.rows[0].cellDiagnostics = {
    value: [{ status: "unknown", message: "PRIVATE" } as never],
  };
  assert.equal(snapshotSchema.safeParse(injected).success, false);
});

test("the app bounds its gap preview while preserving the complete unresolved counts", () => {
  const raw = result();
  raw.research_quality = {
    goal_status: "partial",
    required_cells: 4,
    unresolved_cells: 1,
    row_shortfall: 0,
    gaps: Array.from({ length: 70 }, (_, index) => ({
      row_id: "row_a",
      column_key: "value",
      status: "uninspected",
      diagnostic_id: "d_" + index,
    })),
    gaps_total: 70,
    gaps_omitted: 0,
    complete: false,
    scope: "declared_cells_and_minimum_rows",
    factual_truth_verified: false,
  };
  const snapshot = snapshotSchema.parse(resultSnapshot(raw, reference));
  assert.equal(snapshot.researchQuality?.gaps.length, 64);
  assert.equal(snapshot.researchQuality?.gapsTotal, 70);
  assert.equal(snapshot.researchQuality?.gapsOmitted, 6);
  assert.equal(snapshot.researchQuality?.unresolvedCells, 1);
  assert.equal(snapshot.researchQuality?.complete, false);
});

test("portable export and corrections preserve original diagnostics without changing canonical values", async () => {
  const raw = result();
  raw.cell_diagnostics = [
    {
      row_id: "row_a",
      column_key: "value",
      status: "not_stated",
      diagnostic_id: "d_one",
    },
  ];
  const snapshot = snapshotSchema.parse(resultSnapshot(raw, reference));
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-diagnostics-"));
  try {
    const original = new ResearchStore(
      join(directory, "original"),
      snapshot,
      async () => structuredClone(snapshot),
    );
    await original.amend({
      snapshot_id: snapshot.id,
      row_id: "row_a",
      field: "value",
      value: "owner correction",
      reason: "Synthetic correction",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const bundle = await original.exportBundle(snapshot.id);
    const restored = new ResearchStore(
      join(directory, "restored"),
      snapshot,
      async () => structuredClone(snapshot),
    );
    const view = await restored.importBundle(
      JSON.parse(JSON.stringify(bundle)),
    );
    assert.equal(view.snapshot.rows[0].values.value, null);
    assert.equal(view.amendments[0].value, "owner correction");
    assert.deepEqual(
      view.snapshot.rows[0].cellDiagnostics,
      snapshot.rows[0].cellDiagnostics,
    );
    assert.match(
      cellDiagnosticSummary(view.snapshot.rows[0], "value")!,
      /Not stated/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
