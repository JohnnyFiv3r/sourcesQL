import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import {
  snapshotSchema,
  effectiveValue,
  type Snapshot,
} from "../src/schema.js";
import type {
  ResearchUpdateRequest,
  UpdateBeginInput,
  UpdateCompletionInput,
  UpdateEvidenceContext,
  UpdatePublishInput,
} from "../server/updates.js";

const columns = [
  {
    key: "issuer",
    label: "Organization",
    logicalType: "VARCHAR",
    nullable: false,
  },
  {
    key: "capacity",
    label: "Planned Capacity (MW)",
    logicalType: "INTEGER",
    nullable: true,
  },
];
function row(id: string, issuer: string, capacity: number) {
  return {
    id,
    values: { issuer, capacity },
    sourceUrl: "https://example.com/old",
    evidenceRefs: [],
    evidence: {},
    verificationNote: "Synthetic fixture",
  };
}
function snapshot(
  id: string,
  resultId: string,
  rows: Snapshot["rows"],
  at = "2026-10-14T00:00:00Z",
): Snapshot {
  return snapshotSchema.parse({
    schemaVersion: 2,
    id,
    title: id,
    origin: { engine: "sourcesql", resultId, runId: `run_${id}` },
    capturedAt: at,
    captureBasis: "run_completed_at",
    capturePrecision: "instant",
    dataClassification: "synthetic_fixture",
    rowCount: rows.length,
    coverage: {
      planComplete: true,
      corpusComplete: "bounded_fixture",
      notes: ["Synthetic fixture"],
    },
    columns,
    rows,
  });
}
function seed(count = 2) {
  return snapshot("baseline", "wq_baseline", [
    row("row_a", "Acme", 100),
    ...Array.from({ length: count - 1 }, (_, i) =>
      row(`row_b${i}`, `Beta ${i}`, 200 + i),
    ),
  ]);
}
function begin(snapshotId = "baseline"): UpdateBeginInput {
  return {
    request_id: randomUUID(),
    snapshot_id: snapshotId,
    expected_revision: 1,
    existing: { row_ids: ["row_a"], fields: ["capacity"] },
    discovery: {
      question: "Find additional organizations",
      identity_fields: ["issuer"],
    },
  };
}
function result(request: ResearchUpdateRequest) {
  const observed = new Date(Date.parse(request.createdAt) + 1000).toISOString(),
    completed = new Date(Date.parse(request.createdAt) + 2000).toISOString();
  const existing = snapshot(
    "existing",
    "wq_existing",
    [
      {
        ...row("row_a", "Acme", 120),
        sourceUrl: "https://example.com/current",
        evidence: { capacity: ["Acme planned capacity is 120 MW."] },
      },
    ],
    completed,
  );
  const discovery = snapshot(
    "discovery",
    "wq_discovery",
    [
      {
        ...row("row_c", "Gamma", 300),
        sourceUrl: "https://example.com/gamma",
        evidence: { issuer: ["Gamma"], capacity: ["300 MW"] },
      },
    ],
    completed,
  );
  const context = (
    snap: Snapshot,
    content: string,
    sourceId: string,
    rowId: string,
    url: string,
  ): UpdateEvidenceContext => ({
    result_id: snap.origin!.resultId,
    completed_at: completed,
    source_versions: [
      {
        source_version_id: sourceId,
        content,
        content_sha256: createHash("sha256").update(content).digest("hex"),
        retrieved_at: observed,
        content_basis: "document",
        url,
      },
    ],
    evidence: [
      {
        evidence_id: `e_${rowId}`,
        row_id: rowId,
        field: "capacity",
        source_version_id: sourceId,
        support: [{ quote: content }],
      },
    ],
  });
  const completion: UpdateCompletionInput = {
    request_id: request.id,
    existing_snapshot: existing,
    discovery_snapshot: discovery,
    assessments: [
      {
        row_id: "row_a",
        field: "capacity",
        status: "verified",
        note: "Current source reports 120 MW",
        observed_at: observed,
        source_version_ids: ["src_existing"],
      },
    ],
    discovery_observations: [
      {
        row_id: "row_c",
        observed_at: observed,
        source_version_ids: ["src_discovery"],
      },
    ],
  };
  const contexts = {
    existing: context(
      existing,
      "Acme planned capacity is 120 MW.",
      "src_existing",
      "row_a",
      "https://example.com/current",
    ),
    discovery: context(
      discovery,
      "Gamma planned capacity is 300 MW.",
      "src_discovery",
      "row_c",
      "https://example.com/gamma",
    ),
  };
  return { completion, contexts };
}
async function setup(
  t: { after(fn: () => Promise<void>): unknown },
  count = 2,
) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-update-store-")),
    initial = seed(count);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const restart = () => new ResearchStore(directory, initial),
    store = restart();
  await store.amend({
    snapshot_id: initial.id,
    row_id: "row_a",
    field: "capacity",
    value: 110,
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  return { store, restart, initial };
}
async function completed(
  t: { after(fn: () => Promise<void>): unknown },
  count = 2,
) {
  const f = await setup(t, count),
    input = begin(),
    request = await f.store.beginUpdate(input),
    returned = result(request);
  const saved = await f.store.completeUpdate(
    returned.completion,
    returned.contexts,
  );
  return { ...f, input, request, ...returned, saved };
}
async function reviewed(
  t: { after(fn: () => Promise<void>): unknown },
  count = 2,
) {
  const f = await completed(t, count);
  for (const change of f.saved.changes!)
    await f.store.reviewResearchUpdate({
      request_id: f.request.id,
      change_id: change.id,
      decision: "accept",
      expected_revision: 1,
      mutation_id: randomUUID(),
    });
  const publish: UpdatePublishInput = {
    request_id: f.request.id,
    snapshot_id: "accepted",
    expected_revision: 1,
    mutation_id: randomUUID(),
  };
  return { ...f, publish };
}

class Backend implements ResearchStateBackend {
  state?: ResearchState;
  revision = 0;
  writes = 0;
  loseNextResponse = false;
  holdReads = false;
  private waiting: (() => void)[] = [];
  async read() {
    const value = {
      state: structuredClone(this.state),
      version: String(this.revision),
    };
    if (this.holdReads)
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length === 2) {
          this.holdReads = false;
          this.waiting.splice(0).forEach((release) => release());
        }
      });
    return value;
  }
  async write(state: ResearchState, expectedVersion: string) {
    if (expectedVersion !== String(this.revision))
      throw new Error("durable CAS conflict");
    this.state = structuredClone(state);
    this.revision++;
    this.writes++;
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("lost commit response");
    }
  }
}

