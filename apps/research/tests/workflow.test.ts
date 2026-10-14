import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchStore } from "../server/store.js";
import {
  snapshotSchema,
  effectiveValue,
  sourcesForViewSelection,
  type ResearchInput,
  type AppendResearchInput,
} from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import { researchLinks } from "../src/research-links.js";

const seed = snapshotSchema.parse(sample);
const input = (extra: Partial<ResearchInput> = {}): ResearchInput => ({
  request_id: randomUUID(),
  snapshot_id: seed.id,
  row_id: "record-1",
  field: "closes_at",
  question: "What has changed about this deadline?",
  ...extra,
});
const child = (id: string) => ({
  ...seed,
  id,
  sourceResultSetId: "r123abcdef",
  rows: [seed.rows[0]],
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-workflow-"));
  return { directory, store: new ResearchStore(directory, seed) };
}
test("tree origins retain request-time corrections and distinguish cell, row, table and legacy scopes", async () => {
  const { store } = await setup();
  const identity = seed.columns[0].key;
  await store.amend({
    snapshot_id: seed.id,
    row_id: "record-1",
    field: identity,
    value: "Corrected issuer",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  for (const [name, scope, kind] of [
    ["cell-origin", { field: "closes_at" }, "expand"],
    ["row-origin", { field: undefined }, "expand"],
    ["table-origin", { row_id: undefined, field: undefined }, "refresh"],
  ] as const) {
    const request = input(scope);
    await store.beginResearch(request, kind);
    await store.appendResearch({
      request_id: request.request_id,
      snapshot:
        kind === "refresh"
          ? { ...seed, id: name, sourceResultSetId: "r222abcdef" }
          : child(name),
      assessments:
        kind === "refresh"
          ? seed.rows.flatMap((row) =>
              seed.columns.map((column) => ({
                row_id: row.id,
                field: column.key,
                status: "unverified" as const,
                note: "Synthetic test; origin metadata only",
              })),
            )
          : undefined,
    });
  }
  await store.amend({
    snapshot_id: seed.id,
    row_id: "record-1",
    field: identity,
    value: "Later issuer name",
    expected_revision: 1,
    mutation_id: randomUUID(),
  });
  await store.import({ ...child("legacy-origin"), parentSnapshotId: seed.id });
  const { snapshots } = await store.open();
  assert.equal(
    snapshots.find((s) => s.id === "cell-origin")?.originLabel,
    "Corrected issuer / Deadline",
  );
  assert.equal(
    snapshots.find((s) => s.id === "row-origin")?.originLabel,
    "Corrected issuer / Entire row",
  );
  assert.equal(
    snapshots.find((s) => s.id === "table-origin")?.originLabel,
    `${seed.title} / Entire table`,
  );
  assert.equal(
    snapshots.find((s) => s.id === "legacy-origin")?.originLabel,
    undefined,
  );
  assert.equal(
    snapshots.find((s) => s.id === "legacy-origin")?.parentTitle,
    seed.title,
  );
});
function proposal(
  request_id: string,
  status: "verified" | "conflicting" | "unverified" = "verified",
): AppendResearchInput {
  return {
    request_id,
    snapshot: {
      ...child("refresh-child"),
      rows: [
        {
          ...seed.rows[0],
          values: { ...seed.rows[0].values, closes_at: "2026-10-05 15:00:00" },
          sourceUrl: "https://example.com/new-deadline",
          evidence: {
            closes_at: ["Synthetic test: closes October 5 at 3 pm."],
          },
        },
      ],
    },
    assessments: [
      {
        row_id: "record-1",
        field: "closes_at",
        status,
        note: "Synthetic test observation",
      },
    ],
  };
}
test("archiving a child is durable, isolated, reversible, and cannot be bypassed by retries", async () => {
  const { store, directory } = await setup();
  const request = input();
  await store.beginResearch(request, "expand");
  const completion = {
    request_id: request.request_id,
    snapshot: child("removed-child"),
  };
  const saved = await store.appendResearch(completion);
  await store.import({ ...child("sibling"), parentSnapshotId: seed.id });
  await store.amend({
    snapshot_id: seed.id,
    row_id: "record-1",
    field: "closes_at",
    value: "2026-10-04 15:00:00",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const before = await store.open();
  const sibling = await store.open("sibling");
  assert.equal(researchLinks(before).length, 1);
  const receipt = await store.remove("removed-child");
  assert.equal(receipt.parentSnapshotId, seed.id);
  assert.equal(receipt.status, "archived");
  assert.deepEqual(await store.remove("removed-child"), receipt);
  const restarted = new ResearchStore(directory, seed);
  const after = await restarted.open();
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(after.amendments, before.amendments);
  assert.deepEqual(
    (await restarted.open("sibling")).snapshot,
    sibling.snapshot,
  );
  assert.deepEqual(
    after.snapshots.map((s) => s.id),
    [seed.id, "sibling"],
  );
  assert.deepEqual(researchLinks(after), []);
  const context = await restarted.researchContext(request.request_id);
  assert.equal(context.request.status, "completed");
  assert.equal(context.request.resultArchivedAt, receipt.archivedAt);
  assert.match(context.instructions.join(" "), /archived/);
  const archivedState = JSON.parse(
    await readFile(join(directory, "research.json"), "utf8"),
  );
  assert.deepEqual(
    archivedState.snapshots.find(
      (s: { id: string }) => s.id === "removed-child",
    ),
    saved.snapshot,
  );
  assert.equal(archivedState.requests[0].status, "completed");
  await assert.rejects(
    restarted.open("removed-child"),
    /archived.*restore_research/,
  );
  await assert.rejects(restarted.import(saved.snapshot), /archived/);
  await assert.rejects(
    restarted.import({
      ...child("late-child"),
      parentSnapshotId: "removed-child",
    }),
    /archived/,
  );
  await assert.rejects(restarted.appendResearch(completion), /archived/);
  await assert.rejects(
    restarted.beginResearch(input({ snapshot_id: "removed-child" }), "expand"),
    /archived/,
  );
  await assert.rejects(
    restarted.rename({
      snapshot_id: "removed-child",
      expected_title: saved.displayTitle,
      title: "Changed",
    }),
    /archived/,
  );
  await assert.rejects(
    restarted.amend({
      snapshot_id: "removed-child",
      row_id: "record-1",
      field: "closes_at",
      value: "2026-10-04 15:00:00",
      expected_revision: 0,
      mutation_id: randomUUID(),
    }),
    /archived/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "research.json"), "utf8")),
    archivedState,
  );
  const restored = await restarted.restore("removed-child");
  assert.deepEqual(restored.snapshot, saved.snapshot);
  assert.deepEqual(await restarted.restore("removed-child"), restored);
  assert.equal(researchLinks(await restarted.open()).length, 1);
  assert.equal(
    (await restarted.researchContext(request.request_id)).request
      .resultArchivedAt,
    undefined,
  );
});
test("removal never cascades, closes pending requests, or deletes a root", async () => {
  const { store, directory } = await setup();
  await store.import({ ...child("branch"), parentSnapshotId: seed.id });
  await store.import({ ...child("leaf"), parentSnapshotId: "branch" });
  const before = await readFile(join(directory, "research.json"), "utf8");
  await assert.rejects(store.remove(seed.id), /Only child/);
  await assert.rejects(store.remove("missing"), /not found/);
  await assert.rejects(store.remove("branch"), /active children: leaf/);
  assert.equal(
    await readFile(join(directory, "research.json"), "utf8"),
    before,
  );
  const pending = input({ snapshot_id: "leaf" });
  await store.beginResearch(pending, "expand");
  await assert.rejects(store.remove("leaf"), /pending requests/);
  assert.equal(
    (await store.researchContext(pending.request_id)).request.status,
    "pending",
  );
  await store.finishResearch(
    pending.request_id,
    "cancelled",
    "Test user cancellation",
  );
  await store.remove("leaf");
  await store.remove("branch");
  await assert.rejects(store.restore("leaf"), /branch is archived/);
  await store.restore("branch");
  assert.ok(!(await store.open()).snapshots.some((s) => s.id === "leaf"));
  await store.restore("leaf");
  assert.equal((await store.open("leaf")).snapshot.parentSnapshotId, "branch");
});
test("archiving accepted refresh research preserves the parent correction and its source evidence", async () => {
  const { store, directory } = await setup();
  const request = input();
  await store.beginResearch(request, "refresh");
  await store.appendResearch(proposal(request.request_id));
  await store.reviewRefresh({
    request_id: request.request_id,
    row_id: "record-1",
    field: "closes_at",
    decision: "accept",
    expected_revision: 0,
  });
  const before = await store.open();
  await store.remove("refresh-child");
  const restarted = new ResearchStore(directory, seed);
  const after = await restarted.open();
  assert.deepEqual(after.amendments, before.amendments);
  assert.deepEqual(after.acceptedSources, before.acceptedSources);
  assert.equal(
    effectiveValue(after, after.snapshot.rows[0], "closes_at"),
    "2026-10-05 15:00:00",
  );
  assert.ok(
    sourcesForViewSelection(after, after.snapshot.rows[0], "closes_at").some(
      (s) => s.url === "https://example.com/new-deadline",
    ),
  );
  assert.equal(
    (await restarted.restore("refresh-child")).refresh?.changes[0].decision,
    "accept",
  );
});
test("requests and nested children survive restart with exact origin and frozen corrections", async () => {
  const { store, directory } = await setup();
  await store.amend({
    snapshot_id: seed.id,
    row_id: "record-1",
    field: "closes_at",
    value: "2026-10-04 15:00:00",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const start = input();
  const prepared = await store.beginResearch(start, "expand");
  assert.equal(prepared.request.status, "pending");
  assert.deepEqual(await store.beginResearch(start, "expand"), prepared);
  await assert.rejects(
    store.beginResearch({ ...start, row_id: "record-2" }, "expand"),
    /different scope/,
  );
  const restarted = new ResearchStore(directory, seed);
  const context = await restarted.researchContext(start.request_id);
  assert.equal(
    context.effectiveRowsAtRequest[0].values.closes_at,
    "2026-10-04 15:00:00",
  );
  assert.equal(
    context.originalSnapshot.rows[0].values.closes_at,
    seed.rows[0].values.closes_at,
  );
  const returned = {
    request_id: start.request_id,
    snapshot: child("first-child"),
  };
  const first = await restarted.appendResearch(returned);
  assert.equal(first.snapshot.parentSnapshotId, seed.id);
  assert.deepEqual(await restarted.appendResearch(returned), first);
  await assert.rejects(
    restarted.appendResearch({
      ...returned,
      snapshot: child("different-child"),
    }),
    /different results/,
  );
  const secondInput = input({ snapshot_id: "first-child" });
  await restarted.beginResearch(secondInput, "expand");
  await restarted.appendResearch({
    request_id: secondInput.request_id,
    snapshot: { ...child("grandchild"), sourceResultSetId: "r456abcdef" },
  });
  const root = await new ResearchStore(directory, seed).open();
  assert.deepEqual(
    root.snapshots.map((s) => [s.id, s.depth]),
    [
      [seed.id, 0],
      ["first-child", 1],
      ["grandchild", 2],
    ],
  );
  assert.equal(root.amendments.length, 1);
  assert.deepEqual(root.snapshot, seed);
});
test("parallel results bind to their originating selection, not completion order", async () => {
  const { store } = await setup();
  const first = input(),
    second = input({ row_id: "record-2" });
  await Promise.all([
    store.beginResearch(first, "expand"),
    store.beginResearch(second, "expand"),
  ]);
  await store.appendResearch({
    request_id: second.request_id,
    snapshot: child("second-returned-first"),
  });
  await store.appendResearch({
    request_id: first.request_id,
    snapshot: child("first-returned-second"),
  });
  const view = await store.open();
  assert.equal(
    view.requests.find((r) => r.id === first.request_id)?.resultSnapshotId,
    "first-returned-second",
  );
  assert.equal(
    view.requests.find((r) => r.id === second.request_id)?.rowId,
    "record-2",
  );
});
test("cancelled/failed requests reject late results and wrong-parent attachments", async () => {
  const { store } = await setup();
  for (const status of ["cancelled", "failed"] as const) {
    const request = input();
    await store.beginResearch(request, "expand");
    await store.finishResearch(request.request_id, status, "Test closure");
    await assert.rejects(
      store.appendResearch({
        request_id: request.request_id,
        snapshot: child(status),
      }),
      /closed/,
    );
  }
  const request = input();
  await store.beginResearch(request, "expand");
  await assert.rejects(
    store.appendResearch({
      request_id: request.request_id,
      snapshot: { ...child("wrong"), parentSnapshotId: "other" },
    }),
    /different parent/,
  );
  await assert.rejects(
    store.beginResearch(input({ row_id: undefined }), "expand"),
    /requires row_id and question/,
  );
  await assert.rejects(
    store.import({ ...seed, id: "cycle", parentSnapshotId: "cycle" }),
    /own parent/,
  );
});
test("refresh proposes differences and preserves original/corrected values until explicit acceptance", async () => {
  const { store, directory } = await setup();
  await store.amend({
    snapshot_id: seed.id,
    row_id: "record-1",
    field: "closes_at",
    value: "2026-10-04 15:00:00",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const request = input();
  await store.beginResearch(request, "refresh");
  const result = await store.appendResearch(proposal(request.request_id));
  assert.equal(result.refresh?.changes[0].status, "conflicting");
  let parent = await store.open();
  assert.equal(
    effectiveValue(parent, parent.snapshot.rows[0], "closes_at"),
    "2026-10-04 15:00:00",
  );
  const review = {
    request_id: request.request_id,
    row_id: "record-1",
    field: "closes_at",
    decision: "accept" as const,
    expected_revision: 1,
  };
  await store.reviewRefresh(review);
  await store.reviewRefresh(review);
  parent = await new ResearchStore(directory, seed).open();
  assert.equal(parent.amendments.length, 2);
  assert.equal(
    effectiveValue(parent, parent.snapshot.rows[0], "closes_at"),
    "2026-10-05 15:00:00",
  );
  assert.equal(parent.amendments[1].sourceSnapshotId, "refresh-child");
  assert.ok(
    sourcesForViewSelection(parent, parent.snapshot.rows[0], "closes_at").some(
      (s) => s.url === "https://example.com/new-deadline",
    ),
  );
  assert.deepEqual(parent.snapshot, seed);
});
test("unverified/conflicting evidence cannot be accepted, keep never mutates the parent", async () => {
  for (const status of ["unverified", "conflicting"] as const) {
    const { store } = await setup();
    const request = input();
    await store.beginResearch(request, "refresh");
    const result = await store.appendResearch(
      proposal(request.request_id, status),
    );
    assert.equal(result.refresh?.changes[0].canAccept, false);
    const review = {
      request_id: request.request_id,
      row_id: "record-1",
      field: "closes_at",
      expected_revision: 0,
    };
    await assert.rejects(
      store.reviewRefresh({ ...review, decision: "accept" }),
      /supported/,
    );
    await store.reviewRefresh({ ...review, decision: "keep" });
    assert.equal((await store.open()).revision, 0);
  }
});
test("refresh validates row identity, coverage, duplicate assessments, evidence and stale acceptance", async () => {
  const { store } = await setup();
  const request = input();
  await store.beginResearch(request, "refresh");
  const result = proposal(request.request_id);
  await assert.rejects(
    store.appendResearch({ ...result, assessments: [] }),
    /every requested/,
  );
  await assert.rejects(
    store.appendResearch({
      ...result,
      assessments: [...result.assessments!, ...result.assessments!],
    }),
    /duplicate/,
  );
  await assert.rejects(
    store.appendResearch({
      ...result,
      snapshot: { ...result.snapshot, rows: [] },
    }),
    /every requested row/,
  );
  await assert.rejects(
    store.appendResearch({
      ...result,
      snapshot: {
        ...result.snapshot,
        rows: [{ ...result.snapshot.rows[0], evidence: {} }],
      },
    }),
    /evidence/,
  );
  await store.appendResearch(result);
  await store.amend({
    snapshot_id: seed.id,
    row_id: "record-1",
    field: "closes_at",
    value: "2026-10-06 15:00:00",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  await assert.rejects(
    store.reviewRefresh({
      request_id: request.request_id,
      row_id: "record-1",
      field: "closes_at",
      decision: "accept",
      expected_revision: 0,
    }),
    /changed/,
  );
  assert.equal(
    (await store.open("refresh-child")).refresh?.changes[0].status,
    "conflicting",
  );
});
test("whole-row and whole-table refresh scopes require every field, and reject stale result IDs", async () => {
  const { store } = await setup();
  const request = input({ row_id: undefined, field: undefined });
  await store.beginResearch(request, "refresh");
  await assert.rejects(
    store.appendResearch({
      request_id: request.request_id,
      snapshot: { ...seed, id: "stale" },
    }),
    /newly executed/,
  );
  const all = {
    request_id: request.request_id,
    snapshot: { ...seed, id: "all-refreshed", sourceResultSetId: "rabcdef123" },
    assessments: seed.rows.flatMap((r) =>
      seed.columns.map((c) => ({
        row_id: r.id,
        field: c.key,
        status: "unverified" as const,
        note: "No current authoritative evidence",
      })),
    ),
  };
  const view = await store.appendResearch(all);
  assert.equal(
    view.refresh?.changes.length,
    seed.rows.length * seed.columns.length,
  );
  assert.ok(view.refresh?.changes.every((c) => !c.canAccept));
});
