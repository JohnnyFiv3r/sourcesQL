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
