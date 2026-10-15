import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  request,
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import handler from "../api/index.js";
import { packageVercelAssets } from "../scripts/build-vercel.js";
import { createResearchApplication, researchAccess } from "../server/app.js";
import { createHttpApp } from "../server/http.js";
import { createServer } from "../server/mcp.js";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import {
  type EngineResult,
  type ResearchEngine,
  resultSnapshot,
} from "../server/engine.js";
import { snapshotSchema, type Snapshot } from "../src/schema.js";
import { readArchivedUiBundle, uiResourceUri } from "../server/ui-resource.js";
import sample from "../fixtures/water-procurement.json";

const assetContainer = await mkdtemp(
  join(tmpdir(), "sourcesql-vercel-assets-"),
);
const root = join(assetContainer, ".vercel-assets");
await packageVercelAssets(root);
after(() => rm(assetContainer, { recursive: true, force: true }));
const token = "synthetic-test-token-" + "a".repeat(48);
const environment = {
  RESEARCH_AUTH_MODE: "protected",
  SOURCESQL_BACKEND: "motherduck",
  SOURCESQL_PRINCIPAL: "synthetic-owner",
  RESEARCH_BEARER_TOKEN: token,
  RESEARCH_PUBLIC_ORIGIN: "https://sourcesql.example",
  VERCEL_URL: "preview.vercel.app",
};
class Backend implements ResearchStateBackend {
  state?: ResearchState;
  revision = 0;
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
  async call<T>() {
    return { profiles: [{ name: "fixture", mode: "fixture" }] } as T;
  },
};
async function serving(
  application: (req: IncomingMessage, res: ServerResponse) => unknown,
) {
  const server = createHttpServer((req, res) => {
    void application(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function send(
  server: Server,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{
    status: number;
    headers: IncomingMessage["headers"];
    body: string;
    json: any;
  }>((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: text ? "POST" : "GET",
        headers: {
          host: "sourcesql.example",
          accept: "application/json, text/event-stream",
          ...(text
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(text)),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let json: any;
          try {
            json = JSON.parse(body);
          } catch {
            /* HTML is intentionally public */
          }
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
            json,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(text);
  });
}
const rpc = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});
const auth = { authorization: "Bearer " + token };
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("serverless policy rejects local storage, anonymous access and private disclosure", () => {
  for (const patch of [
    { SOURCESQL_BACKEND: "local" },
    { RESEARCH_AUTH_MODE: "fixture-anonymous" },
    { SOURCESQL_PRINCIPAL: "" },
    { RESEARCH_BEARER_TOKEN: "short" },
    { SOURCESQL_ALLOW_PRIVATE: "1" },
    { RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE: "1" },
  ])
    assert.throws(() =>
      researchAccess({ ...environment, ...patch }, false, true),
    );
  assert.equal(
    researchAccess(environment, false, true).principal,
    "synthetic-owner",
  );
});

test("production serverless execution is refused before backend initialization unless explicitly enabled", async () => {
  let initialized = 0;
  assert.throws(
    () =>
      createHttpApp({
        environment: { ...environment, VERCEL_ENV: "production" },
        root,
        serverless: true,
        services: async () => {
          initialized++;
          throw new Error("Must not initialize");
        },
      }),
    /explicit SOURCESQL_ALLOW_PRODUCTION opt-in/,
  );
  assert.equal(initialized, 0);
  assert.equal(
    researchAccess({ ...environment, VERCEL_ENV: "preview" }, false, true)
      .principal,
    "synthetic-owner",
  );
  assert.equal(
    researchAccess(
      {
        ...environment,
        VERCEL_ENV: "production",
        SOURCESQL_ALLOW_PRODUCTION: "1",
      },
      false,
      true,
    ).principal,
    "synthetic-owner",
  );
});

test("host, exact origin, bearer and body guards run before durable backend initialization", async () => {
  let initialized = 0;
  const app = createHttpApp({
    environment,
    root,
    serverless: true,
    services: async () => {
      initialized++;
      throw new Error("Must not initialize");
    },
  });
  const server = await serving(app);
  try {
    assert.equal((await send(server, "/health")).status, 200);
    assert.equal((await send(server, "/health")).json.principal, undefined);
    assert.equal(
      (
        await send(server, "/health", undefined, {
          host: "evil.example",
          "x-forwarded-host": "sourcesql.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(server, "/mcp", rpc("ping"), {
          ...auth,
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(server, "/mcp", rpc("ping"), {
          ...auth,
          origin: "https://sourcesql.example:444",
        })
      ).status,
      403,
    );
    assert.equal((await send(server, "/mcp", rpc("ping"))).status, 401);
    assert.equal(
      (
        await send(server, "/mcp", rpc("ping"), {
          authorization: "Bearer wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await send(
          server,
          "/mcp",
          { padding: "x".repeat(4 * 1024 * 1024) },
          auth,
        )
      ).status,
      413,
    );
    assert.equal(initialized, 0);
  } finally {
    await close(server);
  }
  for (const origin of [
    "https://user:password@sourcesql.example",
    "https://sourcesql.example/path",
    "http://sourcesql.example",
    "https://*.example",
  ])
    assert.throws(() =>
      createHttpApp({
        environment: { ...environment, RESEARCH_PUBLIC_ORIGIN: origin },
        root,
        serverless: true,
        services: async () => {
          throw new Error();
        },
      }),
    );
});

test("stateless JSON MCP works across fresh serverless factories with durable state and read-only assets", async () => {
  const backend = new Backend();
  const assetsBefore = await readdir(root, { recursive: true });
  const factory = () =>
    createResearchApplication({
      environment,
      root,
      serverless: true,
      backend: { engine, stateBackend: backend },
    });
  const first = await factory();
  const server = await serving(
    createHttpApp({
      environment,
      root,
      serverless: true,
      services: async () => first,
    }),
  );
  let mutation: Record<string, unknown>;
  try {
    const initialized = await send(
      server,
      "/mcp",
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      }),
      auth,
    );
    assert.equal(initialized.status, 200);
    assert.ok(initialized.json.result.protocolVersion);
    assert.equal(initialized.headers["mcp-session-id"], undefined);
    const listed = await send(server, "/mcp", rpc("tools/list"), auth);
    assert.ok(
      listed.json.result.tools.some(
        (tool: any) => tool.name === "sourcesql_query",
      ),
    );
    const opened = await send(
      server,
      "/mcp",
      rpc("tools/call", { name: "open_research", arguments: {} }),
      auth,
    );
    assert.equal(opened.status, 200);
    assert.equal(opened.json.result.isError, undefined);
    const view = opened.json.result.structuredContent;
    mutation = {
      snapshot_id: view.snapshot.id,
      row_id: view.snapshot.rows[0].id,
      field: "closes_at",
      value: null,
      expected_revision: 0,
      mutation_id: randomUUID(),
    };
    const amended = await send(
      server,
      "/mcp",
      rpc("tools/call", { name: "amend_observation", arguments: mutation }),
      auth,
    );
    assert.equal(amended.json.result.structuredContent.revision, 1);
  } finally {
    await close(server);
  }
  const second = await factory();
  const reopened = await serving(
    createHttpApp({
      environment,
      root,
      serverless: true,
      services: async () => second,
    }),
  );
  try {
    const response = await send(
      reopened,
      "/mcp",
      rpc("tools/call", { name: "open_research", arguments: {} }),
      auth,
    );
    assert.equal(response.json.result.structuredContent.revision, 1);
    assert.equal(
      response.json.result.structuredContent.amendments[0].mutation_id,
      mutation!.mutation_id,
    );
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(await readdir(root, { recursive: true }), assetsBefore);
    assert.equal(backend.revision, 1);
  } finally {
    await close(reopened);
  }
});

test("fresh serverless factories authorize durably reordered JSON keys but refuse changed previews before writes", async () => {
  function sortedJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortedJson);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, sortedJson(nested)]),
      );
    return value;
  }
  class SortedBackend extends Backend {
    async write(state: ResearchState, expected: string) {
      await super.write(
        JSON.parse(JSON.stringify(sortedJson(state))),
        expected,
      );
    }
  }
  const backend = new SortedBackend();
  const result: EngineResult = {
    result_id: "wq_reordered_json",
    run_id: "run_reordered_json",
    columns: [
      {
        key: "label",
        label: "Label",
        logical_type: "VARCHAR",
        nullable: false,
      },
      {
        key: "payload",
        label: "Payload",
        logical_type: "JSON",
        nullable: false,
      },
    ],
    rows: [
      {
        payload: {
          zeta: [
            { zebra: 3, alpha: null },
            { zebra: 4, alpha: true },
          ],
          alpha: true,
        },
        label: "First",
      },
      {
        payload: { zeta: [{ zebra: 7, alpha: false }], alpha: null },
        label: "Second",
      },
    ],
    row_ids: ["row_first", "row_second"],
    row_count: 2,
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    receipt: { status: "completed", finished_at: "2026-10-14T16:00:00Z" },
    next_offset: null,
  };
  const canonicalEngine: ResearchEngine = {
    async call<T>(method: string, params?: Record<string, unknown>) {
      assert.equal(method, "read_result");
      assert.equal(params?.result_id, result.result_id);
      return structuredClone(result) as T;
    },
  };
  const factory = () =>
    createResearchApplication({
      environment,
      root,
      serverless: true,
      backend: { engine: canonicalEngine, stateBackend: backend },
    });
  const reference = {
    result_id: result.result_id,
    snapshot_id: "snapshot_reordered_json",
    title: "Durable JSON",
  };
  const first = await factory();
  const server = first.makeServer();
  const client = new Client({ name: "json-order", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const opened = await client.callTool({
      name: "open_research",
      arguments: { result_ref: reference },
    });
    assert.equal(opened.isError, undefined);
  } finally {
    await client.close();
    await server.close();
  }
  const canonical = resultSnapshot(result, reference);
  const saved = backend.state!.snapshots.find(
    (s) => s.id === reference.snapshot_id,
  )!;
  assert.notEqual(
    JSON.stringify(saved.rows),
    JSON.stringify(canonical.rows),
    "Persistence must actually reorder row object keys",
  );
  assert.notEqual(
    JSON.stringify(saved.rows[0].values.payload),
    JSON.stringify(canonical.rows[0].values.payload),
    "Nested cell keys must actually be reordered",
  );
  const reopened = await (await factory()).store.open(reference.snapshot_id);
  assert.deepEqual(reopened.snapshot.rows, canonical.rows);
  assert.deepEqual(reopened.snapshot.columns, canonical.columns);
  const untampered = structuredClone(backend.state!);
  const revision = backend.revision;
  const tamperCases: { name: string; change: (snapshot: Snapshot) => void }[] =
    [
      {
        name: "nested value",
        change: (s) => {
          (s.rows[0].values.payload as Record<string, unknown>).alpha = false;
        },
      },
      {
        name: "extra nested key",
        change: (s) => {
          (s.rows[0].values.payload as Record<string, unknown>).extra =
            "injected";
        },
      },
      {
        name: "row ordering",
        change: (s) => {
          s.rows.reverse();
        },
      },
      {
        name: "nested array ordering",
        change: (s) => {
          (s.rows[0].values.payload as { zeta: unknown[] }).zeta.reverse();
        },
      },
      {
        name: "column ordering",
        change: (s) => {
          s.columns.reverse();
        },
      },
      {
        name: "column label",
        change: (s) => {
          s.columns[0].label = "Forged label";
        },
      },
      {
        name: "content hash",
        change: (s) => {
          s.dataRef!.contentSha256 = "b".repeat(64);
        },
      },
    ];
  for (const { name, change } of tamperCases) {
    backend.state = structuredClone(untampered);
    change(
      backend.state.snapshots.find((s) => s.id === reference.snapshot_id)!,
    );
    const app = await factory();
    await assert.rejects(
      app.store.open(reference.snapshot_id),
      /does not match canonical/,
      name,
    );
    await assert.rejects(
      app.store.amend({
        snapshot_id: reference.snapshot_id,
        row_id: result.row_ids[0],
        field: "label",
        value: "Correction",
        expected_revision: 0,
        mutation_id: randomUUID(),
      }),
      /does not match canonical/,
      name,
    );
    assert.equal(
      backend.revision,
      revision,
      name + " must be rejected before a durable write",
    );
  }
});

