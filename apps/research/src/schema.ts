import { validateTypedCell, validInstant } from "./typed-values.js";
import { z } from "zod";

export const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const scalarCell = z.union([
  z.string().max(8000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const webUrl = z
  .string()
  .max(2048)
  .url()
  .refine(
    (v) => ["https:", "http:"].includes(new URL(v).protocol),
    "Use an http or https source URL",
  );
const source = z
  .object({ url: webUrl, label: z.string().min(1).max(150).optional() })
  .strict();
const sourceList = z.array(source).min(1).max(12);
export const v1SnapshotSchema = z
  .object({
    id,
    title: z.string().min(1).max(150),
    sourceResultSetId: z.string().regex(/^r[a-f0-9]+$/),
    capturedAt: z.iso.date(),
    parentSnapshotId: id.optional(),
    coverage: z.string().min(1).max(1000),
    columns: z
      .array(z.object({ key, label: z.string().min(1).max(80) }).strict())
      .min(1)
      .max(12),
    rows: z
      .array(
        z
          .object({
            id,
            values: z.record(key, scalarCell),
            sourceUrl: webUrl,
            sources: sourceList.optional(),
            cellSources: z.record(key, sourceList).optional(),
            evidence: z.record(key, z.array(z.string().max(12000)).max(12)),
            verificationNote: z.string().max(2000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((s, ctx) => {
    const keys = s.columns.map((c) => c.key);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Column keys must be unique" });
    if (new Set(s.rows.map((r) => r.id)).size !== s.rows.length)
      ctx.addIssue({ code: "custom", message: "Row IDs must be unique" });
    for (const row of s.rows) {
      if (
        Object.keys(row.values).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(row.values, k))
      )
        ctx.addIssue({
          code: "custom",
          message: `Row ${row.id} must contain exactly the declared columns`,
        });
      if (Object.keys(row.cellSources ?? {}).some((k) => !keys.includes(k)))
        ctx.addIssue({
          code: "custom",
          message: `Unknown source column in ${row.id}`,
        });
      if (Object.keys(row.evidence).some((k) => !keys.includes(k)))
        ctx.addIssue({
          code: "custom",
          message: `Unknown evidence column in ${row.id}`,
        });
    }
    if (JSON.stringify(s).length > 200000)
      ctx.addIssue({
        code: "custom",
        message: "Snapshot exceeds 200 KB. Import a bounded SQL projection.",
      });
  });

export type CellValue =
  string | number | boolean | null | CellValue[] | { [key: string]: CellValue };
function nestedCell(depth: number): z.ZodType<CellValue> {
  return depth === 8
    ? scalarCell
    : z.union([
        scalarCell,
        z.array(nestedCell(depth + 1)).max(1000),
        z
          .record(key, nestedCell(depth + 1))
          .refine((v) => Object.keys(v).length <= 128),
      ]);
}
export const cell = nestedCell(0);
export const v2SnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    id,
    title: z.string().min(1).max(150),
    origin: z
      .object({
        engine: z.enum([
          "sourcesql",
          "open-webql",
          "legacy-import",
          "imported",
        ]),
        resultId: id,
        runId: id.nullable(),
      })
      .strict(),
    capturedAt: z.string(),
    captureBasis: z.enum([
      "run_completed_at",
      "content_observed_at",
      "imported_declared_time",
    ]),
    capturePrecision: z.enum(["day", "instant"]),
    parentSnapshotId: id.nullable().optional(),
    rowCount: z.number().int().nonnegative(),
    dataClassification: z.enum([
      "public_web",
      "private_local",
      "private_derived",
      "synthetic_fixture",
    ]),
    coverage: z
      .object({
        planComplete: z.boolean(),
        corpusComplete: z.enum(["unknown", "bounded_fixture"]),
        notes: z.array(z.string().max(2000)).max(40),
      })
      .strict(),
    columns: z
      .array(
        z
          .object({
            key,
            label: z.string().min(1).max(80),
            logicalType: z.string().min(1).max(1000),
            nullable: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    rows: z
      .array(
        z
          .object({
            id,
            values: z.record(key, cell),
            sourceUrl: webUrl.nullable(),
            sources: sourceList.optional(),
            cellSources: z.record(key, sourceList).optional(),
            evidenceRefs: z.array(id).max(1000).default([]),
            evidence: z
              .record(key, z.array(z.string().max(12000)).max(12))
              .default({}),
            verificationNote: z.string().max(2000).default(""),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    dataRef: z
      .object({
        resultId: id,
        contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .optional(),
    previewOffset: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const dateValid =
      s.capturePrecision === "day"
        ? z.iso.date().safeParse(s.capturedAt).success
        : validInstant(s.capturedAt);
    if (!dateValid) fail("Invalid capture timestamp or precision");
    if (
      s.capturePrecision === "day" &&
      s.captureBasis !== "imported_declared_time"
    )
      fail("Day precision requires imported_declared_time");
    if (
      (s.origin.engine === "sourcesql" || s.origin.engine === "open-webql") &&
      (s.capturePrecision !== "instant" || !s.origin.runId)
    )
      fail("sourcesQL origin requires an instant and run ID");
    if (s.dataRef && s.dataRef.resultId !== s.origin.resultId)
      fail("dataRef must match origin");
    if (!s.dataRef && (s.rowCount !== s.rows.length || s.previewOffset !== 0))
      fail("Inline row count must equal supplied rows");
    if (s.previewOffset + s.rows.length > s.rowCount)
      fail("Preview exceeds total row count");
    if (
      new Set(s.columns.map((c) => c.key)).size !== s.columns.length ||
      new Set(s.rows.map((r) => r.id)).size !== s.rows.length
    )
      fail("Column keys and row IDs must be unique");
    for (const row of s.rows) {
      if (Object.keys(row.values).length !== s.columns.length)
        fail("Rows must contain exactly the declared columns");
      for (const c of s.columns) {
        const error = validateTypedCell(
          c.logicalType,
          row.values[c.key],
          c.nullable,
        );
        if (error) fail(c.key + ": " + error);
      }
    }
    if (new TextEncoder().encode(JSON.stringify(s)).byteLength > 200000)
      fail("Snapshot exceeds 200 KB UTF-8 bytes; use a result reference");
  });
export type Snapshot = {
  id: string;
  title: string;
  capturedAt: string;
  parentSnapshotId?: string | null;
  sourceResultSetId?: string;
  schemaVersion?: 2;
  origin?: {
    engine: "sourcesql" | "open-webql" | "legacy-import" | "imported";
    resultId: string;
    runId: string | null;
  };
  captureBasis?:
    "run_completed_at" | "content_observed_at" | "imported_declared_time";
  capturePrecision?: "day" | "instant";
  rowCount?: number;
  dataClassification?:
    "public_web" | "private_local" | "private_derived" | "synthetic_fixture";
  coverage:
    | string
    | {
        planComplete: boolean;
        corpusComplete: "unknown" | "bounded_fixture";
        notes: string[];
      };
  columns: {
    key: string;
    label: string;
    logicalType?: string;
    nullable?: boolean;
  }[];
  rows: {
    id: string;
    values: Record<string, CellValue>;
    sourceUrl: string | null;
    sources?: z.infer<typeof source>[];
    cellSources?: Record<string, z.infer<typeof source>[]>;
    evidenceRefs?: string[];
    evidence: Record<string, string[]>;
    verificationNote: string;
  }[];
  dataRef?: { resultId: string; contentSha256: string };
  previewOffset?: number;
};
export const snapshotSchema: z.ZodType<Snapshot> = z.union([
  v1SnapshotSchema,
  v2SnapshotSchema,
]);
export function originForSnapshot(snapshot: Snapshot) {
  return snapshot.origin
    ? snapshot.origin
    : {
        engine: "legacy-import" as const,
        resultId: snapshot.sourceResultSetId!,
        runId: null,
      };
}
export function captureForSnapshot(snapshot: Snapshot) {
  return snapshot.capturePrecision
    ? { precision: snapshot.capturePrecision, basis: snapshot.captureBasis }
    : { precision: "day" as const, basis: "imported_declared_time" as const };
}
export function isPrivateSnapshot(snapshot: Snapshot) {
  return (
    !!snapshot.dataClassification &&
    snapshot.dataClassification.startsWith("private_")
  );
}

export const amendmentSchema = z
  .object({
    snapshot_id: id,
    row_id: id,
    field: key,
    value: cell,
    reason: z.string().trim().min(1).max(2000).optional(),
    expected_revision: z.number().int().nonnegative(),
    mutation_id: z.string().uuid(),
  })
  .strict();
export const renameSchema = z
  .object({
    snapshot_id: id,
    title: z.string().trim().min(1).max(150),
    expected_title: z.string().min(1).max(150),
  })
  .strict();
export type RenameInput = z.infer<typeof renameSchema>;
export type Row = Snapshot["rows"][number];
export type AmendmentInput = z.infer<typeof amendmentSchema>;
export type Amendment = AmendmentInput & {
  createdAt: string;
  originalValue: z.infer<typeof cell>;
  revision: number;
  sourceSnapshotId?: string;
};
export const findResearchRowSchema = z
  .object({
    snapshot_id: id
      .optional()
      .describe(
        "Canonical saved dataset ID. Omit to search across active datasets with query.",
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Case-insensitive substring search across effective cell values.",
      ),
    match: z
      .record(key, cell)
      .optional()
      .describe(
        "Exact matches by column key, combined with AND. Requires snapshot_id. Strings ignore case and surrounding whitespace; numbers, booleans and null retain their types.",
      ),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.snapshot_id && !input.query)
      ctx.addIssue({
        code: "custom",
        message:
          "Supply snapshot_id to list its rows, or query to search active datasets.",
      });
    if (
      input.match &&
      (!input.snapshot_id ||
        Object.keys(input.match).length < 1 ||
        Object.keys(input.match).length > 12)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "match requires snapshot_id and 1–12 exact column-key/value pairs.",
      });
  });
export type FindResearchRowInput = z.input<typeof findResearchRowSchema>;
export const researchInputSchema = z
  .object({
    request_id: z.string().uuid(),
    snapshot_id: id,
    row_id: id.optional(),
    field: key.optional(),
    question: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export const assessmentSchema = z
  .object({
    row_id: id,
    field: key,
    status: z.enum(["verified", "conflicting", "unverified"]),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();
export const appendResearchSchema = z
  .object({
    request_id: z.string().uuid(),
    snapshot: snapshotSchema,
    assessments: z.array(assessmentSchema).max(1200).optional(),
  })
  .strict();
export const reviewRefreshSchema = z
  .object({
    request_id: z.string().uuid(),
    row_id: id,
    field: key,
    decision: z.enum(["accept", "keep"]),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export type ResearchInput = z.infer<typeof researchInputSchema>;
export type AppendResearchInput = z.infer<typeof appendResearchSchema>;
export type ReviewRefreshInput = z.infer<typeof reviewRefreshSchema>;
export type ResearchRequestSummary = {
  id: string;
  kind: "expand" | "refresh";
  snapshotId: string;
  rowId?: string;
  field?: string;
  question: string;
  createdAt: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  resultSnapshotId?: string;
  resultArchivedAt?: string;
  error?: string;
};
export type SnapshotOption = {
  dataClassification?: Snapshot["dataClassification"];
  id: string;
  title: string;
  capturedAt: string;
  parentSnapshotId?: string | null;
  parentTitle?: string;
  originLabel?: string;
  depth: number;
  kind?: "expand" | "refresh";
};
export type RefreshChange = {
  rowId: string;
  field: string;
  label: string;
  previous: z.infer<typeof cell>;
  proposed: z.infer<typeof cell>;
  status: "new" | "changed" | "unchanged" | "conflicting" | "unverified";
  note: string;
  decision?: "accept" | "keep";
  canAccept: boolean;
};
export type ResearchView = {
  snapshot: Snapshot;
  preview?: {
    offset: number;
    returned: number;
    total: number;
    nextOffset: number | null;
  };
  displayTitle: string;
  dataClassification?: Snapshot["dataClassification"];
  amendments: Amendment[];
  revision: number;
  snapshots: SnapshotOption[];
  requests: ResearchRequestSummary[];
  acceptedSources?: Record<string, Record<string, z.infer<typeof source>[]>>;
  update?: {
    requestId: string;
    parentSnapshotId: string;
    parentTitle: string;
    baseRevision: number;
    parentRevision: number;
    stale: boolean;
    publishedSnapshotId?: string;
    changes: import("../server/updates.js").UpdateChange[];
    decisions: Record<string, "accept" | "keep">;
  };
  refresh?: {
    requestId: string;
    parentTitle: string;
    parentRevision: number;
    changes: RefreshChange[];
  };
};
export function displayValue(value: z.infer<typeof cell> | undefined): string {
  return value === null || value === undefined
    ? "Not stated"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
export function effectiveValue(
  view: ResearchView,
  row: Row,
  field: string,
): z.infer<typeof cell> {
  const amendment = view.amendments.findLast(
    (a) => a.row_id === row.id && a.field === field,
  );
  return amendment ? amendment.value : row.values[field];
}

// Explicit cell provenance takes precedence; whole-row selection includes every known source.
export function sourcesForSelection(
  row: Row,
  field?: string,
): z.infer<typeof source>[] {
  const candidates =
    field && row.cellSources?.[field]
      ? row.cellSources[field]
      : [
          ...(row.sourceUrl ? [{ url: row.sourceUrl }] : []),
          ...(row.sources ?? []),
          ...(!field ? Object.values(row.cellSources ?? {}).flat() : []),
        ];
  const unique = new Map<string, z.infer<typeof source>>();
  for (const candidate of candidates) {
    const url = new URL(candidate.url).href;
    const existing = unique.get(url);
    if (!existing || (!existing.label && candidate.label))
      unique.set(url, candidate);
  }
  return [...unique.values()];
}

export function sourcesForViewSelection(
  view: ResearchView,
  row: Row,
  field?: string,
) {
  const accepted = view.acceptedSources?.[row.id];
  const extra = field
    ? (accepted?.[field] ?? [])
    : Object.values(accepted ?? {}).flat();
  const sources = [...extra, ...sourcesForSelection(row, field)];
  return [...new Map(sources.map((s) => [s.url, s])).values()];
}
