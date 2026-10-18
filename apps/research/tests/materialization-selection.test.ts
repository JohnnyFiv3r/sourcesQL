import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import {
  boundedPreview,
  resultSnapshot,
  type EngineResult,
} from "../server/engine.js";
import { buildMaterializationPayload } from "../server/materialization.js";
import {
  effectiveValue,
  type Amendment,
  type Snapshot,
} from "../src/schema.js";

function canonical(id: string): Snapshot {
  const result: EngineResult = {
    result_id: "wq_" + id,
    run_id: "run_" + id,
    columns: [
      { key: "value", label: "Value", logical_type: "VARCHAR", nullable: true },
    ],
    rows: [{ value: "original " + id }],
    row_ids: ["row_0"],
    row_count: 1,
    content_sha256: "a".repeat(64),
    data_classification: "public_web",
    evidence: [],
    source_versions: [],
    receipt: { status: "completed", finished_at: "2026-10-18T12:00:00Z" },
    next_offset: null,
  };
  return resultSnapshot(result, {
    result_id: result.result_id,
    snapshot_id: id,
    title: id,
  });
}

function amendment(
  snapshotId: string,
  sourceSnapshotId?: string,
  value = "accepted refresh",
  revision = 1,
): Amendment {
  return {
    snapshot_id: snapshotId,
    row_id: "row_0",
    field: "value",
    value,
    expected_revision: revision - 1,
    mutation_id: randomUUID(),
    revision,
    originalValue: "original " + snapshotId,
    createdAt: "2026-10-18T12:01:00Z",
    ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
  };
}

class MemoryBackend implements ResearchStateBackend {
  reads = 0;
  writes = 0;
  revision = 0;
  constructor(public state: ResearchState) {}
  async read() {
    this.reads++;
    return {
      state: structuredClone(this.state),
      version: String(this.revision),
    };
  }
  async write(state: ResearchState, expectedVersion: string) {
    assert.equal(
      expectedVersion,
      String(this.revision),
      "fixture CAS must not overwrite a concurrent commit",
    );
    this.state = structuredClone(state);
    this.revision++;
    this.writes++;
  }
}

function harness(snapshots: Snapshot[]) {
  const backend = new MemoryBackend({
    snapshots: snapshots.map((snapshot) =>
      snapshot.dataRef ? boundedPreview(snapshot) : structuredClone(snapshot),
    ),
    amendments: [],
  });
  const calls: string[] = [];
  const denied = new Set<string>();
  let beforeResolve: ((snapshot: Snapshot) => Promise<void>) | undefined;
  const store = new ResearchStore(
    "/unused-selection-test",
    snapshots[0],
    async (snapshot) => {
      calls.push(snapshot.id);
      await beforeResolve?.(snapshot);
      if (denied.has(snapshot.id))
        throw new Error("Result or dependency unavailable");
      return {
        ...structuredClone(
          snapshots.find((entry) => entry.id === snapshot.id)!,
        ),
        parentSnapshotId: snapshot.parentSnapshotId,
      };
    },
    3000,
    { backend },
  );
  return {
    backend,
    calls,
    denied,
    store,
    setBeforeResolve: (hook: typeof beforeResolve) => {
      beforeResolve = hook;
    },
  };
}

test("materialization selection reads one state and resolves only the contributing closure", async () => {
  const h = harness([
    canonical("baseline"),
    canonical("refresh"),
    canonical("unrelated"),
  ]);
  h.backend.state.amendments.push(amendment("baseline", "refresh"));
  h.denied.add("unrelated");
  const captured = await h.store.materializationContext({
    resultId: "wq_baseline",
    expectedRevision: 1,
  });
  assert.equal(h.backend.reads, 1);
  assert.equal(h.backend.writes, 0);
  assert.deepEqual([...h.calls].sort(), ["baseline", "refresh"]);
  assert.deepEqual(
    captured.dependencies.map((entry) => entry.snapshot.id).sort(),
    ["baseline", "refresh"],
  );
  assert.equal(captured.root.revision, 1);
  assert.equal(
    effectiveValue(captured.root, captured.root.snapshot.rows[0], "value"),
    "accepted refresh",
  );
  assert.deepEqual(
    buildMaterializationPayload(captured).parents.map(
      (parent) => parent.result_id,
    ),
    ["wq_baseline", "wq_refresh"],
  );
});

