import { test } from "node:test";
import assert from "node:assert/strict";
import { researchTree, visibleResearchNodes } from "../src/research-tree.js";
import type { SnapshotOption } from "../src/schema.js";

const snapshot = (id: string, parentSnapshotId?: string): SnapshotOption => ({
  id,
  parentSnapshotId,
  title: id,
  capturedAt: "2026-10-13",
  depth: 0,
});

test("tree follows parent IDs across unrelated roots, irrespective of returned depth/order", () => {
  const tree = researchTree([
    snapshot("grandchild", "child"),
    snapshot("root-a"),
    snapshot("root-b"),
    snapshot("child", "root-a"),
    snapshot("sibling", "root-a"),
  ]);
  assert.deepEqual(
    tree.map((n) => n.snapshot.id),
    ["root-a", "root-b"],
  );
  assert.deepEqual(
    tree[0].children.map((n) => n.snapshot.id),
    ["child", "sibling"],
  );
  assert.equal(tree[0].children[0].children[0].snapshot.id, "grandchild");
  assert.deepEqual(
    visibleResearchNodes(tree, new Set(["child"])).map((n) => n.snapshot.id),
    ["root-a", "child", "sibling", "root-b"],
  );
  assert.deepEqual(
    visibleResearchNodes(tree, new Set(["root-a"])).map((n) => n.snapshot.id),
    ["root-a", "root-b"],
  );
});
test("legacy missing parents and cycles stay reachable without duplicate nodes", () => {
  const tree = researchTree([
    snapshot("orphan", "missing"),
    snapshot("a", "b"),
    snapshot("b", "a"),
    snapshot("a", "b"),
  ]);
  assert.deepEqual(
    visibleResearchNodes(tree, new Set()).map((n) => n.snapshot.id),
    ["orphan", "a", "b"],
  );
  assert.deepEqual(researchTree([]), []);
});
