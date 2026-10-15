import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import {
  boundedPreview,
  resultSnapshot,
  type EngineResult,
} from "../server/engine.js";
import { createServer } from "../server/mcp.js";
import {
  effectiveValue,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";

function canonical(id: string, count = 1): Snapshot {
  const result: EngineResult = {
    result_id: "wq_" + id,
    run_id: "run_" + id,
    columns: [
      {
        key: "value",
        label: "Value",
        logical_type: "VARCHAR",
        nullable: false,
      },
    ],
    rows: Array.from({ length: count }, (_, i) => ({ value: "original " + i })),
    row_ids: Array.from({ length: count }, (_, i) => "row_" + i),
    row_count: count,
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    receipt: { status: "completed", finished_at: "2026-10-14T16:00:00Z" },
    next_offset: null,
  };
  return resultSnapshot(result, {
    result_id: result.result_id,
    snapshot_id: id,
    title: id,
  });
}
function harness(snapshots: Snapshot[]) {
  const state: ResearchState = {
    snapshots: snapshots.map((s) => boundedPreview(s)),
    amendments: [],
  };
  const calls: string[] = [];
  const denied = new Set<string>();
  const backend: ResearchStateBackend = {
    async read() {
      return { state: structuredClone(state), version: "1" };
    },
    async write() {
      throw Error("Navigation must not write");
    },
  };
  const store = new ResearchStore(
    "/unused",
    snapshots[0],
    async (snapshot) => {
      calls.push(snapshot.id);
      if (denied.has(snapshot.id))
        throw Error("Result or dependency unavailable");
      return {
        ...structuredClone(snapshots.find((s) => s.id === snapshot.id)!),
        parentSnapshotId: snapshot.parentSnapshotId,
      };
    },
    3000,
    { backend },
  );
  return { store, calls, denied, state };
}
function edit(
  snapshot_id: string,
  row_id = "row_0",
  sourceSnapshotId?: string,
) {
  return {
    snapshot_id,
    row_id,
    field: "value",
    value: "corrected",
    expected_revision: 0,
    mutation_id: randomUUID(),
    revision: 1,
    originalValue: "original 0",
    createdAt: "2026-10-14T16:01:00Z",
    ...(sourceSnapshotId ? { sourceSnapshotId } : {}),
  };
}

test("navigation resolves only the selected table; unrelated unavailable results do not block it", async () => {
  const h = harness([canonical("chosen"), canonical("unrelated")]);
  h.denied.add("unrelated");
  const view = await h.store.open("chosen");
  assert.deepEqual(h.calls, ["chosen"]);
  assert.equal(view.snapshot.rows.length, 1);
  assert.equal(view.snapshots.length, 2);
});
test("each navigation reauthorizes the selected result rather than using a server cache", async () => {
  const h = harness([canonical("chosen")]);
  await h.store.open("chosen");
  h.denied.add("chosen");
  await assert.rejects(h.store.open("chosen"), /dependency unavailable/);
  assert.deepEqual(h.calls, ["chosen", "chosen"]);
});
test("navigation reauthorizes ancestors and accepted evidence and refuses their revocation", async () => {
  const parent = canonical("parent"),
    child = { ...canonical("child"), parentSnapshotId: "parent" };
  const evidence = { ...canonical("evidence"), parentSnapshotId: "parent" };
  const h = harness([parent, child, evidence, canonical("unrelated")]);
  h.state.amendments.push(edit("parent", "row_0", "evidence"));
  const view = await h.store.open("child");
  assert.deepEqual([...h.calls].sort(), ["child", "evidence", "parent"]);
  assert.equal(view.snapshot.parentSnapshotId, "parent");
  h.denied.add("evidence");
  await assert.rejects(h.store.open("child"), /dependency unavailable/);
});
test("navigation sees new durable corrections and refuses archived or absent targets before resolving", async () => {
  const h = harness([canonical("chosen")]);
  assert.equal((await h.store.open("chosen")).revision, 0);
  h.state.amendments.push(edit("chosen"));
  const current = await h.store.open("chosen");
  assert.equal(
    effectiveValue(current, current.snapshot.rows[0], "value"),
    "corrected",
  );
  h.calls.length = 0;
  h.state.archivedSnapshots = [
    { snapshotId: "chosen", archivedAt: "2026-10-14T16:02:00Z" },
  ];
  await assert.rejects(h.store.open("chosen"), /archived/);
  await assert.rejects(h.store.open("missing"), /not found/);
  assert.deepEqual(h.calls, []);
});
test("one MCP open restores a window or canonical row with corrections and refuses invalid selectors", async () => {
  const h = harness([canonical("large", 205), canonical("unrelated")]);
  h.state.amendments.push(edit("large", "row_204"));
  const server = createServer(
    h.store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
  );
  const client = new Client({ name: "navigation-window-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const args of [
      { snapshot_id: "large", offset: 200 },
      { snapshot_id: "large", row_id: "row_204" },
    ]) {
      const before = h.calls.length;
      const response = await client.callTool({
        name: "open_research",
        arguments: args,
      });
      assert(!response.isError, JSON.stringify(response.content));
      const view = response.structuredContent as ResearchView;
      assert.equal(view.preview!.offset, "offset" in args ? 200 : 204);
      assert.equal(view.preview!.total, 205);
      assert.equal(view.snapshot.rows.at(-1)!.id, "row_204");
      assert.equal(
        effectiveValue(view, view.snapshot.rows.at(-1)!, "value"),
        "corrected",
      );
      assert.deepEqual(h.calls.slice(before), ["large"]);
    }
    for (const args of [
      { snapshot_id: "large", offset: 1, row_id: "row_1" },
      { offset: 1 },
      { snapshot_id: "large", row_id: "missing" },
      { snapshot_id: "large", offset: 206 },
    ]) {
      const response = await client.callTool({
        name: "open_research",
        arguments: args,
      });
      assert.equal(response.isError, true);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
