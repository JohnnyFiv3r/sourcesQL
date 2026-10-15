import { createHash } from "node:crypto";
import { z } from "zod";
import {
  id,
  key,
  originForSnapshot,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";
import { validInstant } from "../src/typed-values.js";

export const CHECKPOINT_MAX_BYTES = 24 * 1024;
const instant = z.string().refine(validInstant, "Expected an exact timestamp");
const capturedAt = z
  .string()
  .refine(
    (value) => validInstant(value) || z.iso.date().safeParse(value).success,
    "Invalid capture timestamp",
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
const rowIds = z.array(id).min(1).max(200).refine(unique, "Duplicate row IDs");
const fields = z.array(key).min(1).max(128).refine(unique, "Duplicate fields");
const scalar = z.union([
  z.string().max(8000),
  z
    .number()
    .finite()
    .refine(
      (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
      "Unsafe integer",
    ),
  z.boolean(),
  z.null(),
]);
const checkpointQueryInputSchema = z
  .object({
    query: z.string().min(1).max(16384),
    parameters: z
      .record(key, scalar)
      .refine(
        (values) => Object.keys(values).length <= 128,
        "Too many parameters",
      )
      .default({}),
    request_id: z.string().uuid().optional(),
    profile: key.optional(),
  })
  .strict();
export const checkpointQuerySchema = checkpointQueryInputSchema
  .extend({ provenance: z.enum(["planned", "saved_result"]) })
  .strict();
export const checkpointPendingSchema = z
  .object({
    kind: z.enum(["research_request", "job", "run"]),
    id,
    request_id: z.string().uuid().optional(),
  })
  .strict();
const pending = z
  .array(checkpointPendingSchema)
  .max(20)
  .refine(
    (items) => unique(items.map((item) => `${item.kind}:${item.id}`)),
    "Duplicate pending handles",
  )
  .default([]);
const failure = z
  .object({ code: key, message: z.string().min(1).max(2000) })
  .strict();
export const saveCheckpointSchema = z
  .object({
    checkpoint_id: z.string().uuid(),
    snapshot_id: id,
    expected_revision: z.number().int().nonnegative(),
    question: z.string().trim().min(1).max(4000),
    scope: z.string().trim().min(1).max(2000),
    row_ids: rowIds.optional(),
    fields: fields.optional(),
    query: checkpointQueryInputSchema.optional(),
    pending,
    failure: failure.optional(),
    remaining_work: z
      .array(z.string().trim().min(1).max(1000))
      .max(20)
      .default([]),
  })
  .strict();
export type SaveCheckpointInput = z.input<typeof saveCheckpointSchema>;
export const checkpointSourceVersionSchema = z
  .object({
    id,
    contentSha256: hash.nullable(),
    retrievedAt: instant,
  })
  .strict();
export const checkpointDependencySchema = z
  .object({
    snapshotId: id,
    amendmentRevision: z.number().int().nonnegative(),
    capturedAt,
    result: z
      .object({
        engine: z.enum([
          "sourcesql",
          "open-webql",
          "legacy-import",
          "imported",
        ]),
        resultId: id,
        runId: id.nullable(),
        contentSha256: hash,
      })
      .strict(),
    sourceManifestSha256: hash.optional(),
    sourceVersions: z
      .array(checkpointSourceVersionSchema)
      .max(64)
      .refine(
        (items) => unique(items.map((item) => item.id)),
        "Duplicate source versions",
      ),
  })
  .strict();
export type CheckpointDependencyPin = z.infer<
  typeof checkpointDependencySchema
>;
export type CheckpointSourceVersionPin = z.infer<
  typeof checkpointSourceVersionSchema
>;
export const checkpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    createdAt: instant,
    executionContext: z.string().min(1).max(200).optional(),
    question: z.string().trim().min(1).max(4000),
    scope: z.string().trim().min(1).max(2000),
    selection: z
      .object({
        snapshotId: id,
        amendmentRevision: z.number().int().nonnegative(),
        rowIds: rowIds.nullable(),
        fields: fields.nullable(),
      })
      .strict(),
    dependencies: z.array(checkpointDependencySchema).min(1).max(32),
    query: checkpointQuerySchema.optional(),
    pending,
    failure: failure.optional(),
    remainingWork: z.array(z.string().trim().min(1).max(1000)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.dependencies.map((item) => item.snapshotId)))
      context.addIssue({
        code: "custom",
        message: "Duplicate checkpoint dependencies",
      });
    const selected = value.dependencies.find(
      (item) => item.snapshotId === value.selection.snapshotId,
    );
    if (
      !selected ||
      selected.amendmentRevision !== value.selection.amendmentRevision
    )
      context.addIssue({
        code: "custom",
        message: "Selected snapshot needs its exact dependency revision",
      });
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > CHECKPOINT_MAX_BYTES)
      context.addIssue({
        code: "custom",
        message:
          "Checkpoint exceeds 24 KiB; narrow references or remaining work",
      });
  });