test("update begin survives restart, identical retry recovers, changed scope conflicts", async (t) => {
  const { store, restart } = await setup(t),
    input = begin(),
    first = await store.beginUpdate(input);
  assert.deepEqual(await restart().beginUpdate(input), first);
  assert.equal(
    (await restart().readUpdate(first.id)).baseline[0].values.capacity,
    110,
  );
  await assert.rejects(
    restart().beginUpdate({ ...input, discovery: undefined }),
    /different scope/,
  );
});

test("identical completion retry normalizes the server-bound parent and never duplicates proposals", async (t) => {
  const { restart, completion, contexts, saved } = await completed(t);
  assert.equal(completion.existing_snapshot!.parentSnapshotId, undefined);
  const replay = await restart().completeUpdate(
    structuredClone(completion),
    contexts,
  );
  assert.deepEqual(replay, saved);
  const exported = await restart().exportBundle("baseline");
  assert.deepEqual(exported.state.snapshots.map((s) => s.id).sort(), [
    "baseline",
    "discovery",
    "existing",
  ]);
  await assert.rejects(
    restart().completeUpdate(
      {
        ...completion,
        assessments: [
          { ...completion.assessments[0], note: "Different payload" },
        ],
      },
      contexts,
    ),
    /different results/,
  );
});

test("review decisions persist across restarts, dedupe exact mutations and reject changed arguments", async (t) => {
  const { store, restart, saved, request } = await completed(t),
    change = saved.changes![0];
  const review = {
    request_id: request.id,
    change_id: change.id,
    decision: "accept" as const,
    expected_revision: 1,
    mutation_id: randomUUID(),
  };
  const first = await store.reviewResearchUpdate(review);
  assert.deepEqual(await restart().reviewResearchUpdate(review), first);
  await assert.rejects(
    restart().reviewResearchUpdate({ ...review, decision: "keep" }),
    /mutation ID already used/,
  );
  await restart().reviewResearchUpdate({
    ...review,
    decision: "keep",
    mutation_id: randomUUID(),
  });
  const reconsidered = await restart().readUpdate(request.id);
  assert.equal(reconsidered.reviewMutations?.length, 2);
  assert.equal(reconsidered.decisions?.[change.id], "keep");
  assert.equal(reconsidered.reviewMutations?.[0].decision, "accept");
});

