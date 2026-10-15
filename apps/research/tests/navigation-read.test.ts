import test from "node:test";
import assert from "node:assert/strict";
import {
  readNavigation,
  type NavigationArguments,
} from "../src/navigation-read.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

function view(snapshotId: string, offset = 0): ResearchView {
  const snapshot = { ...snapshotSchema.parse(sample), id: snapshotId };
  return {
    snapshot,
    displayTitle: snapshot.title,
    revision: 0,
    amendments: [],
    snapshots: [],
    requests: [],
    preview: {
      offset,
      returned: snapshot.rows.length,
      total: 300,
      nextOffset: 200,
    },
  };
}

function reader(next: ResearchView) {
  const calls: NavigationArguments[] = [];
  return {
    calls,
    read: async (arguments_: NavigationArguments) => {
      calls.push(arguments_);
      return next;
    },
  };
}

test("returning to a saved window uses exactly one opening read", async () => {
  const expected = view("parent", 100);
  const { read, calls } = reader(expected);
  const next = await readNavigation({
    snapshotId: "parent",
    current: view("child"),
    savedWindow: { windowOffset: 100 },
    read,
  });
  assert.equal(next, expected);
  assert.deepEqual(calls, [{ snapshot_id: "parent", offset: 100 }]);
});

test("a child can return to its canonical origin row without a second page read", async () => {
  const child = view("child");
  child.requests = [
    {
      id: "expansion",
      kind: "expand",
      snapshotId: "parent",
      resultSnapshotId: "child",
      rowId: "canonical-row-173",
      field: "name",
      question: "Research this row",
      createdAt: "2026-10-15T00:00:00Z",
      status: "completed",
    },
  ];
  const { read, calls } = reader(view("parent", 173));
  await readNavigation({ snapshotId: "parent", current: child, read });
  assert.deepEqual(calls, [
    {
      snapshot_id: "parent",
      row_id: "canonical-row-173",
    },
  ]);
});

test("an explicitly saved first window wins over an expansion origin", async () => {
  const child = view("child");
  child.requests = [
    {
      id: "expansion",
      kind: "expand",
      snapshotId: "parent",
      resultSnapshotId: "child",
      rowId: "canonical-row-173",
      question: "Research this row",
      createdAt: "2026-10-15T00:00:00Z",
      status: "completed",
    },
  ];
  const { read, calls } = reader(view("parent"));
  await readNavigation({
    snapshotId: "parent",
    current: child,
    savedWindow: { windowOffset: 0 },
    read,
  });
  assert.deepEqual(calls, [{ snapshot_id: "parent", offset: 0 }]);
});

test("reopening the same table preserves its current window in one fresh read", async () => {
  const current = view("parent", 200);
  const { read, calls } = reader(current);
  await readNavigation({ snapshotId: "parent", current, read });
  assert.deepEqual(calls, [{ snapshot_id: "parent", offset: 200 }]);
});

test("another table's origin row cannot leak into unrelated navigation", async () => {
  const child = view("child");
  child.requests = [
    {
      id: "unrelated",
      kind: "expand",
      snapshotId: "other-parent",
      resultSnapshotId: "other-child",
      rowId: "other-row",
      question: "Research this row",
      createdAt: "2026-10-15T00:00:00Z",
      status: "completed",
    },
  ];
  const { read, calls } = reader(view("parent"));
  await readNavigation({ snapshotId: "parent", current: child, read });
  assert.deepEqual(calls, [{ snapshot_id: "parent" }]);
});

test("latest-table opens do not attach a previous table's paging arguments", async () => {
  const { read, calls } = reader(view("latest"));
  await readNavigation({ current: view("parent", 100), read });
  assert.deepEqual(calls, [{}]);
});

test("an opening read refuses the wrong canonical table and never retries", async () => {
  const { read, calls } = reader(view("different-table"));
  await assert.rejects(
    readNavigation({ snapshotId: "requested-table", read }),
    /different research table/,
  );
  assert.deepEqual(calls, [{ snapshot_id: "requested-table" }]);
});

test("failed navigation is surfaced without falling back to a cached view or second read", async () => {
  let calls = 0;
  const revoked = new Error("Access revoked");
  await assert.rejects(
    readNavigation({
      snapshotId: "parent",
      current: view("parent", 100),
      read: async () => {
        calls++;
        throw revoked;
      },
    }),
    (error) => error === revoked,
  );
  assert.equal(calls, 1);
});