export type ResearchCheckpoint = z.infer<typeof checkpointSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Digest the complete retained source metadata without embedding it in a checkpoint. */
export function checkpointSourceManifestHash(
  records: Record<string, unknown>[],
): string {
  return createHash("sha256")
    .update(`[${records.map(canonical).sort().join(",")}]`)
    .digest("hex");
}
/** Hash original inline observations; a result reference already carries its engine hash. */
export function checkpointSnapshotHash(snapshot: Snapshot): string {
  return (
    snapshot.dataRef?.contentSha256 ??
    createHash("sha256").update(canonical(snapshot)).digest("hex")
  );
}
export function checkpointDependencyForView(
  view: ResearchView,
  sourceVersions: CheckpointSourceVersionPin[] = [],
  sourceManifestSha256?: string,
): CheckpointDependencyPin {
  const origin = originForSnapshot(view.snapshot);
  return checkpointDependencySchema.parse({
    snapshotId: view.snapshot.id,
    amendmentRevision: view.revision,
    capturedAt: view.snapshot.capturedAt,
    result: { ...origin, contentSha256: checkpointSnapshotHash(view.snapshot) },
    sourceVersions,
    ...(sourceManifestSha256 ? { sourceManifestSha256 } : {}),
  });
}
export function validateCheckpoint(value: unknown): ResearchCheckpoint {
  return checkpointSchema.parse(value);
}
/** Metadata and views must already have been authorized by the caller. No I/O or execution. */
export function buildCheckpoint(
  input: SaveCheckpointInput,
  context: {
    view: ResearchView;
    dependencies: CheckpointDependencyPin[];
    createdAt?: string;
    executionContext?: string;
    queryMetadata?: z.input<typeof checkpointQueryInputSchema>;
  },
): ResearchCheckpoint {
  const value = saveCheckpointSchema.parse(input);
  const { view } = context;
  if (value.snapshot_id !== view.snapshot.id)
    throw new Error("Checkpoint snapshot identity mismatch");
  if (value.expected_revision !== view.revision)
    throw new Error(
      "Checkpoint amendment revision changed; reopen research before saving",
    );
  if (
    value.row_ids?.some(
      (rowId) => !view.snapshot.rows.some((row) => row.id === rowId),
    )
  )
    throw new Error(
      "Checkpoint selection contains an unknown canonical row ID",
    );
  if (
    value.fields?.some(
      (field) => !view.snapshot.columns.some((column) => column.key === field),
    )
  )
    throw new Error("Checkpoint selection contains an unknown column key");
  const dependencies = context.dependencies.map((dependency) =>
    checkpointDependencySchema.parse(dependency),
  );
  const root = dependencies.find(
    (dependency) => dependency.snapshotId === view.snapshot.id,
  );
  const expected = checkpointDependencyForView(view);
  if (
    !root ||
    root.amendmentRevision !== expected.amendmentRevision ||
    root.capturedAt !== expected.capturedAt ||
    canonical(root.result) !== canonical(expected.result)
  )
    throw new Error("Checkpoint dependency does not match authorized snapshot");
  const query = context.queryMetadata
    ? checkpointQuerySchema.parse({
        ...context.queryMetadata,
        provenance: "saved_result",
      })
    : value.query
      ? { ...value.query, provenance: "planned" as const }
      : undefined;
  return validateCheckpoint({
    schemaVersion: 1,
    id: value.checkpoint_id,
    ...(context.executionContext
      ? { executionContext: context.executionContext }
      : {}),
    createdAt: context.createdAt ?? new Date().toISOString(),
    question: value.question,
    scope: value.scope,
    selection: {
      snapshotId: value.snapshot_id,
      amendmentRevision: value.expected_revision,
      rowIds: value.row_ids ?? null,
      fields: value.fields ?? null,
    },
    dependencies,
    ...(query ? { query } : {}),
    pending: value.pending,
    ...(value.failure ? { failure: value.failure } : {}),
    remainingWork: value.remaining_work,
  });
}
export type CheckpointDependencyState =
  | {
      snapshotId: string;
      status: "authorized";
      pin: CheckpointDependencyPin;
      view?: ResearchView;
    }
  | { snapshotId: string; status: "missing" | "inaccessible" | "archived" };
