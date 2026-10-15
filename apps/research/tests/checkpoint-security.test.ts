import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  buildCheckpoint,
  checkpointDependencyForView,
  type SaveCheckpointInput,
} from "../server/checkpoints.js";
import { resultSnapshot, type ResearchEngine } from "../server/engine.js";
import { snapshotSchema, type Snapshot } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
const seed = snapshotSchema.parse(sample);
const args = (
  snapshot: Snapshot,
  extra: Partial<SaveCheckpointInput> = {},
): SaveCheckpointInput => ({
  checkpoint_id: randomUUID(),
  snapshot_id: snapshot.id,
  expected_revision: 0,
  question: "Retain the exact authorized research context.",
  scope: "Synthetic security qualification only.",
  ...extra,
});
async function fixture(
  options: {
    allowPrivate?: boolean;
    engine?: ResearchEngine;
    initial?: Snapshot;
  } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "sourcesql-checkpoint-security-"),
  );
  const store = new ResearchStore(
    join(directory, "data"),
    options.initial ?? seed,
  );
  const html = join(directory, "research.html");
  await writeFile(html, "<html>Synthetic checkpoint qualification</html>");
  const server = createServer(store, html, {
    engine: options.engine,
    access: {
      mode: "protected",
      principal: "synthetic-checkpoint-owner",
      allowPrivateDisclosure: options.allowPrivate ?? true,
    },
  });
  const client = new Client({ name: "checkpoint-security", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    directory,
    store,
    client,
    async close() {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("checkpoint retry recovers its original record after reload and conflicts preserve saved context", async () => {
  const env = await fixture();
  try {
    const input = args(seed);
    const first = await env.client.callTool({
      name: "save_research_checkpoint",
      arguments: input,
    });
    assert.equal(first.isError, undefined, JSON.stringify(first.content));
    const saved = (first.structuredContent as any).checkpoint;
    const reopened = new ResearchStore(join(env.directory, "data"), seed);
    const views = await reopened.dependencyViews(seed.id);
    const recovered = await reopened.saveCheckpoint(
      input,
      views.map((view) => checkpointDependencyForView(view)),
    );
    assert.deepEqual(recovered, saved);
    await assert.rejects(
      reopened.saveCheckpoint(
        { ...input, scope: "Different continuation scope" },
        views.map((view) => checkpointDependencyForView(view)),
      ),
      /different arguments/,
    );
    assert.deepEqual(
      (await reopened.readCheckpoint(input.checkpoint_id)).checkpoint,
      saved,
    );
    assert.equal(
      (await reopened.exportBundle(seed.id)).state.checkpoints?.length,
      1,
    );
  } finally {
    await env.close();
  }
});
test("imported checkpoints cannot omit a known parent dependency and report ready", async () => {
  const env = await fixture();
  try {
    const child = {
      ...seed,
      id: "checkpoint-security-child",
      parentSnapshotId: seed.id,
    };
    await env.store.import(child);
    const view = await env.store.open(child.id);
    // Compact records received from another client are untrusted; parents matter.
    const incomplete = buildCheckpoint(args(child), {
      view,
      dependencies: [checkpointDependencyForView(view)],
    });
    const imported = await env.client.callTool({
      name: "import_research_checkpoint",
      arguments: { checkpoint: incomplete },
    });
    if (!imported.isError)
      assert.equal(
        (imported.structuredContent as any).status,
        "blocked",
        "Current application dependencies must be covered by checkpoint pins",
      );
  } finally {
    await env.close();
  }
});
test("resume refuses private checkpoint text when its selected dependency is no longer disclosable", async () => {
  const privateSeed = resultSnapshot(
    {
      result_id: "private_fixture_result",
      run_id: "private_fixture_run",
      columns: [
        {
          key: "value",
          label: "Value",
          logical_type: "VARCHAR",
          nullable: false,
        },
      ],
      rows: [{ value: "synthetic secret" }],
      row_ids: ["private_row"],
      row_count: 1,
      content_sha256: "a".repeat(64),
      data_classification: "private_local",
      evidence: [],
      source_versions: [],
      receipt: { status: "completed", finished_at: "2026-10-15T10:00:00Z" },
      next_offset: null,
    },
    {
      result_id: "private_fixture_result",
      snapshot_id: "private-checkpoint-seed",
      title: "Private synthetic fixture",
    },
  );
  delete privateSeed.dataRef;
  const env = await fixture({ initial: privateSeed, allowPrivate: false });
  try {
    const view = await env.store.open(privateSeed.id);
    const input = args(privateSeed, {
      question: "PRIVATE_CHECKPOINT_QUESTION_SENTINEL",
      query: { query: "SELECT 'PRIVATE_SQL_SENTINEL'", parameters: {} },
    });
    await env.store.saveCheckpoint(input, [checkpointDependencyForView(view)]);
    const response = await env.client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: input.checkpoint_id },
    });
    assert.equal(response.isError, true);
    assert.doesNotMatch(
      JSON.stringify(response),
      /PRIVATE_CHECKPOINT_QUESTION_SENTINEL|PRIVATE_SQL_SENTINEL/,
    );
    assert.equal(response.structuredContent, undefined);
  } finally {
    await env.close();
  }
});
test("foreign pending handles remain blocked without job inspection, materialization or dispatch", async () => {
  const calls: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      throw new Error("No engine operations permitted in this fixture");
    },
  };
  const env = await fixture({ engine });
  try {
    const view = await env.store.open(seed.id);
    const checkpoint = buildCheckpoint(
      args(seed, {
        pending: [{ kind: "job", id: randomUUID(), request_id: randomUUID() }],
      }),
      {
        view,
        dependencies: [checkpointDependencyForView(view)],
        executionContext: "another-personal-workspace",
      },
    );
    const response = await env.client.callTool({
      name: "import_research_checkpoint",
      arguments: { checkpoint },
    });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    assert.equal((response.structuredContent as any).status, "blocked");
    assert.equal(
      (response.structuredContent as any).blockers[0].code,
      "foreign_pending",
    );
    const resumed = await env.client.callTool({
      name: "resume_research_checkpoint",
      arguments: { checkpoint_id: checkpoint.id },
    });
    assert.equal(resumed.isError, undefined);
    assert.equal((resumed.structuredContent as any).status, "blocked");
    assert.deepEqual(calls, []);
  } finally {
    await env.close();
  }
});
