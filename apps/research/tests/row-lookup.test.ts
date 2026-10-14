import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import { snapshotSchema, type ResearchView } from "../src/schema.js";

const seed = snapshotSchema.parse({
  id: "projects",
  title: "Projects",
  sourceResultSetId: "rabc123",
  capturedAt: "2026-10-13",
  coverage: "Synthetic test fixture",
  columns: [
    { key: "project", label: "Project" },
    { key: "location", label: "Location" },
    { key: "capacity", label: "Capacity" },
    { key: "active", label: "Active" },
    { key: "note", label: "Note" },
  ],
  rows: [
    {
      id: "stable-dallas",
      values: {
        project: "Example Data Center",
        location: "Dallas",
        capacity: 1000,
        active: true,
        note: null,
      },
      sourceUrl: "https://example.com/dallas",
      evidence: {},
      verificationNote: "Test",
    },
    {
      id: "stable-austin",
      values: {
        project: "Example Data Center",
        location: "Austin",
        capacity: 1000,
        active: false,
        note: "Long preview ".repeat(100),
      },
      sourceUrl: "https://example.com/austin",
      evidence: {},
      verificationNote: "Test",
    },
  ],
});

test("row lookup exposes ambiguity across pages, effective values, typed filters and exact dataset scope without writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-row-lookup-"));
  try {
    const store = new ResearchStore(directory, seed);
    await store.import(seed);
    await store.import({
      ...seed,
      id: "other-projects",
      title: "Other projects",
    });
    await store.import({
      ...seed,
      id: "archived-projects",
      parentSnapshotId: seed.id,
    });
    await store.remove("archived-projects");
    await store.rename({
      snapshot_id: seed.id,
      expected_title: seed.title,
      title: "Renamed projects",
    });
    await store.amend({
      snapshot_id: seed.id,
      row_id: "stable-dallas",
      field: "location",
      value: "Fort Worth",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const before = await readFile(join(directory, "research.json"), "utf8");
    const first = await store.findRows({
      snapshot_id: seed.id,
      query: "example data",
      limit: 1,
    });
    assert.equal(first.status, "ambiguous");
    assert.equal(first.total_matches, 2);
    assert.equal(first.next_offset, 1);
    assert.equal(first.datasets[0].title, "Renamed projects");
    assert.equal(first.matches[0].row_id, "stable-dallas");
    assert.equal(first.matches[0].values.location, "Fort Worth");
    assert.deepEqual(first.matches[0].corrected_fields, ["location"]);
    const second = await store.findRows({
      snapshot_id: seed.id,
      offset: first.next_offset!,
      limit: 1,
    });
    assert.equal(second.status, "ambiguous");
    assert.equal(second.next_offset, null);
    assert.equal(second.matches[0].row_id, "stable-austin");
    assert.deepEqual(second.matches[0].truncated_fields, ["note"]);
    assert.equal((second.matches[0].values.note as string).length, 501);
    const exact = await store.findRows({
      snapshot_id: seed.id,
      match: {
        project: " EXAMPLE DATA CENTER ",
        location: "Fort Worth",
        capacity: 1000,
        active: true,
        note: null,
      },
    });
    assert.equal(exact.status, "unique");
    assert.equal(exact.matches[0].row_id, "stable-dallas");
    const mismatches: Record<string, string>[] = [
      { capacity: "1000" },
      { active: "true" },
      { note: "null" },
      { location: "Dallas" },
    ];
    for (const match of mismatches)
      assert.equal(
        (await store.findRows({ snapshot_id: seed.id, match })).status,
        "no_matches",
      );
    assert.equal(
      (
        await store.findRows({
          snapshot_id: seed.id,
          query: "Austin",
          match: { location: "Fort Worth" },
        })
      ).total_matches,
      0,
    );
    const global = await store.findRows({ query: "Example Data Center" });
    assert.equal(global.total_matches, 4);
    assert.deepEqual(
      new Set(global.matches.map((m) => m.snapshot_id)),
      new Set([seed.id, "other-projects"]),
    );
    await assert.rejects(
      store.findRows({ snapshot_id: "archived-projects" }),
      /archived/,
    );
    await assert.rejects(
      store.findRows({ snapshot_id: "missing" }),
      /not found/,
    );
    await assert.rejects(
      store.findRows({ snapshot_id: seed.id, match: { wrong_field: "x" } }),
      /Available columns: project \(Project\)/,
    );
    await assert.rejects(store.findRows({}), /Supply snapshot_id/);
    await assert.rejects(
      store.findRows({ query: "example", match: { project: "x" } }),
      /match requires snapshot_id/,
    );
    await assert.rejects(
      store.findRows({ snapshot_id: seed.id, match: {} }),
      /1–12/,
    );
    await assert.rejects(store.findRows({ snapshot_id: seed.id, limit: 21 }));
    assert.equal(
      await readFile(join(directory, "research.json"), "utf8"),
      before,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP lookup drives a request-bound child under the resolved row without UI selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-agent-row-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const store = new ResearchStore(join(directory, "data"), seed);
  const server = createServer(store, htmlPath);
  const client = new Client({ name: "agent-row-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "find_research_row")!;
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool._meta?.ui, undefined);
    const found = await client.callTool({
      name: "find_research_row",
      arguments: {
        snapshot_id: seed.id,
        match: { project: "Example Data Center", location: "Austin" },
      },
    });
    assert.equal(found.isError, undefined);
    const textBlock = (found.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )!;
    const lookup: Awaited<ReturnType<ResearchStore["findRows"]>> = JSON.parse(
      textBlock.text!,
    );
    assert.deepEqual(lookup, found.structuredContent);
    assert.equal(lookup.status, "unique");
    const { snapshot_id, row_id } = lookup.matches[0];
    assert.equal(row_id, "stable-austin");
    const request_id = randomUUID();
    const begun = await client.callTool({
      name: "expand_research",
      arguments: {
        request_id,
        snapshot_id,
        row_id,
        question: "Investigate power availability",
      },
    });
    assert.equal(begun.isError, undefined);
    const context = await client.callTool({
      name: "get_research_request",
      arguments: { request_id },
    });
    assert.equal(context.isError, undefined);
    assert.match(JSON.stringify(context.content), /stable-austin/);
    // Synthetic research result; no external connector or live user store is used.
    const child = {
      ...seed,
      id: "austin-power",
      sourceResultSetId: "rdef456",
      title: "Austin power research",
      rows: [seed.rows[1]],
    };
    const saved = await client.callTool({
      name: "append_research",
      arguments: { request_id, snapshot: child },
    });
    assert.equal(saved.isError, undefined, JSON.stringify(saved.content));
    assert.equal(
      (saved.structuredContent as ResearchView).snapshot.parentSnapshotId,
      snapshot_id,
    );
    const parent = await store.open(snapshot_id);
    const linked = parent.requests.find((r) => r.id === request_id)!;
    assert.equal(linked.rowId, row_id);
    assert.equal(linked.resultSnapshotId, child.id);
    assert.equal(linked.status, "completed");
    assert.deepEqual(parent.snapshot, seed);
    const opened = await client.callTool({
      name: "open_research",
      arguments: { snapshot_id: child.id },
    });
    assert.equal(opened.isError, undefined);
    assert.equal(
      (opened.structuredContent as ResearchView).snapshot.id,
      child.id,
    );
    assert.match(JSON.stringify(opened.content), /austin-power/);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