export type CheckpointPendingState = {
  kind: ResearchCheckpoint["pending"][number]["kind"];
  id: string;
  status: "authorized" | "missing" | "inaccessible" | "foreign";
};
export type CheckpointBlocker = {
  code:
    | "missing"
    | "inaccessible"
    | "archived"
    | "stale_revision"
    | "result_changed"
    | "missing_source_version"
    | "source_version_changed"
    | "source_manifest_changed"
    | "selection_missing"
    | "foreign_pending"
    | "missing_pending"
    | "inaccessible_pending";
  reference: string;
};
export type CheckpointResume = {
  status: "ready" | "blocked";
  checkpoint: ResearchCheckpoint;
  blockers: CheckpointBlocker[];
  instructions: string[];
};
export function resumeCheckpoint(
  value: unknown,
  context: {
    dependencies: CheckpointDependencyState[];
    pending?: CheckpointPendingState[];
    executionContext?: string;
  },
): CheckpointResume {
  const checkpoint = validateCheckpoint(value);
  const blockers: CheckpointBlocker[] = [];
  for (const pinned of checkpoint.dependencies) {
    const current = context.dependencies.find(
      (item) => item.snapshotId === pinned.snapshotId,
    );
    if (!current || current.status !== "authorized") {
      blockers.push({
        code: current?.status ?? "missing",
        reference: pinned.snapshotId,
      });
      continue;
    }
    const pin = checkpointDependencySchema.parse(current.pin);
    if (pin.snapshotId !== pinned.snapshotId)
      throw new Error("Authorized checkpoint dependency identity mismatch");
    if (pin.amendmentRevision !== pinned.amendmentRevision)
      blockers.push({ code: "stale_revision", reference: pinned.snapshotId });
    if (
      pin.capturedAt !== pinned.capturedAt ||
      canonical(pin.result) !== canonical(pinned.result)
    )
      blockers.push({ code: "result_changed", reference: pinned.snapshotId });
    if (
      pinned.sourceManifestSha256 &&
      pin.sourceManifestSha256 !== pinned.sourceManifestSha256
    )
      blockers.push({
        code: "source_manifest_changed",
        reference: pinned.snapshotId,
      });
    for (const source of pinned.sourceVersions) {
      const sourceNow = pin.sourceVersions.find(
        (item) => item.id === source.id,
      );
      if (!sourceNow)
        blockers.push({ code: "missing_source_version", reference: source.id });
      else if (canonical(sourceNow) !== canonical(source))
        blockers.push({ code: "source_version_changed", reference: source.id });
    }
    if (pinned.snapshotId === checkpoint.selection.snapshotId && current.view) {
      const selection = checkpoint.selection;
      if (
        current.view.snapshot.id !== pinned.snapshotId ||
        selection.rowIds?.some(
          (rowId) =>
            !current.view!.snapshot.rows.some((row) => row.id === rowId),
        ) ||
        selection.fields?.some(
          (field) =>
            !current.view!.snapshot.columns.some(
              (column) => column.key === field,
            ),
        )
      )
        blockers.push({
          code: "selection_missing",
          reference: pinned.snapshotId,
        });
    }
  }
  for (const handle of checkpoint.pending) {
    const current = context.pending?.find(
      (item) => item.kind === handle.kind && item.id === handle.id,
    );
    if (
      checkpoint.executionContext &&
      context.executionContext &&
      checkpoint.executionContext !== context.executionContext
    )
      blockers.push({ code: "foreign_pending", reference: handle.id });
    else if (!current || current.status !== "authorized")
      blockers.push({
        code:
          current?.status === "foreign"
            ? "foreign_pending"
            : current?.status === "inaccessible"
              ? "inaccessible_pending"
              : "missing_pending",
        reference: handle.id,
      });
  }
  return {
    status: blockers.length ? "blocked" : "ready",
    checkpoint,
    blockers,
    instructions: [
      "Checkpoint inspection starts no execution. Missing, inaccessible or stale references require explicit resolution; never replace them with a new search.",
      ...checkpoint.pending
        .filter((handle) => handle.kind === "job")
        .map(
          (handle) =>
            `Inspect existing job_id ${handle.id}; preserve its identity and do not resubmit uncertain work.`,
        ),
    ],
  };
}
