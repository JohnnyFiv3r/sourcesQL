import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  UpdateReviewPanel,
  manualUpdateAvailability,
  manualUpdateArguments,
  updateReviewReadiness,
  additionFields,
  groupUpdateEvidence,
} from "../src/update-review-panel.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";
import type { UpdateChange } from "../server/updates.js";
import sample from "../fixtures/water-procurement.json";
function view(): ResearchView {
  const snapshot = snapshotSchema.parse(structuredClone(sample));
  return {
    snapshot,
    displayTitle: snapshot.title,
    amendments: [],
    revision: 3,
    snapshots: [],
    requests: [],
  };
}
function options() {
  return {
    requestId: randomUUID(),
    question: "Check changes and new entities in the same saved scope",
    existing: true,
    discovery: false,
    identityFields: ["issuer"],
  };
}
function change(overrides: Partial<UpdateChange> = {}): UpdateChange {
  return {
    id: "change_a",
    kind: "changed_claim",
    scope: "existing",
    rowId: "record-1",
    field: "issuer",
    previous: "Original entity",
    proposed: "Supported new entity name",
    proposalSnapshotId: "proposal",
    observedAt: "2026-10-15T10:00:00Z",
    note: "Exact retained evidence supports this proposal.",
    evidence: [
      {
        resultId: "result_a",
        sourceVersionId: "source_a",
        contentSha256: "a".repeat(64),
        observedAt: "2026-10-15T10:00:00Z",
        url: "https://example.com/evidence",
        quote: "Exact retained quote",
      },
    ],
    canAccept: true,
    ...overrides,
  };
}
function review(changes = [change()]): NonNullable<ResearchView["update"]> {
  return {
    requestId: randomUUID(),
    parentSnapshotId: "parent",
    parentTitle: "Saved evidence",
    baseRevision: 3,
    parentRevision: 3,
    stale: false,
    changes,
    decisions: {},
  };
}
function render(update: NonNullable<ResearchView["update"]>) {
  return renderToStaticMarkup(
    createElement(UpdateReviewPanel, {
      update,
      columns: [{ key: "issuer", label: "Entity" }],
      busy: false,
      onReview() {},
      onPublish() {},
      onSource() {},
      onOpenPublished() {},
    }),
  );
}

