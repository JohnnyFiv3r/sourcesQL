import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createResearchApplication } from "../server/app.js";
import { createServer } from "../server/mcp.js";
import {
  PythonEngine,
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import {
  assertedSourcesForViewSelection,
  snapshotSchema,
  type ResearchView,
  type Snapshot,
} from "../src/schema.js";
import { SourceList } from "../src/source-list.js";
import {
  HOST_ASSERTED_LABEL,
  needsSourcePicker,
  HOST_ASSERTED_TITLE,
} from "../src/presentation.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const FORGED_URL = "https://made-up.example/never-fetched";
const FORGED_QUOTE = "Scientists confirm the moon is made of cheese.";

// The researcher's forgery from #137: a made-up source, a made-up quote and a
// note claiming verification, with no engine result behind any of it.
const forgedV1 = () =>
  snapshotSchema.parse({
    id: "forged-v1-1",
    title: "Forged claims",
    sourceResultSetId: "r0000000000f",
    capturedAt: "2026-11-23",
    coverage: "Host-written test data",
    columns: [
      { key: "claim", label: "Claim" },
      { key: "status", label: "Status" },
    ],
    rows: [
      {
        id: "claim-1",
        values: { claim: "The moon is cheese", status: "supported" },
        sourceUrl: FORGED_URL,
        evidence: { claim: [FORGED_QUOTE] },
        verificationNote: "verified",
      },
    ],
  });

// A well-formed v2 snapshot that claims a sourcesQL origin but has no dataRef.
const forgedV2 = () =>
  snapshotSchema.parse({
    schemaVersion: 2,
    id: "forged-v2-1",
    title: "Forged v2 claims",
    origin: { engine: "sourcesql", resultId: "wq_forged", runId: "run_forged" },
    capturedAt: "2026-11-23T10:00:00.000Z",
    captureBasis: "run_completed_at",
    capturePrecision: "instant",
    rowCount: 1,
    dataClassification: "public_web",
    coverage: { planComplete: true, corpusComplete: "unknown", notes: [] },
    columns: [
      { key: "claim", label: "Claim", logicalType: "VARCHAR", nullable: false },
    ],
    rows: [
      {
        id: "claim-1",
        values: { claim: "The moon is cheese" },
        sourceUrl: FORGED_URL,
        sources: [{ url: FORGED_URL }],
        cellSources: { claim: [{ url: FORGED_URL }] },
        evidenceRefs: ["e_forged"],
        evidence: { claim: [FORGED_QUOTE] },
        verificationNote: "Direct textual support; not a truth guarantee.",
      },
    ],
  });

type Text = { type: string; text?: string };
const textOf = (result: { content?: unknown }) =>
  (result.content as Text[]).find((c) => c.type === "text")!.text!;

async function connect(store: ResearchStore, directory: string) {
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const server = createServer(store, htmlPath);
  const client = new Client({ name: "host-asserted-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}
async function hostFixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-host-asserted-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const store = new ResearchStore(data, forgedV1());
  const client = await connect(store, directory);
  t.after(() => client.close());
  const stateHash = async () =>
    createHash("sha256")
      .update(await readFile(join(data, "research.json")))
      .digest("hex");
  return { directory, data, store, client, stateHash };
}

const HOST_QUOTE_SENTENCE =
  "1 quotes on 1 rows are host-asserted: sourcesQL has not checked them against fetched text.";
const HOST_SENTENCE =
  "1 sources on 1 rows are host-asserted: sourcesQL has not fetched or checked them.";

test("import_research labels a forged v1 snapshot host-asserted and still accepts it", async (t) => {
  const { client } = await hostFixture(t);
  const saved = await client.callTool({
    name: "import_research",
    arguments: { snapshot: { ...forgedV1(), id: "forged-v1-2" } },
  });
  assert.equal(saved.isError, undefined);
  assert.match(textOf(saved), /Research saved as snapshot_id: forged-v1-2/);
  assert.ok(textOf(saved).includes(HOST_SENTENCE));
  assert.equal((saved.structuredContent as ResearchView).assertion, "host");
});

test("open_research marks host sources in text and widget data", async (t) => {
  const { client } = await hostFixture(t);
  const opened = await client.callTool({
    name: "open_research",
    arguments: { snapshot_id: "forged-v1-1" },
  });
  assert.ok(textOf(opened).includes(HOST_SENTENCE));
  // The quote is host text too, so it is attributed even beside a host URL.
  assert.ok(textOf(opened).includes(HOST_QUOTE_SENTENCE), textOf(opened));
  const view = opened.structuredContent as ResearchView;
  assert.equal(view.assertion, "host");
  const sources = assertedSourcesForViewSelection(view, view.snapshot.rows[0]);
  assert.deepEqual(sources, [{ url: FORGED_URL, assertion: "host" }]);
});

test("find_research_row and get_research_request mark host sources and quotes", async (t) => {
  const { client } = await hostFixture(t);
  const found = await client.callTool({
    name: "find_research_row",
    arguments: { snapshot_id: "forged-v1-1" },
  });
  assert.ok(textOf(found).includes(`${FORGED_URL} (host-asserted)`));
  const matches = (
    found.structuredContent as {
      matches: { assertion: string; source_url: string }[];
    }
  ).matches;
  assert.equal(matches[0].assertion, "host");
  assert.equal(matches[0].source_url, FORGED_URL);

  const request_id = randomUUID();
  await client.callTool({
    name: "expand_research",
    arguments: {
      request_id,
      snapshot_id: "forged-v1-1",
      row_id: "claim-1",
      question: "Check this claim",
    },
  });
  const context = await client.callTool({
    name: "get_research_request",
    arguments: { request_id },
  });
  assert.equal(context.isError, undefined);
  const read = JSON.parse(textOf(context)) as {
    originalSnapshot: {
      rows: { sourceUrl: string; evidence: Record<string, string[]> }[];
    };
    selectedSources: { sources: { url: string }[] }[];
  };
  assert.deepEqual(read.originalSnapshot.rows[0].evidence.claim, [
    `"${FORGED_QUOTE}" (host-asserted, not checked against fetched text)`,
  ]);
  assert.equal(
    read.originalSnapshot.rows[0].sourceUrl,
    `${FORGED_URL} (host-asserted)`,
  );
  assert.equal(
    read.selectedSources[0].sources[0].url,
    `${FORGED_URL} (host-asserted)`,
  );
  const structured = context.structuredContent as {
    originalSnapshot: { assertion: string };
  };
  assert.equal(structured.originalSnapshot.assertion, "host");
  assert.equal(
    (
      context.structuredContent as {
        selectedSources: { sources: { url: string }[] }[];
      }
    ).selectedSources[0].sources[0].url,
    FORGED_URL,
    "Structured data keeps usable URLs",
  );
});

test("the source picker labels host sources inside the link and leaves engine sources plain", () => {
  const html = renderToStaticMarkup(
    createElement(SourceList, {
      busy: false,
      onVisit: () => {},
      sources: [
        { url: "https://engine.example/page" },
        { url: FORGED_URL, assertion: "host" },
      ],
    }),
  );
  const [engine, host] = html.split("</a>");
  assert.doesNotMatch(engine, /Host-asserted/);
  assert.match(host, new RegExp(`<small[^>]*>${HOST_ASSERTED_LABEL}</small>`));
  assert.ok(host.includes(`title="${HOST_ASSERTED_TITLE}"`));
  assert.ok(
    host.indexOf(HOST_ASSERTED_LABEL) < host.length,
    "The label sits inside the anchor, so it is announced with the link",
  );
});

test("export carries host assertions and re-import keeps them", async (t) => {
  const { client, directory } = await hostFixture(t);
  const exported = await client.callTool({
    name: "export_research",
    arguments: { snapshot_id: "forged-v1-1" },
  });
  const bundle = exported.structuredContent as Record<string, unknown> & {
    assertions: Record<string, string>;
  };
  assert.deepEqual(bundle.assertions, { "forged-v1-1": "host" });
  for (const assertions of [
    bundle.assertions,
    {},
    { "forged-v1-1": "engine" },
  ]) {
    const fresh = new ResearchStore(
      join(directory, `fresh-${randomUUID()}`),
      forgedV1(),
    );
    const freshClient = await connect(fresh, directory);
    t.after(() => freshClient.close());
    const imported = await freshClient.callTool({
      name: "import_research_bundle",
      arguments: { bundle: { ...bundle, assertions } },
    });
    assert.equal(imported.isError, undefined, textOf(imported));
    assert.equal(
      (imported.structuredContent as ResearchView).assertion,
      "host",
      "Import recomputes the label, so an edited bundle cannot hide it",
    );
  }
});

test("labelling never rewrites stored state", async (t) => {
  const { client, stateHash } = await hostFixture(t);
  await client.callTool({
    name: "import_research",
    arguments: { snapshot: { ...forgedV1(), id: "forged-v1-2" } },
  });
  const before = await stateHash();
  for (const call of [
    { name: "open_research", arguments: { snapshot_id: "forged-v1-1" } },
    { name: "find_research_row", arguments: { snapshot_id: "forged-v1-1" } },
    { name: "export_research", arguments: { snapshot_id: "forged-v1-1" } },
  ])
    assert.equal((await client.callTool(call)).isError, undefined);
  assert.equal(await stateHash(), before);
});

test("a forged v2 snapshot with a sourcesql origin and no dataRef is labelled host-asserted", async (t) => {
  const { client, store } = await hostFixture(t);
  const saved = await client.callTool({
    name: "import_research",
    arguments: { snapshot: forgedV2() },
  });
  assert.equal(saved.isError, undefined, textOf(saved));
  assert.ok(textOf(saved).includes(HOST_SENTENCE));
  const view = await store.open("forged-v2-1");
  assert.equal(view.assertion, "host");
  const opened = await client.callTool({
    name: "open_research",
    arguments: { snapshot_id: "forged-v2-1" },
  });
  assert.match(textOf(opened), /Source result sourcesql:wq_forged/);
  assert.ok(textOf(opened).includes(HOST_SENTENCE));
});

// --- Engine-backed snapshots, through the real application resolver. ---

const reference = {
  result_id: "wq_real",
  snapshot_id: "saved_real",
  title: "Real result",
};
function engineResult(): EngineResult {
  return {
    result_id: "wq_real",
    run_id: "run_real",
    row_ids: ["row_real"],
    row_count: 1,
    columns: [
      {
        key: "capacity",
        label: "Capacity",
        logical_type: "VARCHAR",
        nullable: true,
      },
    ],
    rows: [{ capacity: "500 MW" }],
    content_sha256: "a".repeat(64),
    data_classification: "public_web",
    next_offset: null,
    receipt: { status: "completed", finished_at: "2026-10-16T10:00:00Z" },
    source_versions: [
      {
        source_version_id: "src_real",
        url: "https://source.example/campus",
      },
    ],
    evidence: [
      {
        evidence_id: "e_real",
        row_id: "row_real",
        column_key: "capacity",
        source_version_id: "src_real",
        status: "supported_text",
        support: [{ quote: "500 MW" }],
      },
    ],
  };
}
class Backend implements ResearchStateBackend {
  revision = 0;
  constructor(public state: ResearchState) {}
  async read() {
    return {
      state: structuredClone(this.state),
      version: String(this.revision),
    };
  }
  async write(state: ResearchState, expected: string) {
    assert.equal(expected, String(this.revision));
    this.state = structuredClone(state);
    this.revision++;
  }
}
const engine: ResearchEngine = {
  async call<T>(method: string): Promise<T> {
    assert.equal(method, "read_result");
    return structuredClone(engineResult()) as T;
  },
};
async function engineFixture(t: {
  after(callback: () => Promise<void>): void;
}) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-engine-asserted-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new Backend({ snapshots: [], amendments: [] });
  const app = await createResearchApplication({
    root,
    serverless: true,
    environment: {
      RESEARCH_AUTH_MODE: "protected",
      SOURCESQL_BACKEND: "motherduck",
      SOURCESQL_PRINCIPAL: "host-asserted-test",
      RESEARCH_BEARER_TOKEN: "synthetic-" + "a".repeat(40),
      RESEARCH_DATA_DIR: directory,
    },
    backend: { engine, stateBackend: backend },
  });
  return app;
}

test("a real result with a tampered quote is refused, so a dataRef proves engine backing", async (t) => {
  const app = await engineFixture(t);
  const canonical = resultSnapshot(engineResult(), reference);
  const tampered: ((s: Snapshot) => void)[] = [
    (s) => {
      s.rows[0].evidence.capacity = [FORGED_QUOTE];
    },
    (s) => {
      s.rows[0].cellSources!.capacity = [{ url: FORGED_URL }];
    },
    (s) => {
      s.rows[0].sources = [{ url: FORGED_URL }];
    },
  ];
  for (const change of tampered) {
    const altered = structuredClone(canonical);
    change(altered);
    await assert.rejects(app.store.import(altered), /does not match canonical/);
  }
});

test("an engine-backed result shows no host-asserted label anywhere", async (t) => {
  const app = await engineFixture(t);
  const saved = await app.store.import(
    resultSnapshot(engineResult(), reference),
  );
  assert.equal(saved.assertion, "engine");
  const server = app.makeServer();
  const client = new Client({ name: "engine-asserted-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(() => client.close());
  const opened = await client.callTool({
    name: "open_research",
    arguments: { snapshot_id: "saved_real" },
  });
  assert.equal(opened.isError, undefined, textOf(opened));
  assert.doesNotMatch(textOf(opened), /host-asserted/);
  const view = opened.structuredContent as ResearchView;
  assert.equal(view.assertion, "engine");
  const sources = assertedSourcesForViewSelection(view, view.snapshot.rows[0]);
  assert.deepEqual(sources, [
    { url: "https://source.example/campus", assertion: "engine" },
  ]);
  const found = await client.callTool({
    name: "find_research_row",
    arguments: { snapshot_id: "saved_real" },
  });
  assert.doesNotMatch(textOf(found), /host-asserted/);
  const html = renderToStaticMarkup(
    createElement(SourceList, {
      sources,
      busy: false,
      onVisit: () => {},
    }),
  );
  assert.doesNotMatch(html, /Host-asserted/);
});

test("materialising a forged snapshot gives the engine no evidence and no sources", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "sourcesql-host-materialize-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = new PythonEngine(undefined, {
    ...process.env,
    SOURCESQL_DATA_DIR: join(directory, "engine"),
    SOURCESQL_PRINCIPAL: "host-asserted-test",
    SOURCESQL_ALLOW_PRIVATE: "0",
  });
  const store = new ResearchStore(join(directory, "app"), forgedV1());
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const server = createServer(store, htmlPath, { engine });
  const client = new Client({ name: "host-materialize-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(() => client.close());
  const revision = (await store.open("forged-v1-1")).revision;
  const materialized = await client.callTool({
    name: "sourcesql_materialize_research",
    arguments: { snapshot_id: "forged-v1-1", expected_revision: revision },
  });
  assert.equal(materialized.isError, undefined, textOf(materialized));
  const json = JSON.stringify(materialized.structuredContent);
  assert.doesNotMatch(json, /made-up\.example/);
  assert.doesNotMatch(json, /moon is made of cheese/);
});

// --- Gaps QA found after the first build. ---

test("a lone host-asserted source goes through the labelled picker, a lone engine source does not", () => {
  assert.equal(needsSourcePicker([]), false);
  assert.equal(needsSourcePicker([{ url: "https://a.example" }]), false);
  assert.equal(
    needsSourcePicker([{ url: "https://a.example", assertion: "engine" }]),
    false,
  );
  assert.equal(
    needsSourcePicker([{ url: FORGED_URL, assertion: "host" }]),
    true,
  );
  assert.equal(
    needsSourcePicker([
      { url: "https://a.example" },
      { url: "https://b.example" },
    ]),
    true,
  );
});

test("a quote-only host snapshot is attributed to the host in import and open text", async (t) => {
  const { client } = await hostFixture(t);
  const quoteOnly = snapshotSchema.parse({
    ...forgedV2(),
    id: "quote-only-1",
    rows: forgedV2().rows.map((row) => ({
      ...row,
      sourceUrl: null,
      sources: undefined,
      cellSources: undefined,
    })),
  });
  assert.ok(Object.values(quoteOnly.rows[0].evidence).flat().length > 0);
  const sentence =
    "1 quotes on 1 rows are host-asserted: sourcesQL has not checked them against fetched text.";
  const saved = await client.callTool({
    name: "import_research",
    arguments: { snapshot: quoteOnly },
  });
  assert.equal(saved.isError, undefined, textOf(saved));
  assert.ok(textOf(saved).includes(sentence), textOf(saved));
  const opened = await client.callTool({
    name: "open_research",
    arguments: { snapshot_id: "quote-only-1" },
  });
  assert.ok(textOf(opened).includes(sentence), textOf(opened));
});

// What an earlier build stored when a refresh was accepted from another table.
async function writeAcceptedAmendment(
  data: string,
  parent: Snapshot,
  sourceSnapshotId: string,
  value: string,
  originalValue: string,
) {
  const file = join(data, "research.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.amendments.push({
    snapshot_id: parent.id,
    row_id: parent.rows[0].id,
    field: "capacity",
    value,
    reason: `Accepted evidence from ${sourceSnapshotId}`,
    sourceSnapshotId,
    expected_revision: 0,
    mutation_id: randomUUID(),
    revision: 1,
    originalValue,
    createdAt: "2026-11-23T10:00:00.000Z",
  });
  await writeFile(file, JSON.stringify(state, null, 2));
}

test("request context marks a host URL host-asserted even when the parent is engine-backed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-mixed-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const parent = resultSnapshot(engineResult(), reference);
  const store = new ResearchStore(data, parent, async (s) => s);
  await store.import({
    ...snapshotSchema.parse({
      id: "host-child",
      title: "Host child",
      sourceResultSetId: "r0000000000f",
      capturedAt: "2026-11-23",
      coverage: "Host-written test data",
      columns: [{ key: "capacity", label: "Capacity" }],
      rows: [
        {
          id: parent.rows[0].id,
          values: { capacity: "900 MW" },
          sourceUrl: FORGED_URL,
          evidence: { capacity: [FORGED_QUOTE] },
          verificationNote: "verified",
        },
      ],
    }),
    parentSnapshotId: parent.id,
  });
  await writeAcceptedAmendment(data, parent, "host-child", "900 MW", "500 MW");
  const reopened = new ResearchStore(data, parent, async (s) => s);
  const requestId = randomUUID();
  await reopened.beginResearch(
    {
      request_id: requestId,
      snapshot_id: parent.id,
      row_id: parent.rows[0].id,
      field: "capacity",
      question: "What else is known about this capacity?",
    },
    "expand",
  );
  const client = await connect(reopened, directory);
  t.after(() => client.close());
  const response = await client.callTool({
    name: "get_research_request",
    arguments: { request_id: requestId },
  });
  assert.equal(response.isError, undefined, textOf(response));
  const sources = (
    response.structuredContent as {
      selectedSources: {
        sources: { url: string; assertion: string }[];
      }[];
    }
  ).selectedSources.flatMap((entry) => entry.sources);
  const byUrl = Object.fromEntries(sources.map((s) => [s.url, s.assertion]));
  assert.equal(byUrl[FORGED_URL], "host");
  assert.equal(byUrl["https://source.example/campus"], "engine");
  // The accepted host source is attributed in the open text as well.
  const opened = await client.callTool({
    name: "open_research",
    arguments: { snapshot_id: parent.id },
  });
  assert.ok(textOf(opened).includes(HOST_SENTENCE), textOf(opened));
});

test("request context keeps an engine-observed correction engine-observed under a host parent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-inverse-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, "data");
  const engine = resultSnapshot(engineResult(), reference);
  const hostParent: Snapshot = snapshotSchema.parse({
    id: "host-parent",
    title: "Host parent",
    sourceResultSetId: "r0000000000f",
    capturedAt: "2026-11-23",
    coverage: "Host-written test data",
    columns: [{ key: "capacity", label: "Capacity" }],
    rows: [
      {
        id: engine.rows[0].id,
        values: { capacity: "400 MW" },
        sourceUrl: FORGED_URL,
        evidence: {},
        verificationNote: "n/a",
      },
    ],
  });
  const store = new ResearchStore(data, hostParent, async (s) => s);
  await store.import({ ...engine, parentSnapshotId: hostParent.id });
  await writeAcceptedAmendment(data, hostParent, engine.id, "500 MW", "400 MW");
  const reopened = new ResearchStore(data, hostParent, async (s) => s);
  const requestId = randomUUID();
  await reopened.beginResearch(
    {
      request_id: requestId,
      snapshot_id: hostParent.id,
      row_id: hostParent.rows[0].id,
      field: "capacity",
      question: "What else is known about this capacity?",
    },
    "expand",
  );
  const client = await connect(reopened, directory);
  t.after(() => client.close());
  const response = await client.callTool({
    name: "get_research_request",
    arguments: { request_id: requestId },
  });
  assert.equal(response.isError, undefined, textOf(response));
  const byUrl = Object.fromEntries(
    (
      response.structuredContent as {
        selectedSources: { sources: { url: string; assertion: string }[] }[];
      }
    ).selectedSources
      .flatMap((entry) => entry.sources)
      .map((s) => [s.url, s.assertion]),
  );
  assert.equal(byUrl[FORGED_URL], "host");
  assert.equal(byUrl["https://source.example/campus"], "engine");
});

