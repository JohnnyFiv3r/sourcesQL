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
  CellUpdateProposal,
  cellUpdateProposals,
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

function proposalView(changes = [change()]) {
  const current = view();
  current.snapshot.id = "proposal";
  current.update = review(changes);
  return current;
}
function renderCell(
  update = review(),
  entry = update.changes[0],
  field?: string,
  busy = false,
) {
  return renderToStaticMarkup(
    createElement(CellUpdateProposal, {
      update,
      change: entry,
      field,
      busy,
      onReview() {},
      onSource() {},
    }),
  );
}
function cellButton(html: string, label: string) {
  const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
  assert.ok(button, label);
  return button;
}

test("cell proposals require the exact saved proposal, canonical row and declared field", () => {
  const entry = change(),
    current = proposalView([entry]);
  assert.equal(cellUpdateProposals(current, "record-1", "issuer")[0], entry);
  current.snapshot.rows.reverse();
  assert.equal(cellUpdateProposals(current, "record-1", "issuer")[0], entry);
  assert.deepEqual(cellUpdateProposals(current, "1", "issuer"), []);
  assert.deepEqual(cellUpdateProposals(current, "record-1", "missing"), []);
  assert.deepEqual(cellUpdateProposals(current, "record-1", "closes_at"), []);
  current.update!.changes = [change({ field: undefined })];
  assert.deepEqual(cellUpdateProposals(current, "record-1", "issuer"), []);
  current.update!.changes = [
    change({ proposalSnapshotId: "another_proposal" }),
  ];
  assert.deepEqual(cellUpdateProposals(current, "record-1", "issuer"), []);
  current.snapshot.id = current.update!.parentSnapshotId;
  current.update!.changes = [entry];
  assert.deepEqual(
    cellUpdateProposals(current, "record-1", "issuer"),
    [],
    "A shared baseline row ID does not attach a different proposal table",
  );
});

test("cell additions use explicit proposal identity and own fields without mapping published additions by position", () => {
  const addition = change({
    id: "addition_a",
    kind: "addition",
    scope: "discovery",
    field: undefined,
    proposed: { issuer: "New entity", closes_at: null },
  });
  const current = proposalView([addition]);
  assert.equal(cellUpdateProposals(current, "record-1", "issuer")[0], addition);
  assert.equal(
    cellUpdateProposals(current, "record-1", "closes_at")[0],
    addition,
  );
  assert.deepEqual(cellUpdateProposals(current, "record-1", "disposition"), []);
  current.update!.changes = [change({ ...addition, proposed: [] })];
  assert.deepEqual(cellUpdateProposals(current, "record-1", "issuer"), []);
  current.update!.changes = [change(), addition];
  current.update!.publishedSnapshotId = "published_successor";
  current.update!.decisions[addition.id] = "accept";
  current.snapshot.id = "published_successor";
  assert.deepEqual(
    cellUpdateProposals(current, "record-1", "issuer"),
    [current.update!.changes[0]],
    "Published existing findings retain canonical row IDs; additions require separate history",
  );
  addition.proposalSnapshotId = "published_successor";
  assert.deepEqual(
    cellUpdateProposals(current, "record-1", "issuer"),
    [current.update!.changes[0]],
    "Published additions stay in full history even if snapshot identifiers overlap",
  );
});

