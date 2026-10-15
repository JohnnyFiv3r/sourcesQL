import test from "node:test";
import assert from "node:assert/strict";
import { snapshotSchema } from "../src/schema.js";
import {
  nextTableSort,
  sourceLinksForValue,
  presentationColumns,
  humanizeColumnLabel,
  formatSourceUrl,
} from "../src/presentation.js";

test("sorting cycles back to original SQL order instead of trapping a saved view in a UI sort", () => {
  const ascending = nextTableSort(undefined, "project");
  assert.deepEqual(ascending, { field: "project", ascending: true });
  const descending = nextTableSort(ascending, "project");
  assert.deepEqual(descending, { field: "project", ascending: false });
  assert.equal(nextTableSort(descending, "project"), undefined);
  assert.deepEqual(nextTableSort(descending, "planned_mw"), {
    field: "planned_mw",
    ascending: true,
  });
});

test("selected URL navigation works without treating unrelated or missing values as source evidence", () => {
  const url = "https://duckdb.org/docs/current/sql/statements/select";
  assert.deepEqual(sourceLinksForValue([], url), [
    { url, label: "Selected URL" },
  ]);
  for (const missing of [
    null,
    undefined,
    "",
    "Aurora Campus",
    "javascript:alert(1)",
  ])
    assert.deepEqual(sourceLinksForValue([], missing), []);
  const original = [
    { url: "https://example.com/verified", label: "Returned evidence" },
  ];
  assert.equal(sourceLinksForValue(original, url), original);
});
import sample from "../fixtures/water-procurement.json";

test("friendly labels preserve explicit author labels, acronyms, quantities and units", () => {
  for (const [key, label] of Object.entries({
    planned_mw: "Planned Capacity (MW)",
    planned_capacity_mw: "Planned Capacity (MW)",
    utility_name: "Utility Name",
    source_url: "Source",
    url: "Source",
    rfp_id: "RFP ID",
    annual_cost_usd: "Annual Cost (USD)",
    capacity_mgd: "Capacity (MGD)",
    success_pct: "Success (%)",
  }))
    assert.equal(humanizeColumnLabel(key), label);
  assert.equal(
    humanizeColumnLabel("planned_mw", "Approved expansion size"),
    "Approved expansion size",
  );
  assert.equal(humanizeColumnLabel("id", "Permit #"), "Permit #");
});

test("presentation puts identity before measures and sources without changing stored schema or rows", () => {
  const snapshot = snapshotSchema.parse(sample);
  snapshot.columns = [
    { key: "url", label: "url" },
    { key: "project", label: "project" },
    { key: "planned_mw", label: "planned_mw" },
  ];
  snapshot.rows = [
    {
      ...snapshot.rows[0],
      values: {
        url: "https://example.com/project",
        project: "Aurora Campus",
        planned_mw: 500,
      },
      evidence: {},
      sourceUrl: "https://example.com/project",
    },
  ];
  const original = structuredClone(snapshot);
  const columns = presentationColumns(snapshot);
  assert.deepEqual(
    columns.map((c) => c.key),
    ["project", "planned_mw", "url"],
  );
  assert.deepEqual(
    columns.map((c) => c.label),
    ["Project", "Planned Capacity (MW)", "Source"],
  );
  assert.deepEqual(snapshot, original);
});

test("document columns stay honest when every title is missing, and no declared columns disappear", () => {
  const snapshot = snapshotSchema.parse(sample);
  snapshot.columns = [
    { key: "url", label: "url" },
    { key: "title", label: "title" },
    ...Array.from({ length: 14 }, (_, i) => ({
      key: `field_${i}`,
      label: `field_${i}`,
    })),
  ];
  snapshot.rows = [];
  const columns = presentationColumns(snapshot);
  assert.equal(columns.length, 16);
  assert.equal(columns[0].key, "title");
  assert.equal(columns.at(-1)!.key, "url");
  assert.equal(
    snapshot.rows.length,
    0,
    "Formatting must not synthesize provider titles",
  );
});

test("compact sources retain readable paths without schemes, query strings or URL mutation", () => {
  const full = "https://www.example.com/planned%20projects/?tracking=1#summary";
  assert.equal(formatSourceUrl(full), "example.com/planned projects");
  assert.equal(formatSourceUrl("https://duckdb.org/"), "duckdb.org");
  assert.equal(formatSourceUrl("unknown"), "unknown");
  assert.equal(
    full,
    "https://www.example.com/planned%20projects/?tracking=1#summary",
  );
});

test("long source addresses keep their distinguishing final path visible", () => {
  assert.equal(
    formatSourceUrl("https://duckdb.org/docs/current/sql/statements/select"),
    "duckdb.org/…/select",
  );
  assert.equal(
    formatSourceUrl("https://duckdb.org/docs/current/sql/query_syntax/where"),
    "duckdb.org/…/where",
  );
});