test("get_research_request marks host sources and quotes in the effective rows", async (t) => {
  const { client } = await hostFixture(t);
  const request_id = randomUUID();
  await client.callTool({
    name: "expand_research",
    arguments: {
      request_id,
      snapshot_id: "forged-v1-1",
      row_id: "claim-1",
      question: "Check this claim",
    },
  });
  const context = await client.callTool({
    name: "get_research_request",
    arguments: { request_id },
  });
  const quote = `"${FORGED_QUOTE}" (host-asserted, not checked against fetched text)`;
  const text = JSON.parse(textOf(context)) as {
    effectiveRowsAtRequest: {
      sourceUrl: string;
      sources?: { url: string }[];
      cellSources?: Record<string, { url: string }[]>;
      evidence: Record<string, string[]>;
    }[];
  };
  const row = text.effectiveRowsAtRequest[0];
  assert.equal(row.sourceUrl, `${FORGED_URL} (host-asserted)`);
  assert.deepEqual(row.evidence.claim, [quote]);
  for (const source of [
    ...(row.sources ?? []),
    ...Object.values(row.cellSources ?? {}).flat(),
  ])
    assert.equal(source.url, `${FORGED_URL} (host-asserted)`);
  const structured = (
    context.structuredContent as {
      effectiveRowsAtRequest: {
        assertion: string;
        sourceUrl: string;
        evidence: Record<string, string[]>;
      }[];
    }
  ).effectiveRowsAtRequest[0];
  assert.equal(structured.assertion, "host");
  assert.equal(structured.sourceUrl, FORGED_URL, "Structured URLs stay usable");
  assert.deepEqual(structured.evidence.claim, [quote]);
});

