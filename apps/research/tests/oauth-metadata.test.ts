import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import { type ResearchEngine } from "../server/engine.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

const engine: ResearchEngine = {
  async call() {
    throw new Error("Metadata discovery must not execute an engine operation");
  },
};
async function discover(oauth?: { scopes: string[] }) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-oauth-metadata-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  const server = createServer(
    new ResearchStore(join(directory, "unused"), snapshotSchema.parse(sample)),
    htmlPath,
    {
      engine,
      oauth,
      access: {
        mode: "protected",
        principal: "synthetic-owner",
        allowPrivateDisclosure: false,
      },
    },
  );
  // A caller retaining its config array must not be able to weaken registered tools.
  if (oauth) oauth.scopes.splice(0);
  const client = new Client({ name: "oauth-metadata", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const uri = (
      tools.find((t) => t.name === "open_research")!._meta!.ui as {
        resourceUri: string;
      }
    ).resourceUri;
    const resource = await client.readResource({ uri });
    // Match JSON wire semantics, including omitted optional undefined fields.
    return JSON.parse(JSON.stringify({ tools, resources, resource })) as {
      tools: {
        name: string;
        _meta?: Record<string, unknown>;
        [key: string]: unknown;
      }[];
      resources: unknown;
      resource: { contents: { _meta?: unknown; mimeType?: string }[] };
    };
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("OAuth discovery exposes the complete owner scope on all tools while preserving schemas, annotations and widget metadata", async () => {
  const bearer = await discover();
  const oauth = await discover({ scopes: ["sourcesql:access"] });
  assert.equal(oauth.tools.length, 27);
  assert.deepEqual(
    oauth.tools.map((t) => t.name),
    bearer.tools.map((t) => t.name),
  );
  for (const tool of oauth.tools) {
    assert.deepEqual(
      tool._meta?.securitySchemes,
      [{ type: "oauth2", scopes: ["sourcesql:access"] }],
      tool.name,
    );
    assert.equal(
      Object.hasOwn(tool, "securitySchemes"),
      false,
      "Pinned SDK supports the documented _meta compatibility surface",
    );
    const { _meta, ...descriptor } = tool;
    const { securitySchemes: _securitySchemes, ...existingMeta } = _meta!;
    const original = Object.keys(existingMeta).length
      ? { ...descriptor, _meta: existingMeta }
      : descriptor;
    assert.deepEqual(
      original,
      bearer.tools.find((t) => t.name === tool.name),
      tool.name + " must preserve the complete existing descriptor",
    );
  }
  for (const name of ["open_research"]) {
    const meta = oauth.tools.find((t) => t.name === name)!._meta!;
    assert.match(
      (meta.ui as { resourceUri: string }).resourceUri,
      /^ui:\/\/sourcesql\/research-[a-f0-9]{16}\.html$/,
    );
    assert.equal(meta["openai/outputTemplate"], undefined);
  }
  assert.deepEqual(oauth.resources, bearer.resources);
  assert.deepEqual(oauth.resource, bearer.resource);
  assert.equal(
    oauth.resource.contents[0].mimeType,
    "text/html;profile=mcp-app",
  );
  assert.deepEqual(oauth.resource.contents[0]._meta, {
    ui: {
      prefersBorder: true,
      csp: { connectDomains: [], resourceDomains: [] },
    },
    "openai/widgetDescription":
      "Interactive sourcesQL research table with source evidence, saved research navigation and corrections. The app is the primary result; avoid repeating its rows in prose or a Markdown table.",
  });
  assert.ok(
    bearer.tools.every((t) => t._meta?.securitySchemes === undefined),
    "Local bearer discovery must remain unchanged",
  );
});

test("OAuth tool configuration refuses missing or narrower workspace grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-oauth-config-"));
  const htmlPath = join(directory, "research.html");
  await writeFile(htmlPath, "<!doctype html><html>Synthetic widget</html>");
  try {
    for (const scopes of [
      [],
      ["sourcesql:read"],
      ["sourcesql:access", "sourcesql:read"],
    ])
      assert.throws(
        () =>
          createServer(
            new ResearchStore(
              join(directory, "unused"),
              snapshotSchema.parse(sample),
            ),
            htmlPath,
            { engine, oauth: { scopes } },
          ),
        /full sourcesql:access owner scope/,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
