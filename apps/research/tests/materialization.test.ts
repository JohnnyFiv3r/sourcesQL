import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMaterializationPayload,
  MATERIALIZATION_CONTRACT,
  type MaterializationContext,
} from "../server/materialization.js";
import type { CellValue, ResearchView, Snapshot } from "../src/schema.js";

function view(
  id: string,
  options: {
    resultId?: string;
    classification?: Snapshot["dataClassification"];
    effectiveClassification?: Snapshot["dataClassification"];
    columns?: Snapshot["columns"];
    rows?: Record<string, CellValue>[];
  } = {},
): ResearchView {
  const snapshot: Snapshot = {
    id,
    title: "Display title " + id,
    capturedAt: "2026-10-18T12:00:00Z",
    coverage: "Synthetic materialization test",
    columns: options.columns ?? [
      { key: "value", label: "Value", logicalType: "VARCHAR", nullable: true },
    ],
    rows: (options.rows ?? [{ value: "original" }]).map((values, index) => ({
      id: "row_" + index,
      values,
      sourceUrl: null,
      evidence: {},
      verificationNote: "",
    })),
    ...(options.classification
      ? { dataClassification: options.classification }
      : {}),
    ...(options.resultId
      ? {
          dataRef: {
            resultId: options.resultId,
            contentSha256: "a".repeat(64),
          },
        }
      : {}),
  };
  return {
    snapshot,
    displayTitle: snapshot.title,
    revision: 0,
    amendments: [],
    snapshots: [],
    requests: [],
    ...(options.effectiveClassification
      ? { dataClassification: options.effectiveClassification }
      : {}),
  };
}
function context(
  root: ResearchView,
  ...dependencies: ResearchView[]
): MaterializationContext {
  return { root, dependencies: [root, ...dependencies] };
}

test("one normalized payload retains the whole canonical parent set in stable order", () => {
  const root = view("baseline", { resultId: "result_Z" });
  const source = view("refresh", { resultId: "result_a" });
  const ancestor = view("ancestor", { resultId: "result_A" });
  const duplicate = view("duplicate", { resultId: "result_a" });
  const inline = view("inline");
  inline.snapshot.origin = {
    engine: "imported",
    resultId: "descriptive_only",
    runId: null,
  };
  const payload = buildMaterializationPayload(
    context(root, source, ancestor, duplicate, inline),
  );
  assert.deepEqual(
    payload.parents,
    ["result_A", "result_Z", "result_a"].map((result_id) => ({
      result_id,
      view: "original",
      amendment_revision: null,
    })),
  );
  assert.deepEqual(payload.provenance, {
    materialization_contract: MATERIALIZATION_CONTRACT,
    snapshot_id: "baseline",
    view: "effective",
    amendment_revision: 0,
    dependencies: ["result_A", "result_Z", "result_a"],
  });
  assert.deepEqual(
    payload,
    buildMaterializationPayload({
      root,
      dependencies: [inline, duplicate, ancestor, source, root, ancestor],
    }),
  );
  assert.ok(!JSON.stringify(payload).includes("descriptive_only"));
});

test("all 205 rows retain exact declared types, order, row IDs and explicit NULL", () => {
  const columns: Snapshot["columns"] = [
    {
      key: "count",
      label: "Lossless count",
      logicalType: "BIGINT",
      nullable: false,
    },
    {
      key: "amount",
      label: "Exact amount",
      logicalType: "DECIMAL(38,6)",
      nullable: true,
    },
    { key: "ratio", label: "Ratio", logicalType: "DOUBLE", nullable: false },
    { key: "active", label: "Active", logicalType: "BOOLEAN", nullable: false },
    { key: "list", label: "List", logicalType: "BIGINT[]", nullable: false },
    {
      key: "nested",
      label: "Nested",
      logicalType: 'STRUCT("name" VARCHAR, "values" BIGINT[])',
      nullable: false,
    },
    {
      key: "allNull",
      label: "Declared all-null",
      logicalType: "DATE",
      nullable: true,
    },
  ];
  const root = view("full", {
    resultId: "result_full",
    columns,
    rows: Array.from({ length: 205 }, (_, index) => ({
      count: "9007199254740993",
      amount: "123456789012345678901234567890.123456",
      ratio: index + 0.25,
      active: index % 2 === 0,
      list: ["9007199254740993", "2"],
      nested: { name: "Unicode α\nline", values: ["3", "4"] },
      allNull: null,
    })),
  });
  root.preview = { offset: 0, returned: 200, total: 205, nextOffset: 200 };
  root.amendments.push({
    snapshot_id: "full",
    row_id: "row_204",
    field: "amount",
    value: null,
    expected_revision: 0,
    mutation_id: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    originalValue: root.snapshot.rows[204].values.amount,
    createdAt: "2026-10-18T12:01:00Z",
  });
  root.revision = 1;
  const before = structuredClone(root);
  const payload = buildMaterializationPayload(context(root));
  assert.equal(payload.rows.length, 205);
  assert.deepEqual(
    payload.row_ids,
    Array.from({ length: 205 }, (_, index) => "row_" + index),
  );
  assert.deepEqual(
    payload.columns,
    columns.map((column) => ({
      key: column.key,
      label: column.label,
      logical_type: column.logicalType,
      nullable: column.nullable,
    })),
  );
  assert.deepEqual(
    Object.keys(payload.rows[204]),
    columns.map((column) => column.key),
  );
  assert.equal(payload.rows[204].amount, null);
  assert.equal(payload.rows[0].amount, "123456789012345678901234567890.123456");
  assert.equal(payload.rows[204].count, "9007199254740993");
  assert.equal(payload.rows[204].ratio, 204.25);
  assert.equal(payload.rows[204].active, true);
  assert.deepEqual(payload.rows[204].list, ["9007199254740993", "2"]);
  assert.deepEqual(payload.rows[204].nested, {
    name: "Unicode α\nline",
    values: ["3", "4"],
  });
  assert.equal(payload.provenance.amendment_revision, 1);
  assert.deepEqual(root, before);
  (payload.rows[204].nested as { name: string }).name = "changed copy";
  assert.deepEqual(root, before);
});