test("manual updates require host messaging and a complete bounded baseline, never a preview", () => {
  const baseline = view();
  assert.equal(manualUpdateAvailability(baseline, true).available, true);
  assert.equal(manualUpdateAvailability(baseline, false).available, false);
  baseline.preview = { total: 205, returned: 9, offset: 0, nextOffset: 9 };
  assert.equal(manualUpdateAvailability(baseline, true).available, false);
  baseline.preview = { total: 9, returned: 9, offset: 100, nextOffset: null };
  assert.equal(manualUpdateAvailability(baseline, true).available, false);
  delete baseline.preview;
  baseline.snapshot.rowCount = 205;
  assert.equal(manualUpdateAvailability(baseline, true).available, false);
});
test("baseline byte limit counts UTF-8 content", () => {
  const baseline = view();
  for (const row of baseline.snapshot.rows)
    for (const field of Object.keys(row.values))
      row.values[field] = "🦆".repeat(2000);
  assert.equal(manualUpdateAvailability(baseline, true).available, false);
});
test("existing findings use canonical selected IDs and exact revision, independent of row positions", () => {
  const baseline = view();
  const args = manualUpdateArguments(baseline, {
    ...options(),
    rowId: "record-3",
    field: "closes_at",
  });
  assert.deepEqual(args.existing, {
    row_ids: ["record-3"],
    fields: ["closes_at"],
  });
  assert.equal(args.expected_revision, 3);
  assert.equal(args.snapshot_id, baseline.snapshot.id);
  assert.equal(args.discovery, undefined);
  assert.throws(
    () => manualUpdateArguments(baseline, { ...options(), rowId: "3" }),
    /canonical row/,
  );
  assert.throws(
    () => manualUpdateArguments(baseline, { ...options(), field: "closes_at" }),
    /canonical row/,
  );
});
test("whole-table review includes every canonical row and discovery remains a separate explicit scope", () => {
  const baseline = view(),
    args = manualUpdateArguments(baseline, {
      ...options(),
      discovery: true,
      identityFields: ["issuer", "opportunity"],
    });
  assert.deepEqual(
    args.existing?.row_ids,
    baseline.snapshot.rows.map((row) => row.id),
  );
  assert.deepEqual(
    args.existing?.fields,
    baseline.snapshot.columns.map((column) => column.key),
  );
  assert.deepEqual(args.discovery?.identity_fields, ["issuer", "opportunity"]);
  const discoveryOnly = manualUpdateArguments(baseline, {
    ...options(),
    existing: false,
    discovery: true,
  });
  assert.equal(discoveryOnly.existing, undefined);
  assert.ok(discoveryOnly.discovery);
  for (const identityFields of [[], ["invented"], ["issuer", "issuer"]])
    assert.throws(
      () =>
        manualUpdateArguments(baseline, {
          ...options(),
          discovery: true,
          identityFields,
        }),
      /identify an entity/,
    );
  assert.throws(
    () => manualUpdateArguments(baseline, { ...options(), existing: false }),
    /Choose existing/,
  );
});
test("empty baselines support discovery without inventing existing findings", () => {
  const baseline = view();
  baseline.snapshot.rows = [];
  assert.throws(
    () => manualUpdateArguments(baseline, options()),
    /no existing findings/,
  );
  assert.equal(
    manualUpdateArguments(baseline, {
      ...options(),
      existing: false,
      discovery: true,
    }).existing,
    undefined,
  );
});
test("publication requires every decision and blocks stale or already published proposals", () => {
  const update = review([
    change(),
    change({ id: "change_b", kind: "not_observed", canAccept: false }),
  ]);
  assert.deepEqual(updateReviewReadiness(update), {
    unreviewed: 2,
    canPublish: false,
  });
  update.decisions.change_a = "accept";
  assert.equal(updateReviewReadiness(update).canPublish, false);
  update.decisions.change_b = "keep";
  assert.deepEqual(updateReviewReadiness(update), {
    unreviewed: 0,
    canPublish: true,
  });
  update.decisions.change_b = "accept";
  assert.equal(updateReviewReadiness(update).canPublish, false);
  update.decisions.change_b = "keep";
  update.stale = true;
  assert.equal(updateReviewReadiness(update).canPublish, false);
  update.stale = false;
  update.publishedSnapshotId = "published_successor";
  assert.equal(updateReviewReadiness(update).canPublish, false);
});
test("review exposes dated evidence and explicit previous/proposed values without treating absence as deletion", () => {
  const html = render(
    review([
      change(),
      change({
        id: "missing",
        kind: "not_observed",
        previous: undefined,
        proposed: undefined,
        canAccept: false,
      }),
    ]),
  );
  for (const text of [
    "Exact retained quote",
    "Original entity",
    "Supported new entity name",
    "Previous",
    "Proposed",
    "https://example.com/evidence",
    "2026-10-15T10:00:00Z",
    "does not establish deletion or cancellation",
    "Publish accepted update",
  ])
    assert.ok(html.includes(text), text);
});
test("unsafe source URLs are not rendered as clickable links and stale review stays blocked", () => {
  const entry = change();
  entry.evidence[0].url = "javascript:alert(1)";
  const update = review([entry]);
  update.stale = true;
  const html = render(update);
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("baseline has newer corrections"));
  assert.ok(html.includes("before accepting or publishing these proposals"));
  assert.ok(!html.includes("Published from baseline revision"));
  assert.ok(
    html
      .match(/<button[^>]*>Publish accepted update[\s\S]*?<\/button>/)?.[0]
      .includes("disabled"),
  );
  const accept = html.match(/<button[^>]*>Accept change<\/button>/)?.[0];
  assert.ok(accept?.includes("disabled"));
});

