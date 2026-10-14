import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import {
  archiveUiBundle,
  LEGACY_RESOURCE_URI,
  uiResourceUri,
} from "../server/ui-resource.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";

test("new UI builds change discovery's cache key and keep older resources readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-ui-versions-"));
  const htmlPath = join(directory, "dist/research.html");
  await mkdir(join(directory, "dist"));
  const oldHtml = "<html>Original UI</html>";
  const newHtml = "<html>UI with research indicators</html>";
  await writeFile(htmlPath, oldHtml);
  const oldUri = await archiveUiBundle(htmlPath);
  assert.equal(await archiveUiBundle(htmlPath), oldUri);
  await writeFile(htmlPath, newHtml);
  const newUri = await archiveUiBundle(htmlPath);
  assert.notEqual(oldUri, newUri);
  assert.equal(uiResourceUri(newHtml), newUri);

  const server = createServer(
    new ResearchStore(join(directory, "data"), snapshotSchema.parse(sample)),
    htmlPath,
  );
  const client = new Client({ name: "UI-version-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    for (const name of ["open_research", "import_research"]) {
      assert.equal(
        (
          tools.find((t) => t.name === name)!._meta?.ui as {
            resourceUri: string;
          }
        ).resourceUri,
        newUri,
      );
    }
    for (const [uri, html] of [
      [newUri, newHtml],
      [oldUri, oldHtml],
      [LEGACY_RESOURCE_URI, newHtml],
    ]) {
      const { contents } = await client.readResource({ uri });
      assert.equal(contents[0].uri, uri);
      assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
      assert.equal("text" in contents[0] && contents[0].text, html);
    }
    await assert.rejects(
      client.readResource({ uri: "ui://research-legacy/research-unknown.html" }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});
