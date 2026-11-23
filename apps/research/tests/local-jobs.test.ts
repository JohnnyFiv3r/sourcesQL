import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  PythonEngine,
  LOCAL_DISPATCH_DEADLINE_SECONDS,
  LOCAL_DISPATCH_LIMIT_MS,
  LOCAL_READ_LIMIT_MS,
  type ResearchEngine,
} from "../server/engine.js";
import {
  SOURCESQL_QUERY_DESCRIPTION,
  SOURCESQL_SERVER_INSTRUCTIONS,
  queryDescription,
  serverInstructions,
} from "../server/agent-guidance.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const JOB_TOOLS = [
  "sourcesql_job_status",
  "sourcesql_start_job",
  "sourcesql_cancel_job",
];
const RUN_TOOLS = [
  "sourcesql_run_status",
  "sourcesql_recover_run",
  "sourcesql_resume_run",
];
const JOB_ID = "11111111-1111-4111-8111-111111111111";

async function withClient<T>(
  engine: ResearchEngine,
  use: (client: Client) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-local-jobs-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "local-jobs-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    return await use(client);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function stub(jobs: boolean, calls: string[] = []): ResearchEngine {
  return {
    ...(jobs ? { supportsAsyncJobs: true } : {}),
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      throw new Error("Discovery must not execute engine work");
    },
  };
}
const listing = (engine: ResearchEngine) =>
  withClient(engine, async (client) => ({
    tools: (await client.listTools()).tools,
    instructions: client.getInstructions(),
  }));

test("local listing omits job tools because the engine has no jobs, not because of their names", async () => {
  const { tools } = await listing(stub(false));
  const names = tools.map((tool) => tool.name);
  for (const name of JOB_TOOLS) assert.ok(!names.includes(name), name);
  for (const name of RUN_TOOLS) assert.ok(names.includes(name), name);
  assert.equal(names.length, 36);
});

test("hosted listing keeps all three job tools", async () => {
  const { tools } = await listing(stub(true));
  const names = tools.map((tool) => tool.name);
  for (const name of [...JOB_TOOLS, ...RUN_TOOLS])
    assert.ok(names.includes(name), name);
  assert.equal(names.length, 39);
});

test("stale job-tool call gets the synchronous no-jobs error and the engine is not called", async () => {
  const calls: string[] = [];
  await withClient(stub(false, calls), async (client) => {
    for (const name of JOB_TOOLS) {
      const result = (await client.callTool({
        name,
        arguments: { job_id: JOB_ID },
      })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true, name);
      const text = result.content[0].text;
      assert.match(
        text,
        new RegExp(
          `^invalid_request: This sourcesQL server runs queries synchronously and has no jobs, so ${name} is not available`,
        ),
      );
      assert.match(text, /sourcesql_run_status or sourcesql_recover_run/);
      assert.doesNotMatch(text, /Invalid bridge request|not found/);
    }
    // The wrapper must leave every other call and the listing working.
    assert.ok((await client.listTools()).tools.length > 0);
    const other = await client.callTool({
      name: "sourcesql_run_status",
      arguments: {},
    });
    assert.equal(other.isError, true, "an invalid call still reaches the SDK");
  });
  assert.ok(!calls.includes("job_status"));
});

test("PythonEngine answers job methods without spawning Python", async () => {
  const engine = new PythonEngine(
    "/nonexistent",
    {},
    { command: "/nonexistent" },
  );
  for (const method of ["job_status", "start_job", "cancel_job"])
    await assert.rejects(
      engine.call(method, { job_id: JOB_ID }),
      new RegExp(
        `runs queries synchronously and has no jobs, so sourcesql_${method} is not available`,
      ),
    );
});

test("open_research with a job_id on a local engine explains there are no jobs", async () => {
  const engine = new PythonEngine(
    "/nonexistent",
    {},
    { command: "/nonexistent" },
  );
  await withClient(engine, async (client) => {
    const result = (await client.callTool({
      name: "open_research",
      arguments: { job_id: JOB_ID },
    })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no jobs/);
    assert.doesNotMatch(result.content[0].text, /engine unavailable/);
  });
});

async function fakeBridge(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-local-bridge-"));
  const script = join(directory, "bridge.mjs");
  await writeFile(
    script,
    `import {createInterface} from "node:readline";
const rl = createInterface({input: process.stdin});
rl.on("line", async (line) => {
  const request = JSON.parse(line);
  const answer = (result) => console.log(JSON.stringify({id: request.id, result}));
${body}
});
`,
  );
  return { directory, script };
}