test("legacy primitive inference never coerces arbitrary objects into JSON scalar text", () => {
  const root = view("legacy", {
    columns: ["text", "flag", "number", "empty", "object", "mixed"].map(
      (key) => ({ key, label: key }),
    ),
    rows: [
      {
        text: "α",
        flag: true,
        number: 3.5,
        empty: null,
        object: { item: "value" },
        mixed: 1,
      },
      {
        text: null,
        flag: false,
        number: null,
        empty: null,
        object: null,
        mixed: "two",
      },
    ],
  });
  const payload = buildMaterializationPayload(context(root));
  assert.deepEqual(
    payload.columns.map((column) => column.logical_type),
    ["VARCHAR", "BOOLEAN", "DOUBLE", "VARCHAR", "JSON", "JSON"],
  );
  assert.ok(payload.columns.every((column) => column.nullable));
  assert.deepEqual(payload.rows[0].object, { item: "value" });
  assert.equal(typeof payload.rows[0].object, "object");
  // Python can reject invalid JSON scalar representations; the builder must not
  // silently serialize values and change their meaning to make them valid.
  assert.equal(payload.rows[0].mixed, 1);
  assert.equal(payload.rows[1].mixed, "two");
});

test("any private view or snapshot in the complete closure makes the promotion private-derived", () => {
  for (const privateView of [
    view("inline-private", { classification: "private_local" }),
    view("effective-private", { effectiveClassification: "private_derived" }),
    view("canonical-private", {
      resultId: "result_private",
      classification: "private_local",
    }),
    view("conflicting", {
      classification: "private_local",
      effectiveClassification: "public_web",
    }),
  ]) {
    const root = view("public", {
      resultId: "result_public",
      classification: "public_web",
    });
    assert.equal(
      buildMaterializationPayload(context(root, privateView))
        .data_classification,
      "private_derived",
      privateView.snapshot.id,
    );
    assert.equal(root.snapshot.dataClassification, "public_web");
  }
  const privateRoot = view("private-root", { classification: "private_local" });
  assert.equal(
    buildMaterializationPayload(context(privateRoot)).data_classification,
    "private_derived",
  );
});

test("effective classification and bounded legacy fallback remain authoritative for nonprivate data", () => {
  const fixture = view("fixture", {
    effectiveClassification: "synthetic_fixture",
  });
  assert.equal(
    buildMaterializationPayload(context(fixture)).data_classification,
    "synthetic_fixture",
  );
  const legacy = view("legacy");
  assert.equal(
    buildMaterializationPayload(context(legacy)).data_classification,
    "public_web",
  );
  assert.equal(
    buildMaterializationPayload(context(legacy), "synthetic_fixture")
      .data_classification,
    "synthetic_fixture",
  );
  assert.equal(
    buildMaterializationPayload(context(legacy), "private_local")
      .data_classification,
    "private_derived",
  );
});