for (const status of ["verified", "conflicting"] as const) {
  test(`a host-evidence ${status} refresh survives export, same-store import and replay after restore`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "sourcesql-round-trip-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new ResearchStore(join(directory, "a"), forgedV1());
    const request_id = randomUUID();
    await store.beginResearch(
      {
        request_id,
        snapshot_id: "forged-v1-1",
        row_id: "claim-1",
        field: "claim",
        question: "Is this still true?",
      },
      "refresh",
    );
    const child = snapshotSchema.parse({
      id: "refreshed-1",
      title: "Refreshed",
      sourceResultSetId: "r0000000000e",
      capturedAt: "2026-11-24",
      coverage: "Host-written test data",
      columns: [
        { key: "claim", label: "Claim" },
        { key: "status", label: "Status" },
      ],
      rows: [
        {
          id: "claim-1",
          values: { claim: "The moon is rock", status: "supported" },
          sourceUrl: FORGED_URL,
          evidence: { claim: ["Host-written quote"] },
          verificationNote: "verified",
        },
      ],
    });
    const append = {
      request_id,
      snapshot: child,
      assessments: [{ row_id: "claim-1", field: "claim", status, note: "n" }],
    };
    await store.appendResearch(append);
    const bundle = await store.exportBundle("refreshed-1");
    assert.ok(
      JSON.stringify(bundle).includes("unverified") &&
        !JSON.stringify(bundle).includes(`"status":"${status}"`),
      "The export states only the downgraded status",
    );
    // Unchanged bundle into the store it came from.
    await store.importBundle(JSON.parse(JSON.stringify(bundle)));
    // Fresh store, then the original retry.
    const fresh = new ResearchStore(join(directory, "b"), forgedV1());
    await fresh.importBundle(JSON.parse(JSON.stringify(bundle)));
    const replayed = await fresh.appendResearch(structuredClone(append));
    assert.equal(replayed.snapshot.id, "refreshed-1");
    // Only the submitted status changed: the export dropped it, so the
    // request's digest of the original payload is what tells them apart.
    const other = status === "verified" ? "conflicting" : "verified";
    await assert.rejects(
      fresh.appendResearch({
        ...structuredClone(append),
        assessments: [
          { row_id: "claim-1", field: "claim", status: other, note: "n" },
        ],
      }),
      /different results/,
    );
    // A different completion still conflicts after the restore.
    await assert.rejects(
      fresh.appendResearch({
        ...structuredClone(append),
        assessments: [
          { row_id: "claim-1", field: "claim", status, note: "changed" },
        ],
      }),
      /different results/,
    );
  });
}

