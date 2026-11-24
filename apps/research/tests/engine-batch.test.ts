import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonEngine } from "../server/engine.js";
import { WORKER_FEATURE_CONTRACTS } from "../server/feature-contracts.js";

// A bridge stub that answers every line on stdin; TEST_MODE bends its replies.
const stub = `
const fs=require('node:fs');let input='';
process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
  const mode=process.env.TEST_MODE;
  if(mode==='hang'){fs.appendFileSync(process.env.TEST_PIDS,process.pid+'\\n');
    const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});
    fs.appendFileSync(process.env.TEST_PIDS,child.pid+'\\n');setInterval(()=>{},1000);return;}
  const replies=input.trim().split('\\n').map(line=>{
    const request=JSON.parse(line);
    fs.appendFileSync(process.env.TEST_TRACE,request.method+'\\n');
    if(request.method==='capabilities'){
      if(mode==='capfail'||mode==='capfailshort')return {id:request.id,error:{code:'storage_unavailable',message:'caps down'}};
      return {id:request.id,result:{worker_feature_contracts:JSON.parse(process.env.TEST_FEATURES)}};}
    return {id:request.id,result:{marker:'inspected'}};});
  if(mode==='reverse')replies.reverse();
  if(mode==='short'||mode==='capfailshort')replies.pop();
  if(mode==='dupe')replies[1]=replies[0];
  for(const reply of replies)process.stdout.write(JSON.stringify(reply)+'\\n');
});`;

async function setup(
  mode: string,
  features: Record<string, string> = WORKER_FEATURE_CONTRACTS,
  timeoutMs?: number,
  limits: { dispatchTimeoutMs?: number; readTimeoutMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-batch-"));
  const script = join(dir, "bridge.cjs");
  await writeFile(script, stub);
  const trace = join(dir, "calls.txt");
  const pids = join(dir, "pids.txt");
  await writeFile(trace, "");
  const engine = new PythonEngine(
    dir,
    {
      ...process.env,
      TEST_MODE: mode,
      TEST_TRACE: trace,
      TEST_PIDS: pids,
      TEST_FEATURES: JSON.stringify(features),
    },
    { command: process.execPath, args: [script], timeoutMs, ...limits },
  );
  return {
    engine,
    pids,
    calls: async () =>
      (await readFile(trace, "utf8")).split("\n").filter(Boolean),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

const params = { result_id: "wq_one" };

test("replies that arrive out of order are matched by id", async () => {
  const h = await setup("reverse");
  try {
    assert.deepEqual(await h.engine.inspectResult(params), {
      marker: "inspected",
    });
  } finally {
    await h.done();
  }
});

test("a mismatched inspection contract discards the batched page", async () => {
  const h = await setup("normal", {
    ...WORKER_FEATURE_CONTRACTS,
    result_inspection: "wrong",
  });
  try {
    assert.equal(await h.engine.inspectResult(params), undefined);
    assert.deepEqual(await h.calls(), ["capabilities", "inspect_result"]);
  } finally {
    await h.done();
  }
});

test("a failing capabilities reply wins and is not cached", async () => {
  const h = await setup("capfail");
  try {
    await assert.rejects(
      h.engine.inspectResult(params),
      /^Error: storage_unavailable: caps down$/,
    );
    await assert.rejects(h.engine.inspectResult(params), /caps down/);
    assert.equal(
      (await h.calls()).filter((method) => method === "capabilities").length,
      2,
    );
  } finally {
    await h.done();
  }
});

test("a complete capabilities refusal is reported even when the inspection reply is missing", async () => {
  const h = await setup("capfailshort");
  try {
    await assert.rejects(
      h.engine.inspectResult(params),
      /^Error: storage_unavailable: caps down$/,
    );
  } finally {
    await h.done();
  }
});

test("a missing inspection reply is ignored when the contract does not match", async () => {
  const h = await setup("short", {
    ...WORKER_FEATURE_CONTRACTS,
    result_inspection: "wrong",
  });
  try {
    assert.equal(await h.engine.inspectResult(params), undefined);
  } finally {
    await h.done();
  }
});

test("a first-read batch gets the short read limit, not the dispatch limit", async () => {
  const h = await setup("hang", WORKER_FEATURE_CONTRACTS, undefined, {
    readTimeoutMs: 400,
    dispatchTimeoutMs: 20_000,
  });
  const started = performance.now();
  try {
    await assert.rejects(
      h.engine.inspectResult(params),
      /Engine timed out; inspect the run before retrying\./,
    );
    assert.ok(performance.now() - started < 5_000);
  } finally {
    await h.done();
  }
});

for (const mode of ["short", "dupe"]) {
  test(`a ${mode} batch reply is an invalid bridge response`, async () => {
    const h = await setup(mode);
    try {
      await assert.rejects(
        h.engine.inspectResult(params),
        /Invalid engine bridge response\./,
      );
    } finally {
      await h.done();
    }
  });
}

test("a batch that never answers is killed with its process group at the deadline", async () => {
  const h = await setup("hang", WORKER_FEATURE_CONTRACTS, 500);
  try {
    await assert.rejects(
      h.engine.inspectResult(params),
      /Engine timed out; inspect the run before retrying\./,
    );
    const pids = (await readFile(h.pids, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(Number);
    assert.equal(pids.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of pids)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await h.done();
  }
});
