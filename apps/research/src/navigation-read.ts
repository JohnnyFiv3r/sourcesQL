import type { ResearchView } from "./schema.js";

export type NavigationArguments = {
  snapshot_id?: string;
  offset?: number;
  row_id?: string;
};

/** Restore a table window in its opening read, rather than paging afterwards. */
export async function readNavigation({
  snapshotId,
  current,
  savedWindow,
  read,
}: {
  snapshotId?: string;
  current?: ResearchView;
  savedWindow?: { windowOffset: number };
  read: (arguments_: NavigationArguments) => Promise<ResearchView>;
}): Promise<ResearchView> {
  const arguments_: NavigationArguments = snapshotId
    ? { snapshot_id: snapshotId }
    : {};
  if (snapshotId) {
    const offset =
      savedWindow?.windowOffset ??
      (current?.snapshot.id === snapshotId
        ? (current.preview?.offset ?? 0)
        : undefined);
    const origin = current?.requests.find(
      (request) =>
        request.resultSnapshotId === current.snapshot.id &&
        request.snapshotId === snapshotId,
    );
    // A saved first window is intentional; do not replace it with an origin row.
    if (offset !== undefined) arguments_.offset = offset;
    else if (origin?.rowId) arguments_.row_id = origin.rowId;
  }
  const next = await read(arguments_);
  if (snapshotId && next.snapshot.id !== snapshotId)
    throw new Error(
      "The host returned a different research table. Try reopening it.",
    );
  return next;
}