test("a restored completed request with no completion payload answers a retry with the conflict, not an exception", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-no-completion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ResearchStore(join(directory, "a"), forgedV1());
  const request_id = randomUUID();
  await store.beginResearch(
    {
      request_id,
      snapshot_id: "forged-v1-1",
      row_id: "claim-1",
      question: "Is this still true?",
    },
    "expand",
  );
  const append = {
    request_id,
    snapshot: snapshotSchema.parse({
      id: "expanded-1",
      title: "Expanded",
      sourceResultSetId: "r0000000000e",
      capturedAt: "2026-11-24",
      coverage: "Host-written test data",
      columns: [{ key: "claim", label: "Claim" }],
      rows: [
        {
          id: "claim-1",
          values: { claim: "The moon is rock" },
          sourceUrl: FORGED_URL,
          evidence: {},
          verificationNote: "n",
        },
      ],
    }),
  };
  await store.appendResearch(append);
  const bundle = JSON.parse(
    JSON.stringify(await store.exportBundle("expanded-1")),
  );
  delete bundle.state.requests[0].completion;
  delete bundle.state.requests[0].completionDigest;
  const fresh = new ResearchStore(join(directory, "b"), forgedV1());
  await fresh.importBundle(bundle);
  await assert.rejects(
    fresh.appendResearch(structuredClone(append)),
    /already has different results/,
  );
});