test("publication requires review, preserves original observations and corrections, and reopens a successor", async (t) => {
  const f = await completed(t),
    publish = {
      request_id: f.request.id,
      snapshot_id: "accepted",
      expected_revision: 1,
      mutation_id: randomUUID(),
    };
  await assert.rejects(f.store.publishResearchUpdate(publish), /Review every/);
  assert.equal(
    (await f.restart().readUpdate(f.request.id)).publication,
    undefined,
  );
  for (const change of f.saved.changes!)
    await f.store.reviewResearchUpdate({
      request_id: f.request.id,
      change_id: change.id,
      decision: "accept",
      expected_revision: 1,
      mutation_id: randomUUID(),
    });
  const first = await f.store.publishResearchUpdate(publish),
    restarted = f.restart(),
    accepted = await restarted.open("accepted"),
    original = await restarted.open("baseline");
  assert.deepEqual(
    accepted.snapshot.rows.map((r) => [r.id, r.values.capacity]),
    [
      ["row_a", 120],
      ["row_b0", 200],
      ["row_c", 300],
    ],
  );
  assert.equal(original.snapshot.rows[0].values.capacity, 100);
  assert.equal(original.amendments.length, 1);
  assert.equal(
    effectiveValue(original, original.snapshot.rows[0], "capacity"),
    110,
  );
  assert.equal(accepted.snapshot.parentSnapshotId, original.snapshot.id);
  assert.deepEqual(await restarted.publishResearchUpdate(publish), first);
  await assert.rejects(
    restarted.publishResearchUpdate({ ...publish, snapshot_id: "other" }),
    /different arguments/,
  );
});

test("a later parent correction blocks new reviews and stale publication without erasing proposals", async (t) => {
  const f = await reviewed(t);
  await f.store.amend({
    snapshot_id: "baseline",
    row_id: "row_a",
    field: "capacity",
    value: 115,
    expected_revision: 1,
    mutation_id: randomUUID(),
  });
  await assert.rejects(
    f.restart().publishResearchUpdate({ ...f.publish, expected_revision: 2 }),
    /baseline has changed/,
  );
  await assert.rejects(
    f.restart().reviewResearchUpdate({
      request_id: f.request.id,
      change_id: f.saved.changes![0].id,
      decision: "accept",
      expected_revision: 2,
      mutation_id: randomUUID(),
    }),
    /baseline changed/,
  );
  assert.equal(
    (await f.restart().readUpdate(f.request.id)).status,
    "completed",
  );
  assert.equal((await f.restart().open("baseline")).amendments.length, 2);
});

test("an already-published exact mutation remains recoverable after later parent amendments", async (t) => {
  const f = await reviewed(t),
    first = await f.store.publishResearchUpdate(f.publish);
  await f.store.amend({
    snapshot_id: "baseline",
    row_id: "row_a",
    field: "capacity",
    value: 115,
    expected_revision: 1,
    mutation_id: randomUUID(),
  });
  const recovered = await f.restart().publishResearchUpdate(f.publish);
  assert.deepEqual(recovered.snapshot, first.snapshot);
  assert.equal(
    (await f.restart().readUpdate(f.request.id)).publishedSnapshotId,
    "accepted",
  );
});

test("cancelled updates survive restart and reject late source results", async (t) => {
  const { store, restart } = await setup(t),
    request = await store.beginUpdate(begin()),
    returned = result(request);
  const cancelled = await store.finishUpdate(
    request.id,
    "cancelled",
    "Owner cancelled the check",
  );
  assert.deepEqual(
    await restart().finishUpdate(request.id, "cancelled", "Repeated"),
    cancelled,
  );
  await assert.rejects(
    restart().completeUpdate(returned.completion, returned.contexts),
    /closed.*late results/,
  );
  assert.equal(
    (await restart().exportBundle("baseline")).state.snapshots.length,
    1,
  );
});

test("oversized accepted successors fail without losing review decisions or changing the baseline", async (t) => {
  const f = await reviewed(t, 100);
  await assert.rejects(
    f.store.publishResearchUpdate(f.publish),
    /100-row inline limit/,
  );
  const after = await f.restart().readUpdate(f.request.id);
  assert.equal(after.status, "completed");
  assert.equal(after.publishedSnapshotId, undefined);
  assert.equal(Object.keys(after.decisions!).length, 2);
  assert.equal((await f.restart().open("baseline")).snapshot.rows.length, 100);
});

