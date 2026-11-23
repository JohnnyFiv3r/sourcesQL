import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { PythonEngine, type EngineResult, type ResearchEngine } from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import type { AccessPolicy } from "../server/access.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const python =
  process.env.SOURCESQL_TEST_PYTHON ??
  process.env.SOURCESQL_PYTHON ??
  join(projectRoot, ".venv/bin/python");
const seed = snapshotSchema.parse(sample);

// The wrapper records each bridge start, then runs the real bridge with the
// same stdio, so the count covers the app's real spawn path.
const wrapperSource = `
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.SPAWN_LOG, process.pid + "\\n");
const run = spawnSync(process.env.REAL_PYTHON, ["-m", "sourcesql.bridge"], { stdio: "inherit" });
process.exit(run.status ?? 1);
`;

async function harness(access?: AccessPolicy, extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-spawns-"));
  const wrapper = join(dir, "wrapper.cjs");
  const log = join(dir, "spawns.log");
  await writeFile(wrapper, wrapperSource);
  await writeFile(log, "");
  const engine = new PythonEngine(
    projectRoot,
    {
      ...process.env,
      SOURCESQL_DATA_DIR: join(dir, "engine"),
      SOURCESQL_PRINCIPAL: "spawn-owner",
      SOURCESQL_ALLOW_PRIVATE: "0",
      SPAWN_LOG: log,
      REAL_PYTHON: python,
      ...extraEnv,
    },
    { command: process.execPath, args: [wrapper] },
  );
  const htmlPath = join(dir, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const server = createServer(new ResearchStore(join(dir, "app"), seed), htmlPath, {
    engine,
    access,
  });
  const client = new Client({ name: "spawn-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const spawns = async () =>
    (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  return {
    dir,
    engine,
    call,
    spawns,
    // Count the bridge starts one action causes.
    during: async <T>(action: () => Promise<T>) => {
      const before = await spawns();
      const value = await action();
      return { value, count: (await spawns()) - before };
    },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

const requestId = () => crypto.randomUUID();

test("a local query starts one bridge process and matches the separate-read path", async () => {
  const h = await harness();
  try {
    const request = { query: "SELECT 1 AS x", request_id: requestId() };
    const fast = await h.during(() => h.call("sourcesql_query", request));
    assert.equal(fast.value.isError, undefined, JSON.stringify(fast.value.content));
    assert.equal(fast.count, 1);

    // The same query through an engine that still does the separate access read.
    Object.defineProperty(h.engine, "queryReturnsAuthorizedPage", { value: false });
    const old = await h.during(() =>
      h.call("sourcesql_query", { ...request, request_id: requestId() }),
    );
    assert.equal(old.count, 2); // the query, then the separate access read
    const strip = (r: { structuredContent?: unknown }) => {
      const s = r.structuredContent as EngineResult;
      return { columns: s.columns, rows: s.rows, row_count: s.row_count };
    };
    assert.deepEqual(strip(fast.value), strip(old.value));
  } finally {
    await h.close();
  }
});

test("the same request_id returns the original result and a different query conflicts", async () => {
  const h = await harness();
  try {
    const id = requestId();
    const first = await h.call("sourcesql_query", { query: "SELECT 1 AS x", request_id: id });
    const again = await h.call("sourcesql_query", { query: "SELECT 1 AS x", request_id: id });
    assert.equal(
      (again.structuredContent as EngineResult).result_id,
      (first.structuredContent as EngineResult).result_id,
    );
    const conflict = await h.call("sourcesql_query", { query: "SELECT 2 AS x", request_id: id });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /idempotency_conflict|different/i);
  } finally {
    await h.close();
  }
});

test("a read starts one bridge process once the first call has filled the feature cache", async () => {
  const h = await harness();
  try {
    const query = await h.call("sourcesql_query", { query: "SELECT 1 AS x", request_id: requestId() });
    const resultId = (query.structuredContent as EngineResult).result_id;
    // A fresh engine pays one extra start for capabilities on its first read.
    const first = await h.during(() => h.call("sourcesql_read_result", { result_id: resultId }));
    assert.equal(first.value.isError, undefined, JSON.stringify(first.value.content));
    assert.equal(first.count, 2);
    const second = await h.during(() => h.call("sourcesql_read_result", { result_id: resultId }));
    assert.equal(second.count, 1);
    assert.deepEqual(second.value.structuredContent, first.value.structuredContent);
  } finally {
    await h.close();
  }
});

test("an unknown result is refused with the same text on the read and query paths", async () => {
  const h = await harness();
  try {
    const missing = "wq_" + "0".repeat(32);
    const read = await h.call("sourcesql_read_result", { result_id: missing });
    const query = await h.call("sourcesql_query", {
      query: "SELECT * FROM input.t",
      inputs: { t: { result_id: missing, view: "original", amendment_revision: null } },
    });
    for (const response of [read, query]) {
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response.content), /unauthorized: Result or dependency unavailable/);
    }
  } finally {
    await h.close();
  }
});

test("anonymous mode still checks the profile through capabilities", async () => {
  const h = await harness({ mode: "fixture-anonymous" } as AccessPolicy);
  try {
    const refused = await h.call("sourcesql_query", {
      query: "SELECT 1 AS x",
      profile: "not-a-fixture-profile",
      request_id: requestId(),
    });
    assert.equal(refused.isError, true);
    const allowed = await h.during(() =>
      h.call("sourcesql_query", { query: "SELECT 1 AS x", request_id: requestId() }),
    );
    assert.equal(allowed.value.isError, undefined, JSON.stringify(allowed.value.content));
    assert.equal(allowed.count, 2); // capabilities for the check, then the query
  } finally {
    await h.close();
  }
});

test("a private result on the query's own page is still refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-private-page-"));
  const htmlPath = join(dir, "research.html");
  await writeFile(htmlPath, "<html>Test</html>");
  const engine: ResearchEngine = {
    queryReturnsAuthorizedPage: true,
    async call<T>(method: string) {
      return (
        method === "query"
          ? { result_id: "wq_private", data_classification: "private_local", rows: [], columns: [] }
          : {}
      ) as T;
    },
  };
  const server = createServer(new ResearchStore(join(dir, "app"), seed), htmlPath, {
    engine,
    access: { mode: "bearer", allowPrivate: false } as unknown as AccessPolicy,
  });
  const client = new Client({ name: "private-page-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const response = await client.callTool({
      name: "sourcesql_query",
      arguments: { query: "SELECT 1 AS x", request_id: requestId() },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.content), /Private host disclosure is not authorized/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a profiles file change applies on the next call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-profiles-"));
  const profiles = join(dir, "profiles.json");
  const profile = { mode: "fixture", provider: "fixture" };
  try {
    await writeFile(profiles, JSON.stringify({ alpha: profile }));
    const h = await harness(undefined, { SOURCESQL_PROFILES_FILE: profiles });
    try {
      const names = async () =>
        JSON.stringify((await h.call("sourcesql_capabilities", {})).structuredContent);
      assert.match(await names(), /alpha/);
      await writeFile(profiles, JSON.stringify({ alpha: profile, beta: profile }));
      assert.match(await names(), /beta/);
    } finally {
      await h.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no bridge process outlives a round of calls", async () => {
  const h = await harness();
  try {
    const query = await h.call("sourcesql_query", { query: "SELECT 1 AS x", request_id: requestId() });
    const resultId = (query.structuredContent as EngineResult).result_id;
    await h.call("sourcesql_capabilities", {});
    await h.call("sourcesql_read_result", { result_id: resultId });
    await h.call("sourcesql_inspect_evidence", { result_id: resultId });
    const pids = (await readFile(join(h.dir, "spawns.log"), "utf8"))
      .split("\n").filter(Boolean).map(Number);
    assert.ok(pids.length >= 4 && pids.length <= 6, `starts in a round: ${pids.length}`);
    for (const pid of pids)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await h.close();
  }
});

test("a crashed bridge fails one call and does not poison the feature lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-crash-"));
  const script = join(dir, "bridge.cjs");
  const state = join(dir, "calls");
  await writeFile(
    script,
    `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(state)},'x');if(fs.readFileSync(${JSON.stringify(state)},'utf8').length===1)process.exit(1);const r=JSON.parse(input);process.stdout.write(JSON.stringify({id:r.id,result:{worker_feature_contracts:{}}})+'\\n');});`,
  );
  const engine = new PythonEngine(dir, { ...process.env }, { command: process.execPath, args: [script] });
  try {
    await assert.rejects(engine.inspectResult({ result_id: "wq_x" }));
    // The next call retries the lookup rather than replaying the failure.
    assert.equal(await engine.inspectResult({ result_id: "wq_x" }), undefined);
    assert.equal((await readFile(state, "utf8")).length, 2);
    // And the successful lookup is now cached.
    await engine.inspectResult({ result_id: "wq_x" });
    assert.equal((await readFile(state, "utf8")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