async function beginRefresh(store: ResearchStore, snapshot_id = "forged-v1-1") {
  const request_id = randomUUID();
  await store.beginResearch(
    {
      request_id,
      snapshot_id,
      row_id: "claim-1",
      field: "claim",
      question: "Is this still true?",
    },
    "refresh",
  );
  return request_id;
}

const refreshColumns = [
  { key: "claim", label: "Claim" },
  { key: "status", label: "Status" },
];

test("an export of a request saved before digests existed still tells a changed status from a retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-legacy-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ResearchStore(join(directory, "a"), forgedV1());
  const request_id = await beginRefresh(store);
  const append = {
    request_id,
    snapshot: snapshotSchema.parse({
      id: "refreshed-1",
      title: "Refreshed",
      sourceResultSetId: "r0000000000e",
      capturedAt: "2026-11-24",
      coverage: "Host-written test data",
      columns: refreshColumns,
      rows: [
        {
          id: "claim-1",
          values: { claim: "The moon is rock", status: "supported" },
          sourceUrl: FORGED_URL,
          evidence: { claim: ["Host-written quote"] },
          verificationNote: "verified",
        },
      ],
    }),
    assessments: [
      { row_id: "claim-1", field: "claim", status: "verified", note: "n" },
    ],
  };
  await store.appendResearch(append);
  // Rewrite the stored request as the previous release saved it: the
  // submitted payload and no digest.
  const file = join(directory, "a", "research.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  delete saved.requests[0].completionDigest;
  await writeFile(file, JSON.stringify(saved));
  const bundle = await new ResearchStore(
    join(directory, "a"),
    forgedV1(),
  ).exportBundle("refreshed-1");
  assert.match(
    bundle.state.requests![0].completionDigest ?? "",
    /^[0-9a-f]{64}$/,
  );
  const fresh = new ResearchStore(join(directory, "b"), forgedV1());
  await fresh.importBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(
    (await fresh.appendResearch(structuredClone(append))).snapshot.id,
    "refreshed-1",
  );
  await assert.rejects(
    fresh.appendResearch({
      ...structuredClone(append),
      assessments: [
        { row_id: "claim-1", field: "claim", status: "conflicting", note: "n" },
      ],
    }),
    /different results/,
  );
});

