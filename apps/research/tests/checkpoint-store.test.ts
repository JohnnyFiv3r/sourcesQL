import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchStore } from "../server/store.js";
import {
  checkpointDependencyForView,
  resumeCheckpoint,
  type SaveCheckpointInput,
} from "../server/checkpoints.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
const seed = snapshotSchema.parse(sample);
async function setup(context: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(
    join(tmpdir(), "sourcesql-checkpoint-store-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new ResearchStore(directory, seed) };
}
function input(
  overrides: Partial<SaveCheckpointInput> = {},
): SaveCheckpointInput {
  return {
    checkpoint_id: randomUUID(),
    snapshot_id: seed.id,
    expected_revision: 0,
    question: "Continue the same evidence review.",
    scope: "The saved first entity.",
    row_ids: [seed.rows[0].id],
    fields: [seed.columns[0].key],
    ...overrides,
  };
}
async function pins(store: ResearchStore, snapshotId = seed.id) {
  return (await store.dependencyViews(snapshotId)).map((view) =>
    checkpointDependencyForView(view),
  );
}

test("checkpoint and execution namespace survive a store restart without replacing original rows", async (context) => {
  const { directory, store } = await setup(context),
    args = input();
  const saved = await store.saveCheckpoint(args, await pins(store));
  const restarted = new ResearchStore(directory, seed);
  assert.deepEqual(
    (await restarted.readCheckpoint(saved.id)).checkpoint,
    saved,
  );
  assert.equal(
    await restarted.checkpointExecutionContext(),
    saved.executionContext,
  );
  assert.deepEqual((await restarted.open(seed.id)).snapshot, seed);
});
test("same-ID retry is idempotent and changed arguments cannot replace continuation state", async (context) => {
  const { store } = await setup(context),
    args = input();
  const saved = await store.saveCheckpoint(args, await pins(store));
  assert.deepEqual(await store.saveCheckpoint(args, await pins(store)), saved);
  await assert.rejects(
    store.saveCheckpoint(
      { ...args, question: "Different scope" },
      await pins(store),
    ),
    /different arguments/,
  );
  assert.deepEqual((await store.readCheckpoint(saved.id)).checkpoint, saved);
});
test("a subsequent correction makes the checkpoint stale instead of silently using newer values", async (context) => {
  const { directory, store } = await setup(context),
    args = input();
  const saved = await store.saveCheckpoint(args, await pins(store));
  await store.amend({
    snapshot_id: seed.id,
    row_id: seed.rows[0].id,
    field: seed.columns[0].key,
    value: "Corrected entity",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const restarted = new ResearchStore(directory, seed),
    view = await restarted.open(seed.id);
  const result = resumeCheckpoint(
    (await restarted.readCheckpoint(saved.id)).checkpoint,
    {
      dependencies: [
        {
          snapshotId: seed.id,
          status: "authorized",
          pin: checkpointDependencyForView(view),
          view,
        },
      ],
    },
  );
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, [
    { code: "stale_revision", reference: seed.id },
  ]);
  assert.equal(saved.selection.amendmentRevision, 0);
  assert.deepEqual(view.snapshot, seed);
});
test("save rechecks dependency closure and refuses a correction race before durable write", async (context) => {
  const { store } = await setup(context),
    oldPins = await pins(store),
    args = input();
  await store.amend({
    snapshot_id: seed.id,
    row_id: seed.rows[0].id,
    field: seed.columns[0].key,
    value: "New correction",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  await assert.rejects(store.saveCheckpoint(args, oldPins), /revision changed/);
  await assert.rejects(store.readCheckpoint(args.checkpoint_id), /not found/);
});
test("compact import persists references without restoring missing snapshots and refuses changed payloads", async (context) => {
  const { directory, store } = await setup(context),
    saved = await store.saveCheckpoint(input(), await pins(store));
  const target = new ResearchStore(join(directory, "target"), {
    ...seed,
    id: "different_seed",
  });
  assert.deepEqual(await target.importCheckpoint(saved), saved);
  assert.equal((await target.readCheckpoint(saved.id)).imported, true);
  await assert.rejects(target.open(seed.id), /not found/);
  await assert.rejects(
    target.importCheckpoint({ ...saved, question: "Altered question" }),
    /identity collision/,
  );
});
test("full research bundles preserve checkpoint records but never adopt the origin execution namespace", async (context) => {
  const { directory, store } = await setup(context),
    jobId = randomUUID();
  const saved = await store.saveCheckpoint(
    input({ pending: [{ kind: "job", id: jobId }] }),
    await pins(store),
  );
  const bundle = await store.exportBundle(seed.id);
  const target = new ResearchStore(join(directory, "target"), seed);
  await target.importBundle(bundle);
  const read = await target.readCheckpoint(saved.id);
  assert.equal(read.imported, true);
  assert.deepEqual(read.checkpoint.pending, [{ kind: "job", id: jobId }]);
  assert.notEqual(
    await target.checkpointExecutionContext(),
    saved.executionContext,
  );
  assert.deepEqual((await target.open(seed.id)).snapshot, seed);
});
