import {
  effectiveValue,
  type CellValue,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";

import {
  MATERIALIZATION_CONTRACT,
  CELL_ORIGINS_ENCODING,
} from "./feature-contracts.js";
export { MATERIALIZATION_CONTRACT } from "./feature-contracts.js";

/** A selected full table and its authorized closure, captured from one app state. */
export type MaterializationContext = {
  root: ResearchView;
  dependencies: ResearchView[];
};

export type MaterializationPayload = {
  columns: {
    key: string;
    label: string;
    logical_type: string;
    nullable: boolean;
  }[];
  rows: Record<string, CellValue>[];
  row_ids: string[];
  data_classification: NonNullable<Snapshot["dataClassification"]>;
  cell_origins?: {
    encoding: typeof CELL_ORIGINS_ENCODING;
    // Coordinates reference row_ids, columns and the sorted parents below.
    cells: [number, number, number][];
  };
  parents: { result_id: string; view: "original"; amendment_revision: null }[];
  provenance: {
    materialization_contract: typeof MATERIALIZATION_CONTRACT;
    snapshot_id: string;
    view: "effective";
    amendment_revision: number;
    dependencies: string[];
  };
};

// Result IDs use ASCII today. Explicit code-point comparison keeps ordering
// independent of locale and of a future identifier's UTF-16 representation.
function compareIds(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Legacy explicit-materializer fallback: ignore nulls; homogeneous strings
 * (including all-null columns) use VARCHAR, booleans BOOLEAN, numbers DOUBLE,
 * and everything else JSON. This selects a type without serializing arbitrary
 * objects into JSON scalar text. Python still validates representations.
 */
function inferredType(
  rows: Record<string, CellValue>[],
  field: string,
): string {
  const values = rows
    .map((row) => row[field])
    .filter((value) => value !== null);
  return values.every((value) => typeof value === "string")
    ? "VARCHAR"
    : values.every((value) => typeof value === "boolean")
      ? "BOOLEAN"
      : values.every((value) => typeof value === "number")
        ? "DOUBLE"
        : "JSON";
}

/**
 * Build a deterministic import recipe from a resolved, authorized full view.
 * No writes, authorization, canonical resolution or engine calls occur here.
 * Parents preserve input-set lineage, not invented cell quotations.
 */
export function buildMaterializationPayload(
  context: MaterializationContext,
  fallbackClassification: NonNullable<
    Snapshot["dataClassification"]
  > = "public_web",
): MaterializationPayload {
  const { root } = context;
  const views = [root, ...context.dependencies];
  const resultIds = [
    ...new Set(
      views.flatMap((view) =>
        view.snapshot.dataRef ? [view.snapshot.dataRef.resultId] : [],
      ),
    ),
  ].sort(compareIds);
  const rootClassification =
    root.dataClassification ??
    root.snapshot.dataClassification ??
    fallbackClassification;
  const privateContributor =
    rootClassification.startsWith("private_") ||
    views.some((view) =>
      [view.dataClassification, view.snapshot.dataClassification].some(
        (classification) => classification?.startsWith("private_"),
      ),
    );
  const rows = root.snapshot.rows.map((row) =>
    Object.fromEntries(
      root.snapshot.columns.map((column) => [
        column.key,
        structuredClone(effectiveValue(root, row, column.key)),
      ]),
    ),
  );
  const origins: [number, number, number][] = [];
  const parentIndexes = new Map(resultIds.map((id, index) => [id, index]));
  const bySnapshot = new Map(views.map((view) => [view.snapshot.id, view]));
  const contributorRows = new Map(
    views.map((view) => [
      view.snapshot.id,
      new Map(view.snapshot.rows.map((row) => [row.id, row])),
    ]),
  );
  const amendments = new Map(
    root.amendments.map((entry) => [
      JSON.stringify([entry.row_id, entry.field]),
      entry,
    ]),
  );
  for (const [rowIndex, row] of root.snapshot.rows.entries()) {
    for (const [columnIndex, column] of root.snapshot.columns.entries()) {
      const amendment = amendments.get(JSON.stringify([row.id, column.key]));
      // A manual edit is a user decision, never a source quotation. Accepted
      // refresh values can use the exact recorded source snapshot instead.
      if (amendment && !amendment.sourceSnapshotId) continue;
      const contributor = amendment?.sourceSnapshotId
        ? bySnapshot.get(amendment.sourceSnapshotId)
        : root;
      const original =
        contributor &&
        contributorRows.get(contributor.snapshot.id)?.get(row.id);
      if (
        !contributor?.snapshot.dataRef ||
        !original?.evidence[column.key]?.length ||
        !original.cellSources?.[column.key]?.length
      )
        continue;
      origins.push([
        rowIndex,
        columnIndex,
        parentIndexes.get(contributor.snapshot.dataRef.resultId)!,
      ]);
    }
  }
  return {
    ...(origins.length
      ? { cell_origins: { encoding: CELL_ORIGINS_ENCODING, cells: origins } }
      : {}),
    columns: root.snapshot.columns.map((column) => ({
      key: column.key,
      label: column.label,
      logical_type: column.logicalType ?? inferredType(rows, column.key),
      nullable: column.nullable ?? true,
    })),
    rows,
    row_ids: root.snapshot.rows.map((row) => row.id),
    data_classification: privateContributor
      ? "private_derived"
      : rootClassification,
    parents: resultIds.map((result_id) => ({
      result_id,
      view: "original",
      amendment_revision: null,
    })),
    provenance: {
      materialization_contract: MATERIALIZATION_CONTRACT,
      snapshot_id: root.snapshot.id,
      view: "effective",
      amendment_revision: root.revision,
      dependencies: resultIds,
    },
  };
}