test("an unavailable contributing refresh blocks either selector; an unavailable unrelated result is never resolved", async () => {
  const h = harness([
    canonical("baseline"),
    canonical("refresh"),
    canonical("unrelated"),
  ]);
  h.backend.state.amendments.push(amendment("baseline", "refresh"));
  h.denied.add("refresh");
  h.denied.add("unrelated");
  for (const selection of [
    { resultId: "wq_baseline", expectedRevision: 1 },
    { snapshotId: "baseline", expectedRevision: 1 },
  ]) {
    h.calls.length = 0;
    await assert.rejects(
      h.store.materializationContext(selection),
      /dependency unavailable/,
    );
    assert.deepEqual([...h.calls].sort(), ["baseline", "refresh"]);
  }
  assert.equal(h.backend.writes, 0);
});

test("private nested inline contributors survive selection even when the root's immediate classification is public", async () => {
  const root = canonical("baseline");
  const inline = canonical("inline");
  const secret = canonical("secret");
  delete inline.dataRef;
  delete secret.dataRef;
  secret.dataClassification = "private_local";
  const h = harness([root, inline, secret, canonical("unrelated")]);
  h.backend.state.amendments.push(
    amendment("baseline", "inline"),
    amendment("inline", "secret"),
  );
  h.denied.add("unrelated");
  const captured = await h.store.materializationContext({
    snapshotId: "baseline",
    expectedRevision: 1,
  });
  assert.deepEqual([...h.calls], ["baseline"]);
  assert.deepEqual(
    captured.dependencies.map((entry) => entry.snapshot.id).sort(),
    ["baseline", "inline", "secret"],
  );
  assert.equal(captured.root.dataClassification, "public_web");
  const payload = buildMaterializationPayload(captured);
  assert.equal(payload.data_classification, "private_derived");
  assert.deepEqual(
    payload.parents.map((parent) => parent.result_id),
    ["wq_baseline"],
  );
  assert.equal(h.backend.reads, 1);
  assert.equal(h.backend.writes, 0);
});

test("delayed canonical resolution preserves the captured revision, values and closure while another writer commits", async () => {
  const h = harness([
    canonical("baseline"),
    canonical("refresh"),
    canonical("later"),
    canonical("unrelated"),
  ]);
  h.backend.state.amendments.push(
    amendment("baseline", "refresh", "captured correction"),
  );
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayOnce = true;
  h.setBeforeResolve(async (snapshot) => {
    if (snapshot.id === "baseline" && delayOnce) {
      delayOnce = false;
      started();
      await barrier;
    }
  });
  const pending = h.store.materializationContext({
    resultId: "wq_baseline",
    expectedRevision: 1,
  });
  await resolving;
  assert.equal(h.backend.reads, 1);
  const writer = new ResearchStore(
    "/unused-concurrent-writer",
    h.backend.state.snapshots[0],
    undefined,
    3000,
    { backend: h.backend },
  );
  // A supported correction commits while the first resolver is blocked. No
  // filesystem or database writer lock spans the captured operation's resolver.
  await writer.amend({
    snapshot_id: "baseline",
    row_id: "row_0",
    field: "value",
    value: "later correction",
    expected_revision: 1,
    mutation_id: randomUUID(),
  });
  const afterEdit = await h.backend.read();
  afterEdit.state.amendments.push(amendment("refresh", "later"));
  await h.backend.write(afterEdit.state, afterEdit.version);
  const readCountBeforeRelease = h.backend.reads;
  release();
  const captured = await pending;
  assert.equal(
    h.backend.reads,
    readCountBeforeRelease,
    "the captured operation must not reread state after resolving",
  );
  assert.equal(captured.root.revision, 1);
  assert.equal(
    effectiveValue(captured.root, captured.root.snapshot.rows[0], "value"),
    "captured correction",
  );
  assert.deepEqual(
    captured.dependencies.map((entry) => entry.snapshot.id).sort(),
    ["baseline", "refresh"],
  );
  assert.deepEqual([...h.calls].sort(), ["baseline", "refresh"]);
  const count = h.calls.length;
  await assert.rejects(
    h.store.materializationContext({
      resultId: "wq_baseline",
      expectedRevision: 1,
    }),
    /amendment revision changed/,
  );
  assert.equal(
    h.calls.length,
    count,
    "stale selection must stop before canonical resolution",
  );
  const current = await h.store.materializationContext({
    resultId: "wq_baseline",
    expectedRevision: 2,
  });
  assert.equal(
    effectiveValue(current.root, current.root.snapshot.rows[0], "value"),
    "later correction",
  );
  assert.deepEqual(
    current.dependencies.map((entry) => entry.snapshot.id).sort(),
    ["baseline", "later", "refresh"],
  );
});

