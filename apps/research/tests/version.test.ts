import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

test("MCP initialize reports the packaged release version shared with Python and lockfile", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const python = await readFile(
    new URL("../../../src/sourcesql/__init__.py", import.meta.url),
    "utf8",
  );
  const project = await readFile(
    new URL("../../../pyproject.toml", import.meta.url),
    "utf8",
  );
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(python.match(/__version__ = "([^"]+)"/)?.[1], pkg.version);
  assert.equal(project.match(/^version = "([^"]+)"/m)?.[1], pkg.version);
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-release-version-"));
  const client = new Client({ name: "version-qualification", version: "1" });
  const server = createServer(
    new ResearchStore(directory, snapshotSchema.parse(sample)),
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    assert.equal(client.getServerVersion()?.version, pkg.version);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
