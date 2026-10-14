import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { ResearchStore } from "../../server/store.js";
import { snapshotSchema } from "../../src/schema.js";
import sample from "../../fixtures/water-procurement.json";
const seed = snapshotSchema.parse(sample);
const input = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
for await (const line of input) {
  if (line === "go") break;
}
input.close();
try {
  const result = await new ResearchStore(process.argv[2], seed).amend({
    snapshot_id: seed.id,
    row_id: seed.rows[0].id,
    field: "closes_at",
    value: process.argv[3] === "null" ? null : "2026-10-08 15:00:00",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  process.stdout.write(
    JSON.stringify({ accepted: true, revision: result.revision }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      accepted: false,
      error: error instanceof Error ? error.message : "Writer refused",
    }) + "\n",
  );
}
