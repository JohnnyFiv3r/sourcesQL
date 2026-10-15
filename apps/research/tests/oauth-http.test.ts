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
async function send(server: Server, path: string, authorization?: string) {
  const body =
    path === "/mcp"
      ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
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
      assert.equal(listed.json.result.tools.length, 37);
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
