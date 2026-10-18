import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { packageVercelAssets } from "../scripts/build-vercel.js";
import { createResearchApplication } from "../server/app.js";
import { createHttpApp } from "../server/http.js";
import type { ResearchStateBackend } from "../server/store.js";

const root = await mkdtemp(join(tmpdir(), "sourcesql-oauth-http-"));
await packageVercelAssets(root);
after(() => rm(root, { recursive: true, force: true }));
const ownerToken = "synthetic-owner-token-" + "a".repeat(48);
const environment = {
  RESEARCH_AUTH_MODE: "protected",
  SOURCESQL_BACKEND: "motherduck",
  SOURCESQL_PRINCIPAL: "fixed-synthetic-owner",
  RESEARCH_BEARER_TOKEN: ownerToken,
  RESEARCH_PUBLIC_ORIGIN: "https://sourcesql.example",
  VERCEL_URL: "preview.vercel.app",
  SOURCESQL_OAUTH_ISSUER: "https://identity.example/",
  SOURCESQL_OAUTH_AUDIENCE: "https://sourcesql.example/mcp",
  SOURCESQL_OAUTH_SUBJECT: "auth0|synthetic-owner",
  SOURCESQL_OAUTH_JWKS_URI: "https://identity.example/.well-known/jwks.json",
};
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "synthetic", alg: "RS256" }],
});
async function token(patch: Record<string, unknown> = {}) {
  return new SignJWT({ scope: "sourcesql:access", ...patch })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
    .setIssuer(String(patch.iss ?? environment.SOURCESQL_OAUTH_ISSUER))
    .setAudience(String(patch.aud ?? environment.SOURCESQL_OAUTH_AUDIENCE))
    .setSubject(String(patch.sub ?? environment.SOURCESQL_OAUTH_SUBJECT))
    .setExpirationTime("5m")
    .sign(privateKey);
}
async function send(
  server: Server,
  path: string,
  authorization?: string,
  rpc?: unknown,
) {
  const body =
    path === "/mcp"
      ? JSON.stringify(rpc ?? { jsonrpc: "2.0", id: 1, method: "tools/list" })
      : undefined;
  return new Promise<{ status: number; challenge?: string; json: any }>(
    (resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port: (server.address() as { port: number }).port,
          path,
          method: body ? "POST" : "GET",
          headers: {
            host: "sourcesql.example",
            accept: "application/json, text/event-stream",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(authorization ? { authorization } : {}),
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              challenge: response.headers["www-authenticate"],
              json: JSON.parse(text),
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    },
  );
}

test("OAuth discovery and denied identities never open storage; the sole owner can discover every tool", async () => {
  let initializations = 0;
  let engineCalls = 0;
  const backend: ResearchStateBackend = {
    async read() {
      throw new Error("Tool discovery must not read storage");
    },
    async write() {
      throw new Error("Tool discovery must not write storage");
    },
  };
  const application = createHttpApp({
    environment,
    root,
    serverless: true,
    oauthJwks: jwks,
    services: async () => {
      initializations++;
      return createResearchApplication({
        environment,
        root,
        serverless: true,
        backend: {
          stateBackend: backend,
          engine: {
            async call() {
              engineCalls++;
              throw new Error("No execution");
            },
          },
        },
      });
    },
  });
  const server = createServer(application);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const discovery = await send(server, path);
      assert.equal(discovery.status, 200);
      assert.deepEqual(discovery.json, {
        resource: environment.SOURCESQL_OAUTH_AUDIENCE,
        authorization_servers: [environment.SOURCESQL_OAUTH_ISSUER],
        scopes_supported: ["sourcesql:access"],
        bearer_methods_supported: ["header"],
      });
      assert.equal(
        JSON.stringify(discovery.json).includes(
          environment.SOURCESQL_OAUTH_SUBJECT,
        ),
        false,
      );
    }
    const unauthenticated = await send(server, "/mcp");
    assert.equal(unauthenticated.status, 401);
    assert.match(
      unauthenticated.challenge!,
      /resource_metadata="https:\/\/sourcesql\.example\/\.well-known\/oauth-protected-resource"/,
    );
    for (const authorization of [
      "Bearer garbage",
      "Bearer " + (await token({ sub: "auth0|another-valid-user" })),
      "Bearer " + (await token({ aud: "https://another.example/mcp" })),
      "Bearer " + (await token({ iss: "https://another-issuer.example/" })),
    ]) {
      const denied = await send(server, "/mcp", authorization);
      assert.equal(denied.status, 401);
      assert.match(denied.challenge!, /error="invalid_token"/);
    }
    const underscoped = await send(
      server,
      "/mcp",
      "Bearer " + (await token({ scope: "openid profile" })),
    );
    assert.equal(underscoped.status, 403);
    assert.match(underscoped.challenge!, /error="insufficient_scope"/);
    assert.equal(initializations, 0);

    for (const authorization of [
      "Bearer " + (await token()),
      "Bearer " + ownerToken,
    ]) {
      const listed = await send(server, "/mcp", authorization);
      assert.equal(listed.status, 200);
      assert.equal(listed.json.result.tools.length, 39);
      assert.ok(
        listed.json.result.tools.every(
          (tool: any) =>
            tool._meta.securitySchemes[0].scopes[0] === "sourcesql:access",
        ),
      );
    }
    assert.equal(initializations, 2);
    assert.equal(engineCalls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OAuth requires a stable matching public resource and complete protected configuration", async () => {
  for (const patch of [
    { RESEARCH_PUBLIC_ORIGIN: undefined },
    { SOURCESQL_OAUTH_AUDIENCE: "https://different.example/mcp" },
    { SOURCESQL_OAUTH_SUBJECT: undefined },
    { RESEARCH_AUTH_MODE: "fixture-anonymous" },
  ]) {
    let initialized = false;
    assert.throws(() =>
      createHttpApp({
        environment: { ...environment, ...patch },
        root,
        serverless: true,
        services: async () => {
          initialized = true;
          throw new Error("No initialization");
        },
      }),
    );
    assert.equal(initialized, false);
  }
  await assert.rejects(
    () =>
      createResearchApplication({
        environment: { ...environment, SOURCESQL_OAUTH_SUBJECT: "" },
        root,
        serverless: true,
      }),
    /OAuth requires/,
  );
});

test("opt-in HTTP diagnostics separate auth, widget delivery and JSON-RPC failures without reading storage", async () => {
  const logs: Record<string, string | number | boolean>[] = [];
  const env = { ...environment, SOURCESQL_MCP_DIAGNOSTICS: "0" };
  let storageReads = 0;
  const application = createHttpApp({
    environment: env,
    root,
    serverless: true,
    oauthJwks: jwks,
    diagnosticLog: (entry) => logs.push(entry),
    services: () =>
      createResearchApplication({
        environment: env,
        root,
        serverless: true,
        backend: {
          stateBackend: {
            async read() {
              storageReads++;
              throw new Error("No storage for resource delivery");
            },
            async write() {
              throw new Error("No writes for resource delivery");
            },
          },
          engine: {
            async call() {
              throw new Error("No engine execution");
            },
          },
        },
      }),
  });
  const server = createServer(application);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const authorization = "Bearer " + ownerToken;
  try {
    await send(server, "/mcp", authorization);
    assert.equal(logs.length, 0, "Diagnostics are disabled by default");
    env.SOURCESQL_MCP_DIAGNOSTICS = "1";
    assert.equal((await send(server, "/mcp")).status, 401);
    assert.equal(logs.at(-1)?.http_status, 401);
    assert.equal(logs.at(-1)?.resource_returned, undefined);
    const discovery = await send(server, "/mcp", authorization);
    const uri = discovery.json.result.tools.find(
      (tool: any) => tool.name === "open_research",
    )._meta.ui.resourceUri;
    assert.equal(logs.at(-1)?.advertised_resource, uri);
    const widget = await send(server, "/mcp", authorization, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri },
    });
    assert.equal(widget.status, 200);
    assert.equal(logs.at(-1)?.resource, uri);
    assert.equal(logs.at(-1)?.resource_returned, true);
    assert.equal(logs.at(-1)?.completed, true);
    assert.equal(
      logs.at(-1)?.resource_bytes,
      Buffer.byteLength(widget.json.result.contents[0].text),
    );
    assert.match(String(logs.at(-1)?.resource_sha256), /^[a-f0-9]{64}$/);
    const missing = await send(server, "/mcp", authorization, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "ui://sourcesql/research-0000000000000000.html" },
    });
    assert.equal(missing.status, 200);
    assert.equal(typeof missing.json.error.code, "number");
    assert.equal(logs.at(-1)?.rpc_error, missing.json.error.code);
    assert.equal(logs.at(-1)?.resource_returned, undefined);
    const privateText = "synthetic-private-request-do-not-log";
    const invalid = await send(server, "/mcp", authorization, {
      jsonrpc: "2.0",
      id: privateText,
      method: "tools/call",
      params: {
        name: "open_research",
        arguments: { snapshot_id: privateText, job_id: privateText },
      },
    });
    assert.equal(invalid.status, 200);
    assert.ok(invalid.json.error || invalid.json.result?.isError);
    assert.equal(logs.at(-1)?.tool, "open_research");
    assert.ok(logs.at(-1)?.rpc_error || logs.at(-1)?.tool_error);
    assert.equal(JSON.stringify(logs).includes(privateText), false);
    assert.equal(JSON.stringify(logs).includes(ownerToken), false);
    assert.equal(storageReads, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
