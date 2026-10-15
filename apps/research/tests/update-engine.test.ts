import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  PythonEngine,
  resolveResult,
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import { effectiveValue, type ResearchView } from "../src/schema.js";
import type { UpdateChange } from "../server/updates.js";

// Actual Python engine and OS-isolated SQL worker, fictional fixture provider only.
// This checks metadata, evidence, identities and continuation; it measures no live semantic quality.
test("actual fixture engine supports fresh manual claims and SQL continuation after reviewed publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-update-engine-"));
  const python = new PythonEngine(undefined, {
    ...process.env,
    SOURCESQL_DATA_DIR: join(directory, "engine"),
    SOURCESQL_PRINCIPAL: "manual-update-fixture-owner",
    SOURCESQL_ALLOW_PRIVATE: "0",
  });
  const methods: string[] = [];
  const engine: ResearchEngine = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      methods.push(method);
      return python.call<T>(method, params);
    },
  };
  const baselineSql =
    "SELECT url, SEM_EXTRACT(content, 'grid agreement status') AS grid_status FROM WEB_FETCH('https://aurora.example/project', mode := 'live')";
  let server: ReturnType<typeof createServer> | undefined;
  let client: Client | undefined;
  try {
    const baseline = await engine.call<EngineResult>("query", {
      query: baselineSql,
      profile: "fixture",
      source_mode: "require_document",
      partial_policy: "strict",
    });
    assert.equal(baseline.receipt.status, "completed");
    assert.equal(baseline.rows[0].grid_status, "proposed");
    const canonicalRow = baseline.row_ids[0];
    const seed = resultSnapshot(baseline, {
      result_id: baseline.result_id,
      snapshot_id: "fixture-baseline",
      title: "Fictional grid agreement",
    });
    const store = new ResearchStore(
      join(directory, "app"),
      seed,
      async (snapshot) => ({
        ...(await resolveResult(engine, {
          result_id: snapshot.dataRef!.resultId,
          snapshot_id: snapshot.id,
          title: snapshot.title,
        })),
        parentSnapshotId: snapshot.parentSnapshotId,
      }),
    );
    server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      {
        engine,
        access: {
          mode: "fixture-anonymous",
          principal: "manual-update-fixture-owner",
          allowPrivateDisclosure: false,
        },
      },
    );
    client = new Client({ name: "actual-update-fixture-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result;
    };
    await call("amend_observation", {
      snapshot_id: seed.id,
      row_id: canonicalRow,
      field: "grid_status",
      value: "unreviewed",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const requestId = randomUUID();
    const started = await call("check_research_updates", {
      request_id: requestId,
      snapshot_id: seed.id,
      expected_revision: 1,
      existing: { row_ids: [canonicalRow], fields: ["grid_status"] },
    });
    const request = (
      started.structuredContent as unknown as { request: { createdAt: string } }
    ).request;
    const queried = await call("sourcesql_query", {
      query:
        "SELECT url, SEM_EXTRACT(content, 'grid agreement status') AS grid_status, $row_id AS canonical_row_id FROM WEB_FETCH('https://aurora.example/project', mode := 'live')",
      request_id: randomUUID(),
      parameters: { row_id: canonicalRow },
      inputs: {
        baseline: {
          result_id: baseline.result_id,
          view: "original",
          amendment_revision: null,
        },
      },
      row_id_column: "canonical_row_id",
      profile: "fixture",
      source_mode: "require_document",
      partial_policy: "strict",
    });
    const result = queried.structuredContent as unknown as EngineResult;
    assert.deepEqual(result.row_ids, [canonicalRow]);
    assert.equal(result.rows[0].grid_status, "proposed");
    const source = result.source_versions.find(
      (source) => source.url === "https://aurora.example/project",
    )!;
    assert.ok(source);
    assert.ok(
      Date.parse(String(source.retrieved_at)) >= Date.parse(request.createdAt),
    );
    assert.equal(source.content_basis, "synthetic_fixture");
    assert.equal(
      source.content_sha256,
      createHash("sha256").update(String(source.content)).digest("hex"),
    );
    const evidence = result.evidence.find(
      (entry) => entry.row_id === canonicalRow && entry.field === "grid_status",
    )!;
    assert.ok(
      evidence,
      "The actual engine must bind direct semantic evidence to the explicit row identity",
    );
    const quote = (evidence.support as { quote: string }[])[0].quote;
    assert.ok(String(source.content).includes(quote));
    assert.equal(
      quote,
      "Grid connection is proposed; no signed agreement is reported.",
    );
    const appended = await call("append_research_updates", {
      request_id: requestId,
      existing_result_ref: {
        result_id: result.result_id,
        snapshot_id: "fixture-proposals",
        title: "Fictional grid review",
      },
      assessments: [
        {
          row_id: canonicalRow,
          field: "grid_status",
          status: "verified",
          note: "Fresh fictional source supports the proposed state; this is textual support only.",
          observed_at: source.retrieved_at,
          source_version_ids: [source.source_version_id],
        },
      ],
      discovery_observations: [],
    });
    const update = appended.structuredContent as unknown as {
      changes: UpdateChange[];
      proposal_snapshot_id: string;
    };
    assert.equal(update.changes.length, 1);
    assert.equal(update.changes[0].kind, "changed_claim");
    assert.equal(update.changes[0].previous, "unreviewed");
    assert.equal(update.changes[0].proposed, "proposed");
    assert.equal(update.changes[0].evidence[0].quote, quote);
    const proposals = (
      await call("open_research", { snapshot_id: update.proposal_snapshot_id })
    ).structuredContent as unknown as ResearchView;
    assert.equal(proposals.update?.changes[0].canAccept, true);
    const queryCount = methods.filter((method) =>
      ["query", "import_table"].includes(method),
    ).length;
    await call("review_research_update", {
      request_id: requestId,
      change_id: update.changes[0].id,
      decision: "accept",
      expected_revision: 1,
      mutation_id: randomUUID(),
    });
    await call("publish_research_update", {
      request_id: requestId,
      snapshot_id: "fixture-accepted",
      expected_revision: 1,
      mutation_id: randomUUID(),
    });
    assert.equal(
      methods.filter((method) => ["query", "import_table"].includes(method))
        .length,
      queryCount,
    );
    const original = await store.open(seed.id);
    assert.equal(original.snapshot.rows[0].values.grid_status, "proposed");
    assert.equal(
      effectiveValue(original, original.snapshot.rows[0], "grid_status"),
      "unreviewed",
    );
    const accepted = (
      await call("open_research", { snapshot_id: "fixture-accepted" })
    ).structuredContent as unknown as ResearchView;
    assert.equal(accepted.snapshot.rows[0].values.grid_status, "proposed");
    const materialized = await call("sourcesql_materialize_research", {
      snapshot_id: accepted.snapshot.id,
      expected_revision: 0,
    });
    const materialization = materialized.structuredContent as Record<
      string,
      unknown
    >;
    const materializedId = String(
      materialization.result_id ??
        (materialization.result_ref as { result_id?: string } | undefined)
          ?.result_id ??
        "",
    );
    assert.ok(
      materializedId,
      "Explicit materialization must return an engine result identity",
    );
    const recoveredMaterialization = await call(
      "sourcesql_materialize_research",
      { snapshot_id: accepted.snapshot.id, expected_revision: 0 },
    );
    assert.equal(
      (recoveredMaterialization.structuredContent as Record<string, unknown>)
        .result_id,
      materializedId,
      "Repeating the same accepted revision must recover the same deterministic engine result",
    );
    const continued = await call("sourcesql_query", {
      query:
        "SELECT url, grid_status FROM input.accepted WHERE grid_status = $status",
      parameters: { status: "proposed" },
      inputs: {
        accepted: {
          result_id: materializedId,
          view: "original",
          amendment_revision: null,
        },
      },
      profile: "fixture",
      request_id: randomUUID(),
    });
    const continuedResult =
      continued.structuredContent as unknown as EngineResult;
    assert.deepEqual(continuedResult.rows, [
      { url: "https://aurora.example/project", grid_status: "proposed" },
    ]);
    assert.equal(
      (continuedResult.receipt.provider_events as unknown[]).length,
      0,
    );
    assert.ok(
      result.source_versions.every((source) => source.provider === "fixture"),
    );
  } finally {
    if (client) await client.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
