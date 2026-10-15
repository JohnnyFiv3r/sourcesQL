import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import {
  CHECKPOINT_MAX_BYTES,
  buildCheckpoint,
  checkpointDependencyForView,
  checkpointSnapshotHash,
  checkpointSourceManifestHash,
  resumeCheckpoint,
  saveCheckpointSchema,
  validateCheckpoint,
  type SaveCheckpointInput,
  type CheckpointDependencyPin,
} from "../server/checkpoints.js";
function fixture(): ResearchView {
  const snapshot = snapshotSchema.parse(structuredClone(sample));
  return {
    snapshot,
    displayTitle: snapshot.title,
    revision: 0,
    amendments: [],
    snapshots: [],
    requests: [],
  };
}
function input(
  view: ResearchView,
  overrides: Partial<SaveCheckpointInput> = {},
): SaveCheckpointInput {
  return {
    checkpoint_id: randomUUID(),
    snapshot_id: view.snapshot.id,
    expected_revision: view.revision,
    question: "Which findings still need evidence?",
    scope: "Retain the selected entities and their evidence scope.",
    row_ids: [view.snapshot.rows[0].id],
    fields: [view.snapshot.columns[0].key],
    remaining_work: ["Inspect the existing pending job before continuing."],
    ...overrides,
  };
}
function checkpoint(
  view = fixture(),
  overrides: Partial<SaveCheckpointInput> = {},
  dependencies?: CheckpointDependencyPin[],
) {
  return buildCheckpoint(input(view, overrides), {
    view,
    dependencies: dependencies ?? [checkpointDependencyForView(view)],
    createdAt: "2026-10-15T12:00:00Z",
  });
}