test("durable CAS permits one concurrent update write, and the losing request can safely retry", async () => {
  const backend = new Backend(),
    initial = seed(),
    restart = () =>
      new ResearchStore("/not-used", initial, undefined, 3000, { backend });
  await restart().amend({
    snapshot_id: "baseline",
    row_id: "row_a",
    field: "capacity",
    value: 110,
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const requests = [begin(), begin()];
  backend.holdReads = true;
  const attempts = await Promise.allSettled(
    requests.map((input) => restart().beginUpdate(input)),
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    1,
  );
  assert.equal(backend.state?.updates?.length, 1);
  const losing = attempts.findIndex((attempt) => attempt.status === "rejected");
  await restart().beginUpdate(requests[losing]);
  assert.equal(backend.state?.updates?.length, 2);
});

test("lost durable completion/review/publication responses recover through the same identities", async () => {
  const backend = new Backend(),
    initial = seed(),
    restart = () =>
      new ResearchStore("/not-used", initial, undefined, 3000, { backend });
  await restart().amend({
    snapshot_id: "baseline",
    row_id: "row_a",
    field: "capacity",
    value: 110,
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const request = await restart().beginUpdate(begin()),
    returned = result(request);
  backend.loseNextResponse = true;
  await assert.rejects(
    restart().completeUpdate(returned.completion, returned.contexts),
    /lost commit response/,
  );
  const saved = await restart().completeUpdate(
    returned.completion,
    returned.contexts,
  );
  for (const change of saved.changes!) {
    const review = {
      request_id: request.id,
      change_id: change.id,
      decision: "accept" as const,
      expected_revision: 1,
      mutation_id: randomUUID(),
    };
    backend.loseNextResponse = true;
    await assert.rejects(
      restart().reviewResearchUpdate(review),
      /lost commit response/,
    );
    await restart().reviewResearchUpdate(review);
  }
  const publish = {
    request_id: request.id,
    snapshot_id: "accepted",
    expected_revision: 1,
    mutation_id: randomUUID(),
  };
  backend.loseNextResponse = true;
  await assert.rejects(
    restart().publishResearchUpdate(publish),
    /lost commit response/,
  );
  assert.equal(
    (await restart().publishResearchUpdate(publish)).snapshot.id,
    "accepted",
  );
  assert.equal(backend.state?.snapshots.length, 4);
  assert.equal(
    (await restart().readUpdate(request.id)).reviewMutations?.length,
    2,
  );
});

test("full bundle transfers retain update proposals, decisions, publication and source-version history", async (t) => {
  const f = await reviewed(t);
  await f.store.publishResearchUpdate(f.publish);
  const bundle = await f.restart().exportBundle("accepted"),
    targetDir = await mkdtemp(join(tmpdir(), "sourcesql-update-import-"));
  t.after(() => rm(targetDir, { recursive: true, force: true }));
  const target = new ResearchStore(targetDir, f.initial);
  await target.importBundle(bundle);
  const sourceUpdate = await f.restart().readUpdate(f.request.id),
    importedUpdate = await target.readUpdate(f.request.id);
  assert.deepEqual(importedUpdate, sourceUpdate);
  assert.deepEqual(
    (await target.open("accepted")).snapshot,
    (await f.store.open("accepted")).snapshot,
  );
  assert.equal((await target.open("baseline")).amendments.length, 1);
  await target.importBundle(bundle);
  assert.equal(
    (await target.exportBundle("accepted")).state.updates?.length,
    1,
  );
});

test("bundle import refuses altered update claims and missing proposal dependencies", async (t) => {
  const f = await reviewed(t);
  await f.store.publishResearchUpdate(f.publish);
  for (const alteration of ["claim", "missing"] as const) {
    const bundle = await f.store.exportBundle("accepted");
    if (alteration === "claim")
      bundle.state.updates![0].changes![0].proposed = 999;
    if (alteration === "missing")
      bundle.state.snapshots = bundle.state.snapshots.filter(
        (snapshot) => snapshot.id !== "existing",
      );
    const targetDir = await mkdtemp(
      join(tmpdir(), "sourcesql-update-invalid-"),
    );
    t.after(() => rm(targetDir, { recursive: true, force: true }));
    await assert.rejects(
      new ResearchStore(targetDir, f.initial).importBundle(bundle),
    );
  }
});

test("archiving a child with a pending update requires explicitly closing that update first", async (t) => {
  const f = await setup(t);
  const child = snapshot("child", "wq_child", f.initial.rows);
  child.parentSnapshotId = "baseline";
  await f.store.import(child);
  await f.store.amend({
    snapshot_id: "child",
    row_id: "row_a",
    field: "capacity",
    value: 110,
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const request = await f.store.beginUpdate(begin("child"));
  await assert.rejects(
    f.store.remove("child"),
    /pending update|pending research|pending requests/,
  );
  await f.store.finishUpdate(
    request.id,
    "cancelled",
    "Owner cancelled before archiving",
  );
  assert.equal((await f.store.remove("child")).status, "archived");
  assert.equal((await f.restart().readUpdate(request.id)).status, "cancelled");
});

test("bundle import refuses review decisions and publication that disagree with accepted successor values", async (t) => {
  const f = await reviewed(t);
  await f.store.publishResearchUpdate(f.publish);
  const bundle = await f.store.exportBundle("accepted");
  const changeId = bundle.state.updates![0].changes![0].id;
  bundle.state.updates![0].decisions![changeId] = "keep";
  const targetDir = await mkdtemp(
    join(tmpdir(), "sourcesql-update-invalid-review-"),
  );
  t.after(() => rm(targetDir, { recursive: true, force: true }));
  await assert.rejects(
    new ResearchStore(targetDir, f.initial).importBundle(bundle),
  );
});
