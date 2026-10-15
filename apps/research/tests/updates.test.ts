import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  effectiveValue,
  snapshotSchema,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";
import {
  buildAcceptedUpdateSnapshot,
  createUpdateRequest,
  deriveUpdateChanges,
  updateBeginSchema,
  updateCompletionSchema,
  validateUpdateCompletion,
  validateUpdateDecision,
  type UpdateCompletionInput,
  type UpdateEvidenceContext,
} from "../server/updates.js";
const observed = "2026-10-15T17:00:00Z",
  checked = "2026-10-15T17:00:10Z";
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
): Snapshot {
  return snapshotSchema.parse({
    schemaVersion: 2,
    id,
    title: id,
    origin: { engine: "sourcesql", resultId, runId: `run_${id}` },
    capturedAt: checked,
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
function context(
  snapshot: Snapshot,
  content: string,
  sourceId: string,
  rowId: string,
  url: string,
): UpdateEvidenceContext {
  return {
    result_id: snapshot.origin!.resultId,
    completed_at: checked,
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
  };
}
function fixture() {
  const baseline = snapshot("baseline", "wq_baseline", [
    row("row_a", "Acme", 100),
    row("row_b", "Beta", 200),
  ]);
  const view: ResearchView = {
    snapshot: baseline,
    displayTitle: "Planned capacity",
    revision: 1,
    snapshots: [],
    requests: [],
    amendments: [
      {
        snapshot_id: baseline.id,
        row_id: "row_a",
        field: "capacity",
        value: 110,
        reason: "Verified owner correction",
        expected_revision: 0,
        mutation_id: randomUUID(),
        revision: 1,
        originalValue: 100,
        createdAt: "2026-10-14T00:00:00Z",
      },
    ],
  };
  const request = createUpdateRequest(
    view,
    {
      request_id: randomUUID(),
      snapshot_id: baseline.id,
      expected_revision: 1,
      existing: { row_ids: ["row_a"], fields: ["capacity"] },
      discovery: {
        question: "Find additional organizations with planned capacity",
        identity_fields: ["issuer"],
      },
    },
    "2026-10-15T16:59:00Z",
  );
  const existing = snapshot("existing", "wq_existing", [
    {
      ...row("row_a", "Acme", 120),
      sourceUrl: "https://example.com/current",
      evidence: { capacity: ["Acme planned capacity is 120 MW."] },
    },
  ]);
  const discovery = snapshot("discovery", "wq_discovery", [
    {
      ...row("row_c", "Gamma", 300),
      sourceUrl: "https://example.com/gamma",
      evidence: { issuer: ["Gamma"], capacity: ["300 MW"] },
    },
  ]);
  const completion: UpdateCompletionInput = {
    request_id: request.id,
    existing_snapshot: existing,
    discovery_snapshot: discovery,
    assessments: [
      {
        row_id: "row_a",
        field: "capacity",
        status: "verified",
        note: "Source reports 120 MW",
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
  return { view, request, completion, contexts };
}
test("manual check pins effective corrections and separates existing/discovery scope", () => {
  const { view, request, completion, contexts } = fixture();
  assert.equal(request.baseRevision, 1);
  assert.equal(request.baseline[0].values.capacity, 110);
  assert.equal(request.baselineSnapshot.rows[0].values.capacity, 100);
  assert.equal(request.corrections[0].value, 110);
  const changes = deriveUpdateChanges(request, completion, contexts);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.scope, c.rowId]),
    [
      ["changed_claim", "existing", "row_a"],
      ["addition", "discovery", "row_c"],
    ],
  );
  assert.equal(changes[0].previous, 110);
  assert.equal(
    changes[0].evidence[0].contentSha256,
    contexts.existing.source_versions[0].content_sha256,
  );
  assert.equal(changes[0].evidence[0].observedAt, observed);
  assert.equal(changes[0].evidence[0].evidenceId, "e_row_a");
  assert.equal(effectiveValue(view, view.snapshot.rows[0], "capacity"), 110);
  assert.deepEqual(deriveUpdateChanges(request, completion, contexts), changes);
});
test("only explicit review publishes an immutable successor with accepted claims and additions", () => {
  const { view, request, completion, contexts } = fixture();
  const before = JSON.stringify({ view, request, completion }),
    changes = deriveUpdateChanges(request, completion, contexts);
  const publish = {
    request_id: request.id,
    snapshot_id: "accepted",
    expected_revision: 1,
    mutation_id: randomUUID(),
  };
  assert.throws(
    () =>
      buildAcceptedUpdateSnapshot(
        request,
        completion,
        changes,
        {},
        view,
        publish,
      ),
    /Review every/,
  );
  const accepted = buildAcceptedUpdateSnapshot(
    request,
    completion,
    changes,
    Object.fromEntries(changes.map((c) => [c.id, "accept"])),
    view,
    publish,
    checked,
  );
  assert.deepEqual(
    accepted.rows.map((r) => [r.id, r.values.capacity]),
    [
      ["row_a", 120],
      ["row_b", 200],
      ["row_c", 300],
    ],
  );
  assert.equal(accepted.parentSnapshotId, "baseline");
  assert.equal(accepted.origin?.engine, "imported");
  assert.equal(accepted.captureBasis, "imported_declared_time");
  assert.equal(
    accepted.rows[0].cellSources?.capacity[0].url,
    "https://example.com/current",
  );
  assert.equal(JSON.stringify({ view, request, completion }), before);
  assert.equal(accepted.dataRef, undefined);
});
test("keep preserves effective amendments without introducing discovery rows", () => {
  const { view, request, completion, contexts } = fixture(),
    changes = deriveUpdateChanges(request, completion, contexts);
  const accepted = buildAcceptedUpdateSnapshot(
    request,
    completion,
    changes,
    Object.fromEntries(changes.map((c) => [c.id, "keep"])),
    view,
    {
      request_id: request.id,
      snapshot_id: "kept",
      expected_revision: 1,
      mutation_id: randomUUID(),
    },
  );
  assert.equal(accepted.rows.length, 2);
  assert.equal(accepted.rows[0].values.capacity, 110);
});
test("not observed is a coverage outcome and never clears an existing value", () => {
  const { request, completion, contexts } = fixture(),
    result = completion.existing_snapshot!;
  result.rows[0].values.capacity = 110;
  result.rows[0].evidence = {};
  completion.assessments[0] = {
    ...completion.assessments[0],
    status: "unverified",
    note: "No current claim returned",
    source_version_ids: [],
    observed_at: checked,
  };
  const changes = deriveUpdateChanges(request, completion, contexts);
  assert.equal(changes[0].kind, "not_observed");
  assert.equal(changes[0].proposed, 110);
  assert.equal(changes[0].canAccept, false);
  assert.throws(
    () =>
      validateUpdateDecision(changes, {
        request_id: request.id,
        change_id: changes[0].id,
        decision: "accept",
        expected_revision: 1,
        mutation_id: randomUUID(),
      }),
    /no supported change/,
  );
  result.rows[0].values.capacity = null;
  assert.throws(
    () => validateUpdateCompletion(request, completion, contexts),
    /absence is not deletion/,
  );
});
test("contradictory claims retain exact evidence and cannot be accepted as automatic updates", () => {
  const { request, completion, contexts } = fixture();
  completion.assessments[0].status = "conflicting";
  const changes = deriveUpdateChanges(request, completion, contexts);
  assert.equal(changes[0].kind, "contradiction");
  assert.equal(changes[0].canAccept, false);
  assert.ok(changes[0].evidence[0].quote);
  assert.doesNotThrow(() =>
    validateUpdateDecision(changes, {
      request_id: request.id,
      change_id: changes[0].id,
      decision: "keep",
      expected_revision: 1,
      mutation_id: randomUUID(),
    }),
  );
});
test("verified identical observations are unchanged", () => {
  const { request, completion, contexts } = fixture();
  request.baseline[0].values.capacity = 120;
  const [change] = deriveUpdateChanges(request, completion, contexts);
  assert.equal(change.kind, "unchanged");
  assert.equal(change.canAccept, false);
});
test("baseline results and mismatched canonical result contexts cannot substitute for observations", () => {
  const { request, completion, contexts } = fixture();
  completion.existing_snapshot!.origin!.resultId =
    request.baselineSnapshot.origin!.resultId;
  assert.throws(
    () => validateUpdateCompletion(request, completion, contexts),
    /freshness check/,
  );
  completion.existing_snapshot!.origin!.resultId = "wq_different";
  assert.throws(
    () => validateUpdateCompletion(request, completion, contexts),
    /canonical source metadata/,
  );
});
test("forged hashes, invented quotes, unknown source versions and claimed new observation times are refused", () => {
  for (const alteration of ["hash", "quote", "version", "time"] as const) {
    const { request, completion, contexts } = fixture();
    if (alteration === "hash")
      contexts.existing.source_versions[0].content_sha256 = "0".repeat(64);
    if (alteration === "quote")
      completion.existing_snapshot!.rows[0].evidence.capacity = [
        "Acme has 999 MW.",
      ];
    if (alteration === "version")
      completion.assessments[0].source_version_ids = ["src_invented"];
    if (alteration === "time")
      completion.assessments[0].observed_at = "2026-10-16T17:00:00Z";
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /hash mismatch|does not occur|unknown source version|observation time/,
    );
  }
  assert.equal(
    updateCompletionSchema.safeParse({
      ...fixture().completion,
      content_sha256: "0".repeat(64),
    }).success,
    false,
  );
});
test("verified and conflicting fields require textual evidence, rather than a source URL alone", () => {
  for (const status of ["verified", "conflicting"] as const) {
    const { request, completion, contexts } = fixture();
    completion.assessments[0].status = status;
    completion.existing_snapshot!.rows[0].evidence = {};
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /textual source evidence/,
    );
  }
});
test("exact row scope, untouched fields, complete assessments and separate discovery are enforced", () => {
  for (const alteration of [
    "omit",
    "duplicate",
    "outside",
    "rekey",
    "substitute",
  ] as const) {
    const { request, completion, contexts } = fixture();
    if (alteration === "omit") completion.assessments = [];
    if (alteration === "duplicate")
      completion.assessments.push(completion.assessments[0]);
    if (alteration === "outside")
      completion.existing_snapshot!.rows[0].values.issuer = "Different entity";
    if (alteration === "rekey")
      completion.existing_snapshot!.rows[0].id = "row_unknown";
    if (alteration === "substitute") completion.discovery_snapshot = undefined;
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /Assess every|duplicate|outside|exact scoped|exactly/,
    );
  }
});
test("discovery refuses row collisions, overlapping identities, missing identities and duplicates", () => {
  for (const alteration of [
    "row-id",
    "overlap",
    "missing",
    "duplicate",
  ] as const) {
    const { request, completion, contexts } = fixture(),
      discovered = completion.discovery_snapshot!;
    if (alteration === "row-id") discovered.rows[0].id = "row_a";
    if (alteration === "overlap") discovered.rows[0].values.issuer = " acME ";
    if (alteration === "missing") discovered.rows[0].values.issuer = "";
    if (alteration === "duplicate") {
      discovered.rows.push({
        ...structuredClone(discovered.rows[0]),
        id: "row_d",
      });
      discovered.rowCount = 2;
    }
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /collide|overlaps|identity is missing/,
    );
  }
});
test("discovery requires a source-backed observation for every row and non-null claim", () => {
  for (const alteration of ["omit", "duplicate", "evidence"] as const) {
    const { request, completion, contexts } = fixture();
    if (alteration === "omit") completion.discovery_observations = [];
    if (alteration === "duplicate")
      completion.discovery_observations.push(
        completion.discovery_observations[0],
      );
    if (alteration === "evidence")
      completion.discovery_snapshot!.rows[0].evidence.capacity = [];
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /every discovered|duplicate|textual source evidence/,
    );
  }
});
test("empty discovery creates no deletion proposals", () => {
  const { request, completion, contexts } = fixture();
  completion.discovery_snapshot!.rows = [];
  completion.discovery_snapshot!.rowCount = 0;
  completion.discovery_observations = [];
  const changes = deriveUpdateChanges(request, completion, contexts);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "changed_claim");
});
test("cancelled and failed requests refuse late completions", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const { request, completion, contexts } = fixture();
    request.status = status;
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /late results are refused/,
    );
  }
});
test("concurrent amendments block stale publication even with a newly claimed revision", () => {
  const { view, request, completion, contexts } = fixture(),
    changes = deriveUpdateChanges(request, completion, contexts);
  view.revision = 2;
  assert.throws(
    () =>
      buildAcceptedUpdateSnapshot(
        request,
        completion,
        changes,
        Object.fromEntries(changes.map((c) => [c.id, "accept"])),
        view,
        {
          request_id: request.id,
          snapshot_id: "accepted",
          expected_revision: 2,
          mutation_id: randomUUID(),
        },
      ),
    /baseline has changed/,
  );
});
test("begin requires explicit valid scope and complete distinct discovery identities", () => {
  const { view, request } = fixture();
  assert.equal(
    updateBeginSchema.safeParse({
      request_id: randomUUID(),
      snapshot_id: "baseline",
      expected_revision: 1,
    }).success,
    false,
  );
  assert.throws(
    () => createUpdateRequest(view, { ...request.input, expected_revision: 0 }),
    /current revision/,
  );
  assert.throws(
    () =>
      createUpdateRequest(view, {
        ...request.input,
        existing: { row_ids: ["unknown"], fields: ["capacity"] },
      }),
    /Unknown existing row/,
  );
  assert.throws(
    () =>
      createUpdateRequest(view, {
        ...request.input,
        discovery: { question: "Discover", identity_fields: ["unknown"] },
      }),
    /Unknown field/,
  );
  view.snapshot.rows[1].values.issuer = "ACME";
  assert.throws(
    () => createUpdateRequest(view, request.input),
    /identities are ambiguous/,
  );
  view.snapshot.rows[1].values.issuer = null;
  assert.throws(
    () => createUpdateRequest(view, request.input),
    /identity is missing/,
  );
});
test("complete baselines and successor publication enforce current inline limits", () => {
  const { view, request, completion, contexts } = fixture(),
    preview = structuredClone(view);
  preview.snapshot.rowCount = 101;
  assert.throws(
    () => createUpdateRequest(preview, request.input),
    /at most 100 rows/,
  );
  const addition = deriveUpdateChanges(request, completion, contexts).find(
    (c) => c.kind === "addition",
  )!;
  request.baseline = Array.from({ length: 100 }, (_, index) =>
    row(`row_${index}`, `Organization ${index}`, index),
  );
  assert.throws(
    () =>
      buildAcceptedUpdateSnapshot(
        request,
        completion,
        [addition],
        { [addition.id]: "accept" },
        view,
        {
          request_id: request.id,
          snapshot_id: "accepted",
          expected_revision: 1,
          mutation_id: randomUUID(),
        },
      ),
    /100-row inline limit/,
  );
});
test("kept private proposal dependencies still mark a successor private-derived", () => {
  const { view, request, completion, contexts } = fixture();
  completion.discovery_snapshot!.dataClassification = "private_derived";
  const changes = deriveUpdateChanges(request, completion, contexts);
  const successor = buildAcceptedUpdateSnapshot(
    request,
    completion,
    changes,
    Object.fromEntries(changes.map((c) => [c.id, "keep"])),
    view,
    {
      request_id: request.id,
      snapshot_id: "accepted",
      expected_revision: 1,
      mutation_id: randomUUID(),
    },
  );
  assert.equal(successor.dataClassification, "private_derived");
});

