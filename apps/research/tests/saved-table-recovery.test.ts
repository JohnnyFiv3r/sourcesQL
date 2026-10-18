import test from "node:test";
import assert from "node:assert/strict";
import {
  SAVED_TABLE_LOAD_ERROR,
  SAVED_TABLE_TARGET_MISSING,
  SavedTableRecovery,
} from "../src/saved-table-recovery.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

function view(snapshotId: string): ResearchView {
  return {
    snapshot: { ...snapshotSchema.parse(sample), id: snapshotId },
    displayTitle: "Saved table",
    amendments: [],
    acceptedSources: {},
    revision: 0,
    snapshots: [],
    requests: [],
  };
}

test("an invalid bootstrap retains only its canonical table ID and retries that saved table once", async () => {
  const recovery = new SavedTableRecovery();
  const invalidSnapshot = { id: "saved-ohio", unrecognized: "not accepted" };
  assert.equal(snapshotSchema.safeParse(invalidSnapshot).success, false);
  recovery.captureResult({ structuredContent: { snapshot: invalidSnapshot } });
  recovery.markFailed();
  const reads: string[] = [];
  const read = async (snapshotId: string) => {
    reads.push(snapshotId);
    return view(snapshotId);
  };
  assert.equal((await recovery.retry(read))?.snapshot.id, "saved-ohio");
  assert.equal(await recovery.retry(read), undefined);
  assert.deepEqual(reads, ["saved-ohio"]);
  assert.equal((await recovery.readSaved(read)).snapshot.id, "saved-ohio");
  assert.deepEqual(reads, ["saved-ohio", "saved-ohio"]);
});

test("approved tool input wins over a different result and recovery rejects a default fixture", async () => {
  const recovery = new SavedTableRecovery();
  recovery.captureInput({ snapshot_id: "saved-ohio" });
  recovery.captureResult({
    structuredContent: { snapshot: { id: "fixture" } },
  });
  recovery.markFailed();
  assert.equal(recovery.snapshotId, "saved-ohio");
  await assert.rejects(
    recovery.retry(async (snapshotId) => {
      assert.equal(snapshotId, "saved-ohio");
      return view("fixture");
    }),
    { message: SAVED_TABLE_LOAD_ERROR },
  );
  assert.throws(() => recovery.assertTarget(view("fixture")), {
    message: SAVED_TABLE_LOAD_ERROR,
  });
  assert.equal(await recovery.retry(async () => view("saved-ohio")), undefined);
});

test("no target means no automatic or manual read, never an empty default request", async () => {
  const recovery = new SavedTableRecovery();
  recovery.captureInput({ snapshot_id: "../not-a-canonical-id" });
  recovery.captureResult({ structuredContent: { snapshot: {} } });
  recovery.markFailed();
  const read = async (): Promise<ResearchView> => {
    assert.fail("A missing target must not open the default research table");
  };
  assert.equal(await recovery.retry(read), undefined);
  await assert.rejects(recovery.readSaved(read), {
    message: SAVED_TABLE_TARGET_MISSING,
  });
});

test("a failed reread cannot loop and accepted tables ignore later bootstrap targets", async () => {
  const recovery = new SavedTableRecovery();
  recovery.captureInput({ result_ref: { snapshot_id: "saved-ohio" } });
  recovery.markFailed();
  let reads = 0;
  const read = async (): Promise<ResearchView> => {
    reads++;
    throw new Error("Transient saved read failure");
  };
  await assert.rejects(recovery.retry(read), /Transient saved read failure/);
  assert.equal(await recovery.retry(read), undefined);
  assert.equal(reads, 1);
  recovery.markAccepted();
  recovery.captureInput({ snapshot_id: "fixture" });
  recovery.captureResult({
    structuredContent: { snapshot: { id: "fixture" } },
  });
  assert.equal(recovery.snapshotId, "saved-ohio");
  assert.equal(recovery.hasAccepted, true);
});

test("late approved input cannot let an older in-flight recovery open another table", async () => {
  const recovery = new SavedTableRecovery();
  recovery.captureResult({
    structuredContent: { snapshot: { id: "saved-old" } },
  });
  recovery.markFailed();
  let finish!: (view: ResearchView) => void;
  const pending = recovery.retry(
    () =>
      new Promise<ResearchView>((resolve) => {
        finish = resolve;
      }),
  );
  recovery.captureInput({ snapshot_id: "saved-current" });
  finish(view("saved-old"));
  await assert.rejects(pending, { message: SAVED_TABLE_LOAD_ERROR });
  assert.equal(recovery.snapshotId, "saved-current");
});