test("checkpoint references canonical selection without copying observations or evidence", () => {
  const view = fixture(),
    saved = checkpoint(view);
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(saved.selection.rowIds, [view.snapshot.rows[0].id]);
  assert.equal(
    saved.dependencies[0].result.resultId,
    view.snapshot.sourceResultSetId,
  );
  assert.equal(
    saved.dependencies[0].result.contentSha256,
    checkpointSnapshotHash(view.snapshot),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < CHECKPOINT_MAX_BYTES);
  assert.ok(!Object.hasOwn(saved.dependencies[0], "rows"));
  assert.deepEqual(
    validateCheckpoint(JSON.parse(JSON.stringify(saved))),
    saved,
  );
});
test("whole-table and all-field scopes remain explicit references", () => {
  const view = fixture(),
    value = input(view);
  delete value.row_ids;
  delete value.fields;
  const saved = buildCheckpoint(value, {
    view,
    dependencies: [checkpointDependencyForView(view)],
  });
  assert.equal(saved.selection.rowIds, null);
  assert.equal(saved.selection.fields, null);
});
test("canonical selection addresses rows beyond a preview and refuses invented or repeated IDs", () => {
  const view = fixture(),
    base = view.snapshot.rows[0];
  view.snapshot.rows = Array.from({ length: 205 }, (_, index) => ({
    ...structuredClone(base),
    id: `row_${index}`,
  }));
  assert.deepEqual(
    checkpoint(view, { row_ids: ["row_204"] }).selection.rowIds,
    ["row_204"],
  );
  assert.throws(() => checkpoint(view, { row_ids: ["205"] }), /canonical row/);
  assert.throws(() => checkpoint(view, { fields: ["invented"] }), /column key/);
  assert.throws(
    () => checkpoint(view, { row_ids: ["row_1", "row_1"] }),
    /Duplicate row/,
  );
});
test("build requires the exact authorized revision, original hash, capture and dependency", () => {
  const view = fixture();
  assert.throws(
    () => checkpoint(view, { expected_revision: 1 }),
    /revision changed/,
  );
  assert.throws(() => checkpoint(view, {}, []), /dependency does not match/);
  const changed = checkpointDependencyForView(view);
  changed.result.contentSha256 = "b".repeat(64);
  assert.throws(
    () => checkpoint(view, {}, [changed]),
    /dependency does not match/,
  );
  const pin = checkpointDependencyForView(view);
  pin.capturedAt = "2020-01-01";
  assert.throws(() => checkpoint(view, {}, [pin]), /dependency does not match/);
});
test("inline observation hashes survive key ordering and change with observations", () => {
  const view = fixture(),
    reversed = Object.fromEntries(Object.entries(view.snapshot).reverse());
  assert.equal(
    checkpointSnapshotHash(reversed as typeof view.snapshot),
    checkpointSnapshotHash(view.snapshot),
  );
  const changed = structuredClone(view.snapshot);
  changed.rows[0].verificationNote += " Changed.";
  assert.notEqual(
    checkpointSnapshotHash(changed),
    checkpointSnapshotHash(view.snapshot),
  );
});
test("query parameters, pending identities and honest failure survive inspection", () => {
  const view = fixture(),
    requestId = randomUUID(),
    jobId = randomUUID();
  const saved = checkpoint(view, {
    query: {
      query: "SELECT * FROM input WHERE name = $name",
      parameters: { name: "example", unknown: null, enabled: true, limit: 3 },
      request_id: requestId,
      profile: "fixture",
    },
    pending: [{ kind: "job", id: jobId, request_id: requestId }],
    failure: {
      code: "submission_unknown",
      message: "The submission response was lost.",
    },
  });
  assert.equal(saved.query?.request_id, requestId);
  assert.equal(saved.query?.parameters.unknown, null);
  const resumed = resumeCheckpoint(saved, {
    dependencies: [
      {
        snapshotId: view.snapshot.id,
        status: "authorized",
        pin: checkpointDependencyForView(view),
        view,
      },
    ],
    pending: [{ kind: "job", id: jobId, status: "authorized" }],
  });
  assert.equal(resumed.status, "ready");
  assert.ok(
    resumed.instructions.some(
      (value) => value.includes(jobId) && value.includes("do not resubmit"),
    ),
  );
  assert.deepEqual(resumed.checkpoint.pending, saved.pending);
  assert.equal(saved.failure?.code, "submission_unknown");
});
test("unknown versions, embedded data and malformed query parameters are refused", () => {
  const saved = checkpoint();
  assert.throws(() => validateCheckpoint({ ...saved, schemaVersion: 2 }));
  assert.throws(() => validateCheckpoint({ ...saved, rows: [] }));
  assert.throws(() =>
    validateCheckpoint({
      ...saved,
      dependencies: [{ ...saved.dependencies[0], content: "full source text" }],
    }),
  );
  for (const parameters of [
    { nested: { bad: true } },
    { array: [1] },
    { unsafe: Number.MAX_SAFE_INTEGER + 1 },
    { nan: NaN },
    { infinity: Infinity },
  ])
    assert.throws(() =>
      saveCheckpointSchema.parse({
        ...input(fixture()),
        query: { query: "SELECT 1", parameters },
      }),
    );
});
test("compact size is measured as UTF-8 bytes rather than character count", () => {
  assert.throws(
    () =>
      checkpoint(fixture(), {
        question: "🦆".repeat(1000),
        scope: "🦆".repeat(500),
        remaining_work: Array.from({ length: 15 }, () => "🦆".repeat(500)),
      }),
    /24 KiB/,
  );
  assert.throws(() =>
    checkpoint(fixture(), {
      remaining_work: Array.from({ length: 21 }, () => "work"),
    }),
  );
});
test("resume blocks missing, inaccessible, archived and stale dependencies", () => {
  const view = fixture(),
    saved = checkpoint(view),
    snapshotId = view.snapshot.id;
  assert.deepEqual(resumeCheckpoint(saved, { dependencies: [] }).blockers, [
    { code: "missing", reference: snapshotId },
  ]);
  for (const status of ["inaccessible", "archived"] as const)
    assert.deepEqual(
      resumeCheckpoint(saved, { dependencies: [{ snapshotId, status }] })
        .blockers,
      [{ code: status, reference: snapshotId }],
    );
  const pin = checkpointDependencyForView(view);
  pin.amendmentRevision = 1;
  const resumed = resumeCheckpoint(saved, {
    dependencies: [{ snapshotId, status: "authorized", pin }],
  });
  assert.equal(resumed.status, "blocked");
  assert.deepEqual(resumed.blockers, [
    { code: "stale_revision", reference: snapshotId },
  ]);
});
test("every source-version pin and result identity is checked", () => {
  const view = fixture(),
    snapshotId = view.snapshot.id;
  const original = checkpointDependencyForView(view, [
    {
      id: "src_example",
      contentSha256: "a".repeat(64),
      retrievedAt: "2026-10-15T10:00:00Z",
    },
  ]);
  const saved = checkpoint(view, {}, [original]);
  const absent = checkpointDependencyForView(view);
  assert.equal(
    resumeCheckpoint(saved, {
      dependencies: [{ snapshotId, status: "authorized", pin: absent }],
    }).blockers[0].code,
    "missing_source_version",
  );
  const changed = structuredClone(original);
  changed.sourceVersions[0].contentSha256 = "b".repeat(64);
  changed.result.resultId = "different_result";
  assert.deepEqual(
    resumeCheckpoint(saved, {
      dependencies: [{ snapshotId, status: "authorized", pin: changed }],
    }).blockers.map((item) => item.code),
    ["result_changed", "source_version_changed"],
  );
});
test("unknown or foreign pending handles block while preserving original identities", () => {
  const view = fixture(),
    jobId = randomUUID(),
    saved = checkpoint(view, { pending: [{ kind: "job", id: jobId }] });
  const dependencies = [
    {
      snapshotId: view.snapshot.id,
      status: "authorized" as const,
      pin: checkpointDependencyForView(view),
    },
  ];
  assert.equal(
    resumeCheckpoint(saved, { dependencies }).blockers[0].code,
    "missing_pending",
  );
  for (const status of ["foreign", "missing", "inaccessible"] as const) {
    const result = resumeCheckpoint(saved, {
      dependencies,
      pending: [{ kind: "job", id: jobId, status }],
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blockers[0].code, `${status}_pending`);
    assert.equal(result.checkpoint.pending[0].id, jobId);
  }
});
test("resume validates retained canonical row selection", () => {
  const view = fixture(),
    saved = checkpoint(view),
    pin = checkpointDependencyForView(view),
    contextView = structuredClone(view);
  contextView.snapshot.rows = [];
  assert.deepEqual(
    resumeCheckpoint(saved, {
      dependencies: [
        {
          snapshotId: view.snapshot.id,
          status: "authorized",
          pin,
          view: contextView,
        },
      ],
    }).blockers,
    [{ code: "selection_missing", reference: view.snapshot.id }],
  );
});

test("saved SQL provenance comes only from canonical metadata; namespace changes block pending handles", () => {
  const view = fixture(),
    dependencies = [checkpointDependencyForView(view)],
    jobId = randomUUID();
  const saved = buildCheckpoint(
    input(view, {
      query: { query: "SELECT 0", parameters: {} },
      pending: [{ kind: "job", id: jobId }],
    }),
    {
      view,
      dependencies,
      executionContext: "owner-a",
      queryMetadata: { query: "SELECT $value", parameters: { value: 42 } },
    },
  );
  assert.equal(saved.query?.provenance, "saved_result");
  assert.equal(saved.query?.query, "SELECT $value");
  assert.deepEqual(saved.query?.parameters, { value: 42 });
  assert.equal(
    checkpoint(view, { query: { query: "SELECT 1", parameters: {} } }).query
      ?.provenance,
    "planned",
  );
  assert.throws(() =>
    saveCheckpointSchema.parse({
      ...input(view),
      query: { query: "SELECT 1", parameters: {}, provenance: "saved_result" },
    }),
  );
  assert.deepEqual(
    resumeCheckpoint(saved, {
      dependencies: [
        {
          snapshotId: view.snapshot.id,
          status: "authorized",
          pin: dependencies[0],
        },
      ],
      pending: [{ kind: "job", id: jobId, status: "authorized" }],
      executionContext: "owner-b",
    }).blockers,
    [{ code: "foreign_pending", reference: jobId }],
  );
});

test("a compact source manifest covers a broad result beyond the explicit evidence pins", () => {
  const view = fixture();
  const sources = Array.from({ length: 1000 }, (_, index) => ({
    source_version_id: `src_${index}`,
    content_sha256: "a".repeat(64),
    content: `Retained source ${index}`,
    retrieved_at: "2026-10-15T10:00:00Z",
  }));
  const manifest = checkpointSourceManifestHash(sources);
  assert.equal(checkpointSourceManifestHash([...sources].reverse()), manifest);
  assert.equal(
    checkpointSourceManifestHash(
      sources.map((source) =>
        Object.fromEntries(Object.entries(source).reverse()),
      ),
    ),
    manifest,
  );
  const pin = checkpointDependencyForView(view, [], manifest);
  const saved = checkpoint(view, {}, [pin]);
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 4096);
  assert.equal(
    resumeCheckpoint(saved, {
      dependencies: [
        { snapshotId: view.snapshot.id, status: "authorized", pin },
      ],
    }).status,
    "ready",
  );
  sources[999].content = "Changed retained source";
  const changed = {
    ...pin,
    sourceManifestSha256: checkpointSourceManifestHash(sources),
  };
  assert.deepEqual(
    resumeCheckpoint(saved, {
      dependencies: [
        { snapshotId: view.snapshot.id, status: "authorized", pin: changed },
      ],
    }).blockers,
    [{ code: "source_manifest_changed", reference: view.snapshot.id }],
  );
  const missing = { ...pin };
  delete missing.sourceManifestSha256;
  assert.equal(
    resumeCheckpoint(saved, {
      dependencies: [
        { snapshotId: view.snapshot.id, status: "authorized", pin: missing },
      ],
    }).blockers[0].code,
    "source_manifest_changed",
  );
});
