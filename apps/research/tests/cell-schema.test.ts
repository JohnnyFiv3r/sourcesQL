import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import { cell, cellLimits, snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const nestedArray = (levels: number): unknown => {
  let value: unknown = "x";
  for (let i = 0; i < levels; i++) value = [value];
  return value;
};
const nestedObject = (levels: number): unknown => {
  let value: unknown = "x";
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
};

test("cells nested to the depth limit are accepted with their values unchanged", () => {
  for (const value of [
    nestedArray(cellLimits.depth),
    nestedObject(cellLimits.depth),
    Array.from({ length: cellLimits.items }, (_, i) => i),
    Object.fromEntries(
      Array.from({ length: cellLimits.keys }, (_, i) => [`k${i}`, i]),
    ),
    "text",
    3.5,
    false,
    null,
  ])
    assert.deepEqual(cell.parse(value), value);
});

test("cells beyond the depth, size or type limits are rejected", () => {
  const bad: [string, unknown][] = [
    ["too deep array", nestedArray(cellLimits.depth + 1)],
    ["too deep object", nestedObject(cellLimits.depth + 1)],
    ["too many items", new Array(cellLimits.items + 1).fill(0)],
    [
      "too many keys",
      Object.fromEntries(
        Array.from({ length: cellLimits.keys + 1 }, (_, i) => [`k${i}`, i]),
      ),
    ],
    ["key with a leading digit", { "1bad": 1 }],
    ["long string", "x".repeat(8001)],
    ["infinite number", Infinity],
    ["undefined inside an array", ["ok", undefined]],
    ["function inside an object", { a: () => 1 }],
  ];
  for (const [name, value] of bad)
    assert.equal(cell.safeParse(value).success, false, name);
});

test("the advertised description states the limits the validator enforces", () => {
  const description = JSON.stringify(
    (cell as unknown as { description?: string }).description,
  );
  assert.ok(description.includes(`${cellLimits.depth} levels`));
  assert.ok(description.includes(`${cellLimits.items} items`));
  assert.ok(description.includes(`${cellLimits.keys} keys`));
});

async function withClient<T>(run: (client: Client) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-cell-schema-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const engine: ResearchEngine = {
    async call<T>(): Promise<T> {
      throw new Error("Cell validation must not execute engine work");
    },
  };
  const server = createServer(
    new ResearchStore(join(directory, "store"), snapshotSchema.parse(sample)),
    htmlPath,
    { engine },
  );
  const client = new Client({ name: "cell-schema-check", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const findRow = (client: Client, value: unknown) =>
  client
    .callTool({
      name: "find_research_row",
      arguments: { snapshot_id: sample.id, match: { issuer: value } },
    })
    .then(
      (result) => ({
        isError: result.isError === true,
        text: JSON.stringify(result),
      }),
      (error: unknown) => ({ isError: true, text: String(error) }),
    );

test("a match cell nested past the limit is rejected over MCP and the server keeps serving", async () => {
  await withClient(async (client) => {
    const rejected = await findRow(client, nestedArray(cellLimits.depth + 1));
    assert.equal(rejected.isError, true, rejected.text);
    assert.match(rejected.text, /match/);
    assert.ok((await client.listTools()).tools.length > 0);
  });
});

test("a match cell nested to the limit is accepted over MCP", async () => {
  await withClient(async (client) => {
    const accepted = await findRow(client, nestedArray(cellLimits.depth));
    assert.equal(accepted.isError, false, accepted.text);
  });
});

test("a __proto__ key nested inside a cell is dropped, as the recursive schema did", () => {
  assert.deepEqual(cell.parse(JSON.parse('[{"__proto__":0}]')), [{}]);
  assert.deepEqual(cell.parse(JSON.parse('{"a":[{"__proto__":0,"keep":2}]}')), {
    a: [{ keep: 2 }],
  });
});
