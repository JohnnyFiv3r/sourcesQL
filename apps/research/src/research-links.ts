import type { ResearchRequestSummary, SnapshotOption } from "./schema.js";

export type ResearchLink = {
  request: ResearchRequestSummary;
  snapshot: SnapshotOption;
};

// Only completed, available expansion results are drill-down destinations.
export function researchLinks(view: {
  snapshot: { id: string };
  requests: ResearchRequestSummary[];
  snapshots: SnapshotOption[];
}): ResearchLink[] {
  const snapshots = new Map(
    view.snapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  const seen = new Set<string>();
  return [...view.requests].reverse().flatMap((request) => {
    const snapshot = snapshots.get(request.resultSnapshotId ?? "");
    if (
      request.kind !== "expand" ||
      request.status !== "completed" ||
      request.snapshotId !== view.snapshot.id ||
      !request.rowId ||
      !snapshot ||
      snapshot.parentSnapshotId !== view.snapshot.id ||
      seen.has(snapshot.id)
    )
      return [];
    seen.add(snapshot.id);
    return [{ request, snapshot }];
  });
}

export function researchForSelection(
  links: ResearchLink[],
  rowId: string,
  field?: string,
): ResearchLink[] {
  return links.filter(
    ({ request }) =>
      request.rowId === rowId &&
      (!field || !request.field || request.field === field),
  );
}

export function researchScopeLabel(
  links: ResearchLink[],
  field?: string,
): string {
  return field &&
    links.length > 0 &&
    links.every(({ request }) => !request.field)
    ? "Row research"
    : "Research";
}