test("recipe excludes presentation metadata but changes with values, revisions, dependencies or classification", () => {
  const root = view("baseline", {
    resultId: "result_baseline",
    classification: "public_web",
  });
  const first = buildMaterializationPayload(context(root));
  root.snapshot.title = "Renamed table";
  root.snapshot.capturedAt = "2026-10-19T12:00:00Z";
  root.displayTitle = "Renamed table";
  root.requests = [
    {
      id: "different-request",
      question: "Synthetic refresh",
      kind: "refresh",
      snapshotId: "baseline",
      createdAt: "2026-10-19T12:00:00Z",
      status: "pending",
    },
  ];
  assert.deepEqual(buildMaterializationPayload(context(root)), first);
  root.snapshot.rows[0].values.value = "changed value";
  assert.notDeepEqual(buildMaterializationPayload(context(root)), first);
  root.snapshot.rows[0].values.value = "original";
  root.revision = 1;
  assert.notDeepEqual(buildMaterializationPayload(context(root)), first);
  root.revision = 0;
  assert.notDeepEqual(
    buildMaterializationPayload(
      context(root, view("extra", { resultId: "result_extra" })),
    ),
    first,
  );
  root.dataClassification = "synthetic_fixture";
  assert.notDeepEqual(buildMaterializationPayload(context(root)), first);
});

test("inline roots use verified dataRef dependencies even when the root is not repeated in dependencies", () => {
  const root = view("successor");
  root.snapshot.origin = {
    engine: "imported",
    resultId: "source_hint",
    runId: null,
  };
  const parent = view("canonical-parent", { resultId: "result_parent" });
  const payload = buildMaterializationPayload({ root, dependencies: [parent] });
  assert.deepEqual(payload.parents, [
    { result_id: "result_parent", view: "original", amendment_revision: null },
  ]);
  assert.equal(payload.provenance.amendment_revision, 0);
  assert.deepEqual(payload.row_ids, ["row_0"]);
});

test("quoted unchanged cells retain explicit canonical origins while manual corrections do not", () => {
  const root = view("cited", { resultId: "wq_cited" });
  root.snapshot.rows[0].evidence.value = ["An inspected canonical quote."];
  root.snapshot.rows[0].cellSources = {
    value: [{ url: "https://source.example/retained" }],
  };
  const original = buildMaterializationPayload(context(root));
  assert.deepEqual(original.cell_origins, {
    encoding: "indexed-cells.v1",
    cells: [[0, 0, 0]],
  });
  root.amendments.push({
    snapshot_id: "cited",
    row_id: "row_0",
    field: "value",
    value: "Manual interpretation",
    originalValue: "original",
    reason: "User decision",
    revision: 1,
    expected_revision: 0,
    mutation_id: "68af54ae-d37d-431a-a8c0-993d3b03d54f",
    createdAt: "2026-10-19T12:00:00Z",
  });
  root.revision = 1;
  const corrected = buildMaterializationPayload(context(root));
  assert.equal(corrected.cell_origins, undefined);
  assert.equal(corrected.rows[0].value, "Manual interpretation");
});

test("an accepted refresh citation names its exact recorded canonical source", () => {
  const root = view("baseline", { resultId: "wq_base" });
  const refresh = view("refresh", {
    resultId: "wq_refresh",
    rows: [{ value: "New observation" }],
  });
  refresh.snapshot.rows[0].evidence.value = [
    "New observation from an inspected passage.",
  ];
  refresh.snapshot.rows[0].cellSources = {
    value: [{ url: "https://source.example/refresh" }],
  };
  root.amendments.push({
    snapshot_id: "baseline",
    row_id: "row_0",
    field: "value",
    value: "New observation",
    originalValue: "original",
    sourceSnapshotId: "refresh",
    revision: 1,
    expected_revision: 0,
    mutation_id: "68af54ae-d37d-431a-a8c0-993d3b03d54f",
    createdAt: "2026-10-19T12:00:00Z",
  });
  root.revision = 1;
  const payload = buildMaterializationPayload(context(root, refresh));
  assert.deepEqual(payload.cell_origins, {
    encoding: "indexed-cells.v1",
    cells: [[0, 0, 1]],
  });
  assert.deepEqual(payload.provenance.dependencies, ["wq_base", "wq_refresh"]);
});

test("a fully cited 1000 by 128 table fits the hosted request envelope", () => {
  const columns = Array.from({ length: 128 }, (_, index) => ({
    key: `field_${index}`,
    label: `Field ${index}`,
    logicalType: "VARCHAR",
    nullable: false,
  }));
  const rows = Array.from({ length: 1000 }, (_, index) =>
    Object.fromEntries(columns.map((column) => [column.key, `Value ${index}`])),
  );
  const root = view("large_cited", {
    resultId: "wq_" + "a".repeat(64),
    columns,
    rows,
  });
  for (const row of root.snapshot.rows) {
    row.evidence = Object.fromEntries(
      columns.map((column) => [column.key, ["Inspected canonical quotation."]]),
    );
    row.cellSources = Object.fromEntries(
      columns.map((column) => [
        column.key,
        [{ url: "https://source.example/retained" }],
      ]),
    );
  }
  const payload = buildMaterializationPayload(context(root));
  assert.equal(payload.cell_origins?.cells.length, 128000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 16 * 1024 * 1024);
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload.cell_origins)) < 2 * 1024 * 1024,
  );
});
