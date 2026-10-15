import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { PythonEngine, resolveResult, type ResearchEngine } from "./engine.js";
import { type AccessPolicy } from "./access.js";
import { ResearchStore, type ResearchStateBackend } from "./store.js";
import { snapshotSchema } from "../src/schema.js";
import { createServer } from "./mcp.js";
import { OAUTH_ACCESS_SCOPE, readOAuthConfiguration } from "./oauth.js";

export type AppOptions = {
  environment?: NodeJS.ProcessEnv;
  root?: string;
  stdio?: boolean;
  serverless?: boolean;
  backend?: { engine: ResearchEngine; stateBackend?: ResearchStateBackend };
};
export function researchAccess(
  environment: NodeJS.ProcessEnv,
  stdio = false,
  serverless = false,
): AccessPolicy {
  if (
    serverless &&
    environment.VERCEL_ENV === "production" &&
    environment.SOURCESQL_ALLOW_PRODUCTION !== "1"
  )
    throw new Error(
      "Production deployment requires an explicit SOURCESQL_ALLOW_PRODUCTION opt-in",
    );
  const protectedMode = stdio || environment.RESEARCH_AUTH_MODE === "protected";
  if (
    serverless &&
    (!protectedMode ||
      environment.SOURCESQL_BACKEND !== "motherduck" ||
      !environment.SOURCESQL_PRINCIPAL)
  )
    throw new Error(
      "Serverless mode requires protected MotherDuck storage and an explicit fixed principal",
    );
  if (!stdio && protectedMode && !environment.RESEARCH_BEARER_TOKEN)
    throw new Error("Protected HTTP mode requires RESEARCH_BEARER_TOKEN");
  if (
    serverless &&
    (environment.RESEARCH_BEARER_TOKEN!.length < 32 ||
      environment.SOURCESQL_ALLOW_PRIVATE === "1" ||
      environment.RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE === "1")
  )
    throw new Error(
      "Serverless mode requires a strong bearer token and private disclosure disabled",
    );
  return {
    mode: protectedMode ? "protected" : "fixture-anonymous",
    principal: protectedMode
      ? (environment.SOURCESQL_PRINCIPAL ?? "local-owner")
      : "fixture-anonymous",
    allowPrivateDisclosure:
      protectedMode &&
      environment.RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE === "1",
  };
}
export async function createResearchApplication(options: AppOptions = {}) {
  const environment = options.environment ?? process.env;
  const root = options.root ?? fileURLToPath(new URL("../", import.meta.url));
  const access = researchAccess(environment, options.stdio, options.serverless);
  const oauth = readOAuthConfiguration(environment);
  if (oauth && access.mode !== "protected")
    throw new Error("OAuth requires protected owner access");
  const engineEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    SOURCESQL_PRINCIPAL: access.principal,
    SOURCESQL_ALLOW_PRIVATE:
      access.mode === "protected"
        ? (environment.SOURCESQL_ALLOW_PRIVATE ?? "0")
        : "0",
  };
  if (access.mode !== "protected")
    delete engineEnvironment.SOURCESQL_PROFILES_FILE;
  const backendName = environment.SOURCESQL_BACKEND ?? "local";
  if (!["local", "motherduck"].includes(backendName))
    throw new Error("SOURCESQL_BACKEND must be local or motherduck");
  if (backendName === "motherduck" && access.mode !== "protected")
    throw new Error(
      "MotherDuck storage requires a protected transport and fixed principal",
    );
  const { engine, stateBackend } =
    options.backend ??
    (backendName === "motherduck"
      ? await (
          await import("./motherduck.js")
        ).createMotherDuckBackend(engineEnvironment, access.principal)
      : {
          engine: new PythonEngine(undefined, engineEnvironment),
          stateBackend: undefined,
        });
  if (options.serverless && !stateBackend)
    throw new Error(
      "Serverless mode requires durable state; local filesystem fallback is disabled",
    );
  const store = new ResearchStore(
    environment.RESEARCH_DATA_DIR ??
      join(
        root,
        ".data",
        createHash("sha256")
          .update(access.principal)
          .digest("hex")
          .slice(0, 16),
      ),
    snapshotSchema.parse(
      JSON.parse(
        await readFile(join(root, "fixtures/water-procurement.json"), "utf8"),
      ),
    ),
    async (snapshot) => {
      if (
        !snapshot.origin ||
        !["sourcesql", "open-webql"].includes(snapshot.origin.engine) ||
        !snapshot.dataRef
      )
        throw new Error("Unsupported engine data reference");
      const resolved = await resolveResult(engine, {
        result_id: snapshot.dataRef.resultId,
        snapshot_id: snapshot.id,
        title: snapshot.title,
      });
      if (
        resolved.dataRef!.contentSha256 !== snapshot.dataRef.contentSha256 ||
        resolved.origin!.runId !== snapshot.origin.runId ||
        resolved.rowCount !== snapshot.rowCount ||
        !isDeepStrictEqual(resolved.columns, snapshot.columns) ||
        resolved.capturedAt !== snapshot.capturedAt
      )
        throw new Error(
          "Result reference metadata does not match canonical engine data",
        );
      const offset = snapshot.previewOffset ?? 0;
      if (
        snapshot.rows.length <= 100 &&
        !isDeepStrictEqual(
          snapshot.rows,
          resolved.rows.slice(offset, offset + snapshot.rows.length),
        )
      )
        throw new Error("Result preview does not match canonical engine data");
      return { ...resolved, parentSnapshotId: snapshot.parentSnapshotId };
    },
    3000,
    { backend: stateBackend },
  );
  return {
    engine,
    store,
    access,
    makeServer: () =>
      createServer(store, join(root, "dist/research.html"), {
        engine,
        access,
        oauth: oauth ? { scopes: [OAUTH_ACCESS_SCOPE] } : undefined,
        responseByteLimit: options.serverless ? 4 * 1024 * 1024 : undefined,
      }),
  };
}