test("oversized tool responses acknowledge potentially completed mutations and keep original retry identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-response-cap-"));
  const seed = snapshotSchema.parse(sample),
    backend = new Backend();
  const store = new ResearchStore("/unused", seed, undefined, 3000, {
    backend,
  });
  const html = join(directory, "research.html");
  await writeFile(html, "<html>Synthetic</html>");
  const server = createServer(store, html, { responseByteLimit: 1024 });
  const client = new Client({ name: "response-cap", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const mutation = {
      snapshot_id: seed.id,
      row_id: seed.rows[0].id,
      field: "closes_at",
      value: null,
      expected_revision: 0,
      mutation_id: randomUUID(),
    };
    const response = await client.callTool({
      name: "amend_observation",
      arguments: mutation,
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
    assert.match(
      JSON.stringify(response.content),
      /may already have completed.*same job, request or mutation IDs/,
    );
    assert.equal((await store.open()).revision, 1);
    await client.callTool({ name: "amend_observation", arguments: mutation });
    assert.equal(backend.revision, 1);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const historicalBundles = [
  {
    filename: "research-9b396ddfaead18f3.html",
    sha256: "9b396ddfaead18f337375ba5fb6d714b68c8ce3e475c641190e7a159188b0bb4",
  },
  {
    filename: "research-2e96c79d74441904.html",
    sha256: "2e96c79d744419047ab91e5e62f5eee055249466666db306b41802914dbf8b6a",
  },
  {
    filename: "research-a0b4eab71ba980c1.html",
    sha256: "a0b4eab71ba980c15066db41a24a7599be40e0ce4c3d07a0a0c1d866790804ae",
  },
  {
    filename: "research-a8517535856c8aa3.html",
    sha256: "a8517535856c8aa3ca2dab059a4734075895659fd78f2d0e3c7eb9e4bcb5c25a",
  },
  {
    filename: "research-dfe1c3e8aec7c276.html",
    sha256: "dfe1c3e8aec7c276ab2e0d62ddb0df68f46efc35ebd09997c4bb4dffff644f78",
  },
  {
    filename: "research-66390a91a9d5271f.html",
    sha256: "66390a91a9d5271f9cd6e570cede89b021d9274e70f1400d1f0eea686544cad1",
  },
  {
    filename: "research-b1349a13ba4d1fbe.html",
    sha256: "b1349a13ba4d1fbe273ddff6a69c797f6a2449fec2fb2e0e3125e685847aade6",
  },
  {
    filename: "research-be8725d56a366d19.html",
    sha256: "be8725d56a366d19ecd66b4e7882b4b854b99fe8625e9b41b3f79ebdf8e72418",
  },
  {
    filename: "research-b5ab74c900f06fdb.html",
    sha256: "b5ab74c900f06fdbe7aa0015c25fee66dbc09b4a9df16a152d0aaef1d0b2831c",
  },
] as const;

test("serverless assets contain only current and explicitly retained public widgets plus declared synthetic files", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  );
  const html = await readFile(join(root, "dist/research.html"), "utf8");
  const currentFilename = uiResourceUri(html).split("/").at(-1)!;
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    [
      ...new Set([
        "dist/research.html",
        "dist/index.html",
        `.ui-builds/${currentFilename}`,
        ...historicalBundles.map(({ filename }) => `.ui-builds/${filename}`),
        "fixtures/water-procurement.json",
      ]),
    ].sort(),
  );
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
      expected,
    );
    assert.doesNotMatch(path, /\.env|research\.json|credentials|owner-/);
  }
  assert.equal(uiResourceUri(html), manifest.resource_uri);
  assert.equal(
    await readArchivedUiBundle(
      join(root, "dist/research.html"),
      manifest.resource_uri,
    ),
    html,
  );
  for (const { filename, sha256 } of historicalBundles) {
    const historical = await readArchivedUiBundle(
      join(root, "dist/research.html"),
      `ui://sourcesql/${filename}`,
    );
    assert.equal(createHash("sha256").update(historical).digest("hex"), sha256);
  }
  const uploadRules = (
    await readFile(new URL("../.vercelignore", import.meta.url), "utf8")
  ).split(/\r?\n/);
  assert.deepEqual(
    uploadRules.filter((line) => line.startsWith("!ui-history")),
    [
      "!ui-history",
      ...historicalBundles.map(({ filename }) => `!ui-history/${filename}`),
    ],
    "Historical upload inputs must remain explicitly enumerated",
  );
});

