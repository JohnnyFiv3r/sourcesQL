import { z } from "zod";
import { queryFeedbackSchema } from "./query-feedback.js";
import { usageNotices } from "./usage.js";
import {
  cellDiagnosticSchema,
  id,
  key,
  researchQualitySchema,
  snapshotSchema,
  type ResearchView,
} from "./schema.js";

// Published widgets validate snapshot v2 strictly. Add presentation metadata at
// the view level so those immutable clients can still read the original cells.
// Keep this namespace frozen; future incompatible metadata needs a new version.
const presentationV1Schema = z.object({
  snapshotId: id,
  researchQuality: researchQualitySchema.optional(),
  rows: z
    .array(
      z.object({
        rowId: id,
        cellDiagnostics: z.record(key, z.array(cellDiagnosticSchema).max(32)),
      }),
    )
    .max(100),
});

export type ResearchViewWire = ResearchView & {
  presentationV1?: z.infer<typeof presentationV1Schema>;
  queryFeedbackV1?: {
    snapshotId: string;
    feedback: z.infer<typeof queryFeedbackSchema>;
  };
};

export function encodeResearchView(view: ResearchView): ResearchViewWire {
  const { researchQuality, queryFeedback, ...snapshot } = view.snapshot;
  const diagnostics: z.infer<typeof presentationV1Schema>["rows"] = [];
  const rows = snapshot.rows.map((row) => {
    const { cellDiagnostics, ...base } = row;
    if (cellDiagnostics !== undefined)
      diagnostics.push({ rowId: row.id, cellDiagnostics });
    return base;
  });
  return {
    ...view,
    snapshot: { ...snapshot, rows },
    ...(queryFeedback !== undefined
      ? {
          queryFeedbackV1: { snapshotId: snapshot.id, feedback: queryFeedback },
        }
      : {}),
    ...(researchQuality !== undefined || diagnostics.length
      ? {
          presentationV1: {
            snapshotId: snapshot.id,
            ...(researchQuality !== undefined ? { researchQuality } : {}),
            rows: diagnostics,
          },
        }
      : {}),
  };
}

const DISPLAY_ERROR =
  "The saved research could not be displayed safely. Reload the same table or refresh this connection's tools.";

export function decodeResearchView(value: unknown): ResearchView {
  try {
    if (!value || typeof value !== "object") throw new Error();
    const view = value as ResearchViewWire;
    if (!view.snapshot || !Array.isArray(view.amendments)) throw new Error();
    let snapshot = snapshotSchema.parse(view.snapshot);
    if (view.presentationV1 !== undefined) {
      const metadata = presentationV1Schema.parse(view.presentationV1);
      if (metadata.snapshotId !== snapshot.id) throw new Error();
      const diagnostics = new Map(
        metadata.rows.map((row) => [row.rowId, row.cellDiagnostics]),
      );
      if (
        diagnostics.size !== metadata.rows.length ||
        metadata.rows.some(
          (row) =>
            !snapshot.rows.some((candidate) => candidate.id === row.rowId),
        )
      )
        throw new Error();
      snapshot = snapshotSchema.parse({
        ...snapshot,
        ...(metadata.researchQuality !== undefined
          ? { researchQuality: metadata.researchQuality }
          : {}),
        rows: snapshot.rows.map((row) => ({
          ...row,
          ...(diagnostics.has(row.id)
            ? { cellDiagnostics: diagnostics.get(row.id) }
            : {}),
        })),
      });
    }
    // Advisory metadata must not prevent otherwise valid saved cells opening.
    const feedback = z
      .object({ snapshotId: id, feedback: queryFeedbackSchema })
      .safeParse(view.queryFeedbackV1);
    if (feedback.success && feedback.data.snapshotId === snapshot.id)
      snapshot = { ...snapshot, queryFeedback: feedback.data.feedback };
    const {
      presentationV1: _presentation,
      queryFeedbackV1: _feedback,
      ...base
    } = view;
    return {
      ...base,
      snapshot,
      ...(base.usageNotices === undefined
        ? {}
        : { usageNotices: usageNotices(base.usageNotices) }),
    };
  } catch {
    throw new Error(DISPLAY_ERROR);
  }
}