test("new queries over old source versions do not count as fresh updates", () => {
  for (const alteration of [
    "old-source",
    "old-run",
    "future-source",
  ] as const) {
    const { request, completion, contexts } = fixture();
    if (alteration === "old-source") {
      contexts.existing.source_versions[0].retrieved_at =
        "2026-10-14T17:00:00Z";
      completion.assessments[0].observed_at = "2026-10-14T17:00:00Z";
    }
    if (alteration === "old-run")
      contexts.existing.completed_at = "2026-10-14T17:00:00Z";
    if (alteration === "future-source") {
      contexts.existing.source_versions[0].retrieved_at =
        "2026-10-16T17:00:00Z";
      completion.assessments[0].observed_at = "2026-10-16T17:00:00Z";
    }
    assert.throws(
      () => validateUpdateCompletion(request, completion, contexts),
      /source retrieval must occur during|completion must be freshly observed/,
    );
  }
});

test("unverified empty observations require a freshly completed canonical run", () => {
  const { request, completion, contexts } = fixture();
  completion.existing_snapshot!.rows[0].values.capacity = 110;
  completion.assessments[0] = {
    ...completion.assessments[0],
    status: "unverified",
    source_version_ids: [],
    observed_at: "2026-10-14T17:00:00Z",
  };
  contexts.existing.completed_at = "2026-10-14T17:00:00Z";
  assert.throws(
    () => validateUpdateCompletion(request, completion, contexts),
    /completion must be freshly observed/,
  );
});

test("publication dates may be old while canonical source retrieval is fresh", () => {
  const { request, completion, contexts } = fixture();
  contexts.existing.source_versions[0].published_at = "2019-01-01T00:00:00Z";
  assert.doesNotThrow(() =>
    validateUpdateCompletion(request, completion, contexts),
  );
});

test("mixing public observations with synthetic baselines cannot produce a synthetic successor", () => {
  const { view, request, completion, contexts } = fixture();
  completion.discovery_snapshot!.dataClassification = "public_web";
  const changes = deriveUpdateChanges(request, completion, contexts);
  const successor = buildAcceptedUpdateSnapshot(
    request,
    completion,
    changes,
    Object.fromEntries(changes.map((change) => [change.id, "keep"])),
    view,
    {
      request_id: request.id,
      snapshot_id: "accepted",
      expected_revision: 1,
      mutation_id: randomUUID(),
    },
  );
  assert.equal(successor.dataClassification, "public_web");
});
