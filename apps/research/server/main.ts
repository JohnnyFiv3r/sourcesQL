import { createHash } from "node:crypto";
import { PythonEngine, resolveResult } from "./engine.js";
import { bearerMatches, type AccessPolicy } from "./access.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "./mcp.js";
import { ResearchStore } from "./store.js";
import { snapshotSchema } from "../src/schema.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const isStdio = process.argv.includes("--stdio");
const protectedMode = isStdio || process.env.RESEARCH_AUTH_MODE === "protected";
const access: AccessPolicy = {
  mode: protectedMode ? "protected" : "fixture-anonymous",
  principal: protectedMode
    ? (process.env.WEBQL_PRINCIPAL ?? "local-owner")
    : "fixture-anonymous",
  allowPrivateDisclosure:
    protectedMode && process.env.RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE === "1",
};
if (!isStdio && protectedMode && !process.env.RESEARCH_BEARER_TOKEN)
  throw new Error("Protected HTTP mode requires RESEARCH_BEARER_TOKEN");
const engineEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  WEBQL_PRINCIPAL: access.principal,
  WEBQL_ALLOW_PRIVATE: protectedMode
    ? (process.env.WEBQL_ALLOW_PRIVATE ?? "0")
    : "0",
};
if (!protectedMode) delete engineEnvironment.WEBQL_PROFILES_FILE;
const engine = new PythonEngine(undefined, engineEnvironment);
const store = new ResearchStore(
  process.env.RESEARCH_DATA_DIR ??
    join(
      root,
      ".data",
      createHash("sha256").update(access.principal).digest("hex").slice(0, 16),
    ),
  snapshotSchema.parse(
    JSON.parse(
      await readFile(join(root, "fixtures/water-procurement.json"), "utf8"),
    ),
  ),
  async (snapshot) => {
    if (snapshot.origin?.engine !== "open-webql" || !snapshot.dataRef)
      throw new Error("Unsupported local data reference");
    const resolved = await resolveResult(engine, {
      result_id: snapshot.dataRef.resultId,
      snapshot_id: snapshot.id,
      title: snapshot.title,
    });
    if (
      resolved.dataRef!.contentSha256 !== snapshot.dataRef.contentSha256 ||
      resolved.origin!.runId !== snapshot.origin.runId ||
      resolved.rowCount !== snapshot.rowCount ||
      JSON.stringify(resolved.columns) !== JSON.stringify(snapshot.columns) ||
      resolved.capturedAt !== snapshot.capturedAt
    )
      throw new Error(
        "Result reference metadata does not match canonical engine data",
      );
    const offset = snapshot.previewOffset ?? 0;
    if (
      snapshot.rows.length <= 100 &&
      JSON.stringify(snapshot.rows) !==
        JSON.stringify(
          resolved.rows.slice(offset, offset + snapshot.rows.length),
        )
    )
      throw new Error("Result preview does not match canonical engine data");
    return { ...resolved, parentSnapshotId: snapshot.parentSnapshotId };
  },
);
const makeServer = () =>
  createServer(store, join(root, "dist/research.html"), { engine, access });
if (isStdio) {
  await makeServer().connect(new StdioServerTransport());
} else {
  const port = Number(process.env.PORT ?? 3117);
  const app = createMcpExpressApp({ host: "127.0.0.1", jsonLimit: "16mb" });
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://127.0.0.1:${port}` &&
      origin !== `http://localhost:${port}`
    ) {
      res.status(403).send("Cross-origin requests are not allowed.");
      return;
    }
    next();
  });
  app.get("/", (_req, res) => res.sendFile(resolve(root, "dist/index.html")));
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      mode: access.mode,
      principal: protectedMode ? undefined : "fixture-anonymous",
    }),
  );
  app.all("/mcp", async (req, res) => {
    if (
      protectedMode &&
      !bearerMatches(
        req.headers.authorization,
        process.env.RESEARCH_BEARER_TOKEN!,
      )
    ) {
      res.status(401).json({ error: "Bearer authentication required" });
      return;
    }
    const server = makeServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent)
        res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.listen(port, "127.0.0.1", () =>
    console.error(
      `Open WebQL research app: http://127.0.0.1:${port} | MCP: /mcp`,
    ),
  );
}