test("a completion digest that is not a 64-character hex string is refused on import", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-bad-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ResearchStore(join(directory, "a"), forgedV1());
  const request_id = await beginRefresh(store);
  await store.appendResearch({
    request_id,
    snapshot: snapshotSchema.parse({
      id: "refreshed-1",
      title: "Refreshed",
      sourceResultSetId: "r0000000000e",
      capturedAt: "2026-11-24",
      coverage: "Host-written test data",
      columns: refreshColumns,
      rows: [
        {
          id: "claim-1",
          values: { claim: "The moon is rock", status: "supported" },
          sourceUrl: FORGED_URL,
          evidence: {},
          verificationNote: "n",
        },
      ],
    }),
    assessments: [
      { row_id: "claim-1", field: "claim", status: "unverified", note: "n" },
    ],
  });
  const bundle = JSON.parse(
    JSON.stringify(await store.exportBundle("refreshed-1")),
  );
  const digest = bundle.state.requests[0].completionDigest;
  assert.match(digest, /^[0-9a-f]{64}$/);
  bundle.state.requests[0].completionDigest = [digest];
  await assert.rejects(
    new ResearchStore(join(directory, "b"), forgedV1()).importBundle(bundle),
    /Invalid bundle request digest/,
  );
});

test("an engine-backed refresh replays after a restore maps its result to a new id", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-remap-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engineChild = (resultId: string, capturedAt: string) =>
    snapshotSchema.parse({
      schemaVersion: 2,
      id: "refreshed-1",
      title: "Refreshed",
      origin: { engine: "sourcesql", resultId, runId: `run_${resultId}` },
      capturedAt,
      capturePrecision: "instant",
      captureBasis: "run_completed_at",
      dataClassification: "public_web",
      coverage: { planComplete: true, corpusComplete: "unknown", notes: [] },
      columns: forgedV2().columns,
      rowCount: 1,
      rows: [
        {
          id: "claim-1",
          values: { claim: "The moon is rock" },
          sourceUrl: FORGED_URL,
          evidence: { claim: ["Engine quote"] },
          verificationNote: "n",
        },
      ],
      dataRef: { resultId, contentSha256: "a".repeat(64) },
    });
  // The app's resolver rebinds the saved snapshot to the engine result and keeps its parent.
  const resolveAs =
    (resultId: string, capturedAt: string) => async (saved: Snapshot) => ({
      ...engineChild(resultId, capturedAt),
      parentSnapshotId: saved.parentSnapshotId,
    });
  const store = new ResearchStore(
    join(directory, "a"),
    forgedV2(),
    resolveAs("wq_origin", "2026-11-24T10:00:00.000Z"),
  );
  const request_id = await beginRefresh(store, "forged-v2-1");
  const append = {
    request_id,
    snapshot: engineChild("wq_origin", "2026-11-24T10:00:00.000Z"),
    assessments: [
      { row_id: "claim-1", field: "claim", status: "verified", note: "n" },
    ],
  };
  await store.appendResearch(append);
  const bundle = JSON.parse(
    JSON.stringify(await store.exportBundle("refreshed-1")),
  );
  // What the app's import does: the completion is rebound to the local result.
  const local = engineChild("wq_restore_1", "2026-11-25T09:00:00.000Z");
  bundle.state.snapshots = bundle.state.snapshots.map((s: Snapshot) =>
    s.id === local.id ? { ...local, parentSnapshotId: s.parentSnapshotId } : s,
  );
  bundle.state.requests[0].completion.snapshot = {
    ...local,
    parentSnapshotId:
      bundle.state.requests[0].completion.snapshot.parentSnapshotId,
  };
  const fresh = new ResearchStore(
    join(directory, "b"),
    forgedV2(),
    resolveAs("wq_restore_1", "2026-11-25T09:00:00.000Z"),
  );
  await fresh.importBundle(bundle);
  assert.equal(
    (
      await fresh.appendResearch({
        ...structuredClone(append),
        snapshot: local,
      })
    ).snapshot.id,
    "refreshed-1",
  );
  await assert.rejects(
    fresh.appendResearch({
      ...structuredClone(append),
      snapshot: local,
      assessments: [
        { row_id: "claim-1", field: "claim", status: "conflicting", note: "n" },
      ],
    }),
    /different results/,
  );
});