test("compact cell review keeps typed current and proposed values with evidence collapsed", () => {
  const entry = change({ previous: null, proposed: "9007199254740993" });
  const html = renderCell(review([entry]), entry);
  for (const text of [
    "Current",
    "Proposed",
    "Not stated",
    "9007199254740993",
    "Accept proposal",
    "Keep current",
    "2026-10-15T10:00:00Z",
    "Exact retained quote",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /<details[^>]*class="cell-update-evidence"[^>]*>/);
  assert.ok(!/<details[^>]*\bopen(?:=|\s|>)/.test(html));
  assert.ok(!/<input|<textarea|contenteditable/i.test(html));
  assert.ok(!cellButton(html, "Accept proposal").includes("disabled"));
  const booleans = renderCell(
    review(),
    change({ previous: false, proposed: 0 }),
  );
  assert.ok(booleans.includes(">false</p>") && booleans.includes(">0</p>"));
  const addition = change({
    kind: "addition",
    scope: "discovery",
    field: undefined,
    proposed: { issuer: "New entity", capacity: "500 MW" },
  });
  const added = renderCell(review([addition]), addition, "capacity");
  assert.ok(added.includes("500 MW"));
  assert.ok(!added.includes("&quot;issuer&quot;"));
  assert.ok(added.includes("adds the entire entity when you publish"));
  const invalidAdditions: UpdateChange["proposed"][] = [
    null,
    [],
    {},
    { issuer: "Entity" },
  ];
  for (const proposed of invalidAdditions) {
    const invalid = change({ kind: "addition", scope: "discovery", proposed });
    assert.ok(
      cellButton(
        renderCell(review([invalid]), invalid, "capacity"),
        "Accept proposal",
      ).includes("disabled"),
    );
  }
});

test("cell review decisions stay adjustable while stale, unsupported and published acceptance stays disabled", () => {
  const entry = change(),
    update = review([entry]);
  update.decisions[entry.id] = "accept";
  let html = renderCell(update, entry);
  assert.ok(
    cellButton(html, "Accept proposal").includes('aria-pressed="true"'),
  );
  assert.ok(!cellButton(html, "Keep current").includes("disabled"));
  update.decisions[entry.id] = "keep";
  html = renderCell(update, entry);
  assert.ok(cellButton(html, "Keep current").includes('aria-pressed="true"'));
  assert.ok(!cellButton(html, "Accept proposal").includes("disabled"));
  for (const state of [
    { ...update, stale: true },
    { ...update, publishedSnapshotId: "successor" },
  ])
    for (const label of ["Accept proposal", "Keep current"])
      assert.ok(
        cellButton(renderCell(state, entry), label).includes("disabled"),
      );
  for (const altered of [
    change({ canAccept: false }),
    change({ evidence: [] }),
    change({ kind: "contradiction", canAccept: true }),
    change({ kind: "not_observed", canAccept: true }),
  ]) {
    html = renderCell(review([altered]), altered);
    assert.ok(cellButton(html, "Accept proposal").includes("disabled"));
    assert.ok(!cellButton(html, "Keep current").includes("disabled"));
  }
  html = renderCell(
    { ...update, stale: true, publishedSnapshotId: "successor" },
    entry,
  );
  assert.ok(html.includes("Published review history. Decisions are fixed."));
  assert.ok(!html.includes("baseline has newer corrections"));
});

test("cell findings explain contradictions and absence, and unsafe links cannot enable acceptance", () => {
  assert.ok(
    renderCell(
      review(),
      change({ kind: "contradiction", canAccept: false }),
    ).includes("Conflicting evidence cannot replace the current value"),
  );
  assert.ok(
    renderCell(
      review(),
      change({ kind: "not_observed", canAccept: false }),
    ).includes("does not establish deletion or cancellation"),
  );
  const entry = change();
  entry.evidence[0].url = "javascript:alert(1)";
  const html = renderCell(review([entry]), entry);
  assert.ok(!html.includes("javascript:"));
  assert.ok(cellButton(html, "Accept proposal").includes("disabled"));
});

test("cell actions send only the explicit review choice and cannot apply a disabled proposal", () => {
  const entry = change(),
    update = review([entry]),
    decisions: [string, string][] = [];
  type Node = {
    props?: { children?: unknown; onClick?: () => void; disabled?: boolean };
  };
  const actions = (node: unknown): Node[] => {
    if (Array.isArray(node)) return node.flatMap(actions);
    if (!node || typeof node !== "object") return [];
    const value = node as Node;
    return value.props?.onClick && typeof value.props.children === "string"
      ? [value]
      : actions(value.props?.children);
  };
  const renderActions = (busy = false) =>
    actions(
      CellUpdateProposal({
        update,
        change: entry,
        busy,
        onReview: (id, decision) => decisions.push([id, decision]),
        onSource() {},
      }),
    );
  const [accept, keep] = renderActions();
  accept.props!.onClick!();
  update.decisions[entry.id] = "accept";
  keep.props!.onClick!();
  assert.deepEqual(decisions, [
    [entry.id, "accept"],
    [entry.id, "keep"],
  ]);
  update.stale = true;
  for (const action of renderActions()) action.props!.onClick!();
  update.stale = false;
  update.publishedSnapshotId = "successor";
  for (const action of renderActions()) action.props!.onClick!();
  update.publishedSnapshotId = undefined;
  for (const action of renderActions(true)) action.props!.onClick!();
  assert.equal(decisions.length, 2);
});
