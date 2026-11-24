import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "../server/mcp.js";
import { LOCAL_STORE_UNAVAILABLE, ResearchStore } from "../server/store.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const seed = snapshotSchema.parse(sample);
const SAFE = `storage_unavailable: ${LOCAL_STORE_UNAVAILABLE}`;
const FORBIDDEN = [
  "ENOTDIR",
  "EACCES",
  "EROFS",
  "EPERM",
  "ENOSPC",
  "EIO",
  "mkdir",
  "errno",
];

const temporary = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "sourcesql-store-location-"));
  t.after(async () => {
    await chmod(join(root, "ro"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return root;
};
const connect = async (t: TestContext, store: ResearchStore, root: string) => {
  const htmlPath = join(root, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const server = createServer(store, htmlPath);
  const client = new Client({ name: "store-location-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(() => client.close());
  return client;
};
const text = (result: { content?: unknown }) =>
  (result.content as { type: string; text?: string }[])
    .map((part) => part.text ?? "")
    .join("\n");
const assertSafe = (
  result: { isError?: boolean; content?: unknown },
  root: string,
) => {
  assert.equal(result.isError, true);
  const message = text(result);
  assert.equal(message, SAFE);
  assert.ok(!message.includes(root), "no path in the message");
  for (const word of FORBIDDEN) assert.ok(!message.includes(word), word);
};
const mutations = (): {
  name: string;
  arguments: Record<string, unknown>;
}[] => [
  {
    name: "import_research",
    arguments: { snapshot: { ...seed, id: "imported-one" } },
  },
  {
    name: "rename_research",
    arguments: {
      snapshot_id: seed.id,
      title: "Another title",
      expected_title: seed.title,
    },
  },
  { name: "remove_research", arguments: { snapshot_id: seed.id } },
  { name: "restore_research", arguments: { snapshot_id: seed.id } },
  {
    name: "append_research",
    arguments: {
      request_id: randomUUID(),
      snapshot: { ...seed, id: "appended-one", parentSnapshotId: seed.id },
    },
  },
  {
    name: "amend_observation",
    arguments: {
      snapshot_id: seed.id,
      row_id: "record-1",
      field: "closes_at",
      value: "2026-10-02 15:00:00",
      reason: "Checked against the listing.",
      expected_revision: 0,
      mutation_id: randomUUID(),
    },
  },
];

test("the stored-reason gate accepts the sentence and it names RESEARCH_DATA_DIR", () => {
  assert.match(LOCAL_STORE_UNAVAILABLE, /^[A-Za-z0-9 ,.;:()_'-]{1,240}$/);
  assert.ok(LOCAL_STORE_UNAVAILABLE.includes("RESEARCH_DATA_DIR"));
});

test("every store-changing tool is refused safely when the location sits under a file", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "blocked"), "an ordinary file");
  const store = new ResearchStore(
    join(root, "blocked", "research-state"),
    seed,
  );
  const client = await connect(t, store, root);
  for (const call of mutations())
    await t.test(call.name, async () =>
      assertSafe(await client.callTool(call), root),
    );
});

test("every store-changing tool is refused safely under a read-only parent", async (t) => {
  if (process.getuid?.() === 0)
    return t.skip("root ignores directory modes, so the failure is not real");
  const root = await temporary(t);
  await mkdir(join(root, "ro"));
  await chmod(join(root, "ro"), 0o500);
  const store = new ResearchStore(join(root, "ro", "research-state"), seed);
  const client = await connect(t, store, root);
  for (const call of mutations())
    await t.test(call.name, async () =>
      assertSafe(await client.callTool(call), root),
    );
});

test("reads under a file name RESEARCH_DATA_DIR and do not tell the agent to restore a file", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "blocked"), "an ordinary file");
  const store = new ResearchStore(
    join(root, "blocked", "research-state"),
    seed,
  );
  const client = await connect(t, store, root);
  for (const call of [
    { name: "open_research", arguments: { snapshot_id: seed.id } },
    { name: "find_research_row", arguments: { snapshot_id: seed.id } },
  ]) {
    const result = await client.callTool(call);
    assertSafe(result, root);
    assert.ok(!text(result).includes("Restore its JSON file"));
  }
});

test("corrupt JSON keeps its corruption message", async (t) => {
  const root = await temporary(t);
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(data, "research.json"), "{not json");
  const client = await connect(t, new ResearchStore(data, seed), root);
  const result = await client.callTool({
    name: "open_research",
    arguments: { snapshot_id: seed.id },
  });
  assert.equal(result.isError, true);
  assert.equal(
    text(result),
    "Cannot read the research store. Restore its JSON file before continuing.",
  );
});

const failing = (code: string) => async () => {
  throw Object.assign(new Error(`${code}: synthetic /synthetic/path`), {
    code,
    path: "/synthetic/path",
  });
};
const inject = (t: TestContext, method: "rename" | "rmdir", code: string) => {
  t.mock.method(fsPromises, method, failing(code));
  syncBuiltinESMExports();
};
const restore = (t: TestContext) => {
  t.mock.restoreAll();
  syncBuiltinESMExports();
};

test("a write that fails after the lock is held is refused safely and leaves no lock", async (t) => {
  const root = await temporary(t);
  const data = join(root, "data");
  const client = await connect(t, new ResearchStore(data, seed), root);
  const rename = {
    name: "rename_research",
    arguments: {
      snapshot_id: seed.id,
      title: "Another title",
      expected_title: seed.title,
    },
  };
  inject(t, "rename", "ENOSPC");
  const log = t.mock.method(console, "error", () => undefined);
  assertSafe(await client.callTool(rename), root);
  assert.match(String(log.mock.calls[0].arguments[0]), /write failed: ENOSPC/);
  restore(t);
  const next = await client.callTool(rename);
  assert.equal(next.isError, undefined, text(next));
  await assert.rejects(stat(join(data, ".writer-lock")), { code: "ENOENT" });
});

test("a failing lock cleanup does not replace the original failure", async (t) => {
  const root = await temporary(t);
  const client = await connect(
    t,
    new ResearchStore(join(root, "data"), seed),
    root,
  );
  inject(t, "rename", "ENOSPC");
  t.mock.method(fsPromises, "rmdir", failing("EIO"));
  syncBuiltinESMExports();
  const log = t.mock.method(console, "error", () => undefined);
  assertSafe(
    await client.callTool({
      name: "rename_research",
      arguments: {
        snapshot_id: seed.id,
        title: "Another title",
        expected_title: seed.title,
      },
    }),
    root,
  );
  const lines = log.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    lines.some((line) => /write failed: ENOSPC/.test(line)),
    lines.join(),
  );
  assert.ok(
    lines.some((line) => /lock cleanup failed: EIO/.test(line)),
    lines.join(),
  );
  restore(t);
});

test("a revision conflict still reaches the agent with its own text", async (t) => {
  const root = await temporary(t);
  const client = await connect(
    t,
    new ResearchStore(join(root, "data"), seed),
    root,
  );
  const result = await client.callTool({
    name: "amend_observation",
    arguments: { ...mutations()[5].arguments, expected_revision: 7 },
  });
  assert.equal(result.isError, true);
  assert.ok(!text(result).startsWith("storage_unavailable"), text(result));
});

test("the stdio server logs the cause and path and hides them from the response", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "blocked"), "an ordinary file");
  const location = join(root, "blocked", "research-state");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/main.ts", "--stdio"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
      SOURCESQL_BACKEND: "local",
      RESEARCH_DATA_DIR: location,
      SOURCESQL_DATA_DIR: join(root, "engine"),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const client = new Client({ name: "store-location-stdio", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool(mutations()[0]);
  assertSafe(result, root);
  assert.ok(stderr.includes("ENOTDIR"), stderr);
  assert.ok(stderr.includes(location), stderr);
});
