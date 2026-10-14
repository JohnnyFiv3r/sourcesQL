import type { SnapshotOption } from "./schema.js";

export type ResearchNode = {
  snapshot: SnapshotOption;
  children: ResearchNode[];
};

export function researchOrigin(snapshot: SnapshotOption): string | undefined {
  const label = snapshot.originLabel ?? snapshot.parentTitle;
  if (!label) return;
  const prefix =
    snapshot.kind === "expand"
      ? "Expanded from"
      : snapshot.kind === "refresh"
        ? "Refresh of"
        : "From";
  return `${prefix}: ${label}`;
}

// Use saved parent IDs, not display order or titles, to derive the hierarchy.
export function researchTree(snapshots: SnapshotOption[]): ResearchNode[] {
  const ids = new Set(snapshots.map((s) => s.id));
  const seen = new Set<string>();
  const visit = (snapshot: SnapshotOption): ResearchNode[] => {
    if (seen.has(snapshot.id)) return [];
    seen.add(snapshot.id);
    return [
      {
        snapshot,
        children: snapshots
          .filter((s) => s.parentSnapshotId === snapshot.id)
          .flatMap(visit),
      },
    ];
  };
  const roots = snapshots
    .filter((s) => !s.parentSnapshotId || !ids.has(s.parentSnapshotId))
    .flatMap(visit);
  // Keep legacy orphaned/cyclic data reachable, once, without inventing evidence.
  return [...roots, ...snapshots.flatMap(visit)];
}

export function visibleResearchNodes(
  nodes: ResearchNode[],
  collapsed: Set<string>,
): ResearchNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(collapsed.has(node.snapshot.id)
      ? []
      : visibleResearchNodes(node.children, collapsed)),
  ]);
}
