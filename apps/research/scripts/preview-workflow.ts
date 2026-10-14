// Isolated UI fixtures. Never writes to the user's research store or calls the research service.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchStore } from "../server/store.js";
import { snapshotSchema } from "../src/schema.js";
const directory = await mkdtemp(join(tmpdir(), "sourcesql-ui-workflow-"));
const seed = snapshotSchema.parse({
  id: "ui-root",
  title: "Pump research · UI test fixtures",
  sourceResultSetId: "r111",
  capturedAt: "2026-10-13",
  coverage: "Synthetic data for component validation only",
  columns: [
    { key: "model", label: "Pump model" },
    { key: "speed", label: "Speed control" },
  ],
  rows: [
    {
      id: "pump-1",
      values: { model: "Pump A", speed: "Fixed speed" },
      sourceUrl: "https://example.com/pump-a",
      evidence: {},
      verificationNote: "Synthetic UI fixture",
    },
    {
      id: "pump-2",
      values: { model: "Pump B", speed: "Variable speed" },
      sourceUrl: "https://example.com/pump-b",
      evidence: {},
      verificationNote: "Synthetic UI fixture",
    },
  ],
});
const store = new ResearchStore(directory, seed);
await store.import(seed);
await store.amend({
  snapshot_id: seed.id,
  row_id: "pump-1",
  field: "speed",
  value: "Fixed speed (confirmed)",
  expected_revision: 0,
  mutation_id: randomUUID(),
});
const first = randomUUID();
await store.beginResearch(
  {
    request_id: first,
    snapshot_id: seed.id,
    row_id: "pump-1",
    field: "speed",
    question: "Compare available controls",
  },
  "expand",
);
await store.appendResearch({
  request_id: first,
  snapshot: {
    ...seed,
    id: "ui-child",
    title: "Controls for Pump A",
    sourceResultSetId: "r222",
    rows: [seed.rows[0]],
  },
});
const second = randomUUID();
await store.beginResearch(
  {
    request_id: second,
    snapshot_id: "ui-child",
    row_id: "pump-1",
    question: "Look into installation",
  },
  "expand",
);
await store.appendResearch({
  request_id: second,
  snapshot: {
    ...seed,
    id: "ui-grandchild",
    title: "Installation requirements",
    sourceResultSetId: "r333",
    rows: [seed.rows[0]],
  },
});
const refresh = randomUUID();
const alternate = randomUUID();
await store.beginResearch(
  {
    request_id: alternate,
    snapshot_id: seed.id,
    row_id: "pump-1",
    field: "speed",
    question: "Find compatible replacement controls",
  },
  "expand",
);
await store.appendResearch({
  request_id: alternate,
  snapshot: {
    ...seed,
    id: "ui-alternate",
    title: "Replacement controls for Pump A",
    sourceResultSetId: "r555",
    rows: [seed.rows[0]],
  },
});
await store.beginResearch(
  {
    request_id: refresh,
    snapshot_id: seed.id,
    row_id: "pump-1",
    field: "speed",
  },
  "refresh",
);
await store.appendResearch({
  request_id: refresh,
  snapshot: {
    ...seed,
    id: "ui-refresh",
    title: "Pump A · refreshed controls",
    sourceResultSetId: "r444",
    rows: [
      {
        ...seed.rows[0],
        values: { model: "Pump A", speed: "Variable speed" },
        sourceUrl: "https://example.com/new-controls",
        evidence: {
          speed: ["Synthetic fixture: variable speed controller available"],
        },
      },
    ],
  },
  assessments: [
    {
      row_id: "pump-1",
      field: "speed",
      status: "verified",
      note: "Synthetic proposal for UI review testing.",
    },
  ],
});
process.env.RESEARCH_DATA_DIR = directory;
process.env.PORT = "3109";
console.error(`Isolated fixture store: ${directory}`);
await import("../server/main.js");
