import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ResearchStore } from "../server/store.js";
import {
  snapshotSchema,
  effectiveValue,
  sourcesForSelection,
  type ResearchView,
  type AmendmentInput,
} from "../src/schema.js";
import { parseCorrection, correctionKind } from "../src/corrections.js";
import sample from "../fixtures/water-procurement.json";

const seed = snapshotSchema.parse(sample);
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-app-test-"));
  return { directory, store: new ResearchStore(directory, seed) };
}
const amendment = (changes: Partial<AmendmentInput> = {}): AmendmentInput => ({
  snapshot_id: seed.id,
  row_id: "record-1",
  field: "closes_at",
  value: "2026-10-02 15:00:00",
  reason: "The listing is insufficient to establish the deadline.",
  expected_revision: 0,
  mutation_id: randomUUID(),
  ...changes,
});

test("synthetic compatibility fixture retains the exported rows, source ID and exact deadline quotes", async () => {
  const original = JSON.parse(
    await readFile(
      new URL("../fixtures/legacy-snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(seed.rows.length, 9);
  assert.equal(seed.sourceResultSetId, original.export_result_set_id);
  seed.rows.forEach((row, i) => {
    assert.equal(row.evidence.closes_at[0], original.rows[i].deadline_quote);
    for (const key of Object.keys(row.values))
      assert.equal(row.values[key], original.rows[i][key]);
  });
});
test("correction survives a store restart without modifying any original evidence", async () => {
  const { store, directory } = await setup();
  await store.amend(amendment());
  const view = await new ResearchStore(directory, seed).open();
  assert.deepEqual(view.snapshot, seed);
  assert.equal(view.amendments.length, 1);
  assert.equal(
    effectiveValue(view, view.snapshot.rows[0], "closes_at"),
    "2026-10-02 15:00:00",
  );
  assert.equal(view.amendments[0].originalValue, "2026-10-01 15:00:00");
});
test("intentional null correction remains null instead of falling back to source value", async () => {
  const { store } = await setup();
  const view = await store.amend(amendment({ value: null }));
  assert.equal(effectiveValue(view, view.snapshot.rows[0], "closes_at"), null);
});
test("renaming persists separately from original evidence and rejects stale or empty titles", async () => {
  const { store, directory } = await setup();
  const input = {
    snapshot_id: seed.id,
    title: "  Water opportunities  ",
    expected_title: seed.title,
  };
  const renamed = await store.rename(input);
  assert.equal(renamed.displayTitle, "Water opportunities");
  assert.equal(renamed.snapshots[0].title, "Water opportunities");
  assert.deepEqual(renamed.snapshot, seed);
  assert.equal(renamed.revision, 0);
  assert.deepEqual(await store.rename(input), renamed);
  assert.deepEqual(await new ResearchStore(directory, seed).open(), renamed);
  await assert.rejects(
    store.rename({ ...input, title: "Stale rename" }),
    /title has changed/,
  );
  await assert.rejects(store.rename({ ...input, title: "   " }));
  await assert.rejects(store.rename({ ...input, title: "x".repeat(151) }));
  await assert.rejects(
    store.rename({ ...input, snapshot_id: "missing" }),
    /not found/,
  );
  await store.import({ ...seed, id: "another-snapshot" });
  assert.equal((await store.open("another-snapshot")).displayTitle, seed.title);
  const amended = await store.amend(amendment());
  assert.equal(amended.displayTitle, "Water opportunities");
  assert.deepEqual(amended.snapshot, seed);
});
test("concurrent edits cannot silently overwrite a newer revision", async () => {
  const { store } = await setup();
  const results = await Promise.allSettled([
    store.amend(amendment()),
    store.amend(amendment({ value: "2026-10-03 15:00:00" })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.open()).amendments.length, 1);
});
test("retrying the same mutation is idempotent; reusing its ID for different data fails", async () => {
  const { store } = await setup();
  const input = amendment();
  await store.amend(input);
  await store.amend(input);
  assert.equal((await store.open()).amendments.length, 1);
  await assert.rejects(
    store.amend({ ...input, value: "2026-10-04 15:00:00" }),
    /different values/,
  );
});
test("new snapshots retain the original snapshot and its corrections", async () => {
  const { store } = await setup();
  await store.amend(amendment());
  const newer = {
    ...seed,
    id: "follow-up",
    parentSnapshotId: seed.id,
    title: "Captured follow-up",
  };
  const imported = await store.import(newer);
  assert.equal(imported.snapshots.length, 2);
  assert.equal(imported.amendments.length, 0);
  assert.equal((await store.open(seed.id)).amendments.length, 1);
  await assert.rejects(
    store.import({ ...seed, title: "Overwrite attempt" }),
    /immutable/,
  );
});
test("unknown rows, undeclared fields, duplicate row IDs and unsafe links are rejected", async () => {
  const { store } = await setup();
  await assert.rejects(
    store.amend(amendment({ row_id: "missing" })),
    /not found/,
  );
  await assert.rejects(
    store.amend(amendment({ field: "not_a_column" })),
    /not found/,
  );
  assert.equal(
    snapshotSchema.safeParse({ ...seed, rows: [seed.rows[0], seed.rows[0]] })
      .success,
    false,
  );
  assert.equal(
    snapshotSchema.safeParse({
      ...seed,
      rows: [{ ...seed.rows[0], sourceUrl: "javascript:alert(1)" }],
    }).success,
    false,
  );
});
test("oversized or malformed exports and impossible dates are rejected", () => {
  assert.equal(
    snapshotSchema.safeParse({ ...seed, capturedAt: "2026-02-31" }).success,
    false,
  );
  assert.equal(
    snapshotSchema.safeParse({
      ...seed,
      rows: Array.from({ length: 101 }, (_, i) => ({
        ...seed.rows[0],
        id: `row-${i}`,
      })),
    }).success,
    false,
  );
  assert.equal(
    snapshotSchema.safeParse({
      ...seed,
      rows: [{ ...seed.rows[0], values: { issuer: "Lost fields" } }],
    }).success,
    false,
  );
});
test("source selection keeps cell provenance specific and aggregates whole-row sources without duplicates", async () => {
  const { store, directory } = await setup();
  const snapshot = snapshotSchema.parse({
    ...seed,
    id: "multiple-sources",
    rows: [
      {
        ...seed.rows[0],
        sources: [
          { url: seed.rows[0].sourceUrl, label: "Issuer listing" },
          { url: "https://example.com/context", label: "Context" },
        ],
        cellSources: {
          closes_at: [
            {
              url: "https://example.com/deadline",
              label: "Deadline amendment",
            },
            { url: "https://example.com/context" },
          ],
          issuer: [{ url: seed.rows[0].sourceUrl }],
        },
      },
    ],
  });
  await store.import(snapshot);
  const view = await new ResearchStore(directory, seed).open(snapshot.id);
  const row = view.snapshot.rows[0];
  assert.deepEqual(
    sourcesForSelection(row, "closes_at").map((s) => s.url),
    ["https://example.com/deadline", "https://example.com/context"],
  );
  assert.equal(sourcesForSelection(row, "issuer").length, 1);
  assert.equal(sourcesForSelection(row, "disposition").length, 2);
  assert.deepEqual(
    sourcesForSelection(row).map((s) => s.url),
    [
      row.sourceUrl,
      "https://example.com/context",
      "https://example.com/deadline",
    ],
  );
  assert.equal(sourcesForSelection(row)[0].label, "Issuer listing");
  const request_id = randomUUID();
  await store.beginResearch(
    {
      request_id,
      snapshot_id: snapshot.id,
      row_id: row.id,
      field: "closes_at",
      question: "Check current evidence",
    },
    "expand",
  );
  const context = await store.researchContext(request_id);
  assert.deepEqual(
    context.selectedSources[0].sources.map((s) => s.url),
    ["https://example.com/deadline", "https://example.com/context"],
  );
  assert.deepEqual((await store.open(snapshot.id)).snapshot, snapshot);
});
test("source collections reject unsafe URLs, empty lists and undeclared cell fields", () => {
  for (const extra of [
    { sources: [{ url: "javascript:alert(1)" }] },
    { cellSources: { closes_at: [{ url: "data:text/html,test" }] } },
    { cellSources: { unknown: [{ url: "https://example.com" }] } },
    { cellSources: { closes_at: [] } },
    {
      sources: Array.from({ length: 13 }, () => ({
        url: "https://example.com",
      })),
    },
  ])
    assert.equal(
      snapshotSchema.safeParse({
        ...seed,
        rows: [{ ...seed.rows[0], ...extra }],
      }).success,
      false,
    );
});
test("correction input validates numbers, booleans and real calendar dates without coercing blanks", () => {
  assert.deepEqual(parseCorrection("number", "0"), { value: 0, error: "" });
  assert.deepEqual(parseCorrection("number", "-2.5"), {
    value: -2.5,
    error: "",
  });
  for (const input of ["twelve", "NaN", "Infinity", "0x10", "1e999"])
    assert.ok(parseCorrection("number", input).error);
  assert.deepEqual(parseCorrection("boolean", "false"), {
    value: false,
    error: "",
  });
  assert.ok(parseCorrection("boolean", "yes").error);
  assert.ok(parseCorrection("date", "2026-02-29").error);
  assert.equal(parseCorrection("date", "2028-02-29").error, "");
  assert.ok(parseCorrection("datetime", "2026-10-02 25:00:00").error);
  assert.ok(parseCorrection("datetime", "2026-02-30 15:00:00").error);
  assert.equal(parseCorrection("datetime", "2026-10-02 15:00:00").error, "");
  assert.deepEqual(parseCorrection("text", "New description"), {
    value: "New description",
    error: "",
  });
  for (const kind of ["text", "number", "boolean", "date", "datetime"] as const)
    assert.deepEqual(parseCorrection(kind, ""), { value: null, error: "" });
});
test("all sample deadline formats retain their value while rejecting invalid replacements", async () => {
  const { store } = await setup();
  const view = await store.open();
  for (const row of view.snapshot.rows) {
    const kind = correctionKind(view, row, "closes_at");
    assert.ok(kind === "date" || kind === "datetime");
    const value = String(row.values.closes_at);
    assert.deepEqual(parseCorrection(kind, value), { value, error: "" });
    assert.ok(parseCorrection(kind, "not a date").error);
  }
  assert.ok(parseCorrection("datetime", "2026-10-02 15:00 PM").error);
  assert.ok(parseCorrection("datetime", "2026-10-02 00:00 AM").error);
});
test("server enforces original field types, infers missing values, and saves without a reason", async () => {
  const { store, directory } = await setup();
  const snapshot = snapshotSchema.parse({
    ...seed,
    id: "typed-corrections",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "active", label: "Active" },
      { key: "when", label: "Date" },
      { key: "label", label: "Name" },
    ],
    rows: [
      {
        ...seed.rows[0],
        id: "typed",
        values: {
          amount: 5,
          active: true,
          when: "2026-10-01",
          label: "Original",
        },
        evidence: {},
      },
      {
        ...seed.rows[0],
        id: "empty",
        values: { amount: null, active: null, when: null, label: null },
        evidence: {},
      },
    ],
  });
  let view = await store.import(snapshot);
  const edit = (
    field: string,
    value: AmendmentInput["value"],
    row_id = "typed",
  ) =>
    store.amend({
      snapshot_id: snapshot.id,
      row_id,
      field,
      value,
      expected_revision: view.revision,
      mutation_id: randomUUID(),
    });
  await assert.rejects(edit("amount", "six"), /number/);
  await assert.rejects(edit("active", "false"), /true or false/);
  await assert.rejects(edit("when", "2026-02-30"), /valid date/);
  await assert.rejects(edit("label", 123), /text/);
  view = await edit("amount", 0);
  view = await edit("active", false);
  assert.equal(view.amendments[0].reason, undefined);
  assert.equal(correctionKind(view, view.snapshot.rows[1], "amount"), "number");
  await assert.rejects(edit("amount", "wrong type", "empty"), /number/);
  view = await edit("amount", 12.5, "empty");
  view = await edit("amount", null);
  await assert.rejects(edit("amount", "still wrong after clearing"), /number/);
  const saved = await new ResearchStore(directory, seed).open(snapshot.id);
  assert.equal(effectiveValue(saved, saved.snapshot.rows[0], "amount"), null);
  assert.equal(effectiveValue(saved, saved.snapshot.rows[0], "active"), false);
  assert.equal(effectiveValue(saved, saved.snapshot.rows[1], "amount"), 12.5);
  assert.deepEqual(saved.snapshot, snapshot);
});
test("MCP stdio handshake, UI resource, correction, import and follow-up round trip", async () => {
  const { directory } = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/main.ts", "--stdio"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
      RESEARCH_DATA_DIR: directory,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "research-integration-test",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "amend_observation",
        "append_research",
        "append_research_updates",
        "check_research_updates",
        "finish_research_update",
        "get_research_update",
        "publish_research_update",
        "review_research_update",
        "save_research_checkpoint",
        "resume_research_checkpoint",
        "import_research_checkpoint",
        "sourcesql_materialize_research",
        "expand_research",
        "find_research_row",
        "finish_research",
        "get_research_request",
        "import_research",
        "open_research",
        "refresh_research",
        "remove_research",
        "rename_research",
        "research_status",
        "restore_research",
        "review_refresh",
        "research_page",
        "export_research",
        "import_research_bundle",
        "sourcesql_capabilities",
        "sourcesql_explain",
        "sourcesql_query",
        "sourcesql_run_status",
        "sourcesql_read_result",
        "sourcesql_inspect_evidence",
        "sourcesql_cancel",
        "sourcesql_job_status",
        "sourcesql_cancel_job",
        "sourcesql_start_job",
      ].sort(),
    );
    const openTool = tools.find((t) => t.name === "open_research")!;
    const resourceUri = (openTool._meta?.ui as { resourceUri: string })
      .resourceUri;
    assert.match(
      resourceUri,
      /^ui:\/\/sourcesql\/research-[a-f0-9]{16}\.html$/,
    );
    const { contents } = await client.readResource({
      uri: resourceUri,
    });
    assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(
      "text" in contents[0] &&
        contents[0].text.includes("sourcesQL research workspace"),
    );
    const opened = await client.callTool({
      name: "open_research",
      arguments: {},
    });
    assert.equal(
      (opened.structuredContent as ResearchView).snapshot.rows.length,
      9,
    );
    assert.equal(openTool.annotations?.readOnlyHint, false);
    const freshSnapshot = {
      ...seed,
      id: "fresh-research-results",
      title: "New research table",
      sourceResultSetId: "ra123bc456def",
      columns: [
        { key: "name", label: "Name" },
        { key: "score", label: "Score" },
      ],
      rows: [
        {
          id: "fresh-row-1",
          values: { name: "Integration fixture", score: 7.5 },
          sourceUrl: "https://example.com/research",
          evidence: {},
          verificationNote: "Synthetic integration fixture",
        },
      ],
    };
    const fresh = await client.callTool({
      name: "open_research",
      arguments: { snapshot: freshSnapshot },
    });
    assert.equal(fresh.isError, undefined);
    assert.deepEqual(
      (fresh.structuredContent as ResearchView).snapshot,
      freshSnapshot,
    );
    const repeated = await client.callTool({
      name: "open_research",
      arguments: { snapshot: freshSnapshot },
    });
    assert.deepEqual(repeated.structuredContent, fresh.structuredContent);
    const reopenedFresh = await client.callTool({
      name: "open_research",
      arguments: { snapshot_id: freshSnapshot.id },
    });
    assert.deepEqual(reopenedFresh.structuredContent, fresh.structuredContent);
    const changedFresh = await client.callTool({
      name: "open_research",
      arguments: { snapshot: { ...freshSnapshot, title: "Overwrite attempt" } },
    });
    assert.equal(changedFresh.isError, true);
    const ambiguous = await client.callTool({
      name: "open_research",
      arguments: { snapshot_id: seed.id, snapshot: freshSnapshot },
    });
    assert.equal(ambiguous.isError, true);
    assert.match(JSON.stringify(ambiguous.content), /not both/);
    const saved = await client.callTool({
      name: "amend_observation",
      arguments: amendment(),
    });
    assert.equal(
      (saved.structuredContent as ResearchView).amendments.length,
      1,
    );
    const renamed = await client.callTool({
      name: "rename_research",
      arguments: {
        snapshot_id: seed.id,
        title: "Water opportunities",
        expected_title: seed.title,
      },
    });
    assert.equal(renamed.isError, undefined);
    assert.equal(
      (renamed.structuredContent as ResearchView).displayTitle,
      "Water opportunities",
    );
    assert.deepEqual(
      (renamed.structuredContent as ResearchView).snapshot,
      seed,
    );
    const requestId = randomUUID();
    const followup = await client.callTool({
      name: "expand_research",
      arguments: {
        request_id: requestId,
        snapshot_id: seed.id,
        row_id: "record-1",
        field: "closes_at",
        question: "Check the latest issuing-source deadline.",
      },
    });
    assert.equal(followup.isError, undefined);
    assert.match(JSON.stringify(followup.structuredContent), /pending/);
    assert.match(JSON.stringify(followup.structuredContent), /append_research/);
    const context = await client.callTool({
      name: "get_research_request",
      arguments: { request_id: requestId },
    });
    assert.match(
      JSON.stringify(context.structuredContent),
      /2026-10-02 15:00:00/,
    );
    const completed = await client.callTool({
      name: "append_research",
      arguments: {
        request_id: requestId,
        snapshot: {
          ...freshSnapshot,
          id: "child-results",
          parentSnapshotId: seed.id,
        },
      },
    });
    assert.equal(completed.isError, undefined);
    const completedView = completed.structuredContent as ResearchView;
    assert.match(JSON.stringify(completed.content), /Now call open_research/);
    const reopened = await client.callTool({
      name: "open_research",
      arguments: { snapshot_id: completedView.snapshot.id },
    });
    assert.equal(reopened.isError, undefined);
    const reopenedView = reopened.structuredContent as ResearchView;
    assert.equal(reopenedView.snapshot.id, "child-results");
    assert.equal(reopenedView.snapshot.parentSnapshotId, seed.id);
    assert.equal(
      reopenedView.requests.find((r) => r.id === requestId)?.status,
      "completed",
    );
    const status = await client.callTool({
      name: "research_status",
      arguments: { snapshot_id: seed.id },
    });
    const updated = status.structuredContent as ResearchView;
    assert.equal(
      updated.requests.find((r) => r.id === requestId)?.resultSnapshotId,
      "child-results",
    );
    assert.equal(
      updated.snapshots.find((s) => s.id === "child-results")?.depth,
      1,
    );
    const invalidScope = await client.callTool({
      name: "expand_research",
      arguments: {
        request_id: randomUUID(),
        snapshot_id: seed.id,
        row_id: "record-1",
        field: "unknown",
        question: "Check current deadline",
      },
    });
    assert.equal(invalidScope.isError, true);
    const imported = await client.callTool({
      name: "import_research",
      arguments: {
        snapshot: { ...seed, id: "second-snapshot", parentSnapshotId: seed.id },
      },
    });
    assert.equal(
      (imported.structuredContent as ResearchView).snapshots.length,
      4,
    );
    const invalid = await client.callTool({
      name: "open_research",
      arguments: { snapshot_id: "does-not-exist" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
