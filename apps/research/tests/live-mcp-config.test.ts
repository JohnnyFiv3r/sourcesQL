import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { repoRoot, testPython } from "./python.js";

const config = JSON.parse(
  await readFile(new URL("../mcp-config.live.example.json", import.meta.url), "utf8"),
).mcpServers["sourcesql-research"] as {
  command: string;
  args: string[];
  env: Record<string, string>;
};

test("the live MCP example holds no key entries, so a key set elsewhere is never masked", () => {
  assert.deepEqual(
    Object.keys(config.env).filter((name) => name.endsWith("_API_KEY")),
    [],
  );
  assert.equal(config.env.SOURCESQL_ALLOW_PRIVATE, "0");
  assert.equal(config.env.SOURCESQL_PROFILES_FILE, "local/profiles.json");
});

test("the live MCP example starts from the clone root in fixture mode when its profiles file is absent", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "sourcesql-live-config-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: config.command === "node" ? process.execPath : config.command,
    args: config.args,
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      ...config.env,
      // The stores and the profiles path move, so the test writes nothing under the clone's local
      // folder and does not depend on a profiles file the reader created in recipe step 4.
      RESEARCH_DATA_DIR: join(scratch, "research"),
      SOURCESQL_DATA_DIR: join(scratch, "engine"),
      SOURCESQL_PYTHON: testPython(),
      SOURCESQL_PROFILES_FILE: join(scratch, "no-profiles.json"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "live-config", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const reply = await client.callTool({ name: "sourcesql_capabilities", arguments: {} });
  const capabilities = JSON.parse(
    (reply.content as { text: string }[])[0].text,
  ) as { profiles_file: string; profiles: { name: string }[] };
  assert.equal(capabilities.profiles_file, "missing");
  assert.deepEqual(
    capabilities.profiles.map((profile) => profile.name),
    ["fixture"],
  );
});
