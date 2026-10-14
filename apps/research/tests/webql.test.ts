import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  snapshotSchema,
  originForSnapshot,
  captureForSnapshot,
  effectiveValue,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";
import { correctionKind } from "../src/corrections.js";
import {
  PythonEngine,
  resolveResult,
  resultSnapshot,
  type ResearchEngine,
  type EngineResult,
} from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import { authorizeSnapshot, bearerMatches } from "../server/access.js";
import sample from "../fixtures/water-procurement.json";
const seed = snapshotSchema.parse(sample);
const result = (count = 205): EngineResult => ({
  result_id: "wq_fixture",
  run_id: "run_fixture",
  columns: [
    { key: "value", label: "Value", logical_type: "BIGINT", nullable: true },
  ],
  rows: Array.from({ length: count }, (_, i) => ({ value: String(i) })),
  row_ids: Array.from({ length: count }, (_, i) => `row_${i}`),
  row_count: count,
  content_sha256: "a".repeat(64),
  data_classification: "synthetic_fixture",
  evidence: [],
  source_versions: [],
  receipt: { status: "completed", finished_at: "2026-10-14T01:02:03Z" },
  next_offset: null,
});
class FixtureEngine implements ResearchEngine {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  constructor(public fixture = result()) {}
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "read_result") {
      const offset = Number(params.offset ?? 0),
        limit = Number(params.limit ?? 100);
      return {
        ...this.fixture,
        rows: this.fixture.rows.slice(offset, offset + limit),
        row_ids: this.fixture.row_ids.slice(offset, offset + limit),
        next_offset:
          offset + limit < this.fixture.row_count ? offset + limit : null,
      } as T;
    }
    if (method === "import_table")
      return { ...this.fixture, result_id: "wq_effective" } as T;
    if (method === "query")
      return {
        result_id: this.fixture.result_id,
        run_id: this.fixture.run_id,
        status: "completed",
      } as T;
    if (method === "export")
      return {
        manifest: { result_id: this.fixture.result_id },
        rows: this.fixture.rows,
      } as T;
    return {
      grammar: "fixture",
      profiles: [{ name: "fixture", mode: "fixture" }],
    } as T;
  }
}
function snapshot(fixture = result(1)): Snapshot {
  return resultSnapshot(fixture, {
    result_id: fixture.result_id,
    snapshot_id: "webql_snapshot",
    title: "Typed fixture",
  });
}
test("v1 payload stays exact with tagged legacy origin and declared day precision", () => {
  const parsed = snapshotSchema.parse(sample);
  assert.deepEqual(parsed, sample);
  assert.deepEqual(originForSnapshot(parsed), {
    engine: "legacy-import",
    resultId: sample.sourceResultSetId,
    runId: null,
  });
  assert.deepEqual(captureForSnapshot(parsed), {
    precision: "day",
    basis: "imported_declared_time",
  });
});
test("v2 retains typed nulls, lossless numbers, nested values and nullable multiple sources", () => {
  const s = snapshot();
  s.columns = [
    { key: "value", label: "Value", logicalType: "BIGINT", nullable: true },
    {
      key: "decimal",
      label: "Decimal",
      logicalType: "DECIMAL(18,2)",
      nullable: false,
    },
    {
      key: "nested",
      label: "Nested",
      logicalType: "STRUCT(name VARCHAR, scores DOUBLE[])[]",
      nullable: false,
    },
    {
      key: "when",
      label: "When",
      logicalType: "TIMESTAMP WITH TIME ZONE",
      nullable: true,
    },
  ];
  s.rows[0].values = {
    value: "9007199254740993",
    decimal: "1234567890123456.78",
    nested: [{ name: "λ", scores: [1.2, null] }],
    when: null,
  };
  s.rows[0].sources = [
    { url: "https://example.com/a" },
    { url: "https://example.com/b" },
  ];
  assert.equal(snapshotSchema.safeParse(s).success, true);
  for (const invalid of [
    { ...s, capturedAt: "2026-02-30T01:00:00Z" },
    { ...s, capturePrecision: "day" },
    { ...s, dataRef: { ...s.dataRef, resultId: "wrong" } },
    {
      ...s,
      rows: [
        {
          ...s.rows[0],
          values: { ...s.rows[0].values, value: 9007199254740993 },
        },
      ],
    },
    {
      ...s,
      columns: [
        { ...s.columns[0], logicalType: "UNKNOWN" },
        ...s.columns.slice(1),
      ],
    },
  ])
    assert.equal(snapshotSchema.safeParse(invalid).success, false);
});
test("declared all-null columns drive scalar correction types and structured cells remain read-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-types-"));
  try {
    const s = snapshot();
    delete s.dataRef;
    s.rows[0].values.value = null;
    const store = new ResearchStore(dir, seed);
    let view = await store.import(s);
    assert.equal(
      correctionKind(view, view.snapshot.rows[0], "value"),
      "integer_string",
    );
    await assert.rejects(
      store.amend({
        snapshot_id: s.id,
        row_id: s.rows[0].id,
        field: "value",
        value: 2,
        expected_revision: 0,
        mutation_id: randomUUID(),
      }),
      /integer string/,
    );
    view = await store.amend({
      snapshot_id: s.id,
      row_id: s.rows[0].id,
      field: "value",
      value: "9007199254740993",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    assert.equal(
      effectiveValue(view, view.snapshot.rows[0], "value"),
      "9007199254740993",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("full result survives >100 preview, row lookup, effective query pin and full export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-lifecycle-"));
  const engine = new FixtureEngine();
  const resolver = (s: Snapshot) =>
    resolveResult(engine, {
      result_id: s.dataRef!.resultId,
      snapshot_id: s.id,
      title: s.title,
    });
  const store = new ResearchStore(dir, seed, resolver);
  const server = createServer(
    store,
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    { engine },
  );
  const client = new Client({ name: "headless-webql-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const opened = await client.callTool({
      name: "open_research",
      arguments: {
        result_ref: {
          result_id: "wq_fixture",
          snapshot_id: "full",
          title: "205 synthetic rows",
        },
      },
    });
    const view = opened.structuredContent as ResearchView;
    assert.equal(view.snapshot.rows.length, 100);
    assert.equal(view.preview!.total, 205);
    assert.equal(view.snapshot.origin!.engine, "open-webql");
    assert.equal(
      (await store.findRows({ snapshot_id: "full", match: { value: "204" } }))
        .matches[0].row_id,
      "row_204",
    );
    const last = await client.callTool({
      name: "research_page",
      arguments: { snapshot_id: "full", offset: 200 },
    });
    assert.equal(
      (last.structuredContent as ResearchView).snapshot.rows.length,
      5,
    );
    await store.amend({
      snapshot_id: "full",
      row_id: "row_204",
      field: "value",
      value: "999",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const query = await client.callTool({
      name: "webql_query",
      arguments: {
        query: "SELECT * FROM input.t",
        request_id: randomUUID(),
        inputs: {
          t: {
            result_id: "wq_fixture",
            view: "effective",
            amendment_revision: 1,
          },
        },
      },
    });
    assert.equal(query.isError, undefined);
    const materialization = engine.calls.find(
      (c) => c.method === "import_table",
    )!;
    assert.equal(
      (materialization.params.rows as Record<string, unknown>[])[204].value,
      "999",
    );
    assert.equal(
      (materialization.params.provenance as Record<string, unknown>)
        .amendment_revision,
      1,
    );
    const stale = await client.callTool({
      name: "webql_query",
      arguments: {
        query: "SELECT * FROM input.t",
        inputs: {
          t: {
            result_id: "wq_fixture",
            view: "effective",
            amendment_revision: 0,
          },
        },
      },
    });
    assert.equal(stale.isError, true);
    const exported = await client.callTool({
      name: "export_research",
      arguments: { snapshot_id: "full" },
    });
    const bundle = exported.structuredContent as {
      state: { snapshots: Snapshot[]; amendments: unknown[] };
    };
    assert.equal(
      bundle.state.snapshots.find((s) => s.id === "full")!.rows.length,
      205,
    );
    assert.equal(bundle.state.amendments.length, 1);
    const restoreDir = await mkdtemp(join(tmpdir(), "webql-restored-"));
    try {
      const restored = await new ResearchStore(
        restoreDir,
        seed,
        resolver,
      ).importBundle(bundle);
      assert.equal(restored.revision, 1);
      assert.equal(
        effectiveValue(restored, restored.snapshot.rows[204], "value"),
        "999",
      );
    } finally {
      await rm(restoreDir, { recursive: true, force: true });
    }
    const reopened = await new ResearchStore(dir, seed, resolver).open("full");
    assert.equal(reopened.snapshot.rows.length, 205);
    assert.equal(reopened.revision, 1);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("protected bearer and fixture/private disclosure policies remain separate", () => {
  assert.equal(bearerMatches("Bearer secret", "secret"), true);
  assert.equal(bearerMatches("Bearer other", "secret"), false);
  const s = snapshot();
  s.dataClassification = "private_derived";
  assert.throws(
    () =>
      authorizeSnapshot(s, {
        mode: "fixture-anonymous",
        principal: "fixture",
        allowPrivateDisclosure: false,
      }),
    /Private host disclosure/,
  );
  assert.throws(
    () =>
      authorizeSnapshot(s, {
        mode: "fixture-anonymous",
        principal: "fixture",
        allowPrivateDisclosure: true,
      }),
    /synthetic fixture/,
  );
  authorizeSnapshot(s, {
    mode: "protected",
    principal: "owner",
    allowPrivateDisclosure: true,
  });
});
test("JSON-lines bridge returns bounded capabilities and safe admission errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-python-"));
  try {
    const engine = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: dir,
      WEBQL_PRINCIPAL: "app-test",
    });
    const capabilities = await engine.call("capabilities");
    assert.equal(typeof capabilities, "object");
    await assert.rejects(
      engine.call("query", {
        query: "DELETE FROM x",
        profile: "fixture",
        inputs: {},
      }),
      /admission|query|read.only|invalid|SELECT/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual engine bridge completes 205-row SQL and app reference lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-actual-lifecycle-"));
  try {
    const engine = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: join(dir, "engine"),
      WEBQL_PRINCIPAL: "actual-app-test",
      WEBQL_ALLOW_PRIVATE: "0",
    });
    const imported = await engine.call<EngineResult>("import_table", {
      columns: [
        {
          key: "value",
          label: "Value",
          logical_type: "BIGINT",
          nullable: false,
        },
      ],
      rows: Array.from({ length: 205 }, (_, i) => ({ value: String(i) })),
      row_ids: Array.from({ length: 205 }, (_, i) => `row_${i}`),
      data_classification: "synthetic_fixture",
    });
    const queried = await engine.call<EngineResult>("query", {
      query: "SELECT value FROM input.t ORDER BY value",
      inputs: {
        t: {
          result_id: imported.result_id,
          view: "original",
          amendment_revision: null,
        },
      },
      profile: "fixture",
      request_id: randomUUID(),
    });
    const resolved = await resolveResult(engine, {
      result_id: queried.result_id,
      snapshot_id: "actual-result",
      title: "Actual engine result",
    });
    assert.equal(resolved.rows.length, 205);
    assert.equal(resolved.rows[204].values.value, "204");
    const resolver = (s: Snapshot) =>
      resolveResult(engine, {
        result_id: s.dataRef!.resultId,
        snapshot_id: s.id,
        title: s.title,
      });
    const store = new ResearchStore(join(dir, "app"), seed, resolver);
    const server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      {
        engine,
        access: {
          mode: "protected",
          principal: "actual-app-test",
          allowPrivateDisclosure: false,
        },
      },
    );
    const client = new Client({ name: "actual-app-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const opened = await client.callTool({
        name: "open_research",
        arguments: {
          result_ref: {
            result_id: queried.result_id,
            snapshot_id: "actual-result",
            title: "Actual engine result",
          },
        },
      });
      assert.equal(opened.isError, undefined);
      const view = opened.structuredContent as ResearchView;
      assert.equal(view.preview!.total, 205);
      assert.equal(view.snapshot.rows.length, 100);
      const last = await client.callTool({
        name: "research_page",
        arguments: { snapshot_id: "actual-result", offset: 200 },
      });
      assert.equal(
        (last.structuredContent as ResearchView).snapshot.rows.length,
        5,
      );
      await store.amend({
        snapshot_id: "actual-result",
        row_id: resolved.rows[204].id,
        field: "value",
        value: "999",
        expected_revision: 0,
        mutation_id: randomUUID(),
      });
      const effective = await client.callTool({
        name: "webql_query",
        arguments: {
          query: "SELECT MAX(value) AS value FROM input.t",
          inputs: {
            t: {
              result_id: queried.result_id,
              view: "effective",
              amendment_revision: 1,
            },
          },
          request_id: randomUUID(),
        },
      });
      assert.equal(effective.isError, undefined);
      assert.equal(
        (effective.structuredContent as unknown as EngineResult).rows[0].value,
        "999",
      );
      const bundle = await client.callTool({
        name: "export_research",
        arguments: { snapshot_id: "actual-result" },
      });
      assert.equal(bundle.isError, undefined);
      assert.equal(
        (
          bundle.structuredContent as { state: { snapshots: Snapshot[] } }
        ).state.snapshots.find((s) => s.id === "actual-result")!.rows.length,
        205,
      );
      const reopened = await new ResearchStore(
        join(dir, "app"),
        seed,
        resolver,
      ).open("actual-result");
      assert.equal(reopened.revision, 1);
      assert.equal(reopened.snapshot.rows.length, 205);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v2 tracked expansion and refresh preserve request binding, review races and late-result refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-v2-requests-"));
  try {
    const store = new ResearchStore(dir, seed);
    const parent = snapshot();
    delete parent.dataRef;
    await store.import(parent);
    const expansion = {
      request_id: randomUUID(),
      snapshot_id: parent.id,
      row_id: parent.rows[0].id,
      question: "Expand synthetic evidence",
    };
    await store.beginResearch(expansion, "expand");
    const child = {
      ...parent,
      id: "expanded",
      origin: { ...parent.origin!, resultId: "wq_child", runId: "run_child" },
    };
    const saved = await store.appendResearch({
      request_id: expansion.request_id,
      snapshot: child,
    });
    assert.equal(saved.snapshot.parentSnapshotId, parent.id);
    assert.equal(
      (
        await store.appendResearch({
          request_id: expansion.request_id,
          snapshot: child,
        })
      ).snapshot.id,
      child.id,
    );
    const cancelled = { ...expansion, request_id: randomUUID() };
    await store.beginResearch(cancelled, "expand");
    await store.finishResearch(
      cancelled.request_id,
      "cancelled",
      "User cancelled",
    );
    await assert.rejects(
      store.appendResearch({
        request_id: cancelled.request_id,
        snapshot: { ...child, id: "too-late" },
      }),
      /closed/,
    );
    const refresh = { ...expansion, request_id: randomUUID(), field: "value" };
    await store.beginResearch(refresh, "refresh");
    const proposal = {
      ...parent,
      id: "refreshed",
      origin: { ...parent.origin!, resultId: "wq_fresh", runId: "run_fresh" },
      rows: [
        {
          ...parent.rows[0],
          values: { value: "2" },
          evidence: { value: ["Synthetic value is 2."] },
        },
      ],
    };
    await store.appendResearch({
      request_id: refresh.request_id,
      snapshot: proposal,
      assessments: [
        {
          row_id: parent.rows[0].id,
          field: "value",
          status: "verified",
          note: "Synthetic textual support",
        },
      ],
    });
    assert.equal((await store.open(parent.id)).revision, 0);
    await store.amend({
      snapshot_id: parent.id,
      row_id: parent.rows[0].id,
      field: "value",
      value: "3",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    await assert.rejects(
      store.reviewRefresh({
        request_id: refresh.request_id,
        row_id: parent.rows[0].id,
        field: "value",
        decision: "accept",
        expected_revision: 0,
      }),
      /changed|Reload|revision/i,
    );
    assert.equal(
      (await store.open(proposal.id)).refresh!.changes[0].status,
      "conflicting",
    );
    assert.equal(
      (await new ResearchStore(dir, seed).open(child.id)).snapshot
        .parentSnapshotId,
      parent.id,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual bridge separates principals and refuses private imports, reads, exports and host disclosure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-bridge-private-"));
  try {
    const owner = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: dir,
      WEBQL_PRINCIPAL: "private-test-owner",
      WEBQL_ALLOW_PRIVATE: "1",
    });
    const privateResult = await owner.call<EngineResult>("import_table", {
      columns: [{ key: "value", logical_type: "VARCHAR", nullable: false }],
      rows: [{ value: "fixture_secret_only" }],
      row_ids: ["private_fixture_row"],
      data_classification: "private_local",
    });
    const anonymous = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: dir,
      WEBQL_PRINCIPAL: "fixture-anonymous",
      WEBQL_ALLOW_PRIVATE: "0",
    });
    const restricted = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: dir,
      WEBQL_PRINCIPAL: "private-test-owner",
      WEBQL_ALLOW_PRIVATE: "0",
    });
    await assert.rejects(
      anonymous.call("read_result", { result_id: privateResult.result_id }),
      /unauthorized/,
    );
    await assert.rejects(
      anonymous.call("import_table", {
        columns: [{ key: "value", logical_type: "VARCHAR", nullable: false }],
        rows: [{ value: "fixture_secret_only" }],
        data_classification: "private_local",
      }),
      /unauthorized/,
    );
    await assert.rejects(
      restricted.call("read_result", { result_id: privateResult.result_id }),
      /unauthorized/,
    );
    await assert.rejects(
      restricted.call("export", { result_id: privateResult.result_id }),
      /unauthorized/,
    );
    const store = new ResearchStore(join(dir, "app"), seed, (s) =>
      resolveResult(owner, {
        result_id: s.dataRef!.resultId,
        snapshot_id: s.id,
        title: s.title,
      }),
    );
    const server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      {
        engine: owner,
        access: {
          mode: "protected",
          principal: "private-test-owner",
          allowPrivateDisclosure: false,
        },
      },
    );
    const client = new Client({ name: "no-private-disclosure", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const privateSnapshot = await resolveResult(owner, {
        result_id: privateResult.result_id,
        snapshot_id: "stored-private",
        title: "fixture_secret_title",
      });
      await store.import(privateSnapshot);
      await store.beginResearch(
        {
          request_id: randomUUID(),
          snapshot_id: privateSnapshot.id,
          row_id: privateSnapshot.rows[0].id,
          question: "fixture_secret_question",
        },
        "expand",
      );
      const publicView = await client.callTool({
        name: "open_research",
        arguments: { snapshot_id: seed.id },
      });
      assert.equal(publicView.isError, undefined);
      assert.equal(
        JSON.stringify(publicView).includes("fixture_secret"),
        false,
      );
      const lookup = await client.callTool({
        name: "find_research_row",
        arguments: { query: "fixture_secret" },
      });
      assert.equal(lookup.isError, undefined);
      assert.equal(
        (lookup.structuredContent as { total_matches: number }).total_matches,
        0,
      );
      const publicExport = await client.callTool({
        name: "export_research",
        arguments: { snapshot_id: seed.id },
      });
      assert.equal(publicExport.isError, undefined);
      assert.equal(
        JSON.stringify(publicExport).includes("fixture_secret"),
        false,
      );
      for (const call of [
        {
          name: "open_research",
          arguments: {
            result_ref: {
              result_id: privateResult.result_id,
              snapshot_id: "private",
              title: "Private fixture",
            },
          },
        },
        {
          name: "webql_read_result",
          arguments: { result_id: privateResult.result_id },
        },
      ]) {
        const refused = await client.callTool(call);
        assert.equal(refused.isError, true);
        assert.equal(
          JSON.stringify(refused).includes("fixture_secret_only"),
          false,
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual engine bundle remaps foreign results and restores full app corrections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-bundle-remap-"));
  const connect = async (engine: ResearchEngine, store: ResearchStore) => {
    const server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      { engine },
    );
    const client = new Client({ name: "bundle-remap-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    return { server, client };
  };
  try {
    const origin = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: join(dir, "origin-engine"),
      WEBQL_PRINCIPAL: "bundle-owner",
      WEBQL_ALLOW_PRIVATE: "0",
    });
    const imported = await origin.call<EngineResult>("import_table", {
      columns: [{ key: "value", logical_type: "BIGINT", nullable: false }],
      rows: Array.from({ length: 205 }, (_, i) => ({ value: String(i) })),
      row_ids: Array.from({ length: 205 }, (_, i) => `row_${i}`),
      data_classification: "synthetic_fixture",
    });
    const sourceStore = new ResearchStore(join(dir, "origin-app"), seed, (s) =>
      resolveResult(origin, {
        result_id: s.dataRef!.resultId,
        snapshot_id: s.id,
        title: s.title,
      }),
    );
    const first = await connect(origin, sourceStore);
    let bundle: Record<string, unknown>;
    try {
      const opened = await first.client.callTool({
        name: "open_research",
        arguments: {
          result_ref: {
            result_id: imported.result_id,
            snapshot_id: "bundle-root",
            title: "Bundle synthetic fixture",
          },
        },
      });
      assert.equal(opened.isError, undefined);
      await sourceStore.amend({
        snapshot_id: "bundle-root",
        row_id: "row_204",
        field: "value",
        value: "999",
        expected_revision: 0,
        mutation_id: randomUUID(),
      });
      const exported = await first.client.callTool({
        name: "export_research",
        arguments: { snapshot_id: "bundle-root" },
      });
      assert.equal(exported.isError, undefined);
      bundle = exported.structuredContent as Record<string, unknown>;
    } finally {
      await first.client.close();
      await first.server.close();
    }
    const target = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: join(dir, "target-engine"),
      WEBQL_PRINCIPAL: "bundle-owner",
      WEBQL_ALLOW_PRIVATE: "0",
    });
    const targetStore = new ResearchStore(join(dir, "target-app"), seed, (s) =>
      resolveResult(target, {
        result_id: s.dataRef!.resultId,
        snapshot_id: s.id,
        title: s.title,
      }),
    );
    const second = await connect(target, targetStore);
    try {
      const restored = await second.client.callTool({
        name: "import_research_bundle",
        arguments: { bundle },
      });
      assert.equal(
        restored.isError,
        undefined,
        JSON.stringify(restored.content),
      );
      const view = restored.structuredContent as ResearchView;
      assert.equal(view.revision, 1);
      assert.equal(view.preview!.total, 205);
      assert.notEqual(view.snapshot.origin!.resultId, imported.result_id);
      const full = await targetStore.open("bundle-root");
      assert.equal(full.snapshot.rows.length, 205);
      assert.equal(
        effectiveValue(full, full.snapshot.rows[204], "value"),
        "999",
      );
      const retry = await second.client.callTool({
        name: "import_research_bundle",
        arguments: { bundle },
      });
      assert.equal(retry.isError, undefined, JSON.stringify(retry.content));
      assert.equal((retry.structuredContent as ResearchView).revision, 1);
    } finally {
      await second.client.close();
      await second.server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protected profile forwarding preserves engine policy while anonymous mode refuses live profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-profile-forward-"));
  try {
    for (const mode of ["protected", "fixture-anonymous"] as const) {
      const engine = new FixtureEngine(result(1));
      const server = createServer(
        new ResearchStore(join(dir, mode), seed),
        fileURLToPath(new URL("../dist/research.html", import.meta.url)),
        {
          engine,
          access: { mode, principal: mode, allowPrivateDisclosure: false },
        },
      );
      const client = new Client({ name: "profile-forward-test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(a);
        await client.connect(b);
        const response = await client.callTool({
          name: "webql_query",
          arguments: {
            query: "SELECT 1 AS value",
            profile: "configured_live",
            partial_policy: "retain_partial",
            source_mode: "allow_excerpt",
            row_id_column: "research_row_id",
          },
        });
        if (mode === "protected") {
          assert.equal(response.isError, undefined);
          const call = engine.calls.find((c) => c.method === "query")!;
          assert.equal(call.params.profile, "configured_live");
          assert.equal(call.params.partial_policy, "retain_partial");
          assert.equal(call.params.source_mode, "allow_excerpt");
          assert.equal(call.params.row_id_column, "research_row_id");
        } else {
          assert.equal(response.isError, true);
          assert.equal(
            engine.calls.some((c) => c.method === "query"),
            false,
          );
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("actual refresh query preserves explicit scoped row identity through result_ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webql-explicit-refresh-"));
  try {
    const engine = new PythonEngine(undefined, {
      ...process.env,
      WEBQL_DATA_DIR: join(dir, "engine"),
      WEBQL_PRINCIPAL: "refresh-owner",
      WEBQL_ALLOW_PRIVATE: "0",
    });
    const imported = await engine.call<EngineResult>("import_table", {
      columns: [{ key: "value", logical_type: "BIGINT", nullable: true }],
      rows: [{ value: "1" }, { value: "2" }],
      row_ids: ["refresh_row_one", "refresh_row_two"],
      data_classification: "synthetic_fixture",
    });
    const store = new ResearchStore(join(dir, "app"), seed, (s) =>
      resolveResult(engine, {
        result_id: s.dataRef!.resultId,
        snapshot_id: s.id,
        title: s.title,
      }),
    );
    const server = createServer(
      store,
      fileURLToPath(new URL("../dist/research.html", import.meta.url)),
      { engine },
    );
    const client = new Client({ name: "explicit-refresh-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const opened = await client.callTool({
        name: "open_research",
        arguments: {
          result_ref: {
            result_id: imported.result_id,
            snapshot_id: "refresh-parent",
            title: "Synthetic scoped refresh",
          },
        },
      });
      assert.equal(opened.isError, undefined);
      const request_id = randomUUID();
      const start = await client.callTool({
        name: "refresh_research",
        arguments: {
          request_id,
          snapshot_id: "refresh-parent",
          row_id: "refresh_row_one",
          field: "value",
        },
      });
      assert.equal(start.isError, undefined);
      const context = await client.callTool({
        name: "get_research_request",
        arguments: { request_id },
      });
      assert.ok(JSON.stringify(context).includes("row_id_column"));
      const queried = await client.callTool({
        name: "webql_query",
        arguments: {
          query:
            "SELECT value, $row_id AS research_row_id FROM input.t WHERE value = CAST($baseline_value AS BIGINT)",
          parameters: { row_id: "refresh_row_one", baseline_value: "1" },
          inputs: {
            t: {
              result_id: imported.result_id,
              view: "original",
              amendment_revision: null,
            },
          },
          row_id_column: "research_row_id",
          partial_policy: "strict",
          source_mode: "require_document",
          request_id: randomUUID(),
        },
      });
      assert.equal(queried.isError, undefined, JSON.stringify(queried.content));
      const result = queried.structuredContent as unknown as EngineResult;
      assert.deepEqual(result.row_ids, ["refresh_row_one"]);
      assert.deepEqual(
        result.columns.map((c) => c.key),
        ["value"],
      );
      const appended = await client.callTool({
        name: "append_research",
        arguments: {
          request_id,
          result_ref: {
            result_id: result.result_id,
            snapshot_id: "refresh-child",
            title: "Identity fixture review",
          },
          assessments: [
            {
              row_id: "refresh_row_one",
              field: "value",
              status: "unverified",
              note: "Identity fixture only; no new external evidence or freshness claim",
            },
          ],
        },
      });
      assert.equal(
        appended.isError,
        undefined,
        JSON.stringify(appended.content),
      );
      const view = appended.structuredContent as ResearchView;
      assert.equal(view.snapshot.parentSnapshotId, "refresh-parent");
      assert.equal(view.refresh!.changes[0].canAccept, false);
      assert.equal((await store.open("refresh-parent")).revision, 0);
      assert.equal(
        (await store.open("refresh-parent")).snapshot.rows.length,
        2,
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot coverage follows receipt declarations without labeling unknown runs as fixtures", () => {
  function coverage(value: Snapshot) {
    assert.ok(value.coverage && typeof value.coverage === "object");
    return value.coverage;
  }
  const fixture = result(1);
  fixture.receipt.corpus_coverage = "bounded_fixture";
  assert.equal(coverage(snapshot(fixture)).corpusComplete, "bounded_fixture");
  fixture.receipt.corpus_coverage = "unknown";
  const unknown = coverage(snapshot(fixture));
  assert.equal(unknown.corpusComplete, "unknown");
  assert.ok(unknown.notes.every((note) => !note.includes("fixture execution")));
  delete fixture.receipt.corpus_coverage;
  assert.equal(coverage(snapshot(fixture)).corpusComplete, "unknown");
});
