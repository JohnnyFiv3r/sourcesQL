import { test } from "node:test";
import assert from "node:assert/strict";
import {
  researchLinks,
  researchForSelection,
  researchScopeLabel,
} from "../src/research-links.js";
import type { ResearchRequestSummary, SnapshotOption } from "../src/schema.js";

const request = (
  id: string,
  extra: Partial<ResearchRequestSummary> = {},
): ResearchRequestSummary => ({
  id,
  kind: "expand",
  snapshotId: "parent",
  rowId: "row-1",
  field: "name",
  question: "Research this field",
  createdAt: "2026-10-13T12:00:00Z",
  status: "completed",
  resultSnapshotId: id,
  ...extra,
});
const snapshot = (id: string, parentSnapshotId = "parent"): SnapshotOption => ({
  id,
  title: id,
  parentSnapshotId,
  capturedAt: "2026-10-13",
  depth: 1,
});

test("drill-downs exclude unfinished, refreshed, missing and unrelated results", () => {
  const requests = [
    request("valid"),
    request("pending", { status: "pending" }),
    request("failed", { status: "failed" }),
    request("cancelled", { status: "cancelled" }),
    request("refresh", { kind: "refresh" }),
    request("missing"),
    request("other-origin", { snapshotId: "elsewhere" }),
    request("wrong-parent"),
  ];
  const links = researchLinks({
    snapshot: { id: "parent" },
    requests,
    snapshots: requests
      .filter((r) => r.id !== "missing")
      .map((r) =>
        snapshot(r.id, r.id === "wrong-parent" ? "elsewhere" : "parent"),
      ),
  });
  assert.deepEqual(
    links.map((link) => link.snapshot.id),
    ["valid"],
  );
});

test("cells include their field and whole-row research without borrowing another field's research", () => {
  const requests = [
    request("name"),
    request("whole-row", { field: undefined }),
    request("price", { field: "price" }),
    request("other-row", { rowId: "row-2" }),
    request("duplicate", { resultSnapshotId: "name" }),
  ];
  const links = researchLinks({
    snapshot: { id: "parent" },
    requests,
    snapshots: requests.map((r) => snapshot(r.resultSnapshotId!)),
  });
  assert.deepEqual(
    researchForSelection(links, "row-1", "name").map((r) => r.snapshot.id),
    ["name", "whole-row"],
  );
  const inherited = researchForSelection(links, "row-1", "unresearched");
  assert.deepEqual(
    inherited.map((r) => r.snapshot.id),
    ["whole-row"],
  );
  assert.equal(researchScopeLabel(inherited, "unresearched"), "Row research");
  assert.equal(
    researchScopeLabel(researchForSelection(links, "row-1", "name"), "name"),
    "Research",
  );
  assert.deepEqual(researchForSelection(links, "row-2", "price"), []);
  assert.deepEqual(
    researchForSelection(links, "row-1").map((r) => r.snapshot.id),
    ["name", "price", "whole-row"],
  );
  assert.deepEqual(
    researchForSelection(links, "row-2").map((r) => r.snapshot.id),
    ["other-row"],
  );
});