test("ambiguous active results are refused before resolution; archived duplicate matches are excluded", async () => {
  const first = canonical("first");
  const second = { ...structuredClone(first), id: "second" };
  const h = harness([first, second]);
  await assert.rejects(
    h.store.materializationContext({
      resultId: "wq_first",
      expectedRevision: 0,
    }),
    /one canonical research snapshot/,
  );
  assert.deepEqual(h.calls, []);
  h.backend.state.archivedSnapshots = [
    { snapshotId: "second", archivedAt: "2026-10-18T12:02:00Z" },
  ];
  const captured = await h.store.materializationContext({
    resultId: "wq_first",
    expectedRevision: 0,
  });
  assert.equal(captured.root.snapshot.id, "first");
  assert.deepEqual(h.calls, ["first"]);
});

test("missing, archived and stale selections refuse before canonical resolution", async () => {
  const h = harness([canonical("baseline")]);
  for (const selection of [
    { snapshotId: "missing", expectedRevision: 0 },
    { resultId: "wq_missing", expectedRevision: 0 },
    { snapshotId: "baseline", expectedRevision: 1 },
    { resultId: "wq_baseline", expectedRevision: 1 },
  ])
    await assert.rejects(h.store.materializationContext(selection));
  h.backend.state.archivedSnapshots = [
    { snapshotId: "baseline", archivedAt: "2026-10-18T12:02:00Z" },
  ];
  await assert.rejects(
    h.store.materializationContext({
      snapshotId: "baseline",
      expectedRevision: 0,
    }),
    /archived/,
  );
  await assert.rejects(
    h.store.materializationContext({
      resultId: "wq_baseline",
      expectedRevision: 0,
    }),
    /one canonical research snapshot/,
  );
  assert.deepEqual(h.calls, []);
  assert.equal(h.backend.writes, 0);
});

test("origin-only inline results give explicit-materialization guidance and remain valid explicit inputs", async () => {
  const inline = canonical("successor");
  delete inline.dataRef;
  inline.parentSnapshotId = "baseline";
  const h = harness([canonical("baseline"), inline]);
  await assert.rejects(
    h.store.materializationContext({
      resultId: "wq_successor",
      expectedRevision: 0,
    }),
    /Inline origin references require explicit sourcesql_materialize_research/,
  );
  assert.deepEqual(h.calls, []);
  const captured = await h.store.materializationContext({
    snapshotId: "successor",
    expectedRevision: 0,
  });
  assert.equal(captured.root.snapshot.id, "successor");
  assert.equal(captured.root.revision, 0);
  assert.deepEqual(h.calls, ["baseline"]);
  assert.deepEqual(
    buildMaterializationPayload(captured).parents.map(
      (parent) => parent.result_id,
    ),
    ["wq_baseline"],
  );
});

test("an origin that disagrees with canonical dataRef cannot be implicitly promoted", async () => {
  const broken = canonical("baseline");
  broken.dataRef!.resultId = "wq_different";
  const h = harness([broken]);
  await assert.rejects(
    h.store.materializationContext({
      resultId: "wq_baseline",
      expectedRevision: 0,
    }),
    /dataRef must match origin/,
  );
  assert.deepEqual(h.calls, []);
});