test("published updates retain locked review history without unfinished instructions after the parent changes", () => {
  const update = review();
  update.decisions.change_a = "accept";
  update.publishedSnapshotId = "accepted_successor";
  for (const parentRevision of [update.baseRevision, update.baseRevision + 1]) {
    update.parentRevision = parentRevision;
    update.stale = parentRevision !== update.baseRevision;
    const html = render(update);
    for (const text of [
      "Published update",
      "review history",
      "Published from baseline revision 3",
      "Review decisions and evidence are retained",
      "Exact retained quote",
      "2026-10-15T10:00:00Z",
      "Original entity",
      "Supported new entity name",
      "Accepted",
    ])
      assert.ok(html.includes(text), text);
    for (const text of [
      "to review",
      "Publish accepted update",
      "baseline has newer corrections",
      "before accepting or publishing",
      "Review each finding before publishing",
    ])
      assert.ok(!html.includes(text), text);
    for (const label of ["Accept change", "Keep current"]) {
      const button = html.match(
        new RegExp(`<button[^>]*>${label}</button>`),
      )?.[0];
      assert.ok(button?.includes("disabled"), label);
    }
    assert.equal(updateReviewReadiness(update).canPublish, false);
  }
});

test("review choices remain adjustable before publication and display the current decision", () => {
  const update = review();
  update.decisions.change_a = "accept";
  let html = render(update);
  let accept = html.match(/<button[^>]*>Accept change<\/button>/)?.[0];
  let keep = html.match(/<button[^>]*>Keep current<\/button>/)?.[0];
  assert.ok(accept?.includes('aria-pressed="true"'));
  assert.ok(keep?.includes('aria-pressed="false"'));
  assert.ok(!accept?.includes("disabled"));
  assert.ok(!keep?.includes("disabled"));
  update.decisions.change_a = "keep";
  html = render(update);
  accept = html.match(/<button[^>]*>Accept change<\/button>/)?.[0];
  keep = html.match(/<button[^>]*>Keep current<\/button>/)?.[0];
  assert.ok(accept?.includes('aria-pressed="false"'));
  assert.ok(keep?.includes('aria-pressed="true"'));
  assert.equal(updateReviewReadiness(update).canPublish, true);
  update.publishedSnapshotId = "accepted_successor";
  html = render(update);
  assert.ok(
    html
      .match(/<button[^>]*>Accept change<\/button>/)?.[0]
      .includes("disabled"),
  );
  assert.ok(
    html.match(/<button[^>]*>Keep current<\/button>/)?.[0].includes("disabled"),
  );
});

test("addition review shows inspectable named entity fields instead of empty previous/proposed cells", () => {
  const addition = change({
    kind: "addition",
    scope: "discovery",
    field: undefined,
    previous: undefined,
    proposed: {
      name: "Aurora Utility",
      planned_mw: 500,
      region: "TN",
      unverified_capacity: null,
    },
  });
  const columns = [
    { key: "name", label: "Utility" },
    { key: "planned_mw", label: "Planned Capacity (MW)" },
    { key: "region", label: "Region" },
  ];
  assert.deepEqual(
    additionFields(addition, columns).map((field) => field.label),
    ["Utility", "Planned Capacity (MW)", "Region", "Unverified Capacity"],
  );
  const html = renderToStaticMarkup(
    createElement(UpdateReviewPanel, {
      update: review([addition]),
      columns,
      busy: false,
      onReview() {},
      onPublish() {},
      onSource() {},
      onOpenPublished() {},
    }),
  );
  for (const text of [
    "Aurora Utility",
    "Planned Capacity (MW)",
    "500",
    "Region",
    "TN",
    "Unverified Capacity",
    "Skip addition",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes("<small>Previous</small>"));
  assert.ok(!html.includes("<small>Proposed</small>"));
  assert.ok(html.includes("New entity values"));
});
test("repeated quote evidence is shown once while distinct provenance links survive", () => {
  const base = change().evidence[0];
  const entry = change({
    evidence: [
      base,
      { ...base, evidenceId: "another_cell" },
      { ...base, url: "https://other.example.com/retained-source" },
    ],
  });
  const grouped = groupUpdateEvidence(entry.evidence);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].links.length, 2);
  const html = render(review([entry]));
  assert.equal(html.split("Exact retained quote").length - 1, 1);
  assert.ok(html.includes("https://example.com/evidence"));
  assert.ok(html.includes("https://other.example.com/retained-source"));
  const anotherVersion = { ...base, sourceVersionId: "source_new_version" };
  assert.equal(groupUpdateEvidence([base, anotherVersion]).length, 2);
});
