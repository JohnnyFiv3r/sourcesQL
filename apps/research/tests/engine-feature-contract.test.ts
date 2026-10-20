import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonEngine } from "../server/engine.js";
import { WORKER_FEATURE_CONTRACTS } from "../server/feature-contracts.js";

test("local compatibility uses the actual feature map rather than the 0.2.3 package label", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-local-features-"));
  const trace = join(directory, "calls.jsonl"),
    script = join(directory, "bridge.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.appendFileSync(process.env.TEST_TRACE,JSON.stringify(request.method)+'\\n');const result=request.method==='capabilities'?{engine_version:'0.2.3',worker_feature_contracts:JSON.parse(process.env.TEST_FEATURES)}:{executed:request.method};process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');});`,
  );
  const adapter = (features: Record<string, string>) =>
    new PythonEngine(
      directory,
      {
        ...process.env,
        TEST_TRACE: trace,
        TEST_FEATURES: JSON.stringify(features),
      },
      { command: process.execPath, args: [script] },
    );
  try {
    const old = adapter({});
    await assert.rejects(
      old.call("query", {
        query: "SELECT 1",
        citations: [
          {
            match: { n: 1 },
            column_key: "n",
            source_version_id: "src_one",
            quote: "An exact quote",
          },
        ],
      }),
      /unsupported_capability/,
    );
    await assert.rejects(
      old.call("import_table", {
        cell_origins: { encoding: "indexed-cells.v1", cells: [[0, 0, 0]] },
      }),
      /unsupported_capability/,
    );
    assert.equal(await old.inspectResult({ result_id: "wq_one" }), undefined);
    assert.deepEqual(
      (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      ["capabilities", "capabilities", "capabilities"],
    );
    assert.deepEqual(await old.call("query", { query: "SELECT 1" }), {
      executed: "query",
    });
    const current = adapter(WORKER_FEATURE_CONTRACTS);
    assert.deepEqual(
      await current.inspectResult({ result_id: "wq_one", mode: "rows" }),
      { executed: "inspect_result" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
