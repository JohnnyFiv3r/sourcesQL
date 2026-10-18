import { z } from "zod";
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
};

export function encodeResearchView(view: ResearchView): ResearchViewWire {
  const { researchQuality, ...snapshot } = view.snapshot;
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
    const { presentationV1: _presentation, ...base } = view;
    return { ...base, snapshot };
  } catch {
    throw new Error(DISPLAY_ERROR);
  }
}
