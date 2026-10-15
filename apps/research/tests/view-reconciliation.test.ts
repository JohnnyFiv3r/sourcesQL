import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { HostedViewReconciliation } from "../src/view-reconciliation.js";
import {
  effectiveValue,
  snapshotSchema,
  type ResearchView,
} from "../src/schema.js";
import { ResearchStore } from "../server/store.js";
import sample from "../fixtures/water-procurement.json";

function view(
  revision = 0,
  snapshotId = "saved-research",
  offset = 0,
): ResearchView {
  const snapshot = { ...snapshotSchema.parse(sample), id: snapshotId };
  return {
    snapshot,
    displayTitle: snapshot.title,
    revision,
    amendments: [],
    snapshots: [],
    requests: [],
    preview: {
      offset,
      returned: snapshot.rows.length,
      total: 250,
      nextOffset: 200,
    },
  };
}

function harness(read?: (id: string, offset: number) => Promise<ResearchView>) {
  let resolve!: (next: ResearchView) => void;
  let reject!: (cause: unknown) => void;
  const deferred = new Promise<ResearchView>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const state = {
    current: undefined as ResearchView | undefined,
    navigation: 0,
    editing: false,
    reads: [] as { id: string; offset: number }[],
    accepted: [] as ResearchView[],
    errors: [] as unknown[],
  };
  let activeRead: Promise<ResearchView> | undefined;
  const reconciler = new HostedViewReconciliation({
    current: () => state.current,
    navigationVersion: () => state.navigation,
    editing: () => state.editing,
    read: (id, offset) => {
      state.reads.push({ id, offset });
      activeRead = read ? read(id, offset) : deferred;
      return activeRead;
    },
    accept: (next) => {
      reconciler.invalidate();
      state.current = next;
      state.accepted.push(next);
    },
    onError: (cause) => state.errors.push(cause),
  });
  return {
    state,
    reconciler,
    resolve,
    reject,
    settled: async () => {
      await activeRead;
      await setImmediate();
    },
  };
}

test("a cached tool result reloads the durable correction once, without another rendered tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-reopen-"));
  try {
    const seed = snapshotSchema.parse(sample);
    const old = await new ResearchStore(directory, seed).open(seed.id);
    await new ResearchStore(directory, seed).amend({
      snapshot_id: seed.id,
      row_id: seed.rows[0].id,
      field: "closes_at",
      value: null,
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const { state, reconciler, settled } = harness((id) =>
      new ResearchStore(directory, seed).open(id),
    );
    reconciler.hostResult(old);
    assert.equal(state.current?.revision, 0);
    assert.equal(state.reads.length, 0, "wait for the host connection");
    reconciler.hostConnected(true);
    await settled();
    assert.equal(state.current?.revision, 1);
    assert.equal(
      effectiveValue(
        state.current!,
        state.current!.snapshot.rows[0],
        "closes_at",
      ),
      null,
    );
    assert.equal(
      state.current!.snapshot.rows[0].values.closes_at,
      seed.rows[0].values.closes_at,
    );
    reconciler.hostConnected(true);
    reconciler.hostResult(old);
    await setImmediate();
    assert.deepEqual(state.reads, [{ id: seed.id, offset: 0 }]);
    assert.equal(
      state.current?.revision,
      1,
      "late cached results cannot undo corrections",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection before the tool result also reads once and retains the current window", async () => {
  const { state, reconciler, resolve } = harness();
  reconciler.hostConnected(true);
  assert.equal(state.reads.length, 0);
  const original = view(0, "saved-research", 100);
  reconciler.hostResult(original);
  resolve(view(1, "saved-research", 100));
  await setImmediate();
  assert.deepEqual(state.reads, [{ id: original.snapshot.id, offset: 100 }]);
  assert.equal(state.current?.preview?.offset, 100);
  assert.equal(state.current?.revision, 1);
});

test("durable titles and request state can change without an amendment revision", async () => {
  const { state, reconciler, resolve } = harness();
  reconciler.hostConnected(true);
  reconciler.hostResult(view());
  const next = { ...view(), displayTitle: "Renamed durable table" };
  resolve(next);
  await setImmediate();
  assert.equal(state.current, next);
});

for (const race of [
  "navigation",
  "newer view",
  "local edit",
  "disposed",
] as const) {
  test(`the initial read cannot overwrite ${race}`, async () => {
    const { state, reconciler, resolve } = harness();
    const original = view();
    reconciler.hostConnected(true);
    reconciler.hostResult(original);
    if (race === "navigation") {
      // Even returning to the same object must invalidate the old navigation.
      state.navigation += 2;
    } else if (race === "newer view") {
      state.current = view(2);
    } else if (race === "local edit") {
      // An edit may have begun and ended before this response arrives.
      reconciler.invalidate();
    } else reconciler.dispose();
    const expected = state.current;
    resolve(view(1));
    await setImmediate();
    assert.equal(state.current, expected);
    assert.equal(state.accepted.length, 1);
  });
}

for (const invalid of [
  "older revision",
  "different snapshot",
  "different window",
] as const) {
  test(`the initial read refuses a result with ${invalid}`, async () => {
    const { state, reconciler, resolve } = harness();
    const original = view(2);
    reconciler.hostConnected(true);
    reconciler.hostResult(original);
    resolve(
      invalid === "older revision"
        ? view(1)
        : invalid === "different snapshot"
          ? view(3, "different-research")
          : view(3, "saved-research", 100),
    );
    await setImmediate();
    assert.equal(state.current, original);
  });
}

test("late cached tool results cannot change the user's current table", async () => {
  const { state, reconciler, resolve } = harness();
  reconciler.hostConnected(true);
  reconciler.hostResult(view());
  state.navigation++;
  const child = view(0, "child-research");
  state.current = child;
  reconciler.hostResult(view());
  resolve(view(1));
  await setImmediate();
  assert.equal(state.current, child);
  assert.equal(state.reads.length, 1);
});

test("the first cached result cannot replace an already opened table", () => {
  const { state, reconciler } = harness();
  const child = view(0, "child-research");
  state.current = child;
  state.navigation++;
  assert.equal(reconciler.hostResult(view()), false);
  assert.equal(state.current, child);
});

test("preview or unsupported hosts do not trigger a server read", async () => {
  const { state, reconciler } = harness();
  reconciler.hostConnected(false);
  reconciler.hostResult(view());
  await setImmediate();
  assert.equal(state.accepted.length, 1);
  assert.equal(state.reads.length, 0);
});

test("an active unsaved editor is left intact", async () => {
  const { state, reconciler, resolve } = harness();
  reconciler.hostConnected(true);
  reconciler.hostResult(view());
  state.editing = true;
  resolve(view(1));
  await setImmediate();
  assert.equal(state.current?.revision, 0);
});

test("a failed current read reports recovery without clearing the cached table", async () => {
  const { state, reconciler, reject } = harness();
  const original = view();
  reconciler.hostResult(original);
  reconciler.hostConnected(true);
  const error = new Error("Tool not found: research_status");
  reject(error);
  await setImmediate();
  assert.equal(state.current, original);
  assert.deepEqual(state.errors, [error]);
});

test("errors from an abandoned read cannot replace a newer navigation's feedback", async () => {
  const { state, reconciler, reject } = harness();
  reconciler.hostConnected(true);
  reconciler.hostResult(view());
  state.navigation++;
  reject(new Error("old read failed"));
  await setImmediate();
  assert.deepEqual(state.errors, []);
});
