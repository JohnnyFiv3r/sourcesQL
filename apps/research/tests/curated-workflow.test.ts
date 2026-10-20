import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  PythonEngine,
  resolveResult,
  resultSnapshot,
  type EngineResult,
} from "../server/engine.js";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchView } from "../src/schema.js";

test("actual MCP/Python curation keeps a quotation through correction and effective SQL reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-cited-workflow-"));
  const engine = new PythonEngine(undefined, {
    ...process.env,
    SOURCESQL_DATA_DIR: join(directory, "engine"),
    SOURCESQL_PRINCIPAL: "curation-fixture-owner",
    SOURCESQL_ALLOW_PRIVATE: "0",
  });
  const acquired = await engine.call<EngineResult>("query", {
    query: "SELECT content FROM WEB_FETCH('https://aurora.example/project')",
    profile: "fixture",
  });
  const seed = resultSnapshot(acquired, {
    result_id: acquired.result_id,
    snapshot_id: "cited-source",
    title: "Synthetic acquired evidence",
  });
  const store = new ResearchStore(join(directory, "app"), seed, (snapshot) =>
    resolveResult(engine, {
      result_id: snapshot.dataRef!.resultId,
      snapshot_id: snapshot.id,
      title: snapshot.title,
    }),
  );
  const server = createServer(
    store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    {
      engine,
      access: {
        mode: "fixture-anonymous",
        principal: "curation-fixture-owner",
        allowPrivateDisclosure: false,
      },
      responseByteLimit: 4 * 1024 * 1024,
    },
  );
  const client = new Client({ name: "actual-cited-workflow", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.structuredContent as Record<string, unknown>;
    };
    const source = acquired.source_versions[0];
    const quoted = await call("sourcesql_query", {
      request_id: randomUUID(),
      profile: "fixture",
      query:
        "SELECT 'Aurora' AS product, CAST(500 AS BIGINT) AS capacity, 'Unreviewed' AS status FROM input.evidence LIMIT 1",
      inputs: {
        evidence: {
          result_id: acquired.result_id,
          view: "original",
          amendment_revision: null,
        },
      },
      citations: [
        {
          match: { product: "Aurora" },
          column_key: "capacity",
          source_version_id: source.source_version_id,
          quote: source.content,
        },
      ],
    });
    assert.deepEqual((quoted.receipt as Record<string, unknown>).counts, {});
    assert.equal(
      (quoted.citation_feedback as Record<string, unknown>).attached_citations,
      1,
    );
    const opened = (await call("open_research", {
      result_ref: {
        result_id: quoted.result_id,
        snapshot_id: "cited-landscape",
        title: "Synthetic cited landscape",
      },
    })) as unknown as ResearchView;
    assert.equal(opened.snapshot.rows[0].values.capacity, "500");
    assert.ok(opened.snapshot.rows[0].cellSources?.capacity?.length);
    const rowId = opened.snapshot.rows[0].id;
    await call("amend_observation", {
      snapshot_id: opened.snapshot.id,
      row_id: rowId,
      field: "status",
      value: "Shortlist",
      reason: "User evaluation decision",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const shortlisted = await call("sourcesql_query", {
      request_id: randomUUID(),
      profile: "fixture",
      query:
        "SELECT product, capacity, status FROM input.saved WHERE status='Shortlist'",
      inputs: {
        saved: {
          result_id: quoted.result_id,
          view: "effective",
          amendment_revision: 1,
        },
      },
    });
    const evidence = await call("sourcesql_inspect_evidence", {
      result_id: shortlisted.result_id,
    });
    const records = evidence.evidence as Record<string, unknown>[];
    assert.ok(
      records.some(
        (record) => record.column_key === "capacity" && record.row_id,
      ),
    );
    assert.ok(
      !records.some(
        (record) => record.column_key === "status" && record.row_id,
      ),
    );
    assert.deepEqual(
      (shortlisted.receipt as Record<string, unknown>).counts,
      {},
    );
    const reopened = (await call("research_status", {
      snapshot_id: opened.snapshot.id,
    })) as unknown as ResearchView;
    assert.equal(reopened.snapshot.rows[0].values.status, "Unreviewed");
    assert.equal(reopened.amendments[0].value, "Shortlist");
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