test("local capabilities report synchronous execution and the enforced limit", async () => {
  const { directory, script } = await fakeBridge(
    `answer({limits: {dispatch_deadline_seconds: 180}});`,
  );
  try {
    const engine = new PythonEngine(directory, process.env, {
      command: process.execPath,
      args: [script],
    });
    const result = await engine.call<Record<string, any>>("capabilities");
    assert.deepEqual(result.execution, {
      mode: "synchronous",
      jobs: false,
      note: "Queries return their result in the same call. There are no jobs to poll.",
      dispatch_deadline_seconds: 180,
      enforced_limit_seconds: 200,
    });
    assert.equal(result.limits.dispatch_deadline_seconds, 180);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("query outlives the read limit while reads are still cut short", async () => {
  const { directory, script } = await fakeBridge(
    `await new Promise((r) => setTimeout(r, 1000)); answer({ok: request.method});`,
  );
  try {
    const engine = new PythonEngine(directory, process.env, {
      command: process.execPath,
      args: [script],
      readTimeoutMs: 300,
      dispatchTimeoutMs: 5000,
    });
    assert.deepEqual(await engine.call("query", {}), { ok: "query" });
    await assert.rejects(engine.call("read_result", {}), /Engine timed out/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function processStopped(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

test(
  "query past the dispatch limit is stopped with its process group",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sourcesql-local-hang-"));
    const script = join(directory, "bridge.mjs");
    const pidFile = join(directory, "child.pid");
    let childPid: number | undefined;
    try {
      await writeFile(
        script,
        `import {spawn} from "node:child_process";\nimport {writeFileSync} from "node:fs";\nconst child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});\nwriteFileSync(process.argv[2],String(child.pid));\nprocess.stdin.resume();\nsetInterval(()=>{},1000);\n`,
      );
      const engine = new PythonEngine(directory, process.env, {
        command: process.execPath,
        args: [script, pidFile],
        readTimeoutMs: 60_000,
        dispatchTimeoutMs: 1500,
      });
      await assert.rejects(
        engine.call("query", {}),
        /Engine timed out; inspect the run before retrying/,
      );
      childPid = Number(await readFile(pidFile, "utf8"));
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
      for (
        let retry = 0;
        retry < 80 && !(await processStopped(childPid));
        retry++
      )
        await delay(25);
      assert.equal(await processStopped(childPid), true);
    } finally {
      if (childPid && !(await processStopped(childPid))) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("local limits are consistent with the reported deadline and the host cap", () => {
  const enforced = LOCAL_DISPATCH_LIMIT_MS / 1000;
  assert.ok(LOCAL_DISPATCH_DEADLINE_SECONDS <= enforced);
  assert.ok(enforced <= LOCAL_DISPATCH_DEADLINE_SECONDS + 30);
  assert.ok(enforced <= 240);
  assert.equal(LOCAL_READ_LIMIT_MS, 30_000);
});

test(
  "reported dispatch deadline matches the Python engine's own default",
  { skip: !process.env.SOURCESQL_PYTHON },
  async () => {
    const root = join(import.meta.dirname, "../../..");
    const result = await new PythonEngine(root, process.env).call<
      Record<string, any>
    >("capabilities");
    assert.equal(
      result.limits.dispatch_deadline_seconds,
      LOCAL_DISPATCH_DEADLINE_SECONDS,
    );
    assert.equal(
      result.execution.dispatch_deadline_seconds,
      LOCAL_DISPATCH_DEADLINE_SECONDS,
    );
  },
);

test("local text never mentions job tools; hosted text is unchanged", async () => {
  const local = await listing(stub(false));
  const mentions = /job_status|start_job|cancel_job/;
  assert.doesNotMatch(local.instructions!, mentions);
  assert.match(local.instructions!, /Local queries are synchronous/);
  for (const tool of local.tools)
    assert.doesNotMatch(String(tool.description ?? ""), mentions, tool.name);
  const hosted = await listing(stub(true));
  assert.equal(hosted.instructions, SOURCESQL_SERVER_INSTRUCTIONS);
  assert.equal(
    hosted.tools.find((tool) => tool.name === "sourcesql_query")!.description,
    SOURCESQL_QUERY_DESCRIPTION,
  );
  assert.equal(serverInstructions(true), SOURCESQL_SERVER_INSTRUCTIONS);
  assert.equal(queryDescription(true), SOURCESQL_QUERY_DESCRIPTION);
  assert.match(
    hosted.instructions!,
    /sourcesql_job_status reads hosted progress/,
  );
});
