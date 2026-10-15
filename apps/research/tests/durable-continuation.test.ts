import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import { checkpointDependencyForView } from "../server/checkpoints.js";
import { snapshotSchema, type Snapshot } from "../src/schema.js";
import type {
  UpdateEvidenceContext,
  ResearchUpdateRequest,
} from "../server/updates.js";

/** Exercise the actual durable boundary: JSON is persisted with sorted object
 * keys and parsed afresh on every read. Array order and values remain exact. */
class SortedJsonBackend implements ResearchStateBackend {
  json?: string;
  version = 0;
  writes = 0;
  loseNextResponse = false;
  async read() {
    return {
      state: this.json ? (JSON.parse(this.json) as ResearchState) : undefined,
      version: String(this.version),
    };
  }
  async write(state: ResearchState, expectedVersion: string) {
    assert.equal(expectedVersion, String(this.version), "stale durable writer");
    this.json = JSON.stringify(state, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    );
    this.version++;
    this.writes++;
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("Lost durable write acknowledgment");
    }
  }
}
function snapshot(id: string, capacity = 100): Snapshot {
  return snapshotSchema.parse({
    schemaVersion: 2,
    id,
    title: id,
    origin: {
      engine: "sourcesql",
      resultId: `result_${id}`,
      runId: `run_${id}`,
    },
    capturedAt: "2026-10-15T10:00:00Z",
    captureBasis: "run_completed_at",
    capturePrecision: "instant",
    dataClassification: "synthetic_fixture",
    rowCount: 1,
    coverage: {
      planComplete: true,
      corpusComplete: "bounded_fixture",
      notes: ["Synthetic fixture"],
    },
    columns: [
      {
        key: "issuer",
        label: "Organization",
        logicalType: "VARCHAR",
        nullable: false,
      },
      {
        key: "capacity",
        label: "Capacity",
        logicalType: "INTEGER",
        nullable: false,
      },
    ],
    rows: [
      {
        id: "row_a",
        values: { issuer: "Synthetic organization", capacity },
        sourceUrl: "https://example.com/fixture",
        evidenceRefs: [],
        evidence: {},
        verificationNote: "Synthetic fixture",
      },
    ],
  });
}
function fixture() {
  const backend = new SortedJsonBackend(),
    baseline = snapshot("sorted_baseline");
  const restart = () =>
    new ResearchStore("unused-durable-directory", baseline, undefined, 3000, {
      backend,
    });
  return { backend, baseline, restart };
}
async function pins(store: ResearchStore, snapshotId: string) {
  return (await store.dependencyViews(snapshotId)).map((view) =>
    checkpointDependencyForView(view),
  );
}
function beginArgs(snapshotId: string) {
  return {
    request_id: randomUUID(),
    snapshot_id: snapshotId,
    expected_revision: 0,
    existing: { row_ids: ["row_a"], fields: ["capacity"] },
  };
}
function completion(request: ResearchUpdateRequest) {
  const observed = new Date(Date.parse(request.createdAt) + 1000).toISOString(),
    completed = new Date(Date.parse(request.createdAt) + 2000).toISOString();
  const proposal = snapshot("sorted_proposal", 200);
  proposal.capturedAt = completed;
  const quote = "Synthetic organization capacity is 200 MW.";
  proposal.rows[0].evidence = { capacity: [quote] };
  const context: UpdateEvidenceContext = {
    result_id: proposal.origin!.resultId,
    completed_at: completed,
    source_versions: [
      {
        source_version_id: "src_sorted",
        content: quote,
        content_sha256: createHash("sha256").update(quote).digest("hex"),
        retrieved_at: observed,
        url: "https://example.com/current",
        content_basis: "document",
      },
    ],
    evidence: [
      {
        evidence_id: "e_sorted",
        row_id: "row_a",
        field: "capacity",
        source_version_id: "src_sorted",
        support: [{ quote }],
      },
    ],
  };
  return {
    input: {
      request_id: request.id,
      existing_snapshot: proposal,
      assessments: [
        {
          row_id: "row_a",
          field: "capacity",
          status: "verified" as const,
          note: "Synthetic source reports 200",
          observed_at: observed,
          source_version_ids: ["src_sorted"],
        },
      ],
      discovery_observations: [],
    },
    contexts: { [proposal.id]: context },
  };
}
async function completed() {
  const f = fixture(),
    request = await f.restart().beginUpdate(beginArgs(f.baseline.id)),
    returned = completion(request);
  const saved = await f
    .restart()
    .completeUpdate(returned.input, returned.contexts);
  return { ...f, request, returned, saved };
}
async function reviewed() {
  const f = await completed();
  const review = {
    request_id: f.request.id,
    change_id: f.saved.changes![0].id,
    decision: "accept" as const,
    expected_revision: 0,
    mutation_id: randomUUID(),
  };
  await f.restart().reviewResearchUpdate(review);
  return {
    ...f,
    review,
    publish: {
      request_id: f.request.id,
      snapshot_id: "sorted_accepted",
      expected_revision: 0,
      mutation_id: randomUUID(),
    },
  };
}