test("rebuilding the current UI preserves old ChatGPT resource reads without copying arbitrary history files", async () => {
  const input = await mkdtemp(join(tmpdir(), "sourcesql-ui-rebuild-"));
  const output = join(input, "packaged");
  const historical = await Promise.all(
    historicalBundles.map(async ({ filename, sha256 }) => ({
      filename,
      sha256,
      uri: `ui://sourcesql/${filename}`,
      html: await readFile(
        new URL(`../ui-history/${filename}`, import.meta.url),
        "utf8",
      ),
    })),
  );
  const current = "<html>New synthetic UI bundle after a rebuild</html>";
  try {
    for (const directory of ["dist", "fixtures", "ui-history"])
      await mkdir(join(input, directory));
    await writeFile(join(input, "dist/research.html"), current);
    await writeFile(
      join(input, "dist/index.html"),
      "<html>Public shell</html>",
    );
    await writeFile(join(input, "fixtures/water-procurement.json"), "{}");
    for (const { filename, html } of historical)
      await writeFile(join(input, "ui-history", filename), html);
    await writeFile(join(input, "ui-history/operator-private.json"), "private");
    await writeFile(
      join(input, "ui-history/research-aaaaaaaaaaaaaaaa.html"),
      "unapproved",
    );
    await packageVercelAssets(output, input);
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.resource_uri, uiResourceUri(current));
    assert.equal(Object.keys(manifest.files).length, 4 + historical.length);
    for (const { uri, html } of historical) {
      assert.notEqual(manifest.resource_uri, uri);
      assert.equal(
        await readArchivedUiBundle(join(output, "dist/research.html"), uri),
        html,
      );
    }
    assert.equal(
      await readArchivedUiBundle(
        join(output, "dist/research.html"),
        manifest.resource_uri,
      ),
      current,
    );
    assert.equal(
      (await readdir(output, { recursive: true })).some((path) =>
        /private|aaaaaaaaaaaaaaaa|ui-history/.test(path),
      ),
      false,
    );

    for (const { filename, html } of historical) {
      await writeFile(join(input, "ui-history", filename), html + "tampered");
      await assert.rejects(
        packageVercelAssets(output, input),
        /Historical UI bundle content hash mismatch/,
      );
      for (const preserved of historical)
        assert.equal(
          await readArchivedUiBundle(
            join(output, "dist/research.html"),
            preserved.uri,
          ),
          preserved.html,
          "A rejected archive must not replace previously verified packaged assets",
        );
      await writeFile(join(input, "ui-history", filename), html);
    }
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("the actual Vercel entrypoint serves guarded health without MotherDuck credentials", async () => {
  const before = { ...process.env };
  const previousDirectory = process.cwd();
  process.chdir(assetContainer);
  Object.assign(process.env, environment);
  delete process.env.MOTHERDUCK_TOKEN;
  const server = await serving(handler);
  try {
    const health = await send(server, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.mode, "protected");
    assert.equal(health.json.principal, undefined);
    assert.equal((await send(server, "/mcp", rpc("tools/list"))).status, 401);
  } finally {
    await close(server);
    process.chdir(previousDirectory);
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
