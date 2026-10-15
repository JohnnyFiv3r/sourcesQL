import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import type { UpdateEvidenceContext } from "../server/updates.js";
import { snapshotSchema, type Snapshot } from "../src/schema.js";

function snapshot(
  id: string,
  capacity = 100,
  classification: Snapshot["dataClassification"] = "public_web",
): Snapshot {
  return snapshotSchema.parse({
    schemaVersion: 2,
    id,
    title: id,
    origin: {
      engine: "sourcesql",
      resultId: `result_${id}`,
      runId: `run_${id}`,
    },
    capturedAt: "2026-10-15T10:00:00Z",
    captureBasis: "run_completed_at",
    capturePrecision: "instant",
    dataClassification: classification,
    rowCount: 1,
    coverage: { planComplete: true, corpusComplete: "unknown", notes: [] },
    columns: [
      {
        key: "issuer",
        label: "Organization",
        logicalType: "VARCHAR",
        nullable: false,
      },
      {
        key: "capacity",
        label: "Capacity",
        logicalType: "INTEGER",
        nullable: false,
      },
    ],
    rows: [
      {
        id: "row_a",
        values: { issuer: "Synthetic organization", capacity },
        sourceUrl: "https://example.com/fixture",
        evidenceRefs: [],
        evidence: {},
        verificationNote: "Synthetic security fixture",
      },
    ],
  });
}
async function fixture(allowPrivate = true, engine?: ResearchEngine) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-update-security-"));
  const initial = snapshot("target_seed"),
    store = new ResearchStore(join(directory, "app"), initial);
  const html = join(directory, "research.html");
  await writeFile(html, "<html>Synthetic update security fixture</html>");
  const server = createServer(store, html, {
    engine,
    access: {
      mode: "protected",
      principal: "synthetic-owner",
      allowPrivateDisclosure: allowPrivate,
    },
  });
  const client = new Client({ name: "update-security", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    directory,
    initial,
    store,
    client,
    async close() {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function saveInlineCompletedUpdate(
  store: ResearchStore,
  privateProposal = false,
) {
  const baseline = snapshot("inline_bundle_baseline");
  await store.import(baseline);
  const request = await store.beginUpdate({
    request_id: randomUUID(),
    snapshot_id: baseline.id,
    expected_revision: 0,
    existing: { row_ids: ["row_a"], fields: ["capacity"] },
  });
  const observed = new Date(Date.parse(request.createdAt) + 1000).toISOString(),
    completed = new Date(Date.parse(request.createdAt) + 2000).toISOString();
  const proposal = snapshot(
    "inline_bundle_proposal",
    200,
    privateProposal ? "private_local" : "public_web",
  );
  proposal.capturedAt = completed;
  const quote = privateProposal
    ? "PRIVATE_UPDATE_SENTINEL: Synthetic organization capacity is 200 MW."
    : "Synthetic organization capacity is 200 MW.";
  proposal.rows[0].evidence = { capacity: [quote] };
  const context: UpdateEvidenceContext = {
    result_id: proposal.origin!.resultId,
    completed_at: completed,
    source_versions: [
      {
        source_version_id: "src_inline",
        content: quote,
        content_sha256: createHash("sha256").update(quote).digest("hex"),
        retrieved_at: observed,
        url: "https://example.com/current",
        content_basis: "document",
      },
    ],
    evidence: [
      {
        evidence_id: "e_inline",
        row_id: "row_a",
        field: "capacity",
        source_version_id: "src_inline",
        support: [{ quote }],
      },
    ],
  };
  await store.completeUpdate(
    {
      request_id: request.id,
      existing_snapshot: proposal,
      assessments: [
        {
          row_id: "row_a",
          field: "capacity",
          status: "verified",
          note: "Synthetic source says 200 MW",
          observed_at: observed,
          source_version_ids: ["src_inline"],
        },
      ],
      discovery_observations: [],
    },
    { [proposal.id]: context },
  );
  return { baseline, request, proposal };
}

test("public MCP bundle import refuses inline completed proposals with caller-supplied canonical source contexts", async () => {
  const source = await fixture();
  const calls: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      throw new Error(
        "No canonical engine result exists for forged inline proposals",
      );
    },
  };
  const target = await fixture(true, engine);
  try {
    const { baseline } = await saveInlineCompletedUpdate(source.store);
    const bundle = await source.store.exportBundle(baseline.id);
    assert.equal(
      bundle.state.updates?.[0].completion?.existing_snapshot?.dataRef,
      undefined,
    );
    const response = await target.client.callTool({
      name: "import_research_bundle",
      arguments: { bundle },
    });
    assert.equal(
      response.isError,
      true,
      "Inline update source contexts must not bypass canonical result resolution",
    );
    assert.deepEqual(
      calls,
      [],
      "Reject before any engine materialization or dispatch",
    );
    await assert.rejects(target.store.open(baseline.id), /not found/i);
  } finally {
    await source.close();
    await target.close();
  }
});

test("manual update reads reauthorize private proposal dependencies before disclosing change text", async () => {
  const env = await fixture(false);
  try {
    const { baseline, request } = await saveInlineCompletedUpdate(
      env.store,
      true,
    );
    assert.equal(
      (await env.store.open(baseline.id)).dataClassification,
      "public_web",
    );
    const response = await env.client.callTool({
      name: "get_research_update",
      arguments: { request_id: request.id },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_UPDATE_SENTINEL/);
  } finally {
    await env.close();
  }
});