test("sorted durable JSON recovers the exact checkpoint after a lost acknowledgment", async () => {
  const f = fixture(),
    input = {
      checkpoint_id: randomUUID(),
      snapshot_id: f.baseline.id,
      expected_revision: 0,
      question: "Synthetic sorted-backend continuation",
      scope: "The same saved fixture.",
      query: { query: "SELECT $z, $a", parameters: { z: 2, a: 1 } },
    };
  f.backend.loseNextResponse = true;
  await assert.rejects(
    f.restart().saveCheckpoint(input, await pins(f.restart(), f.baseline.id)),
    /Lost durable write/,
  );
  const writes = f.backend.writes;
  const recovered = await f
    .restart()
    .saveCheckpoint(input, await pins(f.restart(), f.baseline.id));
  assert.equal(recovered.id, input.checkpoint_id);
  assert.equal(f.backend.writes, writes);
  await assert.rejects(
    f
      .restart()
      .saveCheckpoint(
        { ...input, scope: "Changed scope" },
        await pins(f.restart(), f.baseline.id),
      ),
    /different arguments/,
  );
});

test("sorted durable JSON preserves idempotent compact-checkpoint import and detects changed content", async () => {
  const f = fixture(),
    store = f.restart();
  const saved = await store.saveCheckpoint(
    {
      checkpoint_id: randomUUID(),
      snapshot_id: f.baseline.id,
      expected_revision: 0,
      question: "Synthetic checkpoint import",
      scope: "Unchanged context.",
    },
    await pins(store, f.baseline.id),
  );
  const target = fixture();
  await target.restart().importCheckpoint(saved);
  const writes = target.backend.writes;
  assert.deepEqual(await target.restart().importCheckpoint(saved), saved);
  assert.equal(target.backend.writes, writes);
  await assert.rejects(
    target
      .restart()
      .importCheckpoint({ ...saved, question: "Changed question" }),
    /collision/,
  );
});

test("sorted durable JSON recovers the same update scope without another write", async () => {
  const f = fixture(),
    input = beginArgs(f.baseline.id),
    first = await f.restart().beginUpdate(input),
    writes = f.backend.writes;
  assert.deepEqual(await f.restart().beginUpdate(input), first);
  assert.equal(f.backend.writes, writes);
  await assert.rejects(
    f.restart().beginUpdate({ ...input, question: "Changed question" }),
    /different scope/,
  );
});

test("sorted durable JSON recovers identical update completion and rejects changed proposals", async () => {
  const f = await completed(),
    writes = f.backend.writes;
  assert.deepEqual(
    await f.restart().completeUpdate(f.returned.input, f.returned.contexts),
    f.saved,
  );
  assert.equal(f.backend.writes, writes);
  const changed = structuredClone(f.returned.input);
  changed.assessments[0].note = "Different note";
  await assert.rejects(
    f.restart().completeUpdate(changed, f.returned.contexts),
    /different results/,
  );
});

test("sorted durable JSON recovers review decisions and publication without duplicate mutations", async () => {
  const f = await reviewed(),
    writes = f.backend.writes;
  const recoveredReview = await f.restart().reviewResearchUpdate(f.review);
  assert.equal(recoveredReview.reviewMutations!.length, 1);
  assert.equal(f.backend.writes, writes);
  await assert.rejects(
    f.restart().reviewResearchUpdate({ ...f.review, decision: "keep" }),
    /different arguments/,
  );
  const accepted = await f.restart().publishResearchUpdate(f.publish),
    publishedWrites = f.backend.writes;
  assert.deepEqual(
    await f.restart().publishResearchUpdate(f.publish),
    accepted,
  );
  assert.equal(f.backend.writes, publishedWrites);
  assert.equal(accepted.snapshot.rows[0].values.capacity, 200);
  assert.equal(
    (await f.restart().open(f.baseline.id)).snapshot.rows[0].values.capacity,
    100,
  );
});

test("sorted durable JSON imports and replays a complete continuation bundle with review history intact", async () => {
  const f = await reviewed();
  await f.restart().publishResearchUpdate(f.publish);
  const store = f.restart();
  await store.saveCheckpoint(
    {
      checkpoint_id: randomUUID(),
      snapshot_id: f.baseline.id,
      expected_revision: 0,
      question: "Portable synthetic continuation",
      scope: "The complete reviewed tree.",
    },
    await pins(store, f.baseline.id),
  );
  const bundle = await f.restart().exportBundle(f.baseline.id),
    target = fixture();
  await target.restart().importBundle(bundle);
  const once = await target.restart().exportBundle(f.baseline.id);
  await target.restart().importBundle(bundle);
  const twice = await target.restart().exportBundle(f.baseline.id);
  assert.deepEqual(twice.state, once.state);
  assert.equal(twice.state.updates?.length, 1);
  assert.equal(twice.state.checkpoints?.length, 1);
  assert.equal(twice.state.updates![0].reviewMutations!.length, 1);
  assert.equal(
    (await target.restart().open(f.publish.snapshot_id)).snapshot.rows[0].values
      .capacity,
    200,
  );
});

test("sorted durable JSON recovers a published successor after its acknowledgment is lost", async () => {
  const f = await reviewed();
  f.backend.loseNextResponse = true;
  await assert.rejects(
    f.restart().publishResearchUpdate(f.publish),
    /Lost durable write/,
  );
  const writes = f.backend.writes;
  const recovered = await f.restart().publishResearchUpdate(f.publish);
  assert.equal(recovered.snapshot.id, f.publish.snapshot_id);
  assert.equal(recovered.snapshot.rows[0].values.capacity, 200);
  assert.equal(f.backend.writes, writes);
  await assert.rejects(
    f
      .restart()
      .publishResearchUpdate({ ...f.publish, title: "Changed retry title" }),
    /different arguments/,
  );
});
